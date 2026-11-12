#!/bin/bash
set -e

# =============================================================================
# Credential Loading Functions
# =============================================================================
# Multi-source credential loading with fallback priority:
#   1. Docker secrets file (/run/secrets/mqbase.secrets)
#   2. Environment variables (MQBASE_USER, MQBASE_MQTT_USER)
#   3. Mounted config file (/mosquitto/config/secrets.conf)
#   4. Auto-generate random credentials (with warning)
#
# Dynamic security configuration seeding:
#   MQBASE_DYNSEC_SEED       file copied to /mosquitto/config/dynsec.json before Mosquitto starts
#                            (default: /run/secrets/dynsec.json, only used if the file exists)
#   MQBASE_DYNSEC_SEED_MODE  always (default) - the seed replaces dynsec.json on every start,
#                                               i.e. the deployed secret is the source of truth
#                            init             - the seed is only used when dynsec.json does not exist yet
#   A seed that cannot be accessed or exists but cannot be applied (not a regular file, empty, copy
#   failed) aborts the start.
# =============================================================================

DYNSEC_FILE="/mosquitto/config/dynsec.json"

# Seed dynsec.json from a Docker secret or a mounted file. Secrets are mounted read-only, but the
# dynamic security plugin needs to write its config file, hence the copy.
seed_dynsec() {
	local seed="${MQBASE_DYNSEC_SEED:-/run/secrets/dynsec.json}"
	local mode="${MQBASE_DYNSEC_SEED_MODE:-always}"
	local err

	# Only a missing seed is skipped; [ -e ] is also false when the seed cannot be accessed
	if ! err=$(LC_ALL=C stat -- "$seed" 2>&1 >/dev/null); then
		case "$err" in
			*": No such file or directory") return 0 ;;
		esac
		echo "ERROR: Dynamic security seed $seed cannot be accessed (${err##*: })"
		exit 1
	fi

	if [ ! -f "$seed" ] || [ ! -s "$seed" ]; then
		echo "ERROR: Dynamic security seed $seed is not a regular, non-empty file"
		exit 1
	fi

	case "$mode" in
		always) ;;
		init)
			if [ -s "$DYNSEC_FILE" ]; then
				echo "Dynamic security config exists, seed $seed not applied (MQBASE_DYNSEC_SEED_MODE=init)"
				return 0
			fi
			;;
		*)
			echo "WARNING: Unknown MQBASE_DYNSEC_SEED_MODE '$mode', using 'always'"
			;;
	esac

	# Copy to a temporary file first so that a failed copy cannot leave a truncated live config behind
	if cp "$seed" "${DYNSEC_FILE}.tmp" && chmod 644 "${DYNSEC_FILE}.tmp" && mv "${DYNSEC_FILE}.tmp" "$DYNSEC_FILE"; then
		chown admin:admin "$DYNSEC_FILE" 2>/dev/null || true
		echo "Dynamic security config seeded from $seed"
	else
		rm -f "${DYNSEC_FILE}.tmp"
		echo "ERROR: Failed to seed dynamic security config from $seed"
		exit 1
	fi
}

# Generate a random password (16 alphanumeric characters)
generate_password() {
	tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16
}

# Load credentials from a secrets file (key=value format)
# Usage: load_from_file <filepath>
# Sets: MQBASE_USER, MQBASE_MQTT_USER (if found and not already set)
load_from_file() {
	local file="$1"
	if [ -f "$file" ]; then
		# Only set if not already defined
		if [ -z "$MQBASE_USER" ]; then
			MQBASE_USER=$(grep "^MQBASE_USER=" "$file" 2>/dev/null | cut -d'=' -f2-)
		fi
		if [ -z "$MQBASE_MQTT_USER" ]; then
			MQBASE_MQTT_USER=$(grep "^MQBASE_MQTT_USER=" "$file" 2>/dev/null | cut -d'=' -f2-)
		fi
		return 0
	fi
	return 1
}

# Load credentials with fallback priority
load_credentials() {
	local source=""
	
	# Priority 1: Docker secrets file (Swarm/Compose secrets)
	if [ -f /run/secrets/mqbase.secrets ]; then
		load_from_file /run/secrets/mqbase.secrets
		source="Docker secrets (/run/secrets/mqbase.secrets)"
	fi
	
	# Priority 2: Environment variables (already in env, check if set)
	# These are already available if passed via docker run -e or compose environment:
	# Nothing to do here - just note the source if values are set
	if [ -n "$MQBASE_USER" ] || [ -n "$MQBASE_MQTT_USER" ]; then
		if [ -z "$source" ]; then
			source="environment variables"
		fi
	fi
	
	# Priority 3: Mounted config file
	if [ -z "$MQBASE_USER" ] || [ -z "$MQBASE_MQTT_USER" ]; then
		if [ -f /mosquitto/config/secrets.conf ]; then
			load_from_file /mosquitto/config/secrets.conf
			if [ -n "$MQBASE_USER" ] || [ -n "$MQBASE_MQTT_USER" ]; then
				source="${source:+$source + }mounted config (/mosquitto/config/secrets.conf)"
			fi
		fi
	fi
	
	# Priority 4: Auto-generate if still missing
	if [ -z "$MQBASE_USER" ]; then
		local gen_pass=$(generate_password)
		MQBASE_USER="admin:${gen_pass}"
		echo "=============================================="
		echo "WARNING: No MQBASE_USER credentials found!"
		echo "Auto-generated credentials for HTTP Basic Auth:"
		echo "  Username: admin"
		echo "  Password: ${gen_pass}"
		echo "=============================================="
		source="${source:+$source + }auto-generated (MQBASE_USER)"
	fi
	
	if [ -z "$MQBASE_MQTT_USER" ]; then
		local gen_pass=$(generate_password)
		MQBASE_MQTT_USER="admin:${gen_pass}"
		echo "=============================================="
		echo "WARNING: No MQBASE_MQTT_USER credentials found!"
		echo "Auto-generated credentials for MQTT:"
		echo "  Username: admin"
		echo "  Password: ${gen_pass}"
		echo "=============================================="
		source="${source:+$source + }auto-generated (MQBASE_MQTT_USER)"
	fi
	
	echo "Credentials loaded from: $source"
}

# Create credential files for nginx and web UI
setup_credential_files() {
	# Remove existing files to handle restart case
	rm -f /tmp/mqtt-credentials.json /tmp/htpasswd 2>/dev/null || true
	
	# Parse MQBASE_MQTT_USER (format: username:password) for web client JSON
	local mqtt_username=$(echo "$MQBASE_MQTT_USER" | cut -d':' -f1)
	local mqtt_password=$(echo "$MQBASE_MQTT_USER" | cut -d':' -f2-)
	echo "{\"username\":\"$mqtt_username\",\"password\":\"$mqtt_password\"}" > /tmp/mqtt-credentials.json
	chown admin:admin /tmp/mqtt-credentials.json 2>/dev/null || true
	chmod 644 /tmp/mqtt-credentials.json
	
	# Parse MQBASE_USER (format: username:password) for HTTP Basic Auth htpasswd
	local db_username=$(echo "$MQBASE_USER" | cut -d':' -f1)
	local db_password=$(echo "$MQBASE_USER" | cut -d':' -f2-)
	echo "$db_username:$(echo -n "$db_password" | openssl passwd -apr1 -stdin)" > /tmp/htpasswd
	chown admin:admin /tmp/htpasswd 2>/dev/null || true
	chmod 644 /tmp/htpasswd
}

# Sync MQTT credentials into dynsec.json before Mosquitto starts
# This ensures the password set via MQBASE_MQTT_USER is applied to the broker
sync_mqtt_password() {
	local dynsec="/mosquitto/config/dynsec.json"
	[ -f "$dynsec" ] || return 0
	
	local mqtt_username mqtt_password
	mqtt_username=$(echo "$MQBASE_MQTT_USER" | cut -d':' -f1)
	mqtt_password=$(echo "$MQBASE_MQTT_USER" | cut -d':' -f2-)
	
	# The client must exist in dynsec.json; its PBKDF2 iteration count is kept (the plugin verifies the
	# stored hash with the stored count) and only falls back to 101 when the field is missing or invalid
	local client_count iterations
	if ! client_count=$(jq -r --arg user "$mqtt_username" '[.clients[]? | select(.username == $user)] | length' "$dynsec" 2>/dev/null); then
		echo "WARNING: $dynsec is not valid JSON, MQTT password not synced"
		return 0
	fi
	if [ "$client_count" = "0" ]; then
		echo "WARNING: MQTT user '$mqtt_username' not found in $dynsec, password not synced (the admin UI cannot connect to the broker)"
		return 0
	fi
	iterations=$(jq -r --arg user "$mqtt_username" '[.clients[]? | select(.username == $user)][0].iterations // 101' "$dynsec")
	if ! [[ "$iterations" =~ ^[0-9]+$ ]] || [ "$iterations" -le 0 ]; then
		iterations=101
	fi
	
	# Generate random 12 bytes of salt as hex (24 hex chars)
	# Using hex avoids null byte issues that break shell variables
	local salt_hex salt_b64
	salt_hex=$(head -c 12 /dev/urandom | xxd -p | tr -d '\n')
	
	# Convert hex salt to base64 for storage in dynsec.json
	salt_b64=$(echo "$salt_hex" | xxd -r -p | base64 | tr -d '\n')
	
	# Compute PBKDF2-SHA512 hash matching Mosquitto dynsec format (64-byte key, SHA-512)
	local hash_hex
	hash_hex=$(openssl kdf -keylen 64 \
		-kdfopt digest:SHA512 \
		-kdfopt "pass:${mqtt_password}" \
		-kdfopt "hexsalt:${salt_hex}" \
		-kdfopt "iter:${iterations}" \
		PBKDF2 2>/dev/null | tr -d ' :\n')
	
	if [ -z "$hash_hex" ]; then
		echo "ERROR: Failed to compute PBKDF2 hash, MQTT password not synced"
		exit 1
	fi
	
	# Convert hex hash to base64 (matching dynsec.json format)
	local hash_b64
	hash_b64=$(echo "$hash_hex" | xxd -r -p | base64 | tr -d '\n')
	
	# Update password, salt and iteration count of the target client (JSON-aware, works for any formatting)
	if jq --arg user "$mqtt_username" --arg pw "$hash_b64" --arg salt "$salt_b64" --argjson iter "$iterations" \
		'(.clients[] | select(.username == $user)) |= (.password = $pw | .salt = $salt | .iterations = $iter)' \
		"$dynsec" > "${dynsec}.tmp" && mv "${dynsec}.tmp" "$dynsec"; then
		chown admin:admin "$dynsec" 2>/dev/null || true
		echo "MQTT password synced to dynsec.json for user: $mqtt_username"
	else
		rm -f "${dynsec}.tmp"
		echo "ERROR: Failed to update $dynsec, MQTT password not synced (is the config directory writable for UID $(id -u)?)"
		exit 1
	fi
}

# Create app config JSON for the web UI from environment variables
# These come from mqbase.properties via env_file in compose.yml
setup_app_config() {
	local app_version="${version:-}"
	local app_title="${title:-}"
	local app_logo="${logo:-}"
	local app_favicon="${favicon:-}"
	
	# Create JSON file with version, title, logo, and favicon (empty values if not set)
	# Remove existing file first to handle container restart (file may be owned by different user)
	rm -f /tmp/app-config.json 2>/dev/null || true
	echo "{\"version\":\"${app_version}\",\"title\":\"${app_title}\",\"logo\":\"${app_logo}\",\"favicon\":\"${app_favicon}\"}" > /tmp/app-config.json
	chown admin:admin /tmp/app-config.json 2>/dev/null || true
	chmod 644 /tmp/app-config.json
}

# =============================================================================
# Main Entrypoint
# =============================================================================

user="$(id -u)"
if [ "$user" = '0' ]; then
	# Ensure mosquitto directories exist
	mkdir -p /mosquitto/data /mosquitto/log
	
	# Set ownership for writable directories only
	# NOTE: We deliberately skip /mosquitto/config to preserve host file ownership
	# when the config directory is bind-mounted from the host
	chown -R admin:admin /mosquitto/data /mosquitto/log 2>/dev/null || true
	
	# If dynsec.json exists and is writable, ensure admin owns it
	# (needed for Mosquitto dynamic security updates)
	if [ -w /mosquitto/config/dynsec.json ]; then
		chown admin:admin /mosquitto/config/dynsec.json 2>/dev/null || true
	fi
	
	# Ensure proper permissions for data directory (sqld needs write access)
	chmod -R 755 /mosquitto/data
	
	# Create nginx temp directories and set permissions
	mkdir -p /tmp/nginx_client_body /tmp/nginx_proxy /tmp/nginx_fastcgi /tmp/nginx_uwsgi /tmp/nginx_scgi
	chown -R admin:admin /tmp/nginx_* /var/log/nginx
	chmod -R 755 /tmp/nginx_* /var/log/nginx
fi

# Credentials, ACL seed and UI config are applied whatever user the container runs as: none of it
# needs root, only a writable /tmp and config directory. Skipping it for non-root users would leave
# the image default credentials active and the deployed seed unused.
load_credentials
setup_credential_files
seed_dynsec
sync_mqtt_password
setup_app_config

if [ "$user" = '0' ]; then
	# Switch to admin user and execute the command
	exec su-exec admin "$@"
else
	exec "$@"
fi