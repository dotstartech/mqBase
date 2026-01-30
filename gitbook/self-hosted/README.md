# Self-hosted

Deploy mqBase on your own infrastructure with full control over your data and configuration.

mqBase is distributed as a Docker image that bundles everything you need:

* **Mosquitto** MQTT broker with dynamic security plugin
* **libSQL** database for message persistence via Mosquitto plugin interface
* **Admin Web UI** served by **Nginx** web server for
    - Database queries
    - Live broker monitoring
    - ACL management

## Quick Links

<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Quick Start</strong></td><td>Get up and running in minutes</td><td><a href="quick-start.md">quick-start.md</a></td></tr><tr><td><strong>Configuration</strong></td><td>Customize your deployment</td><td><a href="configuration.md">configuration.md</a></td></tr><tr><td><strong>Production Deployment</strong></td><td>Best practices for production</td><td><a href="production.md">production.md</a></td></tr></tbody></table>

## System Requirements

| Resource | Minimum | Recommended |
| -------- | ------- | ----------- |
| CPU      | 1 core  | 2+ cores    |
| RAM      | 512 MB  | 1+ GB       |
| Disk     | 1 GB    | 10+ GB (depends on retention) |
| Docker   | 20.10+  | Latest      |

## Exposed Ports

| Port | Protocol | Description |
| ---- | -------- | ----------- |
| 1883 | TCP      | MQTT (plain) |
| 8883 | TCP      | MQTT over TLS |
| 9001 | TCP      | MQTT over WebSocket |
| 8080 | HTTP     | Admin UI |
| 8000 | HTTP     | libSQL HTTP API |

## Next Steps

{% content-ref url="quick-start.md" %}
[quick-start.md](quick-start.md)
{% endcontent-ref %}
