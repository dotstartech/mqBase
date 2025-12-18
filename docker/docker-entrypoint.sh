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
		
		# Extract MSA_USER value (format: username:password) for HTTP Basic Auth
		db_user=$(grep "^MSA_USER=" /run/secrets/msa.secrets | cut -d'=' -f2)
		if [ -n "$db_user" ]; then
			db_username=$(echo "$db_user" | cut -d':' -f1)
			db_password=$(echo "$db_user" | cut -d':' -f2)
			# Generate htpasswd using openssl
			echo "$db_username:$(echo -n "$db_password" | openssl passwd -apr1 -stdin)" > /tmp/htpasswd
			chown admin:admin /tmp/htpasswd
			chmod 644 /tmp/htpasswd
		else
			echo "WARNING: MSA_USER not set in msa.secrets, using default 'admin:admin'"
			echo "admin:$(echo -n 'admin' | openssl passwd -apr1 -stdin)" > /tmp/htpasswd
			chown admin:admin /tmp/htpasswd
			chmod 644 /tmp/htpasswd
		fi
	else
		# Create default credentials if no secrets file
		echo "WARNING: msa.secrets not found, using default credentials"
		echo "admin:$(echo -n 'admin' | openssl passwd -apr1 -stdin)" > /tmp/htpasswd
		chown admin:admin /tmp/htpasswd
		chmod 644 /tmp/htpasswd
	fi
	
	# Create app config JSON from environment variables
	# These come from msa.properties via env_file in compose.yml
	app_version="${version:-}"
	app_title="${title:-}"
	app_logo="${logo:-}"
	app_favicon="${favicon:-}"
	
	# Create JSON file with version, title, logo, and favicon (empty values if not set)
	echo "{\"version\":\"${app_version}\",\"title\":\"${app_title}\",\"logo\":\"${app_logo}\",\"favicon\":\"${app_favicon}\"}" > /tmp/app-config.json
	chown admin:admin /tmp/app-config.json
	chmod 644 /tmp/app-config.json
	
	# Switch to admin user and execute the command
	exec su-exec admin "$@"
else
	# If not running as root, just execute the command
	exec "$@"
fi