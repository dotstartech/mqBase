# Message Persistency

mqBase uses a custom Mosquitto plugin to persist MQTT messages to a libSQL database. This page explains the key concepts behind the persistence mechanism.

## Overview

When a message is published to mqBase:

1. The plugin generates a unique **ULID** (Universally Unique Lexicographically Sortable Identifier)
2. The ULID is attached to the message as an MQTT v5 **user property**
3. The message is queued for batch insertion into the libSQL database
4. Subscribers receive the message with the ULID header included

This design enables powerful features like:

* **Message tracing** — Track messages across systems using the ULID
* **Database correlation** — Query the exact message in the database using the ULID from the MQTT header
* **Synchronized deletion** — Delete messages from both the broker (retained) and database atomically

***

## ULID as Primary Key

### What is ULID?

ULID (Universally Unique Lexicographically Sortable Identifier) is a 26-character identifier that combines:

* **Timestamp** (first 10 characters) — Millisecond precision, sortable
* **Randomness** (last 16 characters) — Cryptographically random

Example ULID: `01ARZ3NDEKTSV4RRFFQ69G5FAV`

```
 01ARZ3NDEK          TSV4RRFFQ69G5FAV
 └─────┬─────┘       └──────┬────────┘
    Timestamp           Randomness
  (48 bits, ms)        (80 bits)
```

### Why ULID Instead of UUID or Auto-Increment?

| Feature | ULID | UUID v4 | Auto-Increment |
| ------- | ---- | ------- | -------------- |
| Sortable by time | ✅ Yes | ❌ No | ✅ Yes |
| Globally unique | ✅ Yes | ✅ Yes | ❌ No |
| No coordination needed | ✅ Yes | ✅ Yes | ❌ No |
| Compact (26 chars) | ✅ Yes | ❌ No (36 chars) | ✅ Yes |
| Embeddable in messages | ✅ Yes | ✅ Yes | ❌ No |
| Works in distributed systems | ✅ Yes | ✅ Yes | ❌ No |

### ULID in MQTT Messages

The plugin adds the ULID as an MQTT v5 user property to every published message:

```
User Property: ulid = 01HX7K2P8QRSTUVWXYZ12345AB
```

This means:

* **Publishers** don't need to generate IDs — the broker handles it
* **Subscribers** receive the ULID with the message
* **Applications** can use the ULID to query the database for the exact message

### Extracting ULID from Messages

**JavaScript (MQTT.js)**

```javascript
client.on('message', (topic, payload, packet) => {
  if (packet.properties && packet.properties.userProperties) {
    const ulid = packet.properties.userProperties.ulid;
    console.log(`Message ULID: ${ulid}`);
  }
});
```

**Python (paho-mqtt)**

```python
def on_message(client, userdata, msg):
    if hasattr(msg.properties, 'UserProperty'):
        for key, value in msg.properties.UserProperty:
            if key == 'ulid':
                print(f"Message ULID: {value}")
```

### Querying by ULID

Since ULIDs are time-sortable and the database is indexed on ULID, you can efficiently:

```sql
-- Get exact message by ULID
SELECT * FROM msg WHERE ulid = '01HX7K2P8QRSTUVWXYZ12345AB';

-- Get messages after a specific time (using ULID prefix)
SELECT * FROM msg WHERE ulid > '01HX7K2P' ORDER BY ulid;

-- Get latest 100 messages (sorted by time, newest first)
SELECT * FROM msg ORDER BY ulid DESC LIMIT 100;
```

***

## Synchronized Retained Message Deletion

### The Problem

In standard MQTT, you delete a retained message by publishing an **empty payload** with the **retain flag** set:

```bash
mosquitto_pub -t "sensors/temperature" -r -n  # -n means empty payload
```

This clears the retained message from the broker, but the message **remains in the database**. This creates inconsistency between the broker state and the persisted data.

### The Solution

mqBase's plugin detects retained message deletions and **automatically removes the corresponding record from the database**.

#### How It Works

1. When you publish an empty retained message, the plugin intercepts it
2. The plugin looks for a `ulid` user property in the delete message
3. If a ULID is provided, that specific record is deleted from the database
4. If no ULID is provided, the **most recent** message for that topic is deleted

**mosquitto_pub Example**

Simply publish an empty retained message — the plugin deletes the most recent database entry for that topic:

```bash
# Delete retained message and most recent database entry
mosquitto_pub -h localhost -u admin -P admin -t "sensors/temperature" -r -n
```


**JavaScript Example**

```javascript
// Delete specific message by ULID
client.publish('sensors/temperature', '', {
  retain: true,
  properties: {
    userProperties: {
      ulid: '01HX7K2P8QRSTUVWXYZ12345AB'
    }
  }
});
```

**Python Example**

```python
from paho.mqtt.properties import Properties
from paho.mqtt.packettypes import PacketTypes

props = Properties(PacketTypes.PUBLISH)
props.UserProperty = [('ulid', '01HX7K2P8QRSTUVWXYZ12345AB')]

client.publish('sensors/temperature', '', retain=True, properties=props)
```

### Use Cases

| Scenario | Approach |
| -------- | -------- |
| Clear current sensor reading | Delete by topic (no ULID) |
| Undo a specific erroneous publish | Delete by ULID |
| Clean up old retained messages | Query database, delete by ULIDs |
| Bulk cleanup | Use data retention (`plugin_opt_retention_days`) |

***

## Database Schema

Messages are stored in the `msg` table:

```sql
CREATE TABLE msg (
    ulid TEXT PRIMARY KEY,      -- Time-sortable unique identifier
    topic TEXT NOT NULL,        -- MQTT topic
    payload TEXT NOT NULL,      -- Message payload
    retain INTEGER DEFAULT 0,   -- Retain flag (0 or 1)
    qos INTEGER DEFAULT 0,      -- QoS level (0, 1, or 2)
    headers TEXT                -- JSON object of user properties
);
```

### Indexes

The plugin automatically creates indexes for optimal query performance:

* `idx_msg_topic` — Fast topic-based lookups
* `idx_msg_topic_ulid` — Efficient queries combining topic and time

***

## Best Practices

### For Message Tracing

1. Subscribe to messages with QoS 1 or 2 to ensure delivery
2. Extract the ULID from the user properties
3. Log the ULID for later correlation with database records

### For Data Cleanup

1. Set `plugin_opt_retention_days` for automatic cleanup of old messages
2. Use ULID-based deletion for targeted cleanup of specific messages
3. Query the Admin UI's Database tab to find messages before deleting

### For High-Throughput Systems

1. Tune `plugin_opt_batch_size` and `plugin_opt_flush_interval` for your workload
2. ULIDs are generated with sub-millisecond uniqueness — no bottleneck at high rates
3. Database operations are batched and non-blocking for publishers

{% hint style="info" %}
The ULID is added to **all** published messages, including those on excluded topics. This ensures consistent message identification even when persistence is disabled for specific topics.
{% endhint %}
