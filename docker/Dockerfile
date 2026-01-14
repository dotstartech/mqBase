FROM debian:trixie AS builder

ENV VERSION=2.0.22 \
    LWS_VERSION=4.2.1 \
    LWS_SHA256=842da21f73ccba2be59e680de10a8cce7928313048750eb6ad73b6fa50763c51

COPY plugins/sql/libsql_plugin.c /tmp/libsql_plugin.c
COPY plugins/sql/Makefile /tmp/Makefile

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        wget \
        ca-certificates \
        libssl-dev \
        libcjson-dev \
        libsqlite3-dev \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Build libwebsockets (static)
RUN wget https://github.com/warmcat/libwebsockets/archive/v${LWS_VERSION}.tar.gz -O /tmp/lws.tar.gz \
    && echo "$LWS_SHA256  /tmp/lws.tar.gz" | sha256sum -c - \
    && mkdir -p /build/lws \
    && tar --strip=1 -xf /tmp/lws.tar.gz -C /build/lws \
    && rm /tmp/lws.tar.gz \
    && cd /build/lws \
    && cmake . \
        -DCMAKE_BUILD_TYPE=MinSizeRel \
        -DCMAKE_INSTALL_PREFIX=/usr \
        -DDISABLE_WERROR=ON \
        -DLWS_IPV6=ON \
        -DLWS_WITHOUT_BUILTIN_GETIFADDRS=ON \
        -DLWS_WITHOUT_CLIENT=ON \
        -DLWS_WITHOUT_EXTENSIONS=ON \
        -DLWS_WITHOUT_TESTAPPS=ON \
        -DLWS_WITH_EXTERNAL_POLL=ON \
        -DLWS_WITH_HTTP2=OFF \
        -DLWS_WITH_SHARED=OFF \
        -DLWS_WITH_ZIP_FOPS=OFF \
        -DLWS_WITH_ZLIB=OFF \
    && make -j "$(nproc)"

# Build Mosquitto with plugins
RUN curl -o /tmp/mosq.tar.gz https://mosquitto.org/files/source/mosquitto-${VERSION}.tar.gz \
    && mkdir -p /build/mosq \
    && tar --strip=1 -xf /tmp/mosq.tar.gz -C /build/mosq \
    && rm /tmp/mosq.tar.gz \
    && mkdir -p /build/mosq/plugins/sql \
    && mv /tmp/libsql_plugin.c /build/mosq/plugins/sql/. \
    && mv /tmp/Makefile /build/mosq/plugins/sql/. \
    && sed -i 's/DIRS=/DIRS=sql /' /build/mosq/plugins/Makefile \
    && make -C /build/mosq -j "$(nproc)" \
        CFLAGS="-Wall -O2 -I/build/lws/include -I/build" \
        LDFLAGS="-L/build/lws/lib -lm" \
        WITH_ADNS=no \
        WITH_DOCS=no \
        WITH_SHARED_LIBRARIES=yes \
        WITH_SRV=no \
        WITH_STRIP=yes \
        WITH_WEBSOCKETS=yes \
        prefix=/usr \
        binary

# Download sqld binary
RUN curl --proto '=https' --tlsv1.2 -LsSf https://github.com/tursodatabase/libsql/releases/download/libsql-server-v0.24.32/libsql-server-installer.sh | sh \
    && mv /root/.cargo/bin/sqld /build/sqld

# Build su-exec (lightweight alternative to gosu, no Go dependency)
RUN curl -fsSL https://raw.githubusercontent.com/ncopa/su-exec/master/su-exec.c -o /tmp/su-exec.c \
    && gcc -Wall -Werror -g -o /build/su-exec /tmp/su-exec.c \
    && strip /build/su-exec

FROM debian:trixie-slim

LABEL maintainer="dotStar Technologies" \
      description="mqBase - Mosquitto MQTT Broker with libSQL Persistency and Web Admin Interface"

# Build arguments for user/group IDs
ARG UID=1883
ARG GID=1883

# Install only runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3t64 \
        libcjson1 \
        libsqlite3-0 \
        nginx-light \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    # Remove package manager and unnecessary files to reduce image size
    && rm -rf \
        /var/lib/dpkg \
        /var/lib/apt \
        /var/cache/apt \
        /var/log/dpkg.log \
        /var/log/apt \
        /usr/share/doc \
        /usr/share/man \
        /usr/share/info \
        /usr/share/lintian \
        /usr/share/linda \
        /usr/share/locale/* \
    && groupadd --gid ${GID} admin \
    && useradd --gid ${GID} --uid ${UID} --no-create-home --shell /sbin/nologin admin \
    && mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log /mosquitto/admin \
    && mkdir -p /var/log/nginx /tmp/nginx_client_body /tmp/nginx_proxy /tmp/nginx_fastcgi /tmp/nginx_uwsgi /tmp/nginx_scgi \
    && chown -R admin:admin /mosquitto /var/log/nginx /tmp/nginx_*

# Copy binaries from builder
COPY --from=builder /build/mosq/lib/libmosquitto.so.1 /usr/lib/libmosquitto.so.1
COPY --from=builder /build/mosq/src/mosquitto /usr/sbin/mosquitto
COPY --from=builder /build/mosq/plugins/dynamic-security/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so
COPY --from=builder /build/mosq/plugins/sql/libsql_plugin.so /usr/lib/libsql_plugin.so
COPY --from=builder /build/sqld /usr/local/bin/sqld
COPY --from=builder /build/su-exec /usr/local/bin/su-exec

# Copy configuration and scripts
COPY mosquitto/config/mosquitto.conf /mosquitto/config/mosquitto.conf
COPY mosquitto/config/dynsec.json /mosquitto/config/dynsec.json
COPY libsql/libsql.conf /mosquitto/config/libsql.conf
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
COPY docker/run.sh /mosquitto/run.sh
COPY docker/nginx-admin.conf /etc/nginx/nginx.conf
COPY admin /mosquitto/admin

# Set permissions
RUN chmod +x /docker-entrypoint.sh /mosquitto/run.sh \
    && chown -R admin:admin /mosquitto

WORKDIR /mosquitto/

VOLUME ["/mosquitto/data", "/mosquitto/log"]

# Standard MQTT
EXPOSE 1883
# MQTT over TLS  
EXPOSE 8883
# MQTT over WebSocket
EXPOSE 9001
# Admin interface (nginx)
EXPOSE 8080
# libSQL queries over HTTP
EXPOSE 8000

# Health check - verify nginx is serving (uses /health endpoint which bypasses auth)
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=3 \
    CMD curl -sf http://localhost:8080/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["/mosquitto/run.sh"]