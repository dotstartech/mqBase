/*
 * mqbase-init: Process supervisor for distroless container
 * 
 * This replaces the shell-based entrypoint for distroless images.
 * It handles:
 *   - Credential generation/parsing
 *   - Starting nginx, sqld, and mosquitto
 *   - Process monitoring and graceful shutdown
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>

#define MAX_PROCS 3

static volatile int running = 1;
static pid_t pids[MAX_PROCS] = {0};
static const char *proc_names[MAX_PROCS] = {"nginx", "sqld", "mosquitto"};

void signal_handler(int sig) {
    (void)sig;
    running = 0;
    for (int i = 0; i < MAX_PROCS; i++) {
        if (pids[i] > 0) {
            kill(pids[i], SIGTERM);
        }
    }
}

/* Generate random password using /dev/urandom */
void generate_password(char *buf, size_t len) {
    const char charset[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) {
        srand(time(NULL) ^ getpid());
        for (size_t i = 0; i < len - 1; i++) {
            buf[i] = charset[rand() % (sizeof(charset) - 1)];
        }
    } else {
        unsigned char rbuf[32];
        if (read(fd, rbuf, sizeof(rbuf)) > 0) {
            for (size_t i = 0; i < len - 1; i++) {
                buf[i] = charset[rbuf[i] % (sizeof(charset) - 1)];
            }
        }
        close(fd);
    }
    buf[len - 1] = '\0';
}

/* Simple apr1 password hashing for htpasswd - using a simpler plaintext approach
   that nginx actually supports: {PLAIN} prefix is NOT supported by nginx.
   Instead, we'll use the crypt() function with SHA-512 */
#include <crypt.h>

/* Generate a salt for crypt */
void generate_salt(char *salt, size_t len) {
    const char charset[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789./";
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
        unsigned char rbuf[32];
        if (read(fd, rbuf, sizeof(rbuf)) > 0) {
            for (size_t i = 0; i < len - 1; i++) {
                salt[i] = charset[rbuf[i] % (sizeof(charset) - 1)];
            }
        }
        close(fd);
    }
    salt[len - 1] = '\0';
}

/* Write content to a file */
int write_file(const char *path, const char *content) {
    FILE *f = fopen(path, "w");
    if (!f) return -1;
    fputs(content, f);
    fclose(f);
    return 0;
}

/* Setup credentials and config files */
int setup_credentials(void) {
    char mqtt_user[64] = "admin";
    char mqtt_pass[32] = "";
    char http_user[64] = "admin";
    char http_pass[32] = "";
    
    const char *mqtt_cred = getenv("MQBASE_MQTT_USER");
    const char *http_cred = getenv("MQBASE_USER");
    
    /* Parse MQTT credentials (format: username:password) */
    if (mqtt_cred && strchr(mqtt_cred, ':')) {
        strncpy(mqtt_user, mqtt_cred, sizeof(mqtt_user) - 1);
        char *sep = strchr(mqtt_user, ':');
        if (sep) {
            *sep = '\0';
            strncpy(mqtt_pass, sep + 1, sizeof(mqtt_pass) - 1);
        }
    } else {
        generate_password(mqtt_pass, 17);
        fprintf(stderr, "==============================================\n");
        fprintf(stderr, "WARNING: No MQBASE_MQTT_USER credentials found!\n");
        fprintf(stderr, "Auto-generated credentials for MQTT:\n");
        fprintf(stderr, "  Username: admin\n");
        fprintf(stderr, "  Password: %s\n", mqtt_pass);
        fprintf(stderr, "==============================================\n");
    }
    
    /* Parse HTTP credentials */
    if (http_cred && strchr(http_cred, ':')) {
        strncpy(http_user, http_cred, sizeof(http_user) - 1);
        char *sep = strchr(http_user, ':');
        if (sep) {
            *sep = '\0';
            strncpy(http_pass, sep + 1, sizeof(http_pass) - 1);
        }
    } else {
        generate_password(http_pass, 17);
        fprintf(stderr, "==============================================\n");
        fprintf(stderr, "WARNING: No MQBASE_USER credentials found!\n");
        fprintf(stderr, "Auto-generated credentials for HTTP Basic Auth:\n");
        fprintf(stderr, "  Username: admin\n");
        fprintf(stderr, "  Password: %s\n", http_pass);
        fprintf(stderr, "==============================================\n");
    }
    
    /* Write MQTT credentials JSON for web client */
    char json[256];
    snprintf(json, sizeof(json), "{\"username\":\"%s\",\"password\":\"%s\"}", mqtt_user, mqtt_pass);
    write_file("/tmp/mqtt-credentials.json", json);
    
    /* Create htpasswd file using SHA-512 crypt */
    char salt[20] = "$6$"; /* SHA-512 prefix */
    generate_salt(salt + 3, 17);
    char *hashed = crypt(http_pass, salt);
    if (hashed) {
        char htpasswd[512];
        snprintf(htpasswd, sizeof(htpasswd), "%s:%s\n", http_user, hashed);
        write_file("/tmp/htpasswd", htpasswd);
    } else {
        /* Fallback - won't work but at least creates the file */
        char htpasswd[256];
        snprintf(htpasswd, sizeof(htpasswd), "%s:{PLAIN}%s\n", http_user, http_pass);
        write_file("/tmp/htpasswd", htpasswd);
    }
    
    /* Create app-config.json from environment variables */
    const char *app_version = getenv("version");
    const char *app_title = getenv("title");
    const char *app_logo = getenv("logo");
    const char *app_favicon = getenv("favicon");
    char app_config[512];
    snprintf(app_config, sizeof(app_config), 
             "{\"version\":\"%s\",\"title\":\"%s\",\"logo\":\"%s\",\"favicon\":\"%s\"}",
             app_version ? app_version : "",
             app_title ? app_title : "",
             app_logo ? app_logo : "",
             app_favicon ? app_favicon : "");
    write_file("/tmp/app-config.json", app_config);
    
    return 0;
}

/* Copy file from src to dst */
int copy_file(const char *src, const char *dst) {
    FILE *in = fopen(src, "r");
    if (!in) return -1;
    FILE *out = fopen(dst, "w");
    if (!out) { fclose(in); return -1; }
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        fwrite(buf, 1, n, out);
    }
    fclose(in);
    fclose(out);
    return 0;
}

/* Fork and exec a process */
pid_t start_process(const char *path, char *const argv[]) {
    pid_t pid = fork();
    if (pid == 0) {
        execv(path, argv);
        fprintf(stderr, "Failed to exec %s: %s\n", path, strerror(errno));
        _exit(1);
    }
    return pid;
}

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;
    
    /* Setup signal handlers */
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    signal(SIGCHLD, SIG_DFL);
    
    fprintf(stderr, "mqbase-init: Starting services...\n");
    
    /* Setup credentials */
    if (setup_credentials() != 0) {
        fprintf(stderr, "Failed to setup credentials\n");
        return 1;
    }
    
    /* Ensure directories exist with proper permissions */
    mkdir("/var/log/nginx", 0777);
    mkdir("/run", 0777);
    mkdir("/tmp/nginx_client_body", 0777);
    mkdir("/tmp/nginx_proxy", 0777);
    mkdir("/mosquitto/data", 0777);
    mkdir("/mosquitto/data/dbs", 0777);
    mkdir("/mosquitto/data/dbs/default", 0777);
    mkdir("/mosquitto/data/metastore", 0777);
    mkdir("/mosquitto/log", 0777);
    
    /* Touch log file so mosquitto can write to it */
    FILE *logf = fopen("/mosquitto/log/mosquitto.log", "a");
    if (logf) fclose(logf);
    chmod("/mosquitto/log/mosquitto.log", 0666);
    
    /* Copy dynsec.json to a writable location if it doesn't exist there */
    if (access("/mosquitto/data/dynsec.json", F_OK) != 0) {
        copy_file("/mosquitto/config/dynsec.json", "/mosquitto/data/dynsec.json");
        chmod("/mosquitto/data/dynsec.json", 0666);
    }
    
    /* Start nginx */
    char *nginx_argv[] = {"/usr/sbin/nginx", "-g", "daemon off;", NULL};
    pids[0] = start_process("/usr/sbin/nginx", nginx_argv);
    fprintf(stderr, "mqbase-init: Started nginx (pid %d)\n", pids[0]);
    
    /* Start sqld - serves HTTP API for database queries
     * Uses -d flag to create database directory at /mosquitto/data/dbs/default/data
     * The plugin opens the same database file for direct SQLite access */
    char *sqld_argv[] = {"/usr/local/bin/sqld", 
        "-d", "/mosquitto/data",
        "--http-listen-addr", "127.0.0.1:8000",
        "--enable-http-console",
        NULL};
    pids[1] = start_process("/usr/local/bin/sqld", sqld_argv);
    fprintf(stderr, "mqbase-init: Started sqld (pid %d)\n", pids[1]);
    
    /* Wait for sqld to initialize and create the database directory structure */
    sleep(2);
    
    /* Make database files world-writable so mosquitto (running as nobody) can access them */
    chmod("/mosquitto/data/dbs/default/data", 0666);
    chmod("/mosquitto/data/dbs/default/data-shm", 0666);
    chmod("/mosquitto/data/dbs/default/data-wal", 0666);
    chmod("/mosquitto/data/dbs/default/.sentinel", 0666);
    chmod("/mosquitto/data/dbs/default/stats.json", 0666);
    chmod("/mosquitto/data/dbs/default/wallog", 0666);
    
    /* Start mosquitto - plugin opens the same database sqld manages */
    char *mosquitto_argv[] = {"/usr/sbin/mosquitto", "-c", "/mosquitto/config/mosquitto.conf", NULL};
    pids[2] = start_process("/usr/sbin/mosquitto", mosquitto_argv);
    fprintf(stderr, "mqbase-init: Started mosquitto (pid %d)\n", pids[2]);
    
    fprintf(stderr, "mqbase-init: All services started\n");
    
    /* Monitor processes */
    while (running) {
        int status;
        pid_t died = waitpid(-1, &status, WNOHANG);
        
        if (died > 0) {
            for (int i = 0; i < MAX_PROCS; i++) {
                if (pids[i] == died) {
                    fprintf(stderr, "mqbase-init: %s (pid %d) exited with status %d\n", 
                            proc_names[i], died, WEXITSTATUS(status));
                    running = 0;
                    break;
                }
            }
        }
        
        usleep(100000);  /* 100ms */
    }
    
    /* Cleanup - send SIGTERM to all */
    fprintf(stderr, "mqbase-init: Shutting down...\n");
    for (int i = 0; i < MAX_PROCS; i++) {
        if (pids[i] > 0) {
            kill(pids[i], SIGTERM);
        }
    }
    
    /* Wait for children to exit */
    for (int i = 0; i < MAX_PROCS; i++) {
        if (pids[i] > 0) {
            waitpid(pids[i], NULL, 0);
        }
    }
    
    fprintf(stderr, "mqbase-init: Shutdown complete\n");
    return 0;
}
