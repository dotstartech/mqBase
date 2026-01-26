#!/bin/bash
# Test script for both Docker image variants
# Builds each image with --no-cache, starts container, and runs test suite
#
# Usage: ./test-images.sh [--trixie-only] [--distroless-only]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Container configuration
CONTAINER_NAME="mqbase-test"
MQTT_USER="test"
MQTT_PASS="test"
ADMIN_USER="admin"
ADMIN_PASS="admin"

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

# Track results
TRIXIE_RESULT=""
DISTROLESS_RESULT=""

log_section() {
    echo ""
    echo -e "${BLUE}========================================"
    echo -e "$1"
    echo -e "========================================${NC}"
    echo ""
}

log_info() {
    echo -e "${YELLOW}→${NC} $1"
}

log_pass() {
    echo -e "${GREEN}✓${NC} $1"
}

log_fail() {
    echo -e "${RED}✗${NC} $1"
}

cleanup_container() {
    log_info "Cleaning up container..."
    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
    # Also stop any container using our ports
    docker rm -f mqbase 2>/dev/null || true
    # Wait for ports to be released (TCP TIME_WAIT can take a few seconds)
    sleep 3
}

wait_for_container() {
    local max_attempts=30
    local attempt=1
    
    log_info "Waiting for container to be ready..."
    
    # First wait for HTTP health endpoint
    while [ $attempt -le $max_attempts ]; do
        if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080/health" 2>/dev/null | grep -q "200"; then
            break
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    
    if [ $attempt -gt $max_attempts ]; then
        log_fail "Container HTTP failed to become ready after ${max_attempts}s"
        echo "Container logs:"
        docker logs "$CONTAINER_NAME" 2>&1 | tail -50
        return 1
    fi
    
    # Then wait for MQTT broker to be ready
    attempt=1
    while [ $attempt -le $max_attempts ]; do
        if mosquitto_pub -h 127.0.0.1 -p 1883 -u "$MQTT_USER" -P "$MQTT_PASS" -t "test/ready" -m "ping" -q 0 2>/dev/null; then
            log_pass "Container is ready (HTTP + MQTT)"
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    
    log_fail "Container MQTT failed to become ready after ${max_attempts}s"
    echo "Container logs:"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -50
    return 1
}

run_tests() {
    local image_type="$1"
    
    log_info "Running test suite for $image_type image..."
    
    if bash "$SCRIPT_DIR/test.sh"; then
        log_pass "$image_type: All tests passed!"
        return 0
    else
        log_fail "$image_type: Some tests failed!"
        return 1
    fi
}

test_trixie_image() {
    log_section "Testing debian:trixie-slim Image"
    
    # Build
    log_info "Building debian:trixie-slim image (--no-cache)..."
    if ! "$PROJECT_DIR/docker/build.sh" --no-cache; then
        log_fail "debian:trixie-slim image build failed"
        return 1
    fi
    log_pass "debian:trixie-slim image built successfully"
    
    # Stop any existing container
    cleanup_container
    
    # Start container
    log_info "Starting debian:trixie-slim container..."
    docker run -d \
        --name "$CONTAINER_NAME" \
        -p 1883:1883 \
        -p 8080:8080 \
        -p 9001:9001 \
        -e MQBASE_MQTT_USER="${MQTT_USER}:${MQTT_PASS}" \
        -e MQBASE_USER="${ADMIN_USER}:${ADMIN_PASS}" \
        mqbase:latest
    
    # Wait for container to be ready
    if ! wait_for_container; then
        cleanup_container
        return 1
    fi
    
    # Run tests
    if run_tests "debian:trixie-slim"; then
        cleanup_container
        return 0
    else
        cleanup_container
        return 1
    fi
}

test_distroless_image() {
    log_section "Testing distroless/base-debian13 Image"
    
    # Build
    log_info "Building distroless/base-debian13 image (--no-cache)..."
    if ! "$PROJECT_DIR/docker/build.sh" --no-cache --distroless; then
        log_fail "distroless/base-debian13 image build failed"
        return 1
    fi
    log_pass "distroless/base-debian13 image built successfully"
    
    # Stop any existing container
    cleanup_container
    
    # Start container (distroless uses different env var format)
    log_info "Starting distroless container..."
    docker run -d \
        --name "$CONTAINER_NAME" \
        -p 1883:1883 \
        -p 8080:8080 \
        -p 9001:9001 \
        -e MQBASE_MQTT_USER="${MQTT_USER}:${MQTT_PASS}" \
        -e MQBASE_USER="${ADMIN_USER}:${ADMIN_PASS}" \
        mqbase:latest-distroless
    
    # Wait for container to be ready
    if ! wait_for_container; then
        cleanup_container
        return 1
    fi
    
    # Run tests
    if run_tests "distroless/base-debian13"; then
        cleanup_container
        return 0
    else
        cleanup_container
        return 1
    fi
}

# Main execution
log_section "mqBase Docker Image Test Suite"
echo "Testing images: $([ "$TEST_TRIXIE" = true ] && echo "debian:trixie-slim ")$([ "$TEST_DISTROLESS" = true ] && echo "distroless/base-debian13")"

# Test debian:trixie-slim image
if [ "$TEST_TRIXIE" = true ]; then
    if test_trixie_image; then
        TRIXIE_RESULT="PASS"
    else
        TRIXIE_RESULT="FAIL"
    fi
fi

# Test distroless/base-debian13 image
if [ "$TEST_DISTROLESS" = true ]; then
    if test_distroless_image; then
        DISTROLESS_RESULT="PASS"
    else
        DISTROLESS_RESULT="FAIL"
    fi
fi

# Summary
log_section "Test Summary"

if [ "$TEST_TRIXIE" = true ]; then
    if [ "$TRIXIE_RESULT" = "PASS" ]; then
        echo -e "debian:trixie-slim:        ${GREEN}PASS${NC}"
    else
        echo -e "debian:trixie-slim:        ${RED}FAIL${NC}"
    fi
fi

if [ "$TEST_DISTROLESS" = true ]; then
    if [ "$DISTROLESS_RESULT" = "PASS" ]; then
        echo -e "distroless/base-debian13:  ${GREEN}PASS${NC}"
    else
        echo -e "distroless/base-debian13:  ${RED}FAIL${NC}"
    fi
fi

echo ""

# Exit with appropriate code
if [ "$TRIXIE_RESULT" = "FAIL" ] || [ "$DISTROLESS_RESULT" = "FAIL" ]; then
    exit 1
fi

exit 0
