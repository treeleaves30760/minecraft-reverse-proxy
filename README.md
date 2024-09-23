# minecraft-reverse-proxy

This is a tool for multiple minecraft server on the same server

## Usage

Create config.json base on config-example.json

```json
[
 { "url_name": "example1.server.com", "port": 25564 },
 { "url_name": "example2.server.com", "port": 25566 },
 { "url_name": "example3.server.com", "port": 25567 }
]
```

Then run the service

```bash
npm run start
```
