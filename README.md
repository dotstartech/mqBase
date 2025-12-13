# MQTT SQL Admin

MQTT SQL Admin is based on [Mosquitto](https://github.com/eclipse-mosquitto/mosquitto) MQTT broker, [libSQL](https://github.com/tursodatabase/libsql) database and [Nginx](https://github.com/nginx/nginx) web server. It features:
 - MQTT v5.0 protocol (plain MQTT, over TLS or WebSocket)
 - Authentication and authorization based on Access Control List
 - Message persistency in local libSQL database with remote HTTP access
 - Admin web user interface (served by internal Nginx)

## Development
To build Docker image run from the project's root directory
```bash
docker build --no-cache --build-arg UID=$(id -u) --build-arg GID=$(id -g) -t mqtt-sql-admin:0.1.0 -f ./docker/Dockerfile .
```

To start the MQTT SQL Admin as Docker Swarm service
```bash
docker network create --driver overlay dev-proxy
docker secret create dynsec.json mosquitto/config/dynsec.json
docker secret create msa.secrets msa.secrets
docker secret create msa.properties msa.properties
docker stack deploy -c compose.yml msa
```

The `msa.secrets` file contains environment variables for the admin UI to connect to the MQTT broker:
```
MSA_MQTT_USER=admin:admin
```

The `msa.properties` file contains application configuration:
```properties
version=0.2.0
title=MQTT SQL Admin
logo=admin/logo.png
favicon=admin/logo.png
```

| Property | Description |
|----------|-------------|
| `version` | Application version (used by build/deploy scripts) |
| `title` | Title displayed in the web UI header (default: "MQTT SQL Admin") |
| `logo` | Path to logo image displayed in the header (optional, no logo if empty) |
| `favicon` | Path to favicon displayed in the browser tab (optional, no icon if empty) |

The `dynsec.json` file defines the Mosquitto dynamic security configuration with two users:
- `admin:admin` — Full access to all topics (for admin UI)
- `test:test` — Restricted access to `+/test/#` topics (for testing)

To enable TLS termination inside the Mosquitto broker, mount your TLS certificate and key to `/mosquitto/security/` (e.g., `server.crt` and `server.key`) and uncomment the `certfile`/`keyfile` lines in [`mosquitto/config/mosquitto.conf`](mosquitto/config/mosquitto.conf). For mutual TLS (mTLS) with client certificates, also configure the `cafile` and `require_certificate` options.

## SQL Plugin Configuration

The SQL plugin persists MQTT messages to a libSQL database. It can be configured via `mosquitto.conf` with the following options:

### Plugin Options

| Option | Description | Default |
|--------|-------------|---------|
| `plugin_opt_exclude_topics` | Comma-separated list of topic patterns to exclude from persistence. Supports MQTT wildcards (`+` and `#`). | _(none)_ |
| `plugin_opt_batch_size` | Number of messages to accumulate before flushing to the database. | `100` |
| `plugin_opt_flush_interval` | Maximum time in milliseconds between database flushes. | `50` |
| `plugin_opt_retention_days` | Automatically delete messages older than N days. Set to `0` to disable (keep all messages). | `0` |

### Database Indexes

The plugin automatically creates the following indexes for optimal query performance:
- `idx_msg_topic` - Index on the `topic` column for fast topic-based lookups
- `idx_msg_timestamp` - Index on the `timestamp` column for efficient retention cleanup

### Example Configuration

```properties
plugin /usr/lib/sql_plugin.so
# Exclude command topics from persistence
plugin_opt_exclude_topics cmd/#,+/test/exclude/#
# Batch insert settings
plugin_opt_batch_size 100
plugin_opt_flush_interval 50
# Keep messages for 1 year, then automatically delete
plugin_opt_retention_days 365
```

### Data Retention

When `plugin_opt_retention_days` is set to a value greater than 0, the plugin will periodically (every hour) delete messages older than the specified number of days. This helps manage database size for long-running deployments.

```properties
# Keep messages for 90 days
plugin_opt_retention_days 90

# Disable retention (keep all messages forever)
plugin_opt_retention_days 0
```

### Performance Tuning

The batch insert mechanism significantly improves throughput by reducing database transaction overhead. Tune the parameters based on your workload:

**Lower latency** (for real-time applications):
```properties
plugin_opt_batch_size 25
plugin_opt_flush_interval 20
```

**Higher throughput** (for high-volume IoT workloads):
```properties
plugin_opt_batch_size 200
plugin_opt_flush_interval 100
```

**Balanced** (default, good for most use cases):
```properties
plugin_opt_batch_size 100
plugin_opt_flush_interval 50
```

## Acknowledgements

This project uses the following open source libraries:

- [Catppuccin](https://github.com/catppuccin/catppuccin) — Soothing pastel color scheme for the admin UI
- [ulid-c](https://github.com/skeeto/ulid-c) — C implementation of ULID (Universally Unique Lexicographically Sortable Identifier)
