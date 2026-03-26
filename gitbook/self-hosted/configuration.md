# Configuration

Customize your mqBase deployment with environment variables, configuration files, and plugin options.

## Credentials

mqBase supports multiple methods for providing credentials, with the following priority:

| Priority | Method | Use Case |
| -------- | ------ | -------- |
| 1        | Docker secrets | Production (Swarm/Kubernetes) |
| 2        | Environment variables | Docker Compose, `docker run` |
| 3        | Mounted config file | File-based configuration |
| 4        | Auto-generate | Quick demos |

### Environment Variables

| Variable | Format | Description |
| -------- | ------ | ----------- |
| `MQBASE_USER` | `username:password` | HTTP Basic Auth for Admin UI and database API |
| `MQBASE_MQTT_USER` | `username:password` | MQTT broker credentials |

```bash
docker run -d \
  -e MQBASE_USER=admin:secretpass \
  -e MQBASE_MQTT_USER=mqtt:mqttpass \
  dotstartech/mqbase:latest
```

### Secrets File

Create a `secrets.conf` file:

```properties
MQBASE_USER=admin:secretpass
MQBASE_MQTT_USER=mqtt:mqttpass
```

Mount it to the container:

```bash
docker run -d \
  -v ./secrets.conf:/mosquitto/config/secrets.conf:ro \
  dotstartech/mqbase:latest
```

### Auto-Generated Credentials

If no credentials are provided, mqBase generates secure random passwords and prints them to the logs:

```bash
docker logs mqbase
```

```
==============================================
WARNING: No MQBASE_USER credentials found!
Auto-generated credentials for HTTP Basic Auth:
  Username: admin
  Password: xK7mN2pQ9rT4wY6z
==============================================
```

{% hint style="warning" %}
Auto-generated credentials are only printed once. Save them immediately or restart the container to generate new ones.
{% endhint %}

***

## Application Properties

The `mqbase.properties` file controls UI customization:

```properties
version=0.11.0
title=mqBase Admin
logo=admin/logo.png
favicon=admin/logo.png
```

| Property  | Description |
| --------- | ----------- |
| `version` | Application version |
| `title`   | Browser tab and header title |
| `logo`    | Header logo image path |
| `favicon` | Browser favicon path |

***

## SQL Plugin Configuration

The SQL plugin persists MQTT messages to libSQL. Configure it in `mosquitto.conf`:

```properties
plugin /usr/lib/libsql_plugin.so
plugin_opt_exclude_topics cmd/#,+/test/exclude/#
plugin_opt_batch_size 100
plugin_opt_flush_interval 50
plugin_opt_retention_days 365
plugin_opt_exclude_headers header-to-exclude
```

### Plugin Options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `plugin_opt_exclude_topics` | Topic patterns to exclude (supports `+` and `#` wildcards) | _(none)_ |
| `plugin_opt_batch_size` | Messages to batch before database flush | `100` |
| `plugin_opt_flush_interval` | Max milliseconds between flushes | `50` |
| `plugin_opt_retention_days` | Auto-delete messages older than N days (0 = keep forever) | `0` |
| `plugin_opt_exclude_headers` | Headers to exclude from storage (`#` = exclude all) | _(none)_ |

### Performance Tuning

<tabs>
<tab title="Low Latency">
For real-time applications requiring immediate persistence:

```properties
plugin_opt_batch_size 25
plugin_opt_flush_interval 20
```
</tab>

<tab title="High Throughput">
For IoT workloads with high message volume:

```properties
plugin_opt_batch_size 200
plugin_opt_flush_interval 100
```
</tab>

<tab title="Balanced (Default)">
Good for most use cases:

```properties
plugin_opt_batch_size 100
plugin_opt_flush_interval 50
```
</tab>
</tabs>

***

## TLS Configuration

To enable TLS on the MQTT listener, mount your certificates and update `mosquitto.conf`:

### 1. Mount Certificates

```yaml
volumes:
  - ./certs/server.crt:/mosquitto/security/server.crt:ro
  - ./certs/server.key:/mosquitto/security/server.key:ro
```

### 2. Configure Mosquitto

Edit `mosquitto.conf`:

```properties
listener 8883
certfile /mosquitto/security/server.crt
keyfile /mosquitto/security/server.key
tls_version tlsv1.3
```

### Mutual TLS (mTLS)

For client certificate authentication:

```properties
listener 8883
certfile /mosquitto/security/server.crt
keyfile /mosquitto/security/server.key
cafile /mosquitto/security/ca.crt
require_certificate true
```

***

## Access Control (ACL)

mqBase uses Mosquitto's Dynamic Security plugin for authentication and authorization. The configuration is stored in `dynsec.json`.

### Default Users

| Username | Password | Access |
| -------- | -------- | ------ |
| `admin`  | `admin`  | Full access to all topics including `$CONTROL` and `$SYS` |
| `test`   | `test`   | Restricted to `test/#` topics only |

### Managing ACL via Admin UI

1. Open the Admin UI at http://localhost:8080
2. Navigate to the **ACL** tab
3. Manage **Clients**, **Groups**, and **Roles**

### ACL Concepts

* **Clients** — Individual MQTT users with credentials
* **Groups** — Collections of clients for easier role assignment
* **Roles** — Define topic-based permissions (publish, subscribe, etc.)

{% hint style="info" %}
Changes made via the ACL tab are applied immediately without requiring a restart.
{% endhint %}

***

## Volume Mounts

| Container Path | Description |
| -------------- | ----------- |
| `/mosquitto/data` | Persistent database and Mosquitto data |
| `/mosquitto/log` | Log files |
| `/mosquitto/config` | Configuration files (read-only recommended) |
| `/mosquitto/security` | TLS certificates |

### Recommended Volume Configuration

```yaml
volumes:
  - mqbase-data:/mosquitto/data      # Named volume for data
  - mqbase-log:/mosquitto/log        # Named volume for logs
  - ./config:/mosquitto/config:ro    # Bind mount for config (read-only)
  - ./certs:/mosquitto/security:ro   # Bind mount for certs (read-only)
```
