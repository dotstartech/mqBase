# DEV Scripts and Configs

## External Nginx Reverse Proxy
`proxy.conf` is an example configuration for external Nginx reverse proxy (not the one running in this container). The variable mapping below shall be added to the Nginx configuration before the `server {}` block
```apacheconf
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```