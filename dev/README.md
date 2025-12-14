# DEV Scripts and Configs

## Build, Test and Deploy Scripts

```bash
# Builds the Docker image with version tag from msa.properties
./dev/build.sh
# Deploys the service to Docker Swarm
./dev/deploy.sh
# Runs integration tests to verify MQTT persistence, topics exclusion, etc.
./dev/test.sh
```

---

## Stress Test Script

### Usage
```bash
./dev/stress-test.sh [OPTIONS]
```

### Options
| Option | Description | Default |
|--------|-------------|---------|
| `-n, --messages NUM` | Total number of messages to send | 1000 |
| `-d, --duration SECS` | Duration for rate calculation display | 10 |
| `-p, --publishers NUM` | Number of parallel publishers | 200 |
| `-q, --qos LEVEL` | QoS level (0, 1, or 2) | 0 |
| `-r, --retained` | Send all messages as retained | false |
| `-l, --latency` | Measure message processing latency | false |
| `-s, --samples` | Show sample of stored messages | false |
| `-h, --help` | Show help | - |

### Examples

**Basic test with 500 messages across 30 publishers:**
```bash
./dev/stress-test.sh -n 500 -p 30
```

**High-concurrency test with 1000 publishers (IoT simulation):**
```bash
./dev/stress-test.sh -n 1000 -p 1000
```

**Test with QoS 1 (guaranteed delivery):**
```bash
./dev/stress-test.sh -n 1000 -p 50 --qos 1
```

**Test retained messages:**
```bash
./dev/stress-test.sh -n 100 -p 10 --retained
```

**Measure end-to-end latency (send → storage):**
```bash
./dev/stress-test.sh -n 500 -p 50 --latency
# or a more realistic use case
./dev/stress-test.sh -n 60000 -d 10 -p 1000 -r -q 2 -l
```

### Understanding the Output

The script outputs a results summary like this:

```
========================================
Stress Test Results
========================================

Messages:
  Expected:   1000
  Stored:     1000
  Efficiency: 100.00%

Performance:
  Test Duration:    0.25s
  Publish Rate:     4000 msg/s (sent)
  Storage Rate:     4000 msg/s (stored)
```

**Key Metrics:**

| Metric | Description |
|--------|-------------|
| **Expected** | Total messages that should be stored |
| **Stored** | Actual messages found in database |
| **Efficiency** | Percentage of messages successfully persisted |
| **Publish Rate** | How fast messages were sent to the broker |
| **Storage Rate** | Effective database write throughput |

**Result Verdicts:**
- ✅ `PASS` - 100% of messages stored
- ⚠️ `WARN` - >95% stored (some may still be processing)
- ❌ `FAIL` - <95% stored (potential data loss or timeout)

### Notes

- The script pre-generates all message payloads before publishing for maximum throughput
- It waits for the database to stabilize (count stops changing) before reporting results
- Each publisher sends messages to its own topic: `data/test/stress/pub{N}`
- Environment variables can override defaults: `MQTT_BROKER`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASS`, `DB_URL`

### Message Payload Format

Each test message uses a JSON payload with the following structure:

```json
{"t":"abc123","p":42,"s":7,"ts":1734567890123}
```

| Field | Description |
|-------|-------------|
| `t` | Test ID - unique identifier for this test run (random hex string) |
| `p` | Publisher ID - identifies which parallel publisher sent the message (0 to N-1) |
| `s` | Sequence number - message sequence within this publisher (0 to messages/publishers) |
| `ts` | Timestamp - Unix epoch milliseconds when the message was created |

This structure enables:
- **Test isolation**: Filter messages by test ID to analyze specific runs
- **Publisher tracking**: Identify message distribution across parallel publishers  
- **Sequence verification**: Detect missing or out-of-order messages
- **Latency measurement**: Compare `ts` with ULID timestamp to calculate end-to-end latency

---

## External Nginx Reverse Proxy
`proxy.conf` is an example configuration for external Nginx reverse proxy (not the one running in this container). The variable mapping below shall be added to the Nginx configuration before the `server {}` block
```apacheconf
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```