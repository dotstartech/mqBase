#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <sys/syscall.h>
#include <unistd.h>

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
static sqlite3_stmt *stmt = NULL;

// Topic exclusion patterns
static char *exclude_patterns[MAX_EXCLUDE_PATTERNS];
static int exclude_pattern_count = 0;

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

static int on_message_callback(int event, void *event_data, void *userdata) {
	struct mosquitto_evt_message *ed = event_data;

	UNUSED(event);
	UNUSED(userdata);

	char ulid[27];
    unsigned long long usEpoch = ulid_generate(&ulid_gen, ulid);
    long int msEpoch = usEpoch / 1000ULL;

    // Check if topic should be excluded from persistence
    if (is_topic_excluded(ed->topic)) {
        mosquitto_log_printf(MOSQ_LOG_DEBUG, "Excluded topic from persistence: %s", ed->topic);
        // Still add ULID property but don't store in database
        return mosquitto_property_add_string_pair(&ed->properties, MQTT_PROP_USER_PROPERTY, "ulid", ulid);
    }

    if(stmt != NULL) {
		sqlite3_bind_text(stmt, 1, ulid, -1, SQLITE_STATIC);
        
		char *topic = strdup(ed->topic);
		sqlite3_bind_text(stmt, 2, topic, -1, SQLITE_STATIC);
		
		char *payload = strndup((char *)ed->payload, ed->payloadlen);
    	sqlite3_bind_text(stmt, 3, payload, -1, SQLITE_STATIC);

        sqlite3_bind_int64(stmt, 4, (sqlite3_int64)msEpoch);
    	
		sqlite3_step(stmt);
    	sqlite3_reset(stmt);

        mosquitto_log_printf(MOSQ_LOG_DEBUG, "Stored event: topic=%s with payload=%s", topic, payload);

        free(topic);
        free(payload);
    }

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
        }
    }

    int rc = sqlite3_open("/mosquitto/data/dbs/default/data", &msg_db);
    if (rc) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Can't open database: %s\n", sqlite3_errmsg(msg_db));
		sqlite3_close(msg_db);
	} else {
        mosquitto_log_printf(MOSQ_LOG_INFO, "Opened database: /mosquitto/data/dbs/default/data");

		char *err_msg = 0;
		const char *sql = "create table if not exists msg(ulid text primary key, topic text not null, payload text not null, timestamp integer not null);";
		rc = sqlite3_exec(msg_db, sql, NULL, 0, &err_msg);
		if (rc != SQLITE_OK) {
            mosquitto_log_printf(MOSQ_LOG_ERR, "SQL error: %s", err_msg);
			sqlite3_free(err_msg);
		} else {
    		rc = sqlite3_prepare_v2(msg_db, "insert into msg (ulid, topic, payload, timestamp) values (?1, ?2, ?3, ?4)", -1, &stmt, 0);
    		if (rc != SQLITE_OK) {
                mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to prepare insert data statement: %s", sqlite3_errmsg(msg_db));
			}
		}
	}

	if (ulid_generator_init(&ulid_gen, ULID_PARANOID) != 0) {
        mosquitto_log_printf(MOSQ_LOG_ERR, "Failed to init ULID generator");
    }

	mosq_pid = identifier;
	return mosquitto_callback_register(mosq_pid, MOSQ_EVT_MESSAGE, on_message_callback, NULL, NULL);
}

int mosquitto_plugin_cleanup(void *user_data, struct mosquitto_opt *opts, int opt_count)
{
	UNUSED(user_data);
	UNUSED(opts);
	UNUSED(opt_count);

    // Free exclusion patterns
    free_exclude_patterns();

	if (stmt != NULL) {
		sqlite3_finalize(stmt);
	}

	if (msg_db != NULL) {
		sqlite3_close(msg_db);
	}

	return mosquitto_callback_unregister(mosq_pid, MOSQ_EVT_MESSAGE, on_message_callback, NULL);
}
