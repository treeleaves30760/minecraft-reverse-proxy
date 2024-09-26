# minecraft-reverse-proxy

This is a tool for multiple minecraft server on the same server

## Usage

Create config.json base on config-example.json

```json
[
	{ "url_name": "example1.server.com", "send_url": "localhost", "port": 25564 },
	{ "url_name": "example2.server.com", "send_url": "localhost", "port": 25566 },
	{ "url_name": "example3.server.com", "send_url": "localhost", "port": 25567 }
]
```

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
