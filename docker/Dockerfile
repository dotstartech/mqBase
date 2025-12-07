FROM debian:trixie

LABEL maintainer="dotStar Technologies" description="MQTT SQL Admin - Mosquitto MQTT Broker with libSQL Persistency and Web Admin Interface"

ENV VERSION=2.0.22 \
    LWS_VERSION=4.2.1 \
    LWS_SHA256=842da21f73ccba2be59e680de10a8cce7928313048750eb6ad73b6fa50763c51

# Build arguments for user/group IDs
ARG UID=1883
ARG GID=1883

COPY plugins/msg-sql/msg_plugin.c /tmp/msg_plugin.c
COPY plugins/msg-sql/Makefile /tmp/Makefile
COPY mosquitto/config/mosquitto.conf /tmp/mosquitto.conf
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
COPY docker/run.sh /run.sh
COPY admin /mosquitto/admin
COPY docker/nginx-admin.conf /tmp/nginx-admin.conf

RUN apt update && apt install -y build-essential cmake wget libssl-dev libcjson-dev ca-certificates libsqlite3-dev curl gosu nginx-light \
    && wget https://github.com/warmcat/libwebsockets/archive/v${LWS_VERSION}.tar.gz -O /tmp/lws.tar.gz \
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
    && make -j "$(nproc)" \
    && rm -rf /root/.cmake \
    && curl --proto '=https' --tlsv1.2 -LsSf https://github.com/tursodatabase/libsql/releases/download/libsql-server-v0.24.32/libsql-server-installer.sh | sh \
    && mv /root/.cargo/bin/sqld /usr/local/bin/sqld \
    && curl -o /tmp/mosq.tar.gz https://mosquitto.org/files/source/mosquitto-${VERSION}.tar.gz \
    && mkdir -p /build/mosq \
    && tar --strip=1 -xf /tmp/mosq.tar.gz -C /build/mosq \
    && rm /tmp/mosq.tar.gz \
    && mkdir -p /build/mosq/plugins/msg-sql \
    && mv /tmp/msg_plugin.c /build/mosq/plugins/msg-sql/. \
    && mv /tmp/Makefile /build/mosq/plugins/msg-sql/. \
    && sed -i 's/DIRS=/DIRS=msg-sql /' /build/mosq/plugins/Makefile \
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
        binary \
    && groupadd --gid ${GID} admin \
    && useradd --gid ${GID} --uid ${UID} --no-create-home --shell /sbin/nologin admin \
    && mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log \
    && install -d /usr/sbin/ \
    && install -s -m644 /build/mosq/lib/libmosquitto.so.1 /usr/lib/libmosquitto.so.1 \
    && install -s -m755 /build/mosq/src/mosquitto /usr/sbin/mosquitto \
    && install -s -m755 /build/mosq/plugins/dynamic-security/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so \
    && install -s -m755 /build/mosq/plugins/msg-sql/msg_plugin.so /usr/lib/msg_plugin.so \
    && install -m644 /tmp/mosquitto.conf /mosquitto/config/mosquitto.conf \
    && mv /run.sh /mosquitto \
    && chown -R admin:admin /mosquitto \
    && chmod +x /mosquitto/run.sh \
    && mv /tmp/nginx-admin.conf /etc/nginx/nginx.conf \
    && mkdir -p /var/log/nginx /tmp/nginx_client_body /tmp/nginx_proxy /tmp/nginx_fastcgi /tmp/nginx_uwsgi /tmp/nginx_scgi \
    && chown -R admin:admin /var/log/nginx /tmp/nginx_* \
    && chmod -R 755 /var/log/nginx /tmp/nginx_* \
    && apt -y purge curl build-essential wget cmake \
    && apt -y autoremove \
    && apt -y clean \
    && rm -rf /build /tmp/* /var/lib/apt/lists/*

VOLUME ["/mosquitto/data", "/mosquitto/log"]

# Standard MQTT
EXPOSE 1883

# MQTT over TLS  
EXPOSE 8883

# MQTT over WebSocket
# EXPOSE 9001 - FOR FUTURE USE

# Admin interface (nginx)
EXPOSE 8080

# libSQL queries over HTTP
# EXPOSE 8000 - FOR FUTURE USE

WORKDIR /mosquitto/

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["./run.sh"]
#CMD ["/usr/sbin/mosquitto", "-c", "/mosquitto/config/mosquitto.conf"]
#CMD ["tail", "-f", "/dev/null"]