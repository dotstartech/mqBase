#!/bin/bash
set -e

# Set permissions
user="$(id -u)"
if [ "$user" = '0' ]; then
	# Ensure mosquitto directories exist
	mkdir -p /mosquitto/data /mosquitto/log /mosquitto/config
	
	# Set ownership for writable directories only (skip read-only mounted files like TLS certs)
	chown -R admin:admin /mosquitto/data /mosquitto/log /mosquitto/config 2>/dev/null || true
	
	# Ensure proper permissions for data directory (sqld needs write access)
	chmod -R 755 /mosquitto/data
	
	# Create nginx temp directories and set permissions
	mkdir -p /tmp/nginx_client_body /tmp/nginx_proxy /tmp/nginx_fastcgi /tmp/nginx_uwsgi /tmp/nginx_scgi
	chown -R admin:admin /tmp/nginx_* /var/log/nginx
	chmod -R 755 /tmp/nginx_* /var/log/nginx
	
	# Copy dynsec.json from secrets to a readable location for nginx
	# If the secret exists, copy it; otherwise ensure the existing config file is readable
	if [ -f /run/secrets/dynsec.json ]; then
		cp /run/secrets/dynsec.json /mosquitto/config/dynsec-runtime.json
		chown admin:admin /mosquitto/config/dynsec-runtime.json
		chmod 644 /mosquitto/config/dynsec-runtime.json
	elif [ -f /mosquitto/config/dynsec.json ]; then
		cp /mosquitto/config/dynsec.json /mosquitto/config/dynsec-runtime.json
		chown admin:admin /mosquitto/config/dynsec-runtime.json
		chmod 644 /mosquitto/config/dynsec-runtime.json
	fi
	
	# Parse MQTT credentials from secrets file and create JSON for web client
	if [ -f /run/secrets/msa.secrets ]; then
		# Extract MSA_MQTT_USER value (format: username:password)
		mqtt_user=$(grep "^MSA_MQTT_USER=" /run/secrets/msa.secrets | cut -d'=' -f2)
		if [ -n "$mqtt_user" ]; then
			# Split into username and password
			username=$(echo "$mqtt_user" | cut -d':' -f1)
			password=$(echo "$mqtt_user" | cut -d':' -f2)
			# Create JSON file
			echo "{\"username\":\"$username\",\"password\":\"$password\"}" > /tmp/mqtt-credentials.json
			chown admin:admin /tmp/mqtt-credentials.json
			chmod 644 /tmp/mqtt-credentials.json
		fi
	fi
	
	# Parse msa.properties and create app config JSON for web client
	if [ -f /run/secrets/msa.properties ]; then
		# Extract version, title, logo, and favicon values
		app_version=$(grep "^version=" /run/secrets/msa.properties | cut -d'=' -f2-)
		app_title=$(grep "^title=" /run/secrets/msa.properties | cut -d'=' -f2-)
		app_logo=$(grep "^logo=" /run/secrets/msa.properties | cut -d'=' -f2-)
		app_favicon=$(grep "^favicon=" /run/secrets/msa.properties | cut -d'=' -f2-)
		
		# Create JSON file with version, title, logo, and favicon (empty values if not set)
		echo "{\"version\":\"${app_version}\",\"title\":\"${app_title}\",\"logo\":\"${app_logo}\",\"favicon\":\"${app_favicon}\"}" > /tmp/app-config.json
		chown admin:admin /tmp/app-config.json
		chmod 644 /tmp/app-config.json
	else
		# Create empty config if no properties file
		echo "{\"version\":\"\",\"title\":\"\",\"logo\":\"\",\"favicon\":\"\"}" > /tmp/app-config.json
		chown admin:admin /tmp/app-config.json
		chmod 644 /tmp/app-config.json
	fi
	
	# Switch to admin user and execute the command
	exec gosu admin "$@"
else
	# If not running as root, just execute the command
	exec "$@"
fi