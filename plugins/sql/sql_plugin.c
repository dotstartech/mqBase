#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <time.h>
#include <sys/time.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <pthread.h>
#include <errno.h>

#include "mosquitto_broker.h"
#include "mosquitto_plugin.h"
#include "mosquitto.h"
#include "mqtt_protocol.h"

#include "sqlite3.h"

// Generator configuration flags
#define ULID_RELAXED   (1 << 0)
#define ULID_PARANOID  (1 << 1)
#define ULID_SECURE    (1 << 2)

// Maximum number of exclusion patterns
#define MAX_EXCLUDE_PATTERNS 64
#define MAX_EXCLUDE_HEADERS 64

// Batch insert configuration (defaults, can be overridden via config)
#define DEFAULT_BATCH_SIZE 100           // Flush when queue reaches this size
#define DEFAULT_FLUSH_INTERVAL_MS 50     // Flush at least every 50ms
#define MAX_QUEUE_SIZE 10000             // Maximum queue size before blocking

// Data retention configuration
#define DEFAULT_RETENTION_DAYS 0         // 0 = disabled (keep all messages)
#define RETENTION_CHECK_INTERVAL_SEC 86400 // Check every day

// Configurable batch parameters
static int batch_size = DEFAULT_BATCH_SIZE;
static int flush_interval_ms = DEFAULT_FLUSH_INTERVAL_MS;

// Data retention parameters
static int retention_days = DEFAULT_RETENTION_DAYS;
static time_t last_retention_check = 0;

struct ulid_generator {
    unsigned char last[16];
    unsigned long long last_ts;
    int flags;
    unsigned char i, j;
    unsigned char s[256];
};

static struct ulid_generator ulid_gen;

static mosquitto_plugin_id_t *mosq_pid = NULL;

static sqlite3 *msg_db = NULL;
static sqlite3_stmt *insert_stmt = NULL;
static sqlite3_stmt *delete_stmt = NULL;

// Topic exclusion patterns
static char *exclude_patterns[MAX_EXCLUDE_PATTERNS];
static int exclude_pattern_count = 0;

// Header exclusion list (user property names to exclude from storage)
static char *exclude_headers[MAX_EXCLUDE_HEADERS];
static int exclude_header_count = 0;
static int headers_disabled = 0;  // Set to 1 if exclude_headers contains '#'

// ULID generator mutex for thread safety
static pthread_mutex_t ulid_mutex = PTHREAD_MUTEX_INITIALIZER;

// Operation types for queue entries
#define OP_INSERT 0
#define OP_DELETE 1
#define OP_DELETE_FALLBACK 2  // Delete most recent for topic (no specific ULID)

// Message queue entry for batch inserts and deletes
struct msg_entry {
    int operation;      // OP_INSERT, OP_DELETE, or OP_DELETE_FALLBACK
    char ulid[27];
    char *topic;
    char *payload;
    char *headers;
    int retain;
    int qos;
    struct msg_entry *next;
};

// Message queue for batch processing
static struct msg_entry *msg_queue_head = NULL;
static struct msg_entry *msg_queue_tail = NULL;
static int msg_queue_size = 0;
static pthread_mutex_t queue_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t queue_cond = PTHREAD_COND_INITIALIZER;
static pthread_t batch_thread;
static atomic_int batch_thread_running = 0;

// Forward declarations
static void flush_batch(void);
static void *batch_worker(void *arg);

// MQTT topic matching with wildcards (+ and #)
// Returns 1 if topic matches pattern, 0 otherwise
static int topic_matches_pattern(const char *pattern, const char *topic) {
    const char *p = pattern;
    const char *t = topic;
    
    while (*p && *t) {
        if (*p == '#') {
            // # matches everything from here to the end
            return 1;
        } else if (*p == '+') {
            // + matches a single level (until next / or end)
            while (*t && *t != '/') {
                t++;
            }
            p++;
            // If pattern has more after +, it should be a /
            if (*p && *p != '/') {
                return 0;
            }
        } else if (*p == *t) {
            p++;
            t++;
        } else {
            return 0;
        }
    }
    
    // Check end conditions
    if (*p == '#') {
        return 1;
    }
    if (*p == '\0' && *t == '\0') {
        return 1;
    }
    // Handle pattern ending with /+ matching topic without trailing level
    if (*p == '/' && *(p+1) == '+' && *(p+2) == '\0' && *t == '\0') {
        return 0; // topic/foo doesn't match topic/foo/+
    }
    
    return 0;
}

// Check if topic should be excluded from persistence
static int is_topic_excluded(const char *topic) {
    for (int i = 0; i < exclude_pattern_count; i++) {
        if (topic_matches_pattern(exclude_patterns[i], topic)) {
            return 1;
        }
    }
    return 0;
}

// Parse comma-separated exclusion patterns
static void parse_exclude_patterns(const char *patterns_str) {
    if (patterns_str == NULL || *patterns_str == '\0') {
        return;
    }
    
    char *patterns_copy = strdup(patterns_str);
    if (patterns_copy == NULL) {
        return;
    }
    
    char *token = strtok(patterns_copy, ",");
    while (token != NULL && exclude_pattern_count < MAX_EXCLUDE_PATTERNS) {
        // Trim leading whitespace
        while (*token == ' ') token++;
        // Trim trailing whitespace
        char *end = token + strlen(token) - 1;
        while (end > token && *end == ' ') {
            *end = '\0';
            end--;
        }
        
        if (*token != '\0') {
            exclude_patterns[exclude_pattern_count] = strdup(token);
            if (exclude_patterns[exclude_pattern_count] != NULL) {
                mosquitto_log_printf(MOSQ_LOG_INFO, "Excluding topic pattern: %s", exclude_patterns[exclude_pattern_count]);
                exclude_pattern_count++;
            }
        }
        token = strtok(NULL, ",");
    }
    
    free(patterns_copy);
}

// Free exclusion patterns
static void free_exclude_patterns(void) {
    for (int i = 0; i < exclude_pattern_count; i++) {
        free(exclude_patterns[i]);
        exclude_patterns[i] = NULL;
    }
    exclude_pattern_count = 0;
}

// Parse comma-separated header exclusion list
// Special value '#' disables header storage completely
static void parse_exclude_headers(const char *headers_str) {
    if (headers_str == NULL || *headers_str == '\0') {
        return;
    }
    
    // Check for special '#' value to disable all header storage
    if (strcmp(headers_str, "#") == 0) {
        headers_disabled = 1;
        mosquitto_log_printf(MOSQ_LOG_INFO, "Header storage disabled (exclude_headers=#)");
        return;
    }
    
    char *headers_copy = strdup(headers_str);
    if (headers_copy == NULL) {
        return;
    }
    
    char *token = strtok(headers_copy, ",");
    while (token != NULL && exclude_header_count < MAX_EXCLUDE_HEADERS) {
        // Trim leading whitespace
        while (*token == ' ') token++;
        // Trim trailing whitespace
        char *end = token + strlen(token) - 1;
        while (end > token && *end == ' ') {
            *end = '\0';
            end--;
        }
        
        // Check for '#' in the list
        if (strcmp(token, "#") == 0) {
            headers_disabled = 1;
            mosquitto_log_printf(MOSQ_LOG_INFO, "Header storage disabled (exclude_headers contains #)");
            free(headers_copy);
            return;
        }
        
        if (*token != '\0') {
            exclude_headers[exclude_header_count] = strdup(token);
            if (exclude_headers[exclude_header_count] != NULL) {
                mosquitto_log_printf(MOSQ_LOG_INFO, "Excluding header: %s", exclude_headers[exclude_header_count]);
                exclude_header_count++;
            }
        }
        token = strtok(NULL, ",");
    }
    
    free(headers_copy);
}

// Check if a header name should be excluded
static int is_header_excluded(const char *header_name) {
    for (int i = 0; i < exclude_header_count; i++) {
        if (strcmp(exclude_headers[i], header_name) == 0) {
            return 1;
        }
    }
    return 0;
}

// Free header exclusion list
static void free_exclude_headers(void) {
    for (int i = 0; i < exclude_header_count; i++) {
        free(exclude_headers[i]);
        exclude_headers[i] = NULL;
    }
    exclude_header_count = 0;
}

// Returns unix epoch microseconds.
static unsigned long long platform_utime(int coarse)
{
	// CLOCK_REALTIME_COARSE has a resolution of 1ms, which is sufficient for this purpose. It's also much faster.
	struct timespec tv[1];
	clock_gettime(coarse ? CLOCK_REALTIME_COARSE : CLOCK_REALTIME, tv);
	return tv->tv_sec * 1000000ULL + tv->tv_nsec / 1000ULL;
}

// Gather entropy from the operating system. Returns 0 on success.
static int platform_entropy(void *buf, int len)
{
    return syscall(SYS_getrandom, buf, len, 0) != len;
}

int ulid_generator_init(struct ulid_generator *g, int flags)
{
    g->last_ts = 0;
    g->flags = flags;
    g->i = g->j = 0;
    for (int i = 0; i < 256; i++) {
        g->s[i] = i;
    }

    /* RC4 is used to fill the random segment of ULIDs. It's tiny,
     * simple, perfectly sufficient for the task (assuming it's seeded
     * properly), and doesn't require fixed-width integers. It's not the
     * fastest option, but it's plenty fast for the task.
     *
     * Besides, when we're in a serious hurry in normal operation (not
     * in "relaxed" mode), we're incrementing the random field much more
     * often than generating fresh random bytes.
     */

    int initstyle = 1;
    unsigned char key[256] = {0};
    if (!platform_entropy(key, 256)) {
        // Mix entropy into the RC4 state.
        for (int i = 0, j = 0; i < 256; i++) {
            j = (j + g->s[i] + key[i]) & 0xff;
            int tmp = g->s[i];
            g->s[i] = g->s[j];
            g->s[j] = tmp;
        }
        initstyle = 0;
    } else if (!(flags & ULID_SECURE)) {
        // Failed to read entropy from OS, so generate some.
        unsigned long n = 0;
        unsigned long long now;
        unsigned long long start = platform_utime(0);
        do {
            struct {
                clock_t clk;
                unsigned long long ts;
                long n;
                void *stackgap;
            } noise;
            noise.ts = now = platform_utime(0);
            noise.clk = clock();
            noise.stackgap = &noise;
            noise.n = n;
            unsigned char *k = (unsigned char *)&noise;
            for (int i = 0, j = 0; i < 256; i++) {
                j = (j + g->s[i] + k[i % sizeof(noise)]) & 0xff;
                int tmp = g->s[i];
                g->s[i] = g->s[j];
                g->s[j] = tmp;
            }
        } while (n++ < 1UL << 16 || now - start < 500000ULL);
    }
    return initstyle;
}

void ulid_encode(char str[27], const unsigned char ulid[16])
{
    static const char set[256] = {
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a,
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
        0x47, 0x48, 0x4a, 0x4b, 0x4d, 0x4e, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x56, 0x57, 0x58, 0x59, 0x5a
    };
    str[ 0] = set[ ulid[ 0] >> 5];
    str[ 1] = set[ ulid[ 0] >> 0];
    str[ 2] = set[ ulid[ 1] >> 3];
    str[ 3] = set[(ulid[ 1] << 2 | ulid[ 2] >> 6) & 0x1f];
    str[ 4] = set[ ulid[ 2] >> 1];
    str[ 5] = set[(ulid[ 2] << 4 | ulid[ 3] >> 4) & 0x1f];
    str[ 6] = set[(ulid[ 3] << 1 | ulid[ 4] >> 7) & 0x1f];
    str[ 7] = set[ ulid[ 4] >> 2];
    str[ 8] = set[(ulid[ 4] << 3 | ulid[ 5] >> 5) & 0x1f];
    str[ 9] = set[ ulid[ 5] >> 0];
    str[10] = set[ ulid[ 6] >> 3];
    str[11] = set[(ulid[ 6] << 2 | ulid[ 7] >> 6) & 0x1f];
    str[12] = set[ ulid[ 7] >> 1];
    str[13] = set[(ulid[ 7] << 4 | ulid[ 8] >> 4) & 0x1f];
    str[14] = set[(ulid[ 8] << 1 | ulid[ 9] >> 7) & 0x1f];
    str[15] = set[ ulid[ 9] >> 2];
    str[16] = set[(ulid[ 9] << 3 | ulid[10] >> 5) & 0x1f];
    str[17] = set[ ulid[10] >> 0];
    str[18] = set[ ulid[11] >> 3];
    str[19] = set[(ulid[11] << 2 | ulid[12] >> 6) & 0x1f];
    str[20] = set[ ulid[12] >> 1];
    str[21] = set[(ulid[12] << 4 | ulid[13] >> 4) & 0x1f];
    str[22] = set[(ulid[13] << 1 | ulid[14] >> 7) & 0x1f];
    str[23] = set[ ulid[14] >> 2];
    str[24] = set[(ulid[14] << 3 | ulid[15] >> 5) & 0x1f];
    str[25] = set[ ulid[15] >> 0];
    str[26] = 0;
}

int ulid_decode(unsigned char ulid[16], const char *s)
{
    static const signed char v[] = {
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x08, 0x09,   -1,   -1,   -1,   -1,   -1,   -1,
          -1, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x01, 0x12, 0x13, 0x01, 0x14, 0x15, 0x00,
        0x16, 0x17, 0x18, 0x19, 0x1a,   -1, 0x1b, 0x1c,
        0x1d, 0x1e, 0x1f,   -1,   -1,   -1,   -1,   -1,
          -1, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x01, 0x12, 0x13, 0x01, 0x14, 0x15, 0x00,
        0x16, 0x17, 0x18, 0x19, 0x1a,   -1, 0x1b, 0x1c,
        0x1d, 0x1e, 0x1f,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1,
          -1,   -1,   -1,   -1,   -1,   -1,   -1,   -1
    };
    if (v[(int)s[0]] > 7)
        return 1;
    for (int i = 0; i < 26; i++)
        if (v[(int)s[i]] == -1)
            return 2;
    ulid[ 0] = v[(int)s[ 0]] << 5 | v[(int)s[ 1]] >> 0;
    ulid[ 1] = v[(int)s[ 2]] << 3 | v[(int)s[ 3]] >> 2;
    ulid[ 2] = v[(int)s[ 3]] << 6 | v[(int)s[ 4]] << 1 | v[(int)s[ 5]] >> 4;
    ulid[ 3] = v[(int)s[ 5]] << 4 | v[(int)s[ 6]] >> 1;
    ulid[ 4] = v[(int)s[ 6]] << 7 | v[(int)s[ 7]] << 2 | v[(int)s[ 8]] >> 3;
    ulid[ 5] = v[(int)s[ 8]] << 5 | v[(int)s[ 9]] >> 0;
    ulid[ 6] = v[(int)s[10]] << 3 | v[(int)s[11]] >> 2;
    ulid[ 7] = v[(int)s[11]] << 6 | v[(int)s[12]] << 1 | v[(int)s[13]] >> 4;
    ulid[ 8] = v[(int)s[13]] << 4 | v[(int)s[14]] >> 1;
    ulid[ 9] = v[(int)s[14]] << 7 | v[(int)s[15]] << 2 | v[(int)s[16]] >> 3;
    ulid[10] = v[(int)s[16]] << 5 | v[(int)s[17]] >> 0;
    ulid[11] = v[(int)s[18]] << 3 | v[(int)s[19]] >> 2;
    ulid[12] = v[(int)s[19]] << 6 | v[(int)s[20]] << 1 | v[(int)s[21]] >> 4;
    ulid[13] = v[(int)s[21]] << 4 | v[(int)s[22]] >> 1;
    ulid[14] = v[(int)s[22]] << 7 | v[(int)s[23]] << 2 | v[(int)s[24]] >> 3;
    ulid[15] = v[(int)s[24]] << 5 | v[(int)s[25]] >> 0;
    return 0;
}

unsigned long long ulid_generate(struct ulid_generator *g, char str[27])
{
    unsigned long long ts = platform_utime(1) / 1000;

    if (!(g->flags & ULID_RELAXED) && g->last_ts == ts) {
        // Chance of 80-bit overflow is so small that it's not considered.
        for (int i = 15; i > 5; i--) {
            if (++g->last[i]) {
                break;
            }
        }
        ulid_encode(str, g->last);

        return ts;
    }

    // Fill out timestamp.
    g->last_ts = ts;
    g->last[0] = ts >> 40;
    g->last[1] = ts >> 32;
    g->last[2] = ts >> 24;
    g->last[3] = ts >> 16;
    g->last[4] = ts >>  8;
    g->last[5] = ts >>  0;

    // Fill out random section.
    for (int k = 0; k < 10; k++) {
        g->i = (g->i + 1) & 0xff;
        g->j = (g->j + g->s[g->i]) & 0xff;
        int tmp = g->s[g->i];
        g->s[g->i] = g->s[g->j];
        g->s[g->j] = tmp;
        g->last[6 + k] = g->s[(g->s[g->i] + g->s[g->j]) & 0xff];
    }

    if (g->flags & ULID_PARANOID) {
        g->last[6] &= 0x7f;
    }

    ulid_encode(str, g->last);

    return ts;
}

// Enqueue a message for batch insert
static void enqueue_message(const char *ulid, const char *topic, const char *payload, 
                           size_t payloadlen, const char *headers, int retain, int qos) {
    struct msg_entry *entry = malloc(sizeof(struct msg_entry));
    if (entry == NULL) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to allocate message entry");
        return;
    }
    
    entry->operation = OP_INSERT;
    memcpy(entry->ulid, ulid, 27);
    entry->topic = strdup(topic);
    entry->payload = strndup(payload, payloadlen);
    entry->headers = headers ? strdup(headers) : NULL;
    entry->retain = retain;
    entry->qos = qos;
    entry->next = NULL;
    
    if (entry->topic == NULL || entry->payload == NULL) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to allocate message strings");
        free(entry->topic);
        free(entry->payload);
        free(entry->headers);
        free(entry);
        return;
    }
    
    pthread_mutex_lock(&queue_mutex);
    
    // Add to queue
    if (msg_queue_tail == NULL) {
        msg_queue_head = msg_queue_tail = entry;
    } else {
        msg_queue_tail->next = entry;
        msg_queue_tail = entry;
    }
    msg_queue_size++;
    
    // Signal the batch worker if queue is getting full
    if (msg_queue_size >= batch_size) {
        pthread_cond_signal(&queue_cond);
    }
    
    pthread_mutex_unlock(&queue_mutex);
}

// Enqueue a delete operation for batch processing
// If ulid is NULL, will delete the most recent message for the topic
static void enqueue_delete(const char *topic, const char *ulid) {
    struct msg_entry *entry = malloc(sizeof(struct msg_entry));
    if (entry == NULL) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to allocate delete entry");
        return;
    }
    
    if (ulid != NULL) {
        entry->operation = OP_DELETE;
        memcpy(entry->ulid, ulid, 27);
    } else {
        entry->operation = OP_DELETE_FALLBACK;
        entry->ulid[0] = '\0';
    }
    entry->topic = strdup(topic);
    entry->payload = NULL;
    entry->headers = NULL;
    entry->retain = 0;
    entry->qos = 0;
    entry->next = NULL;
    
    if (entry->topic == NULL) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to allocate delete topic string");
        free(entry);
        return;
    }
    
    pthread_mutex_lock(&queue_mutex);
    
    // Add to queue
    if (msg_queue_tail == NULL) {
        msg_queue_head = msg_queue_tail = entry;
    } else {
        msg_queue_tail->next = entry;
        msg_queue_tail = entry;
    }
    msg_queue_size++;
    
    // Signal the batch worker immediately for delete operations
    pthread_cond_signal(&queue_cond);
    
    pthread_mutex_unlock(&queue_mutex);
}

// Flush queued messages to database as a batch
static void flush_batch(void) {
    struct msg_entry *batch_head = NULL;
    int batch_count = 0;
    
    pthread_mutex_lock(&queue_mutex);
    if (msg_queue_size == 0) {
        pthread_mutex_unlock(&queue_mutex);
        return;
    }
    
    // Take all messages from queue
    batch_head = msg_queue_head;
    batch_count = msg_queue_size;
    msg_queue_head = msg_queue_tail = NULL;
    msg_queue_size = 0;
    pthread_mutex_unlock(&queue_mutex);
    
    if (batch_count == 0 || msg_db == NULL) {
        return;
    }
    
    // Begin transaction for batch operations
    char *err_msg = NULL;
    int rc = sqlite3_exec(msg_db, "BEGIN TRANSACTION", NULL, NULL, &err_msg);
    if (rc != SQLITE_OK) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to begin transaction: %s", err_msg);
        sqlite3_free(err_msg);
        // Fall through and try individual operations anyway
    }
    
    // Process all entries in batch
    struct msg_entry *entry = batch_head;
    int insert_count = 0;
    int delete_count = 0;
    while (entry != NULL) {
        if (entry->operation == OP_INSERT) {
            // Insert operation
            if (insert_stmt != NULL) {
                sqlite3_bind_text(insert_stmt, 1, entry->ulid, -1, SQLITE_STATIC);
                sqlite3_bind_text(insert_stmt, 2, entry->topic, -1, SQLITE_STATIC);
                sqlite3_bind_text(insert_stmt, 3, entry->payload, -1, SQLITE_STATIC);
                sqlite3_bind_int(insert_stmt, 4, entry->retain);
                sqlite3_bind_int(insert_stmt, 5, entry->qos);
                if (entry->headers) {
                    sqlite3_bind_text(insert_stmt, 6, entry->headers, -1, SQLITE_STATIC);
                } else {
                    sqlite3_bind_null(insert_stmt, 6);
                }
                
                rc = sqlite3_step(insert_stmt);
                if (rc == SQLITE_DONE) {
                    insert_count++;
                } else {
                    mosquitto_log_printf(MOSQ_LOG_ERR, "Batch insert failed for topic %s: %s", 
                                       entry->topic, sqlite3_errmsg(msg_db));
                }
                sqlite3_reset(insert_stmt);
            }
        } else if (entry->operation == OP_DELETE) {
            // Delete with specific ULID
            if (delete_stmt != NULL) {
                sqlite3_bind_text(delete_stmt, 1, entry->topic, -1, SQLITE_STATIC);
                sqlite3_bind_text(delete_stmt, 2, entry->ulid, -1, SQLITE_STATIC);
                
                rc = sqlite3_step(delete_stmt);
                if (rc == SQLITE_DONE) {
                    int changes = sqlite3_changes(msg_db);
                    if (changes > 0) {
                        delete_count++;
                        mosquitto_log_printf(MOSQ_LOG_INFO, "Deleted message for topic: %s (ulid: %s)", 
                                            entry->topic, entry->ulid);
                    }
                } else {
                    mosquitto_log_printf(MOSQ_LOG_ERR, "Delete failed for topic %s: %s", 
                                       entry->topic, sqlite3_errmsg(msg_db));
                }
                sqlite3_reset(delete_stmt);
            }
        } else if (entry->operation == OP_DELETE_FALLBACK) {
            // Delete most recent message for topic (fallback when no ULID provided)
            sqlite3_stmt *find_stmt = NULL;
            rc = sqlite3_prepare_v2(msg_db,
                "SELECT ulid FROM msg WHERE topic = ?1 ORDER BY ulid DESC LIMIT 1",
                -1, &find_stmt, 0);
            if (rc == SQLITE_OK) {
                sqlite3_bind_text(find_stmt, 1, entry->topic, -1, SQLITE_STATIC);
                if (sqlite3_step(find_stmt) == SQLITE_ROW) {
                    const char *found_ulid = (const char *)sqlite3_column_text(find_stmt, 0);
                    if (delete_stmt != NULL && found_ulid != NULL) {
                        sqlite3_bind_text(delete_stmt, 1, entry->topic, -1, SQLITE_STATIC);
                        sqlite3_bind_text(delete_stmt, 2, found_ulid, -1, SQLITE_TRANSIENT);
                        
                        rc = sqlite3_step(delete_stmt);
                        if (rc == SQLITE_DONE && sqlite3_changes(msg_db) > 0) {
                            delete_count++;
                            mosquitto_log_printf(MOSQ_LOG_INFO, "Deleted most recent message for topic: %s (ulid: %s)", 
                                                entry->topic, found_ulid);
                        }
                        sqlite3_reset(delete_stmt);
                    }
                } else {
                    mosquitto_log_printf(MOSQ_LOG_WARNING, "No message found to delete for topic: %s", entry->topic);
                }
                sqlite3_finalize(find_stmt);
            }
        }
        
        entry = entry->next;
    }
    
    // Commit transaction
    rc = sqlite3_exec(msg_db, "COMMIT", NULL, NULL, &err_msg);
    if (rc != SQLITE_OK) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to commit transaction: %s", err_msg);
        sqlite3_free(err_msg);
    }
    
    if (insert_count > 0 || delete_count > 0) {
        mosquitto_log_printf(MOSQ_LOG_DEBUG, "Batch: %d inserts, %d deletes committed", 
                            insert_count, delete_count);
    }
    
    // Free batch entries
    entry = batch_head;
    while (entry != NULL) {
        struct msg_entry *next = entry->next;
        free(entry->topic);
        free(entry->payload);
        free(entry->headers);
        free(entry);
        entry = next;
    }
}

// Generate ULID prefix (first 10 chars) from timestamp in milliseconds
// Used for time-based queries since ULIDs are lexicographically sortable by time
static void timestamp_to_ulid_prefix(unsigned long long ts_ms, char prefix[11]) {
    static const char set[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    
    // ULID timestamp is stored in first 6 bytes (48 bits), encoded as 10 base32 chars
    unsigned char bytes[6];
    bytes[0] = ts_ms >> 40;
    bytes[1] = ts_ms >> 32;
    bytes[2] = ts_ms >> 24;
    bytes[3] = ts_ms >> 16;
    bytes[4] = ts_ms >> 8;
    bytes[5] = ts_ms >> 0;
    
    // Encode to base32 (same as ulid_encode but only first 10 chars)
    prefix[0] = set[bytes[0] >> 5];
    prefix[1] = set[bytes[0] & 0x1f];
    prefix[2] = set[bytes[1] >> 3];
    prefix[3] = set[(bytes[1] << 2 | bytes[2] >> 6) & 0x1f];
    prefix[4] = set[(bytes[2] >> 1) & 0x1f];
    prefix[5] = set[(bytes[2] << 4 | bytes[3] >> 4) & 0x1f];
    prefix[6] = set[(bytes[3] << 1 | bytes[4] >> 7) & 0x1f];
    prefix[7] = set[(bytes[4] >> 2) & 0x1f];
    prefix[8] = set[(bytes[4] << 3 | bytes[5] >> 5) & 0x1f];
    prefix[9] = set[bytes[5] & 0x1f];
    prefix[10] = '\0';
}

// Delete messages older than retention_days
// Uses ULID prefix comparison for efficient deletion (ULIDs are lexicographically sortable)
static void cleanup_old_messages(void) {
    if (retention_days <= 0 || msg_db == NULL) {
        return;
    }
    
    time_t now = time(NULL);
    
    // Only run cleanup periodically (every RETENTION_CHECK_INTERVAL_SEC)
    if (now - last_retention_check < RETENTION_CHECK_INTERVAL_SEC) {
        return;
    }
    last_retention_check = now;
    
    // Calculate cutoff timestamp in milliseconds
    unsigned long long cutoff_ms = ((unsigned long long)now - (retention_days * 24 * 60 * 60)) * 1000ULL;
    
    // Generate ULID prefix for cutoff time
    char cutoff_prefix[11];
    timestamp_to_ulid_prefix(cutoff_ms, cutoff_prefix);
    
    char sql[256];
    snprintf(sql, sizeof(sql), "DELETE FROM msg WHERE ulid < '%s'", cutoff_prefix);
    
    char *err_msg = NULL;
    int rc = sqlite3_exec(msg_db, sql, NULL, NULL, &err_msg);
    if (rc != SQLITE_OK) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Retention cleanup failed: %s", err_msg);
        sqlite3_free(err_msg);
    } else {
        int deleted = sqlite3_changes(msg_db);
        if (deleted > 0) {
            mosquitto_log_printf(MOSQ_LOG_INFO, "Retention cleanup: deleted %d messages older than %d days", 
                                deleted, retention_days);
        }
    }
}

// Background worker thread for batch processing
static void *batch_worker(void *arg) {
    UNUSED(arg);
    
    struct timespec timeout;
    
    mosquitto_log_printf(MOSQ_LOG_INFO, "Batch worker thread started");
    
    while (atomic_load(&batch_thread_running)) {
        pthread_mutex_lock(&queue_mutex);
        
        // Wait for either: queue size threshold or timeout
        clock_gettime(CLOCK_REALTIME, &timeout);
        timeout.tv_nsec += flush_interval_ms * 1000000L;
        if (timeout.tv_nsec >= 1000000000L) {
            timeout.tv_sec++;
            timeout.tv_nsec -= 1000000000L;
        }
        
        // Wait with timeout - will wake up on signal or timeout
        while (msg_queue_size < batch_size && atomic_load(&batch_thread_running)) {
            int rc = pthread_cond_timedwait(&queue_cond, &queue_mutex, &timeout);
            if (rc == ETIMEDOUT) {
                break;  // Timeout - flush whatever we have
            }
        }
        
        pthread_mutex_unlock(&queue_mutex);
        
        // Flush accumulated messages
        if (atomic_load(&batch_thread_running) || msg_queue_size > 0) {
            flush_batch();
        }
        
        // Periodically cleanup old messages (if retention is enabled)
        if (atomic_load(&batch_thread_running)) {
            cleanup_old_messages();
        }
    }
    
    // Final flush on shutdown
    flush_batch();
    
    mosquitto_log_printf(MOSQ_LOG_INFO, "Batch worker thread stopped");
    return NULL;
}

// Extract user properties from message and format as semicolon-separated key=value string
// Excludes headers in the exclude_headers list
// Returns allocated string or NULL if no headers. Caller must free.
static char *extract_headers(const mosquitto_property *properties) {
    // If header storage is completely disabled, return NULL
    if (headers_disabled) {
        return NULL;
    }
    
    if (properties == NULL) {
        return NULL;
    }
    
    // First pass: calculate required buffer size
    size_t total_len = 0;
    int header_count = 0;
    const mosquitto_property *prop = properties;
    char *prop_name = NULL;
    char *prop_value = NULL;
    bool skip_first = false;
    
    while ((prop = mosquitto_property_read_string_pair(prop, MQTT_PROP_USER_PROPERTY, 
                                                       &prop_name, &prop_value, skip_first)) != NULL) {
        if (prop_name != NULL && prop_value != NULL && !is_header_excluded(prop_name)) {
            // key=value; format (add 2 for '=' and ';')
            total_len += strlen(prop_name) + strlen(prop_value) + 2;
            header_count++;
        }
        if (prop_name) { free(prop_name); prop_name = NULL; }
        if (prop_value) { free(prop_value); prop_value = NULL; }
        skip_first = true;
    }
    
    if (header_count == 0) {
        return NULL;
    }
    
    // Allocate buffer (total_len already includes space for separators, just need null terminator)
    char *headers = malloc(total_len + 1);
    if (headers == NULL) {
        return NULL;
    }
    headers[0] = '\0';
    
    // Second pass: build the header string
    prop = properties;
    skip_first = false;
    int current = 0;
    
    while ((prop = mosquitto_property_read_string_pair(prop, MQTT_PROP_USER_PROPERTY, 
                                                       &prop_name, &prop_value, skip_first)) != NULL) {
        if (prop_name != NULL && prop_value != NULL && !is_header_excluded(prop_name)) {
            if (current > 0) {
                strcat(headers, ";");
            }
            strcat(headers, prop_name);
            strcat(headers, "=");
            strcat(headers, prop_value);
            current++;
        }
        if (prop_name) { free(prop_name); prop_name = NULL; }
        if (prop_value) { free(prop_value); prop_value = NULL; }
        skip_first = true;
    }
    
    return headers;
}

static int on_message_callback(int event, void *event_data, void *userdata) {
	struct mosquitto_evt_message *ed = event_data;

	UNUSED(event);
	UNUSED(userdata);

	char ulid[27];
    
    // Thread-safe ULID generation
    pthread_mutex_lock(&ulid_mutex);
    ulid_generate(&ulid_gen, ulid);
    pthread_mutex_unlock(&ulid_mutex);

    // Check if topic should be excluded from persistence
    if (is_topic_excluded(ed->topic)) {
        mosquitto_log_printf(MOSQ_LOG_DEBUG, "Excluded topic from persistence: %s", ed->topic);
        // Still add ULID property but don't store in database
        return mosquitto_property_add_string_pair(&ed->properties, MQTT_PROP_USER_PROPERTY, "ulid", ulid);
    }

    // Check if this is a delete operation (empty retained message)
    if (ed->retain && ed->payloadlen == 0) {
        // Try to extract ULID from incoming message properties
        char *prop_name = NULL;
        char *prop_value = NULL;
        char *target_ulid = NULL;
        const mosquitto_property *prop = ed->properties;
        bool skip_first = false;
        
        // Iterate through user properties to find "ulid"
        while ((prop = mosquitto_property_read_string_pair(prop, MQTT_PROP_USER_PROPERTY, 
                                                           &prop_name, &prop_value, skip_first)) != NULL) {
            if (prop_name != NULL && strcmp(prop_name, "ulid") == 0 && prop_value != NULL) {
                target_ulid = strdup(prop_value);
                mosquitto_log_printf(MOSQ_LOG_DEBUG, "Found ULID in properties: %s", target_ulid);
            }
            // Free the strings allocated by mosquitto_property_read_string_pair
            if (prop_name) { free(prop_name); prop_name = NULL; }
            if (prop_value) { free(prop_value); prop_value = NULL; }
            
            if (target_ulid != NULL) break;  // Found what we need
            
            // For next iteration, skip the property we just read
            skip_first = true;
        }
        
        // Queue the delete operation (thread-safe, processed by batch worker)
        if (atomic_load(&batch_thread_running)) {
            if (target_ulid != NULL) {
                enqueue_delete(ed->topic, target_ulid);
                mosquitto_log_printf(MOSQ_LOG_DEBUG, "Enqueued delete: topic=%s ulid=%s", ed->topic, target_ulid);
                free(target_ulid);
            } else {
                // No ULID provided, queue fallback delete (most recent)
                enqueue_delete(ed->topic, NULL);
                mosquitto_log_printf(MOSQ_LOG_DEBUG, "Enqueued fallback delete: topic=%s", ed->topic);
            }
        }
        
        // Still add ULID property for consistency
        return mosquitto_property_add_string_pair(&ed->properties, MQTT_PROP_USER_PROPERTY, "ulid", ulid);
    }

    // Extract headers from message properties (excludes configured headers)
    char *headers = extract_headers(ed->properties);

    // Enqueue message for batch insert (non-blocking)
    if (atomic_load(&batch_thread_running)) {
        enqueue_message(ulid, ed->topic, (char *)ed->payload, ed->payloadlen,
                        headers, ed->retain ? 1 : 0, ed->qos);
        mosquitto_log_printf(MOSQ_LOG_DEBUG, "Enqueued: topic=%s retain=%d qos=%d headers=%s", 
                            ed->topic, ed->retain, ed->qos, headers ? headers : "(none)");
    }

    free(headers);

    return mosquitto_property_add_string_pair(&ed->properties, MQTT_PROP_USER_PROPERTY, "ulid", ulid);
}

int mosquitto_plugin_version(int supported_version_count, const int *supported_versions)
{
	int i;
	for (i=0; i<supported_version_count; i++) {
		if (supported_versions[i] == 5) {
			return 5;
		}
	}
	return -1;
}

int mosquitto_plugin_init(mosquitto_plugin_id_t *identifier, void **user_data, struct mosquitto_opt *opts, int opt_count)
{
	UNUSED(user_data);

    // Parse plugin options
    for (int i = 0; i < opt_count; i++) {
        if (strcmp(opts[i].key, "exclude_topics") == 0) {
            parse_exclude_patterns(opts[i].value);
        } else if (strcmp(opts[i].key, "batch_size") == 0) {
            int val = atoi(opts[i].value);
            if (val > 0 && val <= MAX_QUEUE_SIZE) {
                batch_size = val;
                mosquitto_log_printf(MOSQ_LOG_INFO, "Batch size set to: %d", batch_size);
            }
        } else if (strcmp(opts[i].key, "flush_interval") == 0) {
            int val = atoi(opts[i].value);
            if (val > 0 && val <= 10000) {
                flush_interval_ms = val;
                mosquitto_log_printf(MOSQ_LOG_INFO, "Flush interval set to: %dms", flush_interval_ms);
            }
        } else if (strcmp(opts[i].key, "retention_days") == 0) {
            int val = atoi(opts[i].value);
            if (val >= 0 && val <= 3650) {  // Max 10 years
                retention_days = val;
                if (retention_days > 0) {
                    mosquitto_log_printf(MOSQ_LOG_INFO, "Data retention set to: %d days", retention_days);
                } else {
                    mosquitto_log_printf(MOSQ_LOG_INFO, "Data retention disabled (keeping all messages)");
                }
            }
        } else if (strcmp(opts[i].key, "exclude_headers") == 0) {
            parse_exclude_headers(opts[i].value);
        }
    }

    int rc = sqlite3_open("/mosquitto/data/dbs/default/data", &msg_db);
    if (rc) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Can't open database: %s\n", sqlite3_errmsg(msg_db));
		sqlite3_close(msg_db);
	} else {
        mosquitto_log_printf(MOSQ_LOG_INFO, "Opened database: /mosquitto/data/dbs/default/data");

		char *err_msg = 0;
		const char *sql = "create table if not exists msg(ulid text primary key, topic text not null, payload text not null, retain integer not null default 0, qos integer not null default 0, headers text);";
		rc = sqlite3_exec(msg_db, sql, NULL, 0, &err_msg);
		if (rc != SQLITE_OK) {
            mosquitto_log_printf(MOSQ_LOG_ERR, "SQL error: %s", err_msg);
			sqlite3_free(err_msg);
		} else {
            // Create index on topic for faster topic-based queries
            const char *idx_topic_sql = "CREATE INDEX IF NOT EXISTS idx_msg_topic ON msg(topic);";
            rc = sqlite3_exec(msg_db, idx_topic_sql, NULL, 0, &err_msg);
            if (rc != SQLITE_OK) {
                mosquitto_log_printf(MOSQ_LOG_WARNING, "Failed to create topic index: %s", err_msg);
                sqlite3_free(err_msg);
            } else {
                mosquitto_log_printf(MOSQ_LOG_INFO, "Index on topic column ensured");
            }
            
    		rc = sqlite3_prepare_v2(msg_db, "insert into msg (ulid, topic, payload, retain, qos, headers) values (?1, ?2, ?3, ?4, ?5, ?6)", -1, &insert_stmt, 0);
    		if (rc != SQLITE_OK) {
                mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to prepare insert data statement: %s", sqlite3_errmsg(msg_db));
			}

            // Prepare delete statement for clearing retained messages
            // Deletes by topic AND ulid when ULID is known from message properties
            rc = sqlite3_prepare_v2(msg_db, 
                "DELETE FROM msg WHERE topic = ?1 AND ulid = ?2", 
                -1, &delete_stmt, 0);
            if (rc != SQLITE_OK) {
                mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to prepare delete statement: %s", sqlite3_errmsg(msg_db));
            }
		}
	}

	if (ulid_generator_init(&ulid_gen, ULID_PARANOID) != 0) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to init ULID generator");
    }

    // Start batch worker thread
    atomic_store(&batch_thread_running, 1);
    if (pthread_create(&batch_thread, NULL, batch_worker, NULL) != 0) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to create batch worker thread");
        atomic_store(&batch_thread_running, 0);
    } else {
        mosquitto_log_printf(MOSQ_LOG_INFO, "Batch insert enabled: size=%d, interval=%dms", 
                            batch_size, flush_interval_ms);
    }

	mosq_pid = identifier;
	return mosquitto_callback_register(mosq_pid, MOSQ_EVT_MESSAGE, on_message_callback, NULL, NULL);
}

int mosquitto_plugin_cleanup(void *user_data, struct mosquitto_opt *opts, int opt_count)
{
	UNUSED(user_data);
	UNUSED(opts);
	UNUSED(opt_count);

    // Stop batch worker thread
    if (atomic_load(&batch_thread_running)) {
        atomic_store(&batch_thread_running, 0);
        pthread_cond_signal(&queue_cond);  // Wake up the thread
        pthread_join(batch_thread, NULL);
    }

    // Free exclusion patterns
    free_exclude_patterns();
    free_exclude_headers();

	if (insert_stmt != NULL) {
		sqlite3_finalize(insert_stmt);
	}

    if (delete_stmt != NULL) {
        sqlite3_finalize(delete_stmt);
    }

	if (msg_db != NULL) {
		sqlite3_close(msg_db);
	}

	return mosquitto_callback_unregister(mosq_pid, MOSQ_EVT_MESSAGE, on_message_callback, NULL);
}
