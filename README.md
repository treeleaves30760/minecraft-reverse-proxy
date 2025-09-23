# minecraft-reverse-proxy

This is a tool for multiple minecraft server on the same server with **Proxy Protocol support**.

## Features

- Route Minecraft connections based on hostname
- **Proxy Protocol v1 support** for preserving original client IP addresses
- Support for chaining multiple proxies
- Hot-reload configuration without restart
- Memory monitoring and automatic restart
- Compatible with HAProxy, Cloudflare, and other proxy solutions

## Usage

Create config.json base on config-example.json

### Basic Configuration (Legacy Format)
```json
[
	{ "url_name": "example1.server.com", "send_url": "localhost", "send_port": 25564 },
	{ "url_name": "example2.server.com", "send_url": "localhost", "send_port": 25566 }
]
```

### Advanced Configuration with Proxy Protocol
```json
[
	{
		"url_name": "example1.server.com",
		"send_url": "localhost",
		"send_port": 25564,
		"proxy_protocol": {
			"receive": true,
			"send": true,
			"version": 1
		}
	}
]
```

### Proxy Protocol Configuration Options

- `receive`: Accept incoming Proxy Protocol headers (from upstream proxies)
- `send`: Send Proxy Protocol headers to downstream servers
- `version`: Proxy Protocol version (currently only version 1 is supported)

### Use Cases

1. **Behind a Load Balancer**: Set `receive: true` to get real client IPs from your load balancer
2. **Chaining Proxies**: Use both `receive: true` and `send: true` to preserve client IPs through multiple proxy layers
3. **Security**: Downstream servers can block direct connections when Proxy Protocol is enabled

Then run the service

```bash
npm install
npm run long
```

This will use pm2 to create a process that for minecraft proxy.

## Report

If you find any bugs, welcome to make issue for me.
And please add the screenshot of the error.
You can use the below command to get the error message.

```bash
npm run start:verbose
```
