#!/bin/bash
set -e

# Maximum restart attempts before giving up
MAX_RESTART_ATTEMPTS=3

# Function to handle shutdown
shutdown() {
    echo "Shutting down services..."
    kill $NGINX_PID $SQLD_PID $MOSQUITTO_PID 2>/dev/null || true
    exit 0
}

# Function to restart a failed service
restart_service() {
    local service_name=$1
    local attempt=1
    
    while [ $attempt -le $MAX_RESTART_ATTEMPTS ]; do
        echo "Attempting to restart $service_name (attempt $attempt/$MAX_RESTART_ATTEMPTS)..."
        
        case $service_name in
            nginx)
                nginx &
                NGINX_PID=$!
                sleep 1
                if kill -0 $NGINX_PID 2>/dev/null; then
                    echo "$service_name restarted successfully"
                    return 0
                fi
                ;;
            sqld)
                sqld $SQLD_ARGS &
                SQLD_PID=$!
                sleep 2
                if kill -0 $SQLD_PID 2>/dev/null; then
                    echo "$service_name restarted successfully"
                    return 0
                fi
                ;;
            mosquitto)
                /usr/sbin/mosquitto -c "$MOSQUITTO_CONFIG" &
                MOSQUITTO_PID=$!
                sleep 1
                if kill -0 $MOSQUITTO_PID 2>/dev/null; then
                    echo "$service_name restarted successfully"
                    return 0
                fi
                ;;
        esac
        
        attempt=$((attempt + 1))
        sleep 2
    done
    
    echo "ERROR: Failed to restart $service_name after $MAX_RESTART_ATTEMPTS attempts"
    return 1
}

# Trap SIGTERM and SIGINT
trap shutdown SIGTERM SIGINT

# Check if we can write to /mosquitto/data
if [ ! -w /mosquitto/data ]; then
    echo "ERROR: Cannot write to /mosquitto/data directory"
    echo "Current user: $(id)"
    echo "Directory permissions:"
    ls -la /mosquitto/
    exit 1
fi

# Start nginx for serving admin interface
echo "Starting nginx..."
nginx &
NGINX_PID=$!

# Give nginx time to start
sleep 1

# Check if nginx is still running
if ! kill -0 $NGINX_PID 2>/dev/null; then
    echo "ERROR: nginx failed to start"
    echo "=== Nginx error log ==="
    cat /var/log/nginx/error.log 2>/dev/null || echo "No nginx error log available"
    echo "=== End of nginx error log ==="
    echo "Trying to test nginx config:"
    nginx -t
    exit 1
fi

# Read libsql configuration
LIBSQL_CONF="/mosquitto/config/libsql.conf"
SQLD_ARGS="-d /mosquitto/data"

if [ -f "$LIBSQL_CONF" ]; then
    echo "Reading libsql configuration from $LIBSQL_CONF"
    
    # Parse configuration file (key=value format, ignoring comments and empty lines)
    while IFS='=' read -r key value; do
        # Skip comments and empty lines
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        
        # Trim whitespace
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs)
        
        case "$key" in
            # Network Configuration
            http_listen_addr)
                SQLD_ARGS="$SQLD_ARGS --http-listen-addr=$value"
                ;;
            enable_http_console)
                if [ "$value" = "true" ]; then
                    SQLD_ARGS="$SQLD_ARGS --enable-http-console"
                fi
                ;;
            no_welcome)
                if [ "$value" = "true" ]; then
                    SQLD_ARGS="$SQLD_ARGS --no-welcome"
                fi
                ;;
            # Performance Tuning
            max_concurrent_connections)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --max-concurrent-connections=$value"
                fi
                ;;
            max_concurrent_requests)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --max-concurrent-requests=$value"
                fi
                ;;
            max_response_size)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --max-response-size=$value"
                fi
                ;;
            soft_heap_limit_mb)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --soft-heap-limit-mb=$value"
                fi
                ;;
            hard_heap_limit_mb)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --hard-heap-limit-mb=$value"
                fi
                ;;
            # Stability & Reliability
            shutdown_timeout)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --shutdown-timeout=$value"
                fi
                ;;
            max_log_size)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --max-log-size=$value"
                fi
                ;;
            max_log_duration)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --max-log-duration=$value"
                fi
                ;;
            # Monitoring
            heartbeat_url)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --heartbeat-url=$value"
                fi
                ;;
            heartbeat_period_s)
                if [ -n "$value" ]; then
                    SQLD_ARGS="$SQLD_ARGS --heartbeat-period-s=$value"
                fi
                ;;
        esac
    done < "$LIBSQL_CONF"
else
    echo "No libsql.conf found, using defaults"
    SQLD_ARGS="$SQLD_ARGS --http-listen-addr=0.0.0.0:8000 --enable-http-console"
fi

# Start sqld
echo "Starting sqld with args: $SQLD_ARGS"
sqld $SQLD_ARGS &
SQLD_PID=$!

# Give sqld time to start
sleep 2

# Check if sqld is still running
if ! kill -0 $SQLD_PID 2>/dev/null; then
    echo "ERROR: sqld failed to start"
    exit 1
fi

# Start mosquitto in foreground as the main process
# Use MOSQUITTO_CONFIG env var or default to mosquitto.conf
MOSQUITTO_CONFIG="${MOSQUITTO_CONFIG:-/mosquitto/config/mosquitto.conf}"
echo "Starting mosquitto with config: $MOSQUITTO_CONFIG"
# Fix permissions on mosquitto.db if it exists (prevent world-readable warning)
chmod 0700 /mosquitto/data/mosquitto.db 2>/dev/null || true
/usr/sbin/mosquitto -c "$MOSQUITTO_CONFIG" &
MOSQUITTO_PID=$!

# Wait for Mosquitto to create dynsec.json, then fix permissions for auth-proxy access
sleep 2
chmod 644 /mosquitto/config/dynsec.json 2>/dev/null || true

# Monitor all processes - attempt restart before shutdown
while true; do
    if ! kill -0 $NGINX_PID 2>/dev/null; then
        echo "WARNING: nginx died unexpectedly"
        if ! restart_service nginx; then
            shutdown
        fi
    fi
    if ! kill -0 $SQLD_PID 2>/dev/null; then
        echo "WARNING: sqld died unexpectedly"
        if ! restart_service sqld; then
            shutdown
        fi
    fi
    if ! kill -0 $MOSQUITTO_PID 2>/dev/null; then
        echo "WARNING: mosquitto died unexpectedly"
        if ! restart_service mosquitto; then
            shutdown
        fi
    fi
    sleep 5
done