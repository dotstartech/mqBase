#!/bin/bash
# Stress test script for mqbase
# Fires high volume of MQTT messages and measures throughput
# Requirements: mosquitto_pub, curl, jq, bc

set -e

# Configuration
BROKER="${MQTT_BROKER:-127.0.0.1}"
PORT="${MQTT_PORT:-1883}"
USER="${MQTT_USER:-test}"
PASS="${MQTT_PASS:-test}"
DB_URL="${DB_URL:-http://127.0.0.1:8080/db-admin}"
DB_USER="${DB_USER:-admin}"
DB_PASS="${DB_PASS:-admin}"

# Default test parameters
TOTAL_MESSAGES=1000
DURATION=10
PARALLEL=200
QOS=0
RETAINED=false
MEASURE_LATENCY=false
SHOW_SAMPLES=false
TOPIC_PREFIX="data/test/stress"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Help function
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -n, --messages NUM      Total number of messages (default: 1000)"
    echo "  -d, --duration SECS     Duration in seconds for rate display (default: 5)"
    echo "  -p, --publishers NUM    Number of parallel publishers (default: 20)"
    echo "  -q, --qos LEVEL         QoS level 0, 1, or 2 (default: 0)"
    echo "  -r, --retained          Send all messages as retained"
    echo "  -l, --latency           Measure message processing latency"
    echo "  -s, --samples           Show sample of stored messages"
    echo "  -h, --help              Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 -n 500 --duration 5 --publishers 30"
    echo "  $0 -n 1000 -p 100 --qos 1"
    echo "  $0 -n 100 -p 10 --retained"
    exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--messages)
            TOTAL_MESSAGES="$2"
            shift 2
            ;;
        -d|--duration)
            DURATION="$2"
            shift 2
            ;;
        -p|--publishers)
            PARALLEL="$2"
            shift 2
            ;;
        -q|--qos)
            QOS="$2"
            shift 2
            ;;
        -r|--retained)
            RETAINED=true
            shift
            ;;
        -l|--latency)
            MEASURE_LATENCY=true
            shift
            ;;
        -s|--samples)
            SHOW_SAMPLES=true
            shift
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Build mosquitto_pub options
MOSQUITTO_OPTS="-q $QOS"
if [ "$RETAINED" = true ]; then
    MOSQUITTO_OPTS="$MOSQUITTO_OPTS -r"
fi

log_info() { echo -e "${CYAN}→${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }

# Query database and return count
db_count() {
    curl -s -u "$DB_USER:$DB_PASS" -X POST "$DB_URL/" \
        -H "Content-Type: application/json" \
        -d '{"statements": ["SELECT COUNT(*) FROM msg"]}' | \
        jq -r '.[0].results.rows[0][0]' 2>/dev/null || echo "0"
}

# ULID Crockford Base32 decoding table
ulid_decode_char() {
    local char="$1"
    case "$char" in
        0) echo 0 ;; 1) echo 1 ;; 2) echo 2 ;; 3) echo 3 ;; 4) echo 4 ;;
        5) echo 5 ;; 6) echo 6 ;; 7) echo 7 ;; 8) echo 8 ;; 9) echo 9 ;;
        A|a) echo 10 ;; B|b) echo 11 ;; C|c) echo 12 ;; D|d) echo 13 ;;
        E|e) echo 14 ;; F|f) echo 15 ;; G|g) echo 16 ;; H|h) echo 17 ;;
        J|j) echo 18 ;; K|k) echo 19 ;; M|m) echo 20 ;; N|n) echo 21 ;;
        P|p) echo 22 ;; Q|q) echo 23 ;; R|r) echo 24 ;; S|s) echo 25 ;;
        T|t) echo 26 ;; V|v) echo 27 ;; W|w) echo 28 ;; X|x) echo 29 ;;
        Y|y) echo 30 ;; Z|z) echo 31 ;;
        *) echo 0 ;;
    esac
}

# Extract timestamp (ms) from ULID - first 10 chars encode time
ulid_to_timestamp() {
    local ulid="$1"
    local ts_part="${ulid:0:10}"
    local result=0
    for ((i=0; i<10; i++)); do
        local char="${ts_part:$i:1}"
        local val=$(ulid_decode_char "$char")
        result=$((result * 32 + val))
    done
    echo $result
}

# Calculate latency statistics from stored messages
calculate_latency() {
    local test_id="$1"
    log_info "Calculating message processing latency..."
    
    # Query messages with their ULIDs and payloads
    local query="SELECT ulid, payload FROM msg WHERE payload LIKE '%$test_id%' LIMIT 1000"
    local result=$(curl -s -u "$DB_USER:$DB_PASS" -X POST "$DB_URL/" \
        -H "Content-Type: application/json" \
        -d "{\"statements\": [\"$query\"]}")
    
    # Extract latencies
    local latencies=()
    local count=0
    
    while IFS= read -r line; do
        local ulid=$(echo "$line" | jq -r '.[0]' 2>/dev/null)
        local payload=$(echo "$line" | jq -r '.[1]' 2>/dev/null)
        
        if [ -n "$ulid" ] && [ "$ulid" != "null" ]; then
            # Extract send timestamp from payload
            local send_ts=$(echo "$payload" | jq -r '.ts' 2>/dev/null)
            if [ -n "$send_ts" ] && [ "$send_ts" != "null" ]; then
                # Get storage timestamp from ULID
                local store_ts=$(ulid_to_timestamp "$ulid")
                local latency=$((store_ts - send_ts))
                if [ $latency -ge 0 ] && [ $latency -lt 60000 ]; then  # Sanity check: 0-60s
                    latencies+=($latency)
                    count=$((count + 1))
                fi
            fi
        fi
    done < <(echo "$result" | jq -c '.[0].results.rows[]' 2>/dev/null)
    
    if [ $count -eq 0 ]; then
        log_warn "Could not calculate latency (no valid samples)"
        return
    fi
    
    # Calculate statistics
    local sum=0
    local min=${latencies[0]}
    local max=${latencies[0]}
    
    for lat in "${latencies[@]}"; do
        sum=$((sum + lat))
        [ $lat -lt $min ] && min=$lat
        [ $lat -gt $max ] && max=$lat
    done
    
    local avg=$((sum / count))
    
    # Sort for percentiles
    IFS=$'\n' sorted=($(sort -n <<<"${latencies[*]}"))
    unset IFS
    
    local p50_idx=$((count * 50 / 100))
    local p95_idx=$((count * 95 / 100))
    local p99_idx=$((count * 99 / 100))
    
    [ $p50_idx -ge $count ] && p50_idx=$((count - 1))
    [ $p95_idx -ge $count ] && p95_idx=$((count - 1))
    [ $p99_idx -ge $count ] && p99_idx=$((count - 1))
    
    local p50=${sorted[$p50_idx]}
    local p95=${sorted[$p95_idx]}
    local p99=${sorted[$p99_idx]}
    
    echo ""
    echo "Latency (end-to-end: publish → database storage):"
    echo "  Samples:  $count messages"
    echo "  Min:      ${min}ms"
    echo "  Max:      ${max}ms"
    echo "  Average:  ${avg}ms"
    echo "  P50:      ${p50}ms"
    echo "  P95:      ${p95}ms"
    echo "  P99:      ${p99}ms"
    echo ""
    echo "  Note: Latency includes MQTT publish, broker processing,"
    echo "        plugin insert to sqld using C API, and database write."
}

# Generate unique test ID
TEST_ID=$(date +%s)_stress

# Calculate target rate for display
TARGET_RATE=$((TOTAL_MESSAGES / DURATION))

echo "========================================"
echo "mqBase Stress Test"
echo "========================================"
echo "Broker: $BROKER:$PORT"
echo "User: $USER"
echo "DB URL: $DB_URL"
echo "Test ID: $TEST_ID"
echo ""
echo "Parameters:"
echo "  Total Messages: $TOTAL_MESSAGES"
echo "  Parallel Publishers: $PARALLEL"
echo "  QoS Level: $QOS"
echo "  Retained: $RETAINED"
echo "  Measure Latency: $MEASURE_LATENCY"
echo "  Target Rate: ~$TARGET_RATE msg/s"
echo "========================================"
echo ""

# Calculate messages per publisher
MSGS_PER_PUBLISHER=$((TOTAL_MESSAGES / PARALLEL))
EXPECTED_MESSAGES=$((MSGS_PER_PUBLISHER * PARALLEL))

log_info "Each publisher will send $MSGS_PER_PUBLISHER messages"
echo ""

# Get initial count
log_info "Getting initial message count..."
INITIAL_COUNT=$(db_count)
log_info "Initial count: $INITIAL_COUNT"
echo ""

# Create temp directory for message files
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Pre-generate message files for each publisher (much faster than generating on-the-fly)
log_info "Pre-generating message payloads..."
if [ "$MEASURE_LATENCY" = true ]; then
    # For latency measurement, we'll generate messages with timestamps just before sending
    log_info "Latency measurement enabled - timestamps will be added at send time"
else
    for pub_id in $(seq 1 $PARALLEL); do
        MSG_FILE="$TEMP_DIR/pub${pub_id}.txt"
        for seq in $(seq 1 $MSGS_PER_PUBLISHER); do
            echo "{\"t\":\"$TEST_ID\",\"p\":$pub_id,\"s\":$seq}"
        done > "$MSG_FILE"
    done
fi
log_success "Prepared $((PARALLEL * MSGS_PER_PUBLISHER)) message payloads"
echo ""

# Start stress test
log_info "Starting stress test..."
START_TIME=$(date +%s.%N)

# Launch parallel publishers
PIDS=()
for pub_id in $(seq 1 $PARALLEL); do
    TOPIC="${TOPIC_PREFIX}/pub${pub_id}"
    if [ "$MEASURE_LATENCY" = true ]; then
        # Generate messages with current timestamp and send
        (
            for seq in $(seq 1 $MSGS_PER_PUBLISHER); do
                TS=$(date +%s%3N)  # milliseconds since epoch
                echo "{\"t\":\"$TEST_ID\",\"p\":$pub_id,\"s\":$seq,\"ts\":$TS}"
            done | mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" \
                -t "$TOPIC" -l $MOSQUITTO_OPTS
        ) &
        PIDS+=($!)
    else
        MSG_FILE="$TEMP_DIR/pub${pub_id}.txt"
        mosquitto_pub -h "$BROKER" -p "$PORT" -u "$USER" -P "$PASS" \
            -t "$TOPIC" -l $MOSQUITTO_OPTS < "$MSG_FILE" &
        PIDS+=($!)
    fi
done

# Show progress
log_info "Launched $PARALLEL parallel publishers..."
log_info "Waiting for completion..."

# Wait for all publishers to complete
for pid in "${PIDS[@]}"; do
    wait $pid 2>/dev/null || true
done

END_TIME=$(date +%s.%N)
ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)

echo ""
log_success "All publishers completed in ${ELAPSED}s"
echo ""

# Wait for database to catch up (poll until count stabilizes)
log_info "Waiting for database to process messages..."
PREV_COUNT=0
STABLE_CHECKS=0
for i in $(seq 1 30); do
    sleep 1
    CURRENT_COUNT=$(db_count)
    if [ "$CURRENT_COUNT" = "$PREV_COUNT" ]; then
        STABLE_CHECKS=$((STABLE_CHECKS + 1))
        if [ $STABLE_CHECKS -ge 2 ]; then
            log_success "Database stabilized after ${i}s"
            break
        fi
    else
        STABLE_CHECKS=0
    fi
    PREV_COUNT=$CURRENT_COUNT
    echo -ne "\r  Processed so far: $((CURRENT_COUNT - INITIAL_COUNT)) / $EXPECTED_MESSAGES"
done
echo ""

# Get final count
FINAL_COUNT=$(db_count)
MESSAGES_STORED=$((FINAL_COUNT - INITIAL_COUNT))
EXPECTED_MESSAGES=$((MSGS_PER_PUBLISHER * PARALLEL))

# Calculate statistics
if (( $(echo "$ELAPSED > 0" | bc -l) )); then
    ACTUAL_RATE=$(echo "scale=0; $MESSAGES_STORED / $ELAPSED" | bc)
    PUBLISH_RATE=$(echo "scale=0; $EXPECTED_MESSAGES / $ELAPSED" | bc)
else
    ACTUAL_RATE=0
    PUBLISH_RATE=0
fi

if [ "$EXPECTED_MESSAGES" -gt 0 ]; then
    STORAGE_EFFICIENCY=$(echo "scale=2; $MESSAGES_STORED * 100 / $EXPECTED_MESSAGES" | bc)
else
    STORAGE_EFFICIENCY="0"
fi

echo "========================================"
echo "Stress Test Results"
echo "========================================"
echo ""
echo "Messages:"
echo "  Expected:   $EXPECTED_MESSAGES"
echo "  Stored:     $MESSAGES_STORED"
echo "  Efficiency: ${STORAGE_EFFICIENCY}%"
echo ""
echo "Performance:"
echo "  Test Duration:    ${ELAPSED}s"
echo "  Publish Rate:     ${PUBLISH_RATE} msg/s (sent)"
echo "  Storage Rate:     ${ACTUAL_RATE} msg/s (stored)"
echo ""

# Calculate latency if enabled
if [ "$MEASURE_LATENCY" = true ]; then
    calculate_latency "$TEST_ID"
    echo ""
fi

# Query recent messages to verify (if requested)
if [ "$SHOW_SAMPLES" = true ]; then
    log_info "Sample of stored messages:"
    curl -s -u "$DB_USER:$DB_PASS" -X POST "$DB_URL/" \
        -H "Content-Type: application/json" \
        -d "{\"statements\": [\"SELECT topic, payload FROM msg WHERE payload LIKE '%$TEST_ID%' ORDER BY ulid DESC LIMIT 5\"]}" | \
        jq -r '.[0].results.rows[] | "  \(.[0]): \(.[1])"' 2>/dev/null || echo "  (unable to fetch)"
    echo ""
fi

# Check for any database errors
log_info "Checking database health..."
DB_SIZE=$(curl -s -u "$DB_USER:$DB_PASS" -X POST "$DB_URL/" \
    -H "Content-Type: application/json" \
    -d '{"statements": ["SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"]}' | \
    jq -r '.[0].results.rows[0][0]' 2>/dev/null || echo "0")

if [ "$DB_SIZE" != "0" ] && [ "$DB_SIZE" != "null" ]; then
    DB_SIZE_MB=$(echo "scale=2; $DB_SIZE / 1048576" | bc)
    log_success "Database size: ${DB_SIZE_MB} MB"
else
    log_warn "Could not determine database size"
fi

echo ""
echo "========================================"

# Summary verdict
if [ "$STORAGE_EFFICIENCY" = "100.00" ] || [ "$STORAGE_EFFICIENCY" = "100" ]; then
    echo -e "${GREEN}✓ PASS${NC}: All messages stored successfully!"
elif (( $(echo "$STORAGE_EFFICIENCY > 95" | bc -l) )); then
    echo -e "${YELLOW}⚠ WARN${NC}: ${STORAGE_EFFICIENCY}% messages stored (some may be in flight)"
else
    echo -e "${RED}✗ FAIL${NC}: Only ${STORAGE_EFFICIENCY}% messages stored"
fi

echo "========================================"
