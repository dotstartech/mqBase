# mqBase - MQTT, SQL and web admin in one place

[![Docker Image](https://img.shields.io/docker/v/dotstartech/mqbase?label=Docker&logo=docker)](https://hub.docker.com/r/dotstartech/mqbase)
[![Docker Pulls](https://img.shields.io/docker/pulls/dotstartech/mqbase?logo=docker)](https://hub.docker.com/r/dotstartech/mqbase)
[![Docker Image Size](https://img.shields.io/docker/image-size/dotstartech/mqbase?logo=docker)](https://hub.docker.com/r/dotstartech/mqbase)
[![License](https://img.shields.io/github/license/dotstartech/mqBase)](LICENSE)

mqBase is based on [Mosquitto](https://github.com/eclipse-mosquitto/mosquitto) MQTT broker, [libSQL](https://github.com/tursodatabase/libsql) database and [Nginx](https://github.com/nginx/nginx) web server. It features:
 - MQTT v5.0 protocol (plain MQTT, over TLS or WebSocket)
 - Authentication and authorization based on Access Control List (ACL)
 - Message persistency in local libSQL database with remote HTTP access
 - Admin web UI (served by internal Nginx) with database and broker views and ACL editor

![](docs/mqbase-admin.png)

## Building

```bash
docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) -t mqbase:latest -f ./docker/Dockerfile .

# Or use the build script
./docker/build.sh
```

## Quick Start

### Option 1: Docker Compose

```bash
# Build and run with default credentials (admin:admin)
docker compose up -d

# Or with custom credentials
MQBASE_USER=myuser:mypass MQBASE_MQTT_USER=mqtt:mqttpass docker compose up -d
```

### Option 2: Docker Run

```bash
# With auto-generated credentials (check logs for passwords)
docker run -d --name mqbase -p 1883:1883 -p 8080:8080 -p 9001:9001 mqbase:latest

# With explicit credentials
docker run -d --name mqbase \
  -e MQBASE_USER=admin:admin \
  -e MQBASE_MQTT_USER=admin:admin \
  -p 1883:1883 -p 8080:8080 -p 9001:9001 \
  mqbase:latest
```

### Option 3: Docker Swarm

```bash
docker secret create mqbase.secrets mqbase.secrets
docker stack deploy -c compose.swarm.yml mqbase
```

Open [localhost:8080](http://localhost:8080) (or [127.0.0.1:8080](http://127.0.0.1:8080)) in your browser.

## Credentials Configuration

mqBase supports multiple methods for providing credentials, with the following priority:

| Priority | Method | Use Case |
|----------|--------|----------|
| 1 | Docker secrets (`/run/secrets/mqbase.secrets`) | Production (Swarm/Kubernetes) |
| 2 | Environment variables | Docker Compose, `docker run -e` |
| 3 | Mounted config file (`/mosquitto/config/secrets.conf`) | File-based configuration |
| 4 | Auto-generate | Quick demos (credentials printed to logs) |

### Credentials Format

Both `MQBASE_USER` and `MQBASE_MQTT_USER` use the format `username:password`:

```bash
MQBASE_USER=admin:secretpass
MQBASE_MQTT_USER=mqtt:mqttpass
```

| Variable | Description |
|----------|-------------|
| `MQBASE_USER` | HTTP Basic Auth credentials for admin UI and database API |
| `MQBASE_MQTT_USER` | MQTT broker credentials (used by admin UI to connect to broker) |

### Using Environment Variables

```bash
# Docker run
docker run -e MQBASE_USER=admin:mypass -e MQBASE_MQTT_USER=admin:mypass mqbase:latest

# Docker Compose (in compose.simple.yml or .env file)
environment:
  - MQBASE_USER=admin:mypass
  - MQBASE_MQTT_USER=admin:mypass
```

### Using a Secrets File

Create a `secrets.conf` file and mount it:

```bash
# secrets.conf
MQBASE_USER=admin:secretpass
MQBASE_MQTT_USER=mqtt:mqttpass
```

```bash
docker run -v ./secrets.conf:/mosquitto/config/secrets.conf:ro mqbase:latest
```

### Auto-Generated Credentials

If no credentials are provided, mqBase will auto-generate secure random passwords and print them to the container logs:

```bash
docker logs mqbase
# ==============================================
# WARNING: No MQBASE_USER credentials found!
# Auto-generated credentials for HTTP Basic Auth:
#   Username: admin
#   Password: xK7mN2pQ9rT4wY6z
# ==============================================
```

## Application Configuration

The `mqbase.properties` file contains application configuration:
```properties
version=0.9.0
title=mqBase Admin
logo=admin/logo.png
favicon=admin/logo.png
```

| Property | Description |
|----------|-------------|
| `version` | Application version (used by build/deploy scripts) |
| `title` | Title displayed in the web UI header (default: "mqBase Admin") |
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
| `plugin_opt_exclude_headers` | Comma-separated list of headers (user properties) to exclude from persistence ('#' disables headers storage). | `0` |

### Database Indexes

The plugin automatically creates the following indexes for optimal query performance:
- `idx_msg_topic` - Index on the `topic` column for fast topic-based lookups
- `idx_msg_timestamp` - Index on the `timestamp` column for efficient retention cleanup

### Example Configuration

```properties
plugin /usr/lib/libsql_plugin.so
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

## Admin UI Keyboard Shortcuts

The web admin interface supports the following keyboard shortcuts for improved productivity:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Execute custom query (Database tab) or refresh messages (Broker tab) |
| `Ctrl+1` | Switch to Database tab |
| `Ctrl+2` | Switch to Broker tab |
| `Ctrl+3` | Switch to ACL tab |
| `Ctrl+Shift+R` | Toggle auto-refresh on/off |
| `Escape` | Close modal dialogs |

## Acknowledgements

This project uses the following open source libraries:

- [Catppuccin](https://github.com/catppuccin/catppuccin) — Soothing pastel color scheme for the admin UI
- [ulid-c](https://github.com/skeeto/ulid-c) — C implementation of ULID (Universally Unique Lexicographically Sortable Identifier)
