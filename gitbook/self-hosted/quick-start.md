# Quick Start

Get mqBase running in under 5 minutes with Docker.

## Prerequisites

* Docker 20.10 or later
* Docker Compose v2 (optional, but recommended)

## Option 1: Docker Compose (Recommended)

Create a `compose.yml` file:

```yaml
services:
  mqbase:
    image: dotstartech/mqbase:latest
    container_name: mqbase
    ports:
      - 1883:1883   # MQTT
      - 8080:8080   # Admin UI
      - 9001:9001   # MQTT over WebSocket
    environment:
      - MQBASE_USER=admin:yourpassword
      - MQBASE_MQTT_USER=admin:yourpassword
    volumes:
      - mqbase-data:/mosquitto/data
      - mqbase-log:/mosquitto/log
    restart: unless-stopped

volumes:
  mqbase-data:
  mqbase-log:
```

Start the container:

```bash
docker compose up -d
```

## Option 2: Docker Run

Run with a single command:

```bash
docker run -d --name mqbase \
  -e MQBASE_USER=admin:yourpassword \
  -e MQBASE_MQTT_USER=admin:yourpassword \
  -p 1883:1883 \
  -p 8080:8080 \
  -p 9001:9001 \
  -v mqbase-data:/mosquitto/data \
  dotstartech/mqbase:latest
```

## Access the Admin UI

Open your browser and navigate to:

{% hint style="success" %}
**http://localhost:8080**
{% endhint %}

Log in with the credentials you configured (`admin:yourpassword` in the examples above).

## Test MQTT Connection

Using mosquitto-clients:

```bash
# Subscribe to all topics
mosquitto_sub -h localhost -p 1883 -u admin -P yourpassword -t '#' -v

# Publish a test message (in another terminal)
mosquitto_pub -h localhost -p 1883 -u admin -P yourpassword \
  -t 'sensors/temperature' -m '{"value": 23.5}'
```

Using MQTT.js:

```bash
# Install mqtt-cli
npm install -g mqtt

# Subscribe
mqtt sub -h localhost -p 1883 -u admin -P yourpassword -t '#' -v

# Publish
mqtt pub -h localhost -p 1883 -u admin -P yourpassword \
  -t 'sensors/temperature' -m '{"value": 23.5}'
```

## Verify Message Persistence

1. Open the Admin UI at http://localhost:8080
2. Go to the **Database** tab
3. You should see your test message persisted with timestamp and ULID

## What's Next?

<table data-card-size="large" data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Configuration</strong></td><td>Learn about credentials, TLS, and plugin options</td><td><a href="configuration.md">configuration.md</a></td></tr><tr><td><strong>Production Deployment</strong></td><td>Deploy with Docker Swarm or Kubernetes</td><td><a href="production.md">production.md</a></td></tr></tbody></table>
