# Production Deployment

Best practices and deployment options for running mqBase in production.

## Security Checklist

Before deploying to production, ensure you:

- [ ] Use strong, unique passwords for `MQBASE_USER` and `MQBASE_MQTT_USER`
- [ ] Enable TLS for MQTT connections (port 8883)
- [ ] Put the Admin UI behind a reverse proxy with HTTPS
- [ ] Restrict network access to only required ports
- [ ] Configure data retention to manage disk usage
- [ ] Set up log rotation
- [ ] Remove or disable the `test` user from ACL

***

## Docker Swarm Deployment

Docker Swarm provides built-in secrets management and service orchestration.

### 1. Create Secrets

```bash
# Create secrets file
cat > mqbase.secrets << EOF
MQBASE_USER=admin:$(openssl rand -base64 24)
MQBASE_MQTT_USER=admin:$(openssl rand -base64 24)
EOF

# Add to Swarm secrets
docker secret create mqbase.secrets mqbase.secrets

# Remove local file
rm mqbase.secrets
```

### 2. Deploy Stack

Create `compose.swarm.yml`:

```yaml
version: "3.8"

services:
  mqbase:
    image: dotstartech/mqbase:latest
    ports:
      - 1883:1883
      - 8883:8883
      - 8080:8080
      - 9001:9001
    secrets:
      - mqbase.secrets
    volumes:
      - mqbase-data:/mosquitto/data
      - mqbase-log:/mosquitto/log
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 256M

secrets:
  mqbase.secrets:
    external: true

volumes:
  mqbase-data:
  mqbase-log:
```

Deploy the stack:

```bash
docker stack deploy -c compose.swarm.yml mqbase
```

***

## Kubernetes Deployment

### 1. Create Secret

```bash
kubectl create secret generic mqbase-secrets \
  --from-literal=MQBASE_USER=admin:yourpassword \
  --from-literal=MQBASE_MQTT_USER=admin:yourpassword
```

### 2. Create Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mqbase
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mqbase
  template:
    metadata:
      labels:
        app: mqbase
    spec:
      containers:
        - name: mqbase
          image: dotstartech/mqbase:latest
          ports:
            - containerPort: 1883
            - containerPort: 8080
            - containerPort: 9001
          env:
            - name: MQBASE_USER
              valueFrom:
                secretKeyRef:
                  name: mqbase-secrets
                  key: MQBASE_USER
            - name: MQBASE_MQTT_USER
              valueFrom:
                secretKeyRef:
                  name: mqbase-secrets
                  key: MQBASE_MQTT_USER
          volumeMounts:
            - name: data
              mountPath: /mosquitto/data
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: mqbase-data
---
apiVersion: v1
kind: Service
metadata:
  name: mqbase
spec:
  selector:
    app: mqbase
  ports:
    - name: mqtt
      port: 1883
    - name: admin
      port: 8080
    - name: ws
      port: 9001
```

***

## Reverse Proxy with HTTPS

### Nginx Configuration

```nginx
upstream mqbase {
    server mqbase:8080;
}

upstream mqbase-ws {
    server mqbase:9001;
}

server {
    listen 443 ssl http2;
    server_name mqtt.example.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    # Admin UI
    location / {
        proxy_pass http://mqbase;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket MQTT
    location /mqtt {
        proxy_pass http://mqbase-ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

### Traefik Labels

```yaml
services:
  mqbase:
    image: dotstartech/mqbase:latest
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.mqbase.rule=Host(`mqtt.example.com`)"
      - "traefik.http.routers.mqbase.tls=true"
      - "traefik.http.routers.mqbase.tls.certresolver=letsencrypt"
      - "traefik.http.services.mqbase.loadbalancer.server.port=8080"
```

***

## Monitoring

### Health Check

mqBase includes a built-in health check. Monitor container health:

```bash
docker inspect --format='{{.State.Health.Status}}' mqbase
```

### Log Aggregation

Forward logs to your logging infrastructure:

```yaml
services:
  mqbase:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Or use a log aggregator:

```yaml
services:
  mqbase:
    logging:
      driver: "fluentd"
      options:
        fluentd-address: "localhost:24224"
        tag: "mqbase"
```

### Metrics

Monitor database size and message counts via the Admin UI or direct SQL queries:

```sql
-- Total message count
SELECT COUNT(*) FROM messages;

-- Messages per day
SELECT DATE(timestamp) as day, COUNT(*) as count 
FROM messages 
GROUP BY DATE(timestamp) 
ORDER BY day DESC;

-- Database size (approximate)
SELECT page_count * page_size as size_bytes 
FROM pragma_page_count(), pragma_page_size();
```

***

## Backup and Recovery

### Database Backup

```bash
# Copy database file from container
docker cp mqbase:/mosquitto/data/messages.db ./backup/

# Or use volume backup
docker run --rm \
  -v mqbase-data:/data:ro \
  -v $(pwd)/backup:/backup \
  alpine tar czf /backup/mqbase-data.tar.gz /data
```

### Restore

```bash
# Stop container
docker stop mqbase

# Restore data
docker run --rm \
  -v mqbase-data:/data \
  -v $(pwd)/backup:/backup \
  alpine tar xzf /backup/mqbase-data.tar.gz -C /

# Start container
docker start mqbase
```

***

## Resource Recommendations

| Deployment Size | Messages/Day | CPU | RAM | Disk |
| --------------- | ------------ | --- | --- | ---- |
| Small           | < 100K       | 1 core | 512 MB | 10 GB |
| Medium          | 100K - 1M    | 2 cores | 1 GB | 50 GB |
| Large           | 1M - 10M     | 4 cores | 2 GB | 200 GB |

{% hint style="info" %}
These are estimates. Actual requirements depend on message size, retention period, and query patterns.
{% endhint %}
