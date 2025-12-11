# MQTT SQL Admin

MQTT SQL Admin is based on [Mosquitto](https://github.com/eclipse-mosquitto/mosquitto) MQTT broker, [libSQL](https://github.com/tursodatabase/libsql) database and [Nginx](https://github.com/nginx/nginx) web server. It features:
 - MQTT v5.0 protocol (plain MQTT, over TLS or WebSocket)
 - Authentication and authorization based on Access Control List
 - Message persistency in local libSQL database with remote HTTP access
 - Admin web user interface (served by internal Nginx)

## Development
To build Docker image run from the project's root directory
```bash
docker build --no-cache --build-arg UID=$(id -u) --build-arg GID=$(id -g) -t mqtt-sql-admin:0.1.0 -f ./docker/Dockerfile .
```

To start the MQTT SQL Admin as Docker Swarm service
```bash
docker network create --driver overlay dev-proxy
docker secret create dynsec.json mosquitto/config/dynsec.json
docker secret create msa.secrets msa.secrets
docker stack deploy -c compose.yml msa
```

The `msa.secrets` file contains environment variables for the admin UI to connect to the MQTT broker:
```
MSA_MQTT_USER=admin:admin
```

The `dynsec.json` file defines the Mosquitto dynamic security configuration with two users:
- `admin:admin` — Full access to all topics (for admin UI)
- `test:test` — Restricted access to `+/test/#` topics (for testing)

To enable TLS termination inside the Mosquitto broker, mount your TLS certificate and key to `/mosquitto/security/` (e.g., `server.crt` and `server.key`) and uncomment the `certfile`/`keyfile` lines in [`mosquitto/config/mosquitto.conf`](mosquitto/config/mosquitto.conf). For mutual TLS (mTLS) with client certificates, also configure the `cafile` and `require_certificate` options.

## Acknowledgements

This project uses the following open source libraries:

- [Catppuccin](https://github.com/catppuccin/catppuccin) — Soothing pastel color scheme for the admin UI
- [ulid-c](https://github.com/skeeto/ulid-c) — C implementation of ULID (Universally Unique Lexicographically Sortable Identifier)
