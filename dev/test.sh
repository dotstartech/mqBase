#!/bin/bash
# Integration test script for mqtt-sql-admin
# Tests MQTT message persistence, topic exclusion, HTTP endpoints, and admin features
#
# Exclusion patterns: cmd/# (transient commands not persisted)
#
# Test user can only publish to +/test/# topics (see mosquitto/config/dynsec.json)

set -e

BROKER="${MQTT_BROKER:-127.0.0.1}"
PORT="${MQTT_PORT:-1883}"
WS_PORT="${MQTT_WS_PORT:-9001}"
USER="${MQTT_USER:-test}"
PASS="${MQTT_PASS:-test}"
ADMIN_USER="${MQTT_ADMIN_USER:-admin}"
ADMIN_PASS="${MQTT_ADMIN_PASS:-admin}"
DB_URL="${DB_URL:-http://127.0.0.1:8080/db-admin/}"
ADMIN_URL="${ADMIN_URL:-http://127.0.0.1:8080}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
log_info() { echo -e "${YELLOW}→${NC} $1"; }
log_section() { echo -e "\n${BLUE}=== $1 ===${NC}"; }

# Query database and return count
db_count() {
    curl -s -X POST "$DB_URL" \
        -H "Content-Type: application/json" \
        -d '{"statements": ["SELECT COUNT(*) FROM msg"]}' | \
        jq -r '.[0].results.rows[0][0]'
}

# Query database for messages matching topic pattern
db_find_topic() {
    local topic="$1"
    curl -s -X POST "$DB_URL" \
        -H "Content-Type: application/json" \
        -d "{\"statements\": [\"SELECT COUNT(*) FROM msg WHERE topic = '$topic'\"]}" | \
        jq -r '.[0].results.rows[0][0]'
}

# Query database for message by topic and return payload
db_get_payload() {
    local topic="$1"
    curl -s -X POST "$DB_URL" \
        -H "Content-Type: application/json" \
        -d "{\"statements\": [\"SELECT payload FROM msg WHERE topic = '$topic' ORDER BY ulid DESC LIMIT 1\"]}" | \
        jq -r '.[0].results.rows[0][0]'
}

# Query database for message fields (ulid, topic, payload, retain, qos)
db_get_message() {
    local topic="$1"
    curl -s -X POST "$DB_URL" \
        -H "Content-Type: application/json" \
        -d "{\"statements\": [\"SELECT ulid, topic, payload, retain, qos FROM msg WHERE topic = '$topic' ORDER BY ulid DESC LIMIT 1\"]}" | \
        jq -r '.[0].results.rows[0] | @json'
}

# Check HTTP endpoint returns expected status
http_status() {
    local url="$1"
    curl -s -o /dev/null -w "%{http_code}" "$url"
}

# Generate unique test ID
TEST_ID=$(date +%s)_$(head -c 4 /dev/urandom | xxd -p)

echo "========================================"
echo "MQTT-SQL-Admin Integration Test Suite"
echo "========================================"
echo "Broker: $BROKER:$PORT (WS: $WS_PORT)"
echo "User: $USER"
echo "DB URL: $DB_URL"
echo "Admin URL: $ADMIN_URL"
echo "Test ID: $TEST_ID"
echo "========================================"

# Get initial count
INITIAL_COUNT=$(db_count)
log_info "Initial message count: $INITIAL_COUNT"

# =========================================================================
# SECTION 1: Basic Message Persistence
# =========================================================================
log_section "Section 1: Basic Message Persistence"

# -----------------------------------------
# Test 1: Persistent message (data/test/...)
# -----------------------------------------
echo ""
echo "--- Test 1: Persistent message ---"
TOPIC_PERSIST="data/test/sensor_$TEST_ID"
MSG_PERSIST="{\"test_id\":\"$TEST_ID\",\"type\":\"persistent\",\"value\":42}"

log_info "Publishing to $TOPIC_PERSIST (should be persisted)"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_PERSIST" -m "$MSG_PERSIST" -q 1

sleep 0.5
COUNT_AFTER_1=$(db_count)
if [ "$COUNT_AFTER_1" -gt "$INITIAL_COUNT" ]; then
    log_pass "Message count increased ($INITIAL_COUNT -> $COUNT_AFTER_1)"
else
    log_fail "Message count did not increase ($INITIAL_COUNT -> $COUNT_AFTER_1)"
fi

# -----------------------------------------
# Test 2: Transient message (cmd/test/...)
# -----------------------------------------
echo ""
echo "--- Test 2: Transient message (excluded) ---"
TOPIC_TRANSIENT="cmd/test/action_$TEST_ID"
MSG_TRANSIENT="{\"test_id\":\"$TEST_ID\",\"type\":\"transient\",\"action\":\"ping\"}"

log_info "Publishing to $TOPIC_TRANSIENT (should NOT be persisted - excluded by cmd/#)"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_TRANSIENT" -m "$MSG_TRANSIENT" -q 0

sleep 0.5
COUNT_AFTER_2=$(db_count)
if [ "$COUNT_AFTER_2" -eq "$COUNT_AFTER_1" ]; then
    log_pass "Message count unchanged ($COUNT_AFTER_1 -> $COUNT_AFTER_2) - correctly excluded"
else
    log_fail "Message count changed ($COUNT_AFTER_1 -> $COUNT_AFTER_2) - should have been excluded"
fi

# -----------------------------------------
# Test 3: Multiple persistent messages (batch test)
# -----------------------------------------
echo ""
echo "--- Test 3: Multiple persistent messages (batch insert) ---"
for i in 1 2 3 4 5; do
    TOPIC="data/test/batch_${TEST_ID}_$i"
    MSG="{\"test_id\":\"$TEST_ID\",\"batch\":$i}"
    mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC" -m "$MSG" -q 1
done
log_info "Published 5 batch messages"

sleep 1
COUNT_AFTER_3=$(db_count)
EXPECTED=$((COUNT_AFTER_2 + 5))
if [ "$COUNT_AFTER_3" -eq "$EXPECTED" ]; then
    log_pass "5 messages added ($COUNT_AFTER_2 -> $COUNT_AFTER_3)"
else
    log_fail "Expected $EXPECTED messages, got $COUNT_AFTER_3"
fi

# -----------------------------------------
# Test 4: Verify topic and payload in database
# -----------------------------------------
echo ""
echo "--- Test 4: Verify topic and payload in database ---"
FOUND=$(db_find_topic "$TOPIC_PERSIST")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Found $FOUND message(s) with topic '$TOPIC_PERSIST'"
else
    log_fail "No messages found with topic '$TOPIC_PERSIST'"
fi

PAYLOAD=$(db_get_payload "$TOPIC_PERSIST")
if [[ "$PAYLOAD" == *"$TEST_ID"* ]]; then
    log_pass "Payload contains test_id"
else
    log_fail "Payload does not contain test_id: $PAYLOAD"
fi

FOUND_CMD=$(db_find_topic "$TOPIC_TRANSIENT")
if [ "$FOUND_CMD" -eq 0 ]; then
    log_pass "No messages found with excluded topic '$TOPIC_TRANSIENT'"
else
    log_fail "Found $FOUND_CMD message(s) with excluded topic '$TOPIC_TRANSIENT' (should be 0)"
fi

# =========================================================================
# SECTION 2: QoS and Retain Flags
# =========================================================================
log_section "Section 2: QoS and Retain Flags"

# -----------------------------------------
# Test 5: QoS 0 message
# -----------------------------------------
echo ""
echo "--- Test 5: QoS 0 message ---"
TOPIC_QOS0="data/test/qos0_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_QOS0" -m '{"qos":0}' -q 0
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_QOS0")
QOS_VAL=$(echo "$MSG_DATA" | jq -r '.[4]')
if [ "$QOS_VAL" = "0" ]; then
    log_pass "QoS 0 correctly stored"
else
    log_fail "QoS 0 not stored correctly, got: $QOS_VAL"
fi

# -----------------------------------------
# Test 6: QoS 1 message
# -----------------------------------------
echo ""
echo "--- Test 6: QoS 1 message ---"
TOPIC_QOS1="data/test/qos1_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_QOS1" -m '{"qos":1}' -q 1
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_QOS1")
QOS_VAL=$(echo "$MSG_DATA" | jq -r '.[4]')
if [ "$QOS_VAL" = "1" ]; then
    log_pass "QoS 1 correctly stored"
else
    log_fail "QoS 1 not stored correctly, got: $QOS_VAL"
fi

# -----------------------------------------
# Test 7: QoS 2 message
# -----------------------------------------
echo ""
echo "--- Test 7: QoS 2 message ---"
TOPIC_QOS2="data/test/qos2_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_QOS2" -m '{"qos":2}' -q 2
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_QOS2")
QOS_VAL=$(echo "$MSG_DATA" | jq -r '.[4]')
if [ "$QOS_VAL" = "2" ]; then
    log_pass "QoS 2 correctly stored"
else
    log_fail "QoS 2 not stored correctly, got: $QOS_VAL"
fi

# -----------------------------------------
# Test 8: Retained message flag
# -----------------------------------------
echo ""
echo "--- Test 8: Retained message flag ---"
TOPIC_RETAIN="data/test/retain_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_RETAIN" -m '{"retained":true}' -q 1 -r
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_RETAIN")
RETAIN_VAL=$(echo "$MSG_DATA" | jq -r '.[3]')
if [ "$RETAIN_VAL" = "1" ]; then
    log_pass "Retain flag correctly stored"
else
    log_fail "Retain flag not stored correctly, got: $RETAIN_VAL"
fi

# -----------------------------------------
# Test 9: Non-retained message flag
# -----------------------------------------
echo ""
echo "--- Test 9: Non-retained message flag ---"
TOPIC_NO_RETAIN="data/test/no_retain_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_NO_RETAIN" -m '{"retained":false}' -q 1
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_NO_RETAIN")
RETAIN_VAL=$(echo "$MSG_DATA" | jq -r '.[3]')
if [ "$RETAIN_VAL" = "0" ]; then
    log_pass "Non-retained flag correctly stored"
else
    log_fail "Non-retained flag not stored correctly, got: $RETAIN_VAL"
fi

# =========================================================================
# SECTION 3: Delete Operations
# =========================================================================
log_section "Section 3: Delete Operations"

# -----------------------------------------
# Test 10: Delete with ULID property (targeted delete)
# -----------------------------------------
echo ""
echo "--- Test 10: Delete with ULID property ---"
TOPIC_DELETE_ULID="data/test/delete_ulid_$TEST_ID"

log_info "Publishing first retained message"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_ULID" -m '{"msg":"first"}' -q 1 -r -V 5
sleep 0.5

FIRST_ULID=$(curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d "{\"statements\": [\"SELECT ulid FROM msg WHERE topic = '$TOPIC_DELETE_ULID' ORDER BY ulid DESC LIMIT 1\"]}" | \
    jq -r '.[0].results.rows[0][0]')
log_info "First message ULID: $FIRST_ULID"

log_info "Publishing second retained message"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_ULID" -m '{"msg":"second"}' -q 1 -r -V 5
sleep 0.5

COUNT_BEFORE_DELETE=$(db_find_topic "$TOPIC_DELETE_ULID")
log_info "Messages before targeted delete: $COUNT_BEFORE_DELETE"

log_info "Deleting first message by ULID property"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_ULID" -r -n -V 5 \
    -D publish user-property ulid "$FIRST_ULID"
sleep 0.5

COUNT_AFTER_DELETE=$(db_find_topic "$TOPIC_DELETE_ULID")
REMAINING_MSG=$(db_get_payload "$TOPIC_DELETE_ULID")

if [ "$COUNT_AFTER_DELETE" -eq 1 ] && [[ "$REMAINING_MSG" == *"second"* ]]; then
    log_pass "Targeted delete worked - first message deleted, second remains"
else
    log_fail "Targeted delete failed - expected 1 message with 'second', got $COUNT_AFTER_DELETE"
fi

# -----------------------------------------
# Test 11: Delete without ULID (fallback - deletes most recent)
# -----------------------------------------
echo ""
echo "--- Test 11: Delete without ULID (fallback) ---"
TOPIC_DELETE_FALLBACK="data/test/delete_fallback_$TEST_ID"

log_info "Publishing retained message"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_FALLBACK" -m '{"msg":"to_delete"}' -q 1 -r -V 5
sleep 0.5

COUNT_BEFORE_FALLBACK=$(db_find_topic "$TOPIC_DELETE_FALLBACK")

log_info "Deleting using fallback (no ULID property)"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_FALLBACK" -r -n -V 5
sleep 0.5

COUNT_AFTER_FALLBACK=$(db_find_topic "$TOPIC_DELETE_FALLBACK")
if [ "$COUNT_AFTER_FALLBACK" -eq 0 ]; then
    log_pass "Fallback delete worked - message deleted"
else
    log_fail "Fallback delete failed - expected 0 messages, got $COUNT_AFTER_FALLBACK"
fi

# =========================================================================
# SECTION 4: ULID Generation and Ordering
# =========================================================================
log_section "Section 4: ULID Generation and Ordering"

# -----------------------------------------
# Test 12: ULID uniqueness
# -----------------------------------------
echo ""
echo "--- Test 12: ULID uniqueness ---"
TOPIC_ULID_TEST="data/test/ulid_unique_$TEST_ID"

for i in 1 2 3; do
    mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_ULID_TEST" -m "{\"seq\":$i}" -q 1
done
sleep 0.5

ULID_COUNT=$(curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d "{\"statements\": [\"SELECT COUNT(DISTINCT ulid) FROM msg WHERE topic = '$TOPIC_ULID_TEST'\"]}" | \
    jq -r '.[0].results.rows[0][0]')

if [ "$ULID_COUNT" -eq 3 ]; then
    log_pass "3 unique ULIDs generated"
else
    log_fail "Expected 3 unique ULIDs, got $ULID_COUNT"
fi

# -----------------------------------------
# Test 13: ULID ordering (lexicographic = chronological)
# -----------------------------------------
echo ""
echo "--- Test 13: ULID ordering ---"
ULIDS=$(curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d "{\"statements\": [\"SELECT ulid FROM msg WHERE topic = '$TOPIC_ULID_TEST' ORDER BY ulid ASC\"]}" | \
    jq -r '.[0].results.rows[][0]')

SORTED_ULIDS=$(echo "$ULIDS" | sort)
if [ "$ULIDS" = "$SORTED_ULIDS" ]; then
    log_pass "ULIDs are lexicographically ordered"
else
    log_fail "ULIDs are not properly ordered"
fi

# -----------------------------------------
# Test 14: ULID format validation (26 chars, Crockford Base32)
# -----------------------------------------
echo ""
echo "--- Test 14: ULID format validation ---"
SAMPLE_ULID=$(curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d "{\"statements\": [\"SELECT ulid FROM msg ORDER BY ulid DESC LIMIT 1\"]}" | \
    jq -r '.[0].results.rows[0][0]')

if [[ ${#SAMPLE_ULID} -eq 26 ]] && [[ "$SAMPLE_ULID" =~ ^[0-9A-HJKMNP-TV-Z]+$ ]]; then
    log_pass "ULID format valid: $SAMPLE_ULID"
else
    log_fail "ULID format invalid: $SAMPLE_ULID (length: ${#SAMPLE_ULID})"
fi

# =========================================================================
# SECTION 5: HTTP Endpoints
# =========================================================================
log_section "Section 5: HTTP Endpoints"

# -----------------------------------------
# Test 15: Admin UI endpoint
# -----------------------------------------
echo ""
echo "--- Test 15: Admin UI endpoint ---"
STATUS=$(http_status "$ADMIN_URL/msg-admin")
if [ "$STATUS" = "200" ]; then
    log_pass "/msg-admin returns 200"
else
    log_fail "/msg-admin returns $STATUS (expected 200)"
fi

# -----------------------------------------
# Test 16: Admin UI with trailing slash
# -----------------------------------------
echo ""
echo "--- Test 16: Admin UI trailing slash ---"
STATUS=$(http_status "$ADMIN_URL/msg-admin/")
if [ "$STATUS" = "200" ]; then
    log_pass "/msg-admin/ returns 200"
else
    log_fail "/msg-admin/ returns $STATUS (expected 200)"
fi

# -----------------------------------------
# Test 17: Static files (CSS)
# -----------------------------------------
echo ""
echo "--- Test 17: Static CSS file ---"
STATUS=$(http_status "$ADMIN_URL/admin/styles.css")
if [ "$STATUS" = "200" ]; then
    log_pass "/admin/styles.css returns 200"
else
    log_fail "/admin/styles.css returns $STATUS (expected 200)"
fi

# -----------------------------------------
# Test 18: Static files (JS)
# -----------------------------------------
echo ""
echo "--- Test 18: Static JS file ---"
STATUS=$(http_status "$ADMIN_URL/admin/app.js")
if [ "$STATUS" = "200" ]; then
    log_pass "/admin/app.js returns 200"
else
    log_fail "/admin/app.js returns $STATUS (expected 200)"
fi

# -----------------------------------------
# Test 19: Database API endpoint
# -----------------------------------------
echo ""
echo "--- Test 19: Database API endpoint ---"
RESPONSE=$(curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d '{"statements": ["SELECT 1"]}')
if [[ "$RESPONSE" == *"results"* ]]; then
    log_pass "Database API responds correctly"
else
    log_fail "Database API response unexpected: $RESPONSE"
fi

# -----------------------------------------
# Test 20: App config endpoint
# -----------------------------------------
echo ""
echo "--- Test 20: App config endpoint ---"
RESPONSE=$(curl -s "$ADMIN_URL/app-config")
if [[ "$RESPONSE" == *"title"* ]] && [[ "$RESPONSE" == *"logo"* ]]; then
    log_pass "/app-config returns title and logo"
else
    log_fail "/app-config response unexpected: $RESPONSE"
fi

# -----------------------------------------
# Test 21: MQTT credentials endpoint
# -----------------------------------------
echo ""
echo "--- Test 21: MQTT credentials endpoint ---"
RESPONSE=$(curl -s "$ADMIN_URL/mqtt-credentials")
if [[ "$RESPONSE" == *"username"* ]] && [[ "$RESPONSE" == *"password"* ]]; then
    log_pass "/mqtt-credentials returns credentials"
else
    log_fail "/mqtt-credentials response unexpected: $RESPONSE"
fi

# -----------------------------------------
# Test 22: Broker config endpoint
# -----------------------------------------
echo ""
echo "--- Test 22: Broker config endpoint ---"
RESPONSE=$(curl -s "$ADMIN_URL/broker-config")
if [[ "$RESPONSE" == *"clients"* ]] || [[ "$RESPONSE" == *"roles"* ]]; then
    log_pass "/broker-config returns dynsec config"
else
    log_fail "/broker-config response unexpected: $RESPONSE"
fi

# =========================================================================
# SECTION 6: Edge Cases and Special Characters
# =========================================================================
log_section "Section 6: Edge Cases and Special Characters"

# -----------------------------------------
# Test 23: JSON payload with special characters
# -----------------------------------------
echo ""
echo "--- Test 23: Special characters in payload ---"
TOPIC_SPECIAL="data/test/special_$TEST_ID"
MSG_SPECIAL='{"text":"Hello \"World\"","emoji":"🚀","unicode":"日本語"}'
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_SPECIAL" -m "$MSG_SPECIAL" -q 1
sleep 0.5

STORED=$(db_get_payload "$TOPIC_SPECIAL")
if [[ "$STORED" == *"emoji"* ]]; then
    log_pass "Special characters stored correctly"
else
    log_fail "Special characters not stored correctly"
fi

# -----------------------------------------
# Test 24: Large payload
# -----------------------------------------
echo ""
echo "--- Test 24: Large payload ---"
TOPIC_LARGE="data/test/large_$TEST_ID"
LARGE_PAYLOAD=$(python3 -c "import json; print(json.dumps({'data': 'x' * 10000}))")
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_LARGE" -m "$LARGE_PAYLOAD" -q 1
sleep 0.5

FOUND=$(db_find_topic "$TOPIC_LARGE")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Large payload (10KB) stored"
else
    log_fail "Large payload not stored"
fi

# -----------------------------------------
# Test 25: Multi-level topic
# -----------------------------------------
echo ""
echo "--- Test 25: Multi-level topic ---"
TOPIC_MULTI="data/test/level1/level2/level3/level4_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_MULTI" -m '{"deep":true}' -q 1
sleep 0.5

FOUND=$(db_find_topic "$TOPIC_MULTI")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Multi-level topic stored"
else
    log_fail "Multi-level topic not stored"
fi

# -----------------------------------------
# Test 26: Topic with numbers
# -----------------------------------------
echo ""
echo "--- Test 26: Topic with numbers ---"
TOPIC_NUMBERS="data/test/device123/sensor456_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_NUMBERS" -m '{"num":true}' -q 1
sleep 0.5

FOUND=$(db_find_topic "$TOPIC_NUMBERS")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Topic with numbers stored"
else
    log_fail "Topic with numbers not stored"
fi

# =========================================================================
# SECTION 7: Topic Exclusion Patterns
# =========================================================================
log_section "Section 7: Topic Exclusion Patterns"

# -----------------------------------------
# Test 27: cmd/# exclusion (multi-level)
# -----------------------------------------
echo ""
echo "--- Test 27: cmd/# exclusion (multi-level) ---"
TOPIC_CMD_DEEP="cmd/test/deep/nested/action_$TEST_ID"
COUNT_BEFORE=$(db_count)
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_CMD_DEEP" -m '{"excluded":true}' -q 0
sleep 0.5
COUNT_AFTER=$(db_count)

if [ "$COUNT_AFTER" -eq "$COUNT_BEFORE" ]; then
    log_pass "Deep cmd topic correctly excluded"
else
    log_fail "Deep cmd topic was persisted (should be excluded)"
fi

# -----------------------------------------
# Test 28: data/test/# NOT excluded
# -----------------------------------------
echo ""
echo "--- Test 28: data/test/# NOT excluded ---"
TOPIC_DATA="data/test/should_persist_$TEST_ID"
COUNT_BEFORE=$(db_count)
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DATA" -m '{"persist":true}' -q 1
sleep 0.5
COUNT_AFTER=$(db_count)

if [ "$COUNT_AFTER" -gt "$COUNT_BEFORE" ]; then
    log_pass "data/test topic correctly persisted"
else
    log_fail "data/test topic was excluded (should persist)"
fi

# =========================================================================
# SECTION 8: ULID Timestamp Validation
# =========================================================================
log_section "Section 8: ULID Timestamp Validation"

# -----------------------------------------
# Test 29: Timestamp from ULID is recent (within last minute)
# -----------------------------------------
echo ""
echo "--- Test 29: ULID timestamp is recent ---"
TOPIC_TS="data/test/timestamp_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_TS" -m '{"ts_test":true}' -q 1
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_TS")
ULID=$(echo "$MSG_DATA" | jq -r '.[0]')

# Extract timestamp from ULID (first 10 chars encode milliseconds in Crockford Base32)
# Crockford Base32 alphabet: 0123456789ABCDEFGHJKMNPQRSTVWXYZ
decode_ulid_timestamp() {
    local ulid_prefix="${1:0:10}"
    local alphabet="0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    local timestamp=0
    
    for (( i=0; i<10; i++ )); do
        local char="${ulid_prefix:$i:1}"
        local value=$(echo "$alphabet" | grep -b -o "$char" | head -1 | cut -d: -f1)
        timestamp=$((timestamp * 32 + value))
    done
    
    echo $timestamp
}

ULID_MS=$(decode_ulid_timestamp "$ULID")
ULID_SEC=$((ULID_MS / 1000))
CURRENT_TS=$(date +%s)

DIFF=$((CURRENT_TS - ULID_SEC))

if [ "$DIFF" -lt 60 ] && [ "$DIFF" -ge 0 ]; then
    log_pass "ULID timestamp is within last minute (diff: ${DIFF}s)"
else
    log_fail "ULID timestamp is not recent (diff: ${DIFF}s, ulid: $ULID)"
fi

# =========================================================================
# SECTION 9: Concurrent Messages (Stress Test)
# =========================================================================
log_section "Section 9: Concurrent Messages"

# -----------------------------------------
# Test 30: Rapid fire messages
# -----------------------------------------
echo ""
echo "--- Test 30: Rapid fire messages (20 messages) ---"
TOPIC_RAPID="data/test/rapid_$TEST_ID"
COUNT_BEFORE=$(db_count)

for i in $(seq 1 20); do
    mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "${TOPIC_RAPID}_$i" -m "{\"i\":$i}" -q 0 &
done
wait
sleep 2

COUNT_AFTER=$(db_count)
ADDED=$((COUNT_AFTER - COUNT_BEFORE))

if [ "$ADDED" -eq 20 ]; then
    log_pass "All 20 rapid messages persisted"
else
    log_fail "Expected 20 messages, got $ADDED"
fi

# =========================================================================
# Summary
# =========================================================================
echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo "Total:  $((PASSED + FAILED))"
echo "========================================"

# Cleanup: show last few messages
log_info "Last 5 messages in database:"
curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d '{"statements": ["SELECT ulid, topic, payload FROM msg ORDER BY ulid DESC LIMIT 5"]}' | \
    jq -r '.[0].results.rows[] | "  \(.[1]): \(.[2][0:50])..."'

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
exit 0

COUNT_AFTER_DELETE=$(db_find_topic "$TOPIC_DELETE_ULID")
# Check that the second message still exists
REMAINING_MSG=$(curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d "{\"statements\": [\"SELECT payload FROM msg WHERE topic = '$TOPIC_DELETE_ULID' LIMIT 1\"]}" | \
    jq -r '.[0].results.rows[0][0]')

if [ "$COUNT_AFTER_DELETE" -eq 1 ] && [[ "$REMAINING_MSG" == *"second"* ]]; then
    log_pass "Targeted delete worked - first message deleted, second remains ($COUNT_BEFORE_DELETE -> $COUNT_AFTER_DELETE)"
else
    log_fail "Targeted delete failed - expected 1 message with 'second', got $COUNT_AFTER_DELETE messages, content: $REMAINING_MSG"
fi
echo ""

# -----------------------------------------
# Test 7: Delete without ULID (fallback - deletes most recent)
# -----------------------------------------
echo "--- Test 7: Delete without ULID (fallback) ---"
TOPIC_DELETE_FALLBACK="data/test/delete_fallback_$TEST_ID"

# Publish a retained message
log_info "Publishing retained message to $TOPIC_DELETE_FALLBACK"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_FALLBACK" -m '{"msg":"to_delete"}' -q 1 -r -V 5
sleep 0.5

COUNT_BEFORE_FALLBACK=$(db_find_topic "$TOPIC_DELETE_FALLBACK")
log_info "Messages before fallback delete: $COUNT_BEFORE_FALLBACK"

# Delete by sending empty retained (no ULID property - uses fallback)
log_info "Deleting message using fallback (no ULID property)"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_FALLBACK" -r -n -V 5
sleep 0.5

COUNT_AFTER_FALLBACK=$(db_find_topic "$TOPIC_DELETE_FALLBACK")
if [ "$COUNT_AFTER_FALLBACK" -eq 0 ]; then
    log_pass "Fallback delete worked - message deleted ($COUNT_BEFORE_FALLBACK -> $COUNT_AFTER_FALLBACK)"
else
    log_fail "Fallback delete failed - expected 0 messages, got $COUNT_AFTER_FALLBACK"
fi
echo ""

# -----------------------------------------
# Test 8: Query recent messages
# -----------------------------------------
echo "--- Test 8: Recent messages ---"
log_info "Last 5 messages in database:"
curl -s -X POST "$DB_URL" \
    -H "Content-Type: application/json" \
    -d '{"statements": ["SELECT ulid, topic, payload FROM msg ORDER BY ulid DESC LIMIT 5"]}' | \
    jq -r '.[0].results.rows[] | "  \(.[1]): \(.[2])"'
echo ""

# -----------------------------------------
# Summary
# -----------------------------------------
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo "========================================"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
