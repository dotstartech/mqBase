#!/bin/bash
# Test all credential loading methods for both Docker image variants
#
# Usage: ./test-credentials.sh [--trixie-only] [--distroless-only]

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse arguments
TEST_TRIXIE=true
TEST_DISTROLESS=true
for arg in "$@"; do
    case $arg in
        --trixie-only)
            TEST_DISTROLESS=false
            ;;
        --distroless-only)
            TEST_TRIXIE=false
            ;;
    esac
done

# Counters per image
TRIXIE_PASSED=0
TRIXIE_FAILED=0
DISTROLESS_PASSED=0
DISTROLESS_FAILED=0

# Current image context
CURRENT_IMAGE=""

pass() { 
    echo -e "${GREEN}✓ PASS${NC}: $1"
    if [ "$CURRENT_IMAGE" = "trixie" ]; then
        TRIXIE_PASSED=$((TRIXIE_PASSED + 1))
    else
        DISTROLESS_PASSED=$((DISTROLESS_PASSED + 1))
    fi
}

fail() { 
    echo -e "${RED}✗ FAIL${NC}: $1"
    if [ "$CURRENT_IMAGE" = "trixie" ]; then
        TRIXIE_FAILED=$((TRIXIE_FAILED + 1))
    else
        DISTROLESS_FAILED=$((DISTROLESS_FAILED + 1))
    fi
}

skip() {
    echo -e "${YELLOW}○ SKIP${NC}: $1"
}

cleanup() {
    docker rm -f mqbase-cred-test 2>/dev/null || true
}

wait_for_container() {
    local max_wait=20
    local count=0
    while [ $count -lt $max_wait ]; do
        if curl -s -o /dev/null http://127.0.0.1:18080/health 2>/dev/null; then
            return 0
        fi
        sleep 1
        ((count++))
    done
    return 1
}

test_http_auth() {
    local user="$1"
    local pass="$2"
    local expected="$3"
    local code=$(curl -s -o /dev/null -w "%{http_code}" -u "$user:$pass" http://127.0.0.1:18080/mqtt-credentials 2>/dev/null)
    if [ "$code" = "$expected" ]; then
        return 0
    else
        echo "  (expected $expected, got $code)"
        return 1
    fi
}

# =============================================================================
# Test functions
# =============================================================================

test_auto_generated() {
    local image="$1"
    
    echo -e "${CYAN}=== TEST 1: Auto-generated credentials ===${NC}"
    
    docker run -d --name mqbase-cred-test \
        -p 11883:1883 -p 18080:8080 \
        "$image" >/dev/null 2>&1

    if wait_for_container; then
        # Extract auto-generated password from logs
        HTTP_PASS=$(docker logs mqbase-cred-test 2>&1 | grep -A3 "HTTP Basic Auth\|MQBASE_USER" | grep "Password:" | awk '{print $2}')
        
        if [ -n "$HTTP_PASS" ]; then
            pass "Auto-generated password printed to logs"
        else
            fail "Auto-generated password not found in logs"
        fi
        
        if test_http_auth "admin" "$HTTP_PASS" "200"; then
            pass "Auth with auto-generated password works"
        else
            fail "Auth with auto-generated password failed"
        fi
        
        if test_http_auth "admin" "wrongpass" "401"; then
            pass "Wrong password correctly rejected"
        else
            fail "Wrong password not rejected"
        fi
        
        # Check log message - distroless uses "Auto-generated", shell uses "auto-generated"
        if docker logs mqbase-cred-test 2>&1 | grep -qi "auto-generated"; then
            pass "Log shows auto-generated source"
        else
            fail "Log doesn't show correct source"
        fi
    else
        fail "Container failed to start"
    fi
    cleanup
    echo ""
}

test_env_variables() {
    local image="$1"
    local is_distroless="$2"
    
    echo -e "${CYAN}=== TEST 2: Environment variables ===${NC}"
    
    docker run -d --name mqbase-cred-test \
        -p 11883:1883 -p 18080:8080 \
        -e MQBASE_USER=envuser:envpass123 \
        -e MQBASE_MQTT_USER=mqttuser:mqttpass456 \
        "$image" >/dev/null 2>&1

    if wait_for_container; then
        if test_http_auth "envuser" "envpass123" "200"; then
            pass "Auth with env var credentials works"
        else
            fail "Auth with env var credentials failed"
        fi
        
        if test_http_auth "envuser" "wrongpass" "401"; then
            pass "Wrong password correctly rejected"
        else
            fail "Wrong password not rejected"
        fi
        
        if test_http_auth "admin" "admin" "401"; then
            pass "Default credentials correctly rejected"
        else
            fail "Default credentials should be rejected"
        fi
        
        # Check log message - distroless silently uses env vars (no log output)
        if [ "$is_distroless" = "true" ]; then
            # For distroless: success is no auto-generated warning
            if ! docker logs mqbase-cred-test 2>&1 | grep -q "WARNING.*credentials\|Auto-generated"; then
                pass "Env vars used silently (no warning printed)"
            else
                fail "Should not print warning when env vars provided"
            fi
        else
            if docker logs mqbase-cred-test 2>&1 | grep -q "environment variables"; then
                pass "Log shows 'environment variables' source"
            else
                fail "Log doesn't show correct source"
            fi
        fi
        
        # Check no warning was printed
        if ! docker logs mqbase-cred-test 2>&1 | grep -q "WARNING.*credentials\|No MQBASE"; then
            pass "No credential warning printed"
        else
            fail "Unexpected credential warning printed"
        fi
    else
        fail "Container failed to start"
    fi
    cleanup
    echo ""
}

test_mounted_secrets() {
    local image="$1"
    local is_distroless="$2"
    
    echo -e "${CYAN}=== TEST 3: Mounted secrets file ===${NC}"
    
    # Create temporary secrets file
    TEMP_SECRETS=$(mktemp)
    echo "MQBASE_USER=fileuser:filepass789" > "$TEMP_SECRETS"
    echo "MQBASE_MQTT_USER=filemqtt:filemqttpass" >> "$TEMP_SECRETS"

    docker run -d --name mqbase-cred-test \
        -p 11883:1883 -p 18080:8080 \
        -v "$TEMP_SECRETS:/mosquitto/config/secrets.conf:ro" \
        "$image" >/dev/null 2>&1

    if wait_for_container; then
        if test_http_auth "fileuser" "filepass789" "200"; then
            pass "Auth with mounted file credentials works"
        else
            fail "Auth with mounted file credentials failed"
        fi
        
        if test_http_auth "fileuser" "wrongpass" "401"; then
            pass "Wrong password correctly rejected"
        else
            fail "Wrong password not rejected"
        fi
        
        # Check log message
        if docker logs mqbase-cred-test 2>&1 | grep -q "mounted config"; then
            pass "Log shows 'mounted config' source"
        else
            fail "Log doesn't show correct source"
        fi
    else
        fail "Container failed to start"
    fi
    cleanup
    rm -f "$TEMP_SECRETS"
    echo ""
}

test_priority_override() {
    local image="$1"
    local is_distroless="$2"
    
    echo -e "${CYAN}=== TEST 4: Priority - Env vars override mounted file ===${NC}"
    
    TEMP_SECRETS=$(mktemp)
    echo "MQBASE_USER=fileuser:filepass" > "$TEMP_SECRETS"
    echo "MQBASE_MQTT_USER=filemqtt:filemqttpass" >> "$TEMP_SECRETS"

    docker run -d --name mqbase-cred-test \
        -p 11883:1883 -p 18080:8080 \
        -e MQBASE_USER=envuser:envpass \
        -e MQBASE_MQTT_USER=envmqtt:envmqttpass \
        -v "$TEMP_SECRETS:/mosquitto/config/secrets.conf:ro" \
        "$image" >/dev/null 2>&1

    if wait_for_container; then
        # Env vars should take priority
        if test_http_auth "envuser" "envpass" "200"; then
            pass "Env vars take priority over mounted file"
        else
            fail "Env vars should take priority"
        fi
        
        # File credentials should NOT work
        if test_http_auth "fileuser" "filepass" "401"; then
            pass "Mounted file credentials correctly overridden"
        else
            fail "Mounted file credentials should be overridden"
        fi
    else
        fail "Container failed to start"
    fi
    cleanup
    rm -f "$TEMP_SECRETS"
    echo ""
}

test_partial_credentials() {
    local image="$1"
    
    echo -e "${CYAN}=== TEST 5: Partial credentials (only MQBASE_USER) ===${NC}"
    
    docker run -d --name mqbase-cred-test \
        -p 11883:1883 -p 18080:8080 \
        -e MQBASE_USER=partialuser:partialpass \
        "$image" >/dev/null 2>&1

    if wait_for_container; then
        if test_http_auth "partialuser" "partialpass" "200"; then
            pass "Partial env var (MQBASE_USER only) works"
        else
            fail "Partial env var failed"
        fi
        
        # MQTT user should be auto-generated
        if docker logs mqbase-cred-test 2>&1 | grep -q "No MQBASE_MQTT_USER\|MQBASE_MQTT_USER credentials"; then
            pass "Missing MQBASE_MQTT_USER triggers auto-generation"
        else
            fail "Should auto-generate missing MQBASE_MQTT_USER"
        fi
        
        # But no warning for MQBASE_USER
        if ! docker logs mqbase-cred-test 2>&1 | grep -q "No MQBASE_USER credentials"; then
            pass "No warning for provided MQBASE_USER"
        else
            fail "Should not warn about provided MQBASE_USER"
        fi
    else
        fail "Container failed to start"
    fi
    cleanup
    echo ""
}

test_special_characters() {
    local image="$1"
    
    echo -e "${CYAN}=== TEST 6: Special characters in password ===${NC}"
    
    docker run -d --name mqbase-cred-test \
        -p 11883:1883 -p 18080:8080 \
        -e 'MQBASE_USER=admin:p@ss:w0rd!#$%' \
        -e 'MQBASE_MQTT_USER=mqtt:mqtt123' \
        "$image" >/dev/null 2>&1

    if wait_for_container; then
        if test_http_auth "admin" 'p@ss:w0rd!#$%' "200"; then
            pass "Special characters in password work"
        else
            fail "Special characters in password failed"
        fi
    else
        fail "Container failed to start"
    fi
    cleanup
    echo ""
}

# =============================================================================
# Run tests for a specific image
# =============================================================================

run_tests_for_image() {
    local image="$1"
    local image_label="$2"
    local is_distroless="$3"
    
    echo -e "${BLUE}========================================"
    echo "Testing: $image_label"
    echo "Image: $image"
    echo -e "========================================${NC}"
    echo ""
    
    cleanup
    
    test_auto_generated "$image"
    test_env_variables "$image" "$is_distroless"
    test_mounted_secrets "$image" "$is_distroless"
    test_priority_override "$image" "$is_distroless"
    test_partial_credentials "$image"
    test_special_characters "$image"
}

# =============================================================================
# Main execution
# =============================================================================

echo -e "${BLUE}========================================"
echo "Credential Loading Test Suite"
echo -e "========================================${NC}"
echo ""

# Test debian:trixie-slim image
if [ "$TEST_TRIXIE" = true ]; then
    CURRENT_IMAGE="trixie"
    run_tests_for_image "mqbase:latest" "debian:trixie-slim" "false"
fi

# Test distroless/base-debian13 image
if [ "$TEST_DISTROLESS" = true ]; then
    CURRENT_IMAGE="distroless"
    run_tests_for_image "mqbase:latest-distroless" "distroless/base-debian13" "true"
fi

# =============================================================================
# Summary
# =============================================================================

echo -e "${BLUE}========================================"
echo "Test Summary"
echo -e "========================================${NC}"

TOTAL_PASSED=0
TOTAL_FAILED=0

if [ "$TEST_TRIXIE" = true ]; then
    echo -e "debian:trixie-slim:        ${GREEN}$TRIXIE_PASSED passed${NC}, ${RED}$TRIXIE_FAILED failed${NC}"
    TOTAL_PASSED=$((TOTAL_PASSED + TRIXIE_PASSED))
    TOTAL_FAILED=$((TOTAL_FAILED + TRIXIE_FAILED))
fi

if [ "$TEST_DISTROLESS" = true ]; then
    echo -e "distroless/base-debian13:  ${GREEN}$DISTROLESS_PASSED passed${NC}, ${RED}$DISTROLESS_FAILED failed${NC}"
    TOTAL_PASSED=$((TOTAL_PASSED + DISTROLESS_PASSED))
    TOTAL_FAILED=$((TOTAL_FAILED + DISTROLESS_FAILED))
fi

echo -e "${BLUE}----------------------------------------${NC}"
echo -e "Total: ${GREEN}$TOTAL_PASSED passed${NC}, ${RED}$TOTAL_FAILED failed${NC}"
echo -e "${BLUE}========================================${NC}"

if [ $TOTAL_FAILED -gt 0 ]; then
    exit 1
fi

exit 0
