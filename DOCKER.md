# Docker Examples

This directory contains various Docker configuration examples for different deployment scenarios.

## Files

- **config.docker-example.json**: Example configuration for Docker container networks
- **docker-compose.yml**: Main production compose file
- **docker-compose.dev.yml**: Development override with verbose logging

## Quick Start

1. Copy `config-example.json` to `config.json` and customize it
2. Run `docker compose up -d`
3. Your Minecraft reverse proxy is now running on port 25565

## Advanced Examples

### Multi-server setup
```json
[
  {
    "url_name": "survival.yourdomain.com",
    "send_url": "minecraft-survival",
    "send_port": 25565
  },
  {
    "url_name": "creative.yourdomain.com", 
    "send_url": "minecraft-creative",
    "send_port": 25565
  }
]
```

### With Proxy Protocol (for use behind load balancers)
```json
[
  {
    "url_name": "mc.yourdomain.com",
    "send_url": "minecraft-backend", 
    "send_port": 25565,
    "proxy_protocol": {
      "receive": true,
      "send": true,
      "version": 1
    }
  }
]
```