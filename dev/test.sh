#!/bin/bash
# Integration test script for mqbase
# Tests MQTT message persistence, topic exclusion, HTTP endpoints, and admin features
#
# This script has two sections:
# - Section A: MQTT/TCP tests (requires mosquitto_pub/mosquitto_sub)
# - Section B: WebSocket tests (requires Node.js and MQTT.js CLI)
#
# Exclusion patterns: cmd/#, test/exclude/# (transient commands not persisted)
#
# Test user can only publish to test/# topics (see mosquitto/config/dynsec.json)
#
# IMPORTANT: For tests to pass, mqbase must be started with mosquitto-test.conf:
#   Simple mode:       MOSQUITTO_CONFIG=/mosquitto/config/mosquitto-test.conf docker compose up -d
#   Multi-tenant mode: MOSQUITTO_CONFIG=/mosquitto/config/mosquitto-test.conf docker compose -f compose.multi-tenant.yml up -d

set -e

BROKER="${MQTT_BROKER:-127.0.0.1}"
PORT="${MQTT_PORT:-1883}"
WS_PORT="${MQTT_WS_PORT:-9001}"
USER="${MQTT_USER:-test}"
PASS="${MQTT_PASS:-test}"
ADMIN_USER="${MQTT_ADMIN_USER:-admin}"
ADMIN_PASS="${MQTT_ADMIN_PASS:-admin}"
ADMIN_URL="${ADMIN_URL:-http://127.0.0.1:8080}"

# Auto-detect multi-tenant mode by checking if /api/mode endpoint exists
# In multi-tenant mode, db-admin and other admin endpoints are on port 8081 (mqbase internal nginx)
MULTI_TENANT=false
if curl -s --connect-timeout 1 "http://127.0.0.1:8080/api/mode" | grep -q "multi-tenant" 2>/dev/null; then
    MULTI_TENANT=true
    INTERNAL_URL="http://127.0.0.1:8081"
    echo "Detected multi-tenant mode, using internal URL on port 8081"
fi

if [ -z "$DB_URL" ]; then
    if [ "$MULTI_TENANT" = true ]; then
        DB_URL="${INTERNAL_URL}/db-admin"
    else
        DB_URL="http://127.0.0.1:8080/db-admin"
    fi
fi
DB_USER="${DB_USER:-admin}"
DB_PASS="${DB_PASS:-admin}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
SKIPPED=0

# Tool availability flags
HAS_MOSQUITTO=false
HAS_MQTTJS=false
MQTT_CLI=""

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
log_skip() { echo -e "${CYAN}○ SKIP${NC}: $1"; SKIPPED=$((SKIPPED + 1)); }
log_info() { echo -e "${YELLOW}→${NC} $1"; }
log_section() { echo -e "\n${BLUE}=== $1 ===${NC}"; }
log_warn() { echo -e "${YELLOW}⚠ WARNING${NC}: $1"; }

# =========================================================================
# Tool Availability Checks
# =========================================================================

check_mosquitto_tools() {
    if command -v mosquitto_pub &> /dev/null && command -v mosquitto_sub &> /dev/null; then
        HAS_MOSQUITTO=true
        return 0
    else
        return 1
    fi
}

check_mqttjs_tools() {
    if command -v mqtt &> /dev/null; then
        MQTT_CLI="mqtt"
        HAS_MQTTJS=true
        return 0
    elif command -v npx &> /dev/null && npx mqtt --version &> /dev/null 2>&1; then
        MQTT_CLI="npx mqtt"
        HAS_MQTTJS=true
        return 0
    else
        return 1
    fi
}

# =========================================================================
# Database Helper Functions
# =========================================================================

# Query database and return count
db_count() {
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d '{"stmt": ["SELECT COUNT(*) FROM msg"]}' | \
        jq -r '.result.rows[0][0].value'
}

# Query database for messages matching topic pattern
db_find_topic() {
    local topic="$1"
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d "{\"stmt\": [\"SELECT COUNT(*) FROM msg WHERE topic = '$topic'\"]}" | \
        jq -r '.result.rows[0][0].value'
}

# Query database for message by topic and return payload
db_get_payload() {
    local topic="$1"
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d "{\"stmt\": [\"SELECT payload FROM msg WHERE topic = '$topic' ORDER BY ulid DESC LIMIT 1\"]}" | \
        jq -r '.result.rows[0][0].value'
}

# Query database for message fields (ulid, topic, payload, retain, qos, headers)
# Returns array of values: [ulid, topic, payload, retain, qos, headers]
db_get_message() {
    local topic="$1"
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d "{\"stmt\": [\"SELECT ulid, topic, payload, retain, qos, headers FROM msg WHERE topic = '$topic' ORDER BY ulid DESC LIMIT 1\"]}" | \
        jq -r '.result.rows[0] | [.[].value] | @json'
}

# Query database for ULID by topic
db_get_ulid() {
    local topic="$1"
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d "{\"stmt\": [\"SELECT ulid FROM msg WHERE topic = '$topic' ORDER BY ulid DESC LIMIT 1\"]}" | \
        jq -r '.result.rows[0][0].value'
}

# Query database for unique ULID count by topic
db_count_ulids() {
    local topic="$1"
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d "{\"stmt\": [\"SELECT COUNT(DISTINCT ulid) FROM msg WHERE topic = '$topic'\"]}" | \
        jq -r '.result.rows[0][0].value'
}

# Query database for ULIDs by topic (returns newline-separated list)
db_get_ulids() {
    local topic="$1"
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d "{\"stmt\": [\"SELECT ulid FROM msg WHERE topic = '$topic' ORDER BY ulid ASC\"]}" | \
        jq -r '.result.rows[][0].value'
}

# Query database for latest ULID
db_get_latest_ulid() {
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d '{"stmt": ["SELECT ulid FROM msg ORDER BY ulid DESC LIMIT 1"]}' | \
        jq -r '.result.rows[0][0].value'
}

# Execute raw SQL and return full response
db_execute() {
    local sql="$1"
    curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d "{\"stmt\": [\"$sql\"]}"
}

# Check HTTP endpoint returns expected status
http_status() {
    local url="$1"
    curl -s -o /dev/null -w "%{http_code}" "$url"
}

# =========================================================================
# Script Start
# =========================================================================

# Generate unique test ID
TEST_ID=$(date +%s)_$(head -c 4 /dev/urandom | xxd -p)

echo "========================================"
echo "mqBase Integration Test Suite"
echo "========================================"
echo "Broker: $BROKER:$PORT (WS: $WS_PORT)"
echo "User: $USER"
echo "DB URL: $DB_URL"
echo "DB User: $DB_USER"
echo "Admin URL: $ADMIN_URL"
echo "Test ID: $TEST_ID"
echo "========================================"

# Check tool availability
echo ""
echo "Checking test prerequisites..."
if check_mosquitto_tools; then
    echo -e "  ${GREEN}✓${NC} mosquitto_pub/mosquitto_sub available"
else
    echo -e "  ${RED}✗${NC} mosquitto_pub/mosquitto_sub not found (install: apt install mosquitto-clients)"
fi

if check_mqttjs_tools; then
    echo -e "  ${GREEN}✓${NC} Node.js/MQTT.js CLI available ($MQTT_CLI)"
else
    echo -e "  ${RED}✗${NC} Node.js/MQTT.js CLI not found (install: npm install -g mqtt)"
fi

if ! $HAS_MOSQUITTO && ! $HAS_MQTTJS; then
    echo ""
    echo -e "${RED}Error: No MQTT client tools available. Cannot run tests.${NC}"
    exit 1
fi

# Wait for mqbase to be ready (health check)
echo ""
echo "Waiting for mqbase to be ready..."
MAX_RETRIES=30
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -s --connect-timeout 1 "$ADMIN_URL/health" | grep -q "OK" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} nginx is ready"
        break
    fi
    RETRY=$((RETRY + 1))
    if [ $RETRY -eq $MAX_RETRIES ]; then
        echo -e "${RED}Error: mqbase not responding after ${MAX_RETRIES}s${NC}"
        exit 1
    fi
    sleep 1
done

# Wait for database to be ready
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    DB_RESPONSE=$(curl -s -X POST "$DB_URL/v1/execute" \
        -u "$DB_USER:$DB_PASS" \
        -H "Content-Type: application/json" \
        -d '{"stmt": ["SELECT 1"]}' 2>/dev/null)
    if echo "$DB_RESPONSE" | grep -q '"value":"1"' 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} database is ready"
        break
    fi
    RETRY=$((RETRY + 1))
    if [ $RETRY -eq $MAX_RETRIES ]; then
        echo -e "${RED}Error: database not responding after ${MAX_RETRIES}s${NC}"
        exit 1
    fi
    sleep 1
done

# Get initial count
INITIAL_COUNT=$(db_count)
log_info "Initial message count: $INITIAL_COUNT"

# #########################################################################
# PART A: MQTT/TCP Tests (requires mosquitto_pub/mosquitto_sub)
# #########################################################################
echo ""
echo "========================================"
echo "PART A: MQTT/TCP Tests"
echo "========================================"

if $HAS_MOSQUITTO; then
    log_info "Running MQTT/TCP tests with mosquitto_pub/mosquitto_sub..."

# =========================================================================
# SECTION 1: Basic Message Persistence
# =========================================================================
log_section "Section 1: Basic Message Persistence"

# -----------------------------------------
# Test 1: Persistent message (test/...)
# -----------------------------------------
echo ""
echo "--- Test 1: Persistent message ---"
TOPIC_PERSIST="test/sensor_$TEST_ID"
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
# Test 2: Transient message (test/exclude/...)
# -----------------------------------------
echo ""
echo "--- Test 2: Transient message (excluded) ---"
TOPIC_TRANSIENT="test/exclude/action_$TEST_ID"
MSG_TRANSIENT="{\"test_id\":\"$TEST_ID\",\"type\":\"transient\",\"action\":\"ping\"}"

log_info "Publishing to $TOPIC_TRANSIENT (should NOT be persisted - excluded by test/exclude/#)"
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
    TOPIC="test/batch_${TEST_ID}_$i"
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
TOPIC_QOS0="test/qos0_$TEST_ID"
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
TOPIC_QOS1="test/qos1_$TEST_ID"
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
TOPIC_QOS2="test/qos2_$TEST_ID"
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
TOPIC_RETAIN="test/retain_$TEST_ID"
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
TOPIC_NO_RETAIN="test/no_retain_$TEST_ID"
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
TOPIC_DELETE_ULID="test/delete_ulid_$TEST_ID"

log_info "Publishing first retained message"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DELETE_ULID" -m '{"msg":"first"}' -q 1 -r -V 5
sleep 0.5

FIRST_ULID=$(db_get_ulid "$TOPIC_DELETE_ULID")
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
TOPIC_DELETE_FALLBACK="test/delete_fallback_$TEST_ID"

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
TOPIC_ULID_TEST="test/ulid_unique_$TEST_ID"

for i in 1 2 3; do
    mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_ULID_TEST" -m "{\"seq\":$i}" -q 1
done
sleep 0.5

ULID_COUNT=$(db_count_ulids "$TOPIC_ULID_TEST")

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
ULIDS=$(db_get_ulids "$TOPIC_ULID_TEST")

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
SAMPLE_ULID=$(db_get_latest_ulid)

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
# Test 15: Admin UI endpoint (root)
# -----------------------------------------
echo ""
echo "--- Test 15: Admin UI endpoint (root) ---"
STATUS=$(http_status "$ADMIN_URL/")
if [ "$STATUS" = "200" ]; then
    log_pass "/ (Admin UI) returns 200"
else
    log_fail "/ (Admin UI) returns $STATUS (expected 200)"
fi

# -----------------------------------------
# Test 16: Static files (CSS)
# -----------------------------------------
echo ""
echo "--- Test 16: Static CSS file ---"
STATUS=$(http_status "$ADMIN_URL/admin/styles.css")
if [ "$STATUS" = "200" ]; then
    log_pass "/admin/styles.css returns 200"
else
    log_fail "/admin/styles.css returns $STATUS (expected 200)"
fi

# -----------------------------------------
# Test 17: Static files (JS)
# -----------------------------------------
echo ""
echo "--- Test 17: Static JS file ---"
STATUS=$(http_status "$ADMIN_URL/admin/app.js")
if [ "$STATUS" = "200" ]; then
    log_pass "/admin/app.js returns 200"
else
    log_fail "/admin/app.js returns $STATUS (expected 200)"
fi

# -----------------------------------------
# Test 18: Database API endpoint
# -----------------------------------------
echo ""
echo "--- Test 18: Database API endpoint ---"
RESPONSE=$(db_execute "SELECT 1")
if [[ "$RESPONSE" == *"result"* ]]; then
    log_pass "Database API responds correctly"
else
    log_fail "Database API response unexpected: $RESPONSE"
fi

# -----------------------------------------
# Test 19: App config endpoint
# -----------------------------------------
echo ""
echo "--- Test 19: App config endpoint ---"
RESPONSE=$(curl -s "$ADMIN_URL/app-config")
if [[ "$RESPONSE" == *"title"* ]] && [[ "$RESPONSE" == *"logo"* ]]; then
    log_pass "/app-config returns title and logo"
else
    log_fail "/app-config response unexpected: $RESPONSE"
fi

# -----------------------------------------
# Test 20: MQTT credentials endpoint
# -----------------------------------------
echo ""
echo "--- Test 20: MQTT credentials endpoint ---"
if [ "$MULTI_TENANT" = true ]; then
    RESPONSE=$(curl -s -u "$DB_USER:$DB_PASS" "$INTERNAL_URL/mqtt-credentials")
else
    RESPONSE=$(curl -s -u "$DB_USER:$DB_PASS" "$ADMIN_URL/mqtt-credentials")
fi
if [[ "$RESPONSE" == *"username"* ]] && [[ "$RESPONSE" == *"password"* ]]; then
    log_pass "/mqtt-credentials returns credentials"
else
    log_fail "/mqtt-credentials response unexpected: $RESPONSE"
fi

# -----------------------------------------
# Test 21: Broker config endpoint
# -----------------------------------------
echo ""
echo "--- Test 21: Broker config endpoint ---"
if [ "$MULTI_TENANT" = true ]; then
    RESPONSE=$(curl -s -u "$DB_USER:$DB_PASS" "$INTERNAL_URL/broker-config")
else
    RESPONSE=$(curl -s -u "$DB_USER:$DB_PASS" "$ADMIN_URL/broker-config")
fi
if [[ "$RESPONSE" == *"clients"* ]] || [[ "$RESPONSE" == *"roles"* ]]; then
    log_pass "/broker-config returns dynsec config"
else
    log_fail "/broker-config response unexpected: $RESPONSE"
fi

# -----------------------------------------
# Test 22: Health endpoint
# -----------------------------------------
echo ""
echo "--- Test 22: Health endpoint ---"
STATUS=$(http_status "$ADMIN_URL/health")
RESPONSE=$(curl -s "$ADMIN_URL/health")
if [ "$STATUS" = "200" ] && [ "$RESPONSE" = "OK" ]; then
    log_pass "/health returns 200 OK"
else
    log_fail "/health returns $STATUS (expected 200 OK)"
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
TOPIC_SPECIAL="test/special_$TEST_ID"
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
TOPIC_LARGE="test/large_$TEST_ID"
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
TOPIC_MULTI="test/level1/level2/level3/level4_$TEST_ID"
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
TOPIC_NUMBERS="test/device123/sensor456_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_NUMBERS" -m '{"num":true}' -q 1
sleep 0.5

FOUND=$(db_find_topic "$TOPIC_NUMBERS")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Topic with numbers stored"
else
    log_fail "Topic with numbers not stored"
fi

# -----------------------------------------
# Test 27: Empty payload
# -----------------------------------------
echo ""
echo "--- Test 27: Empty payload ---"
TOPIC_EMPTY="test/empty_payload_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_EMPTY" -m '' -q 1
sleep 0.5

FOUND=$(db_find_topic "$TOPIC_EMPTY")
if [ "$FOUND" -ge 1 ]; then
    PAYLOAD=$(db_get_payload "$TOPIC_EMPTY")
    if [ -z "$PAYLOAD" ] || [ "$PAYLOAD" = "null" ]; then
        log_pass "Empty payload stored correctly"
    else
        log_pass "Empty payload stored (as: '$PAYLOAD')"
    fi
else
    log_fail "Empty payload message not stored"
fi

# -----------------------------------------
# Test 28: Binary payload
# -----------------------------------------
echo ""
echo "--- Test 28: Binary payload ---"
TOPIC_BINARY="test/binary_payload_$TEST_ID"
# Generate 100 bytes of random binary data and send it
BINARY_DATA=$(head -c 100 /dev/urandom | base64)
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_BINARY" -m "$BINARY_DATA" -q 1
sleep 0.5

FOUND=$(db_find_topic "$TOPIC_BINARY")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Binary payload (base64 encoded) stored"
else
    log_fail "Binary payload not stored"
fi

# =========================================================================
# SECTION 7: Topic Exclusion Patterns
# =========================================================================
log_section "Section 7: Topic Exclusion Patterns"

# -----------------------------------------
# Test 29: test/exclude/# exclusion (multi-level)
# -----------------------------------------
echo ""
echo "--- Test 29: test/exclude/# exclusion (multi-level) ---"
TOPIC_CMD_DEEP="test/exclude/deep/nested/action_$TEST_ID"
COUNT_BEFORE=$(db_count)
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_CMD_DEEP" -m '{"excluded":true}' -q 0
sleep 0.5
COUNT_AFTER=$(db_count)

if [ "$COUNT_AFTER" -eq "$COUNT_BEFORE" ]; then
    log_pass "Deep excluded topic correctly excluded"
else
    log_fail "Deep excluded topic was persisted (should be excluded)"
fi

# -----------------------------------------
# Test 30: test/exclude/# exclusion pattern
# -----------------------------------------
echo ""
echo "--- Test 30: test/exclude/# exclusion pattern ---"
# mosquitto.conf has: plugin_opt_exclude_topics cmd/#,test/exclude/#
TOPIC_EXCL_PATTERN="test/exclude/sensor_$TEST_ID"
COUNT_BEFORE=$(db_count)
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_EXCL_PATTERN" -m '{"should_exclude":true}' -q 1
sleep 0.5
COUNT_AFTER=$(db_count)

if [ "$COUNT_AFTER" -eq "$COUNT_BEFORE" ]; then
    log_pass "test/exclude/# pattern correctly excluded"
else
    log_fail "test/exclude/# pattern was persisted (should be excluded)"
fi

# -----------------------------------------
# Test 31: test/# NOT excluded
# -----------------------------------------
echo ""
echo "--- Test 31: test/# NOT excluded ---"
TOPIC_DATA="test/should_persist_$TEST_ID"
COUNT_BEFORE=$(db_count)
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_DATA" -m '{"persist":true}' -q 1
sleep 0.5
COUNT_AFTER=$(db_count)

if [ "$COUNT_AFTER" -gt "$COUNT_BEFORE" ]; then
    log_pass "test/ topic correctly persisted"
else
    log_fail "test/ topic was excluded (should persist)"
fi

# =========================================================================
# SECTION 8: ULID Timestamp Validation
# =========================================================================
log_section "Section 8: ULID Timestamp Validation"

# -----------------------------------------
# Test 32: Timestamp from ULID is recent (within last minute)
# -----------------------------------------
echo ""
echo "--- Test 32: ULID timestamp is recent ---"
TOPIC_TS="test/timestamp_$TEST_ID"
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
# Test 33: Rapid fire messages
# -----------------------------------------
echo ""
echo "--- Test 33: Rapid fire messages (20 messages) ---"
TOPIC_RAPID="test/rapid_$TEST_ID"
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
# SECTION 10: MQTT User Properties (Headers)
# =========================================================================
log_section "Section 10: MQTT User Properties (Headers)"

# -----------------------------------------
# Test 34: Message with user properties stored as headers
# -----------------------------------------
echo ""
echo "--- Test 34: User properties stored as headers ---"
TOPIC_HEADERS="test/headers_$TEST_ID"
# mosquitto_pub -D option adds user properties
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" \
    -t "$TOPIC_HEADERS" -m '{"test":"headers"}' -q 1 \
    -D PUBLISH user-property "source" "sensor-1" \
    -D PUBLISH user-property "priority" "high"
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_HEADERS")
HEADERS=$(echo "$MSG_DATA" | jq -r '.[5]')

if [ "$HEADERS" != "null" ] && echo "$HEADERS" | grep -q "source=sensor-1" && echo "$HEADERS" | grep -q "priority=high"; then
    log_pass "User properties stored as headers: $HEADERS"
else
    log_fail "Headers not stored correctly, got: $HEADERS"
fi

# -----------------------------------------
# Test 35: Message without user properties has null headers
# -----------------------------------------
echo ""
echo "--- Test 35: Message without user properties ---"
TOPIC_NO_HEADERS="test/noheaders_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" \
    -t "$TOPIC_NO_HEADERS" -m '{"test":"no headers"}' -q 1
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_NO_HEADERS")
HEADERS=$(echo "$MSG_DATA" | jq -r '.[5]')

if [ "$HEADERS" = "null" ] || [ -z "$HEADERS" ]; then
    log_pass "No headers stored for message without user properties"
else
    log_fail "Expected null headers, got: $HEADERS"
fi

# -----------------------------------------
# Test 36: Excluded headers are not stored
# -----------------------------------------
echo ""
echo "--- Test 36: Excluded headers are not stored ---"
TOPIC_EXCL_HEADERS="test/excl_headers_$TEST_ID"
# Send message with both included and excluded headers
# mosquitto.conf has: plugin_opt_exclude_headers header-to-exclude,another-header
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" \
    -t "$TOPIC_EXCL_HEADERS" -m '{"test":"excluded headers"}' -q 1 \
    -D PUBLISH user-property "allowed-header" "value1" \
    -D PUBLISH user-property "header-to-exclude" "secret" \
    -D PUBLISH user-property "another-header" "also-secret" \
    -D PUBLISH user-property "visible" "yes"
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_EXCL_HEADERS")
HEADERS=$(echo "$MSG_DATA" | jq -r '.[5]')

# Should contain allowed-header and visible, but NOT header-to-exclude or another-header
if echo "$HEADERS" | grep -q "allowed-header=value1" && \
   echo "$HEADERS" | grep -q "visible=yes" && \
   ! echo "$HEADERS" | grep -q "header-to-exclude" && \
   ! echo "$HEADERS" | grep -q "another-header"; then
    log_pass "Excluded headers correctly filtered: $HEADERS"
else
    log_fail "Header exclusion failed, got: $HEADERS"
fi

# -----------------------------------------
# Test 37: Multiple headers with same allowed name
# -----------------------------------------
echo ""
echo "--- Test 37: Multiple headers stored correctly ---"
TOPIC_MULTI_HEADERS="test/multi_headers_$TEST_ID"
mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" \
    -t "$TOPIC_MULTI_HEADERS" -m '{"test":"multi headers"}' -q 1 \
    -D PUBLISH user-property "tag" "sensor" \
    -D PUBLISH user-property "tag" "outdoor" \
    -D PUBLISH user-property "unit" "celsius"
sleep 0.5

MSG_DATA=$(db_get_message "$TOPIC_MULTI_HEADERS")
HEADERS=$(echo "$MSG_DATA" | jq -r '.[5]')

# Should contain all three headers (tag appears twice with different values)
if echo "$HEADERS" | grep -q "tag=sensor" && \
   echo "$HEADERS" | grep -q "tag=outdoor" && \
   echo "$HEADERS" | grep -q "unit=celsius"; then
    log_pass "Multiple headers stored correctly: $HEADERS"
else
    log_fail "Multiple headers not stored correctly, got: $HEADERS"
fi

# =========================================================================
# SECTION 11: Security and Authentication
# =========================================================================
log_section "Section 11: Security and Authentication"

# -----------------------------------------
# Test 38: Invalid credentials rejected
# -----------------------------------------
echo ""
echo "--- Test 38: Invalid credentials rejected ---"
TOPIC_INVALID="test/invalid_auth_$TEST_ID"

# Try to publish with wrong password (should fail)
if mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "wrongpassword" -t "$TOPIC_INVALID" -m '{"should":"fail"}' -q 1 2>/dev/null; then
    log_fail "Connection with invalid credentials should have been rejected"
else
    log_pass "Invalid credentials correctly rejected"
fi

# -----------------------------------------
# Test 39: Invalid username rejected
# -----------------------------------------
echo ""
echo "--- Test 39: Invalid username rejected ---"
if mosquitto_pub -h "$BROKER" -p "$PORT" -u "nonexistent_user" -P "anypass" -t "$TOPIC_INVALID" -m '{"should":"fail"}' -q 1 2>/dev/null; then
    log_fail "Connection with invalid username should have been rejected"
else
    log_pass "Invalid username correctly rejected"
fi

# -----------------------------------------
# Test 40: No credentials rejected
# -----------------------------------------
echo ""
echo "--- Test 40: No credentials rejected ---"
if mosquitto_pub -h "$BROKER" -p "$PORT" -t "$TOPIC_INVALID" -m '{"should":"fail"}' -q 1 2>/dev/null; then
    log_fail "Anonymous connection should have been rejected"
else
    log_pass "Anonymous connection correctly rejected"
fi

else
    # Skip MQTT/TCP tests
    log_warn "mosquitto_pub/mosquitto_sub not found - skipping MQTT/TCP tests"
    log_info "Install with: apt install mosquitto-clients"
fi

# #########################################################################
# PART B: WebSocket Tests (requires Node.js and MQTT.js CLI)
# #########################################################################
echo ""
echo "========================================"
echo "PART B: WebSocket Tests"
echo "========================================"

if $HAS_MQTTJS; then
    log_info "Running WebSocket tests with $MQTT_CLI..."
    
    # WebSocket options for MQTT.js CLI
    #WS_OPTS="-h $BROKER -C wss --path /mqtt -u $USER -P $PASS"
    WS_OPTS="-h $BROKER -p $WS_PORT -C ws -u $USER -P $PASS"

# =========================================================================
# SECTION 12: WebSocket Connectivity
# =========================================================================
log_section "Section 12: WebSocket Connectivity"

# -----------------------------------------
# Test WS-1: Basic WebSocket connection
# -----------------------------------------
echo ""
echo "--- Test WS-1: WebSocket connection test ---"
#log_info "Testing WebSocket connection to wss://$BROKER/mqtt"
log_info "Testing WebSocket connection to ws://$BROKER:$WS_PORT"

TOPIC_WS1="test/ws_connect_$TEST_ID"
MSG_WS1="{\"test_id\":\"$TEST_ID\",\"type\":\"ws_connection_test\"}"

if $MQTT_CLI pub $WS_OPTS -t "$TOPIC_WS1" -m "$MSG_WS1" 2>/dev/null; then
    log_pass "WebSocket connection successful"
else
    log_fail "WebSocket connection failed"
fi

sleep 0.5

FOUND=$(db_find_topic "$TOPIC_WS1")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Message persisted via WebSocket ($FOUND message(s))"
else
    log_fail "Message not found in database"
fi

# -----------------------------------------
# Test WS-2: WebSocket publish with QoS 1
# -----------------------------------------
echo ""
echo "--- Test WS-2: WebSocket publish with QoS 1 ---"
TOPIC_WS2="test/ws_qos1_$TEST_ID"
MSG_WS2="{\"test_id\":\"$TEST_ID\",\"qos\":1}"

log_info "Publishing with QoS 1 via WebSocket"
if $MQTT_CLI pub $WS_OPTS -t "$TOPIC_WS2" -m "$MSG_WS2" -q 1 2>/dev/null; then
    log_pass "QoS 1 publish successful"
else
    log_fail "QoS 1 publish failed"
fi

sleep 0.5
PAYLOAD=$(db_get_payload "$TOPIC_WS2")
if [[ "$PAYLOAD" == *"$TEST_ID"* ]]; then
    log_pass "QoS 1 message payload verified"
else
    log_fail "QoS 1 message payload mismatch"
fi

# -----------------------------------------
# Test WS-3: WebSocket publish with retained flag
# -----------------------------------------
echo ""
echo "--- Test WS-3: WebSocket publish with retained flag ---"
TOPIC_WS3="test/ws_retained_$TEST_ID"
MSG_WS3="{\"test_id\":\"$TEST_ID\",\"retained\":true}"

log_info "Publishing retained message via WebSocket"
if $MQTT_CLI pub $WS_OPTS -t "$TOPIC_WS3" -m "$MSG_WS3" -r 2>/dev/null; then
    log_pass "Retained publish successful"
else
    log_fail "Retained publish failed"
fi

sleep 0.5
FOUND=$(db_find_topic "$TOPIC_WS3")
if [ "$FOUND" -ge 1 ]; then
    log_pass "Retained message persisted"
else
    log_fail "Retained message not found in database"
fi

# =========================================================================
# SECTION 13: WebSocket Subscribe and Cross-Protocol Message Flow
# =========================================================================
log_section "Section 13: Cross-Protocol Message Flow"

# -----------------------------------------
# Test WS-4: Publish via MQTT, receive via WebSocket
# -----------------------------------------
echo ""
echo "--- Test WS-4: Cross-protocol (MQTT -> WebSocket) ---"
TOPIC_WS4="test/ws_cross_$TEST_ID"
MSG_WS4="{\"test_id\":\"$TEST_ID\",\"direction\":\"mqtt_to_ws\"}"
RECEIVED_FILE="/tmp/ws_test_${TEST_ID}.txt"

if $HAS_MOSQUITTO; then
    log_info "Starting WebSocket subscriber..."
    timeout 5 $MQTT_CLI sub $WS_OPTS -t "$TOPIC_WS4" > "$RECEIVED_FILE" 2>/dev/null &
    SUB_PID=$!
    sleep 1

    log_info "Publishing via standard MQTT..."
    mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_WS4" -m "$MSG_WS4" -q 1

    sleep 1
    kill $SUB_PID 2>/dev/null || true
    wait $SUB_PID 2>/dev/null || true

    if [ -f "$RECEIVED_FILE" ] && grep -q "$TEST_ID" "$RECEIVED_FILE" 2>/dev/null; then
        log_pass "Message received via WebSocket: $(cat "$RECEIVED_FILE")"
    else
        log_fail "Message not received via WebSocket"
    fi
    rm -f "$RECEIVED_FILE"
else
    log_skip "Cross-protocol test requires mosquitto_pub"
fi

# -----------------------------------------
# Test WS-5: Publish via WebSocket, receive via MQTT
# -----------------------------------------
echo ""
echo "--- Test WS-5: Cross-protocol (WebSocket -> MQTT) ---"
TOPIC_WS5="test/ws_reverse_$TEST_ID"
MSG_WS5="{\"test_id\":\"$TEST_ID\",\"direction\":\"ws_to_mqtt\"}"
RECEIVED_FILE="/tmp/ws_test2_${TEST_ID}.txt"

if $HAS_MOSQUITTO; then
    log_info "Starting MQTT subscriber..."
    timeout 5 mosquitto_sub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" -t "$TOPIC_WS5" -C 1 > "$RECEIVED_FILE" 2>/dev/null &
    SUB_PID=$!
    sleep 1

    log_info "Publishing via WebSocket..."
    $MQTT_CLI pub $WS_OPTS -t "$TOPIC_WS5" -m "$MSG_WS5" -q 1 2>/dev/null

    wait $SUB_PID 2>/dev/null || true

    if [ -f "$RECEIVED_FILE" ] && grep -q "$TEST_ID" "$RECEIVED_FILE" 2>/dev/null; then
        log_pass "Message received via MQTT: $(cat "$RECEIVED_FILE")"
    else
        log_fail "Message not received via MQTT"
    fi
    rm -f "$RECEIVED_FILE"
else
    log_skip "Cross-protocol test requires mosquitto_sub"
fi

# =========================================================================
# SECTION 14: WebSocket Topic Exclusion
# =========================================================================
log_section "Section 14: WebSocket Topic Exclusion"

# -----------------------------------------
# Test WS-6: Excluded topic via WebSocket
# -----------------------------------------
echo ""
echo "--- Test WS-6: Excluded topic (test/exclude/#) via WebSocket ---"
TOPIC_WS6="test/exclude/ws_excluded_$TEST_ID"
MSG_WS6="{\"test_id\":\"$TEST_ID\",\"excluded\":true}"

log_info "Publishing to excluded topic via WebSocket"
$MQTT_CLI pub $WS_OPTS -t "$TOPIC_WS6" -m "$MSG_WS6" 2>/dev/null

sleep 0.5
FOUND=$(db_find_topic "$TOPIC_WS6")
if [ "$FOUND" -eq 0 ]; then
    log_pass "Excluded topic correctly not persisted"
else
    log_fail "Excluded topic was persisted ($FOUND messages)"
fi

# =========================================================================
# SECTION 15: WebSocket Batch Publishing
# =========================================================================
log_section "Section 15: WebSocket Batch Publishing"

# -----------------------------------------
# Test WS-7: Multiple rapid messages via WebSocket
# -----------------------------------------
echo ""
echo "--- Test WS-7: Rapid batch publishing via WebSocket ---"
BATCH_COUNT=10
log_info "Publishing $BATCH_COUNT messages rapidly via WebSocket..."

for i in $(seq 1 $BATCH_COUNT); do
    TOPIC="test/ws_batch_${TEST_ID}_$i"
    MSG="{\"test_id\":\"$TEST_ID\",\"batch\":$i}"
    $MQTT_CLI pub $WS_OPTS -t "$TOPIC" -m "$MSG" 2>/dev/null &
done
wait

sleep 1

PERSISTED=0
for i in $(seq 1 $BATCH_COUNT); do
    TOPIC="test/ws_batch_${TEST_ID}_$i"
    COUNT=$(db_find_topic "$TOPIC")
    if [ "$COUNT" -ge 1 ]; then
        PERSISTED=$((PERSISTED + 1))
    fi
done

if [ "$PERSISTED" -eq "$BATCH_COUNT" ]; then
    log_pass "All $BATCH_COUNT batch messages persisted"
else
    log_fail "Only $PERSISTED of $BATCH_COUNT batch messages persisted"
fi

else
    # Skip WebSocket tests
    log_warn "Node.js/MQTT.js CLI not found - skipping WebSocket tests"
    log_info "Install with: npm install -g mqtt"
fi

# =========================================================================
# Summary
# =========================================================================
echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "Passed:  ${GREEN}$PASSED${NC}"
echo -e "Failed:  ${RED}$FAILED${NC}"
echo -e "Skipped: ${CYAN}$SKIPPED${NC}"
echo "Total:   $((PASSED + FAILED + SKIPPED))"
echo "========================================"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
