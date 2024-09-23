const net = require("net");
const fs = require("fs");
const path = require("path");

// 讀取 config.json 文件
const configPath = path.join(__dirname, "config.json");
let config;

try {
	const configData = fs.readFileSync(configPath, "utf8");
	config = JSON.parse(configData);
	console.log("Successfully loaded config.json:", config);
} catch (err) {
	console.error("Error loading config.json:", err);
	process.exit(1);
}

// 將配置轉換為目標對象
const targets = {};
config.forEach((item) => {
	targets[item.url_name] = { host: item.url_name, port: item.port };
});

// 創建 TCP 服務器
const server = net.createServer((client) => {
	console.log("Client connected from:", client.remoteAddress);

	let target = null;
	let buffer = Buffer.alloc(0);

	client.on("data", (data) => {
		console.log("Received data from client:", data.length, "bytes");
		console.log("Raw data:", data.toString("hex"));
		buffer = Buffer.concat([buffer, data]);

		if (!target) {
			// 嘗試解析握手包以獲取主機名
			const handshake = parseHandshake(buffer);
			if (handshake) {
				console.log("Parsed handshake:", handshake);
				target = selectTarget(handshake.hostname);
				if (target) {
					console.log(`Routing to ${target.host}:${target.port}`);
					connectToTarget(client, target, buffer);
				} else {
					console.log(
						"No matching target found for hostname:",
						handshake.hostname
					);
					client.end();
				}
			} else {
				console.log(
					"Handshake parsing incomplete, buffering more data"
				);
				console.log("Current buffer:", buffer.toString("hex"));
			}
		}
	});

	client.on("end", () => {
		console.log("Client disconnected");
	});

	client.on("error", (err) => {
		console.error("Client connection error:", err);
	});
});

function parseHandshake(buffer) {
	console.log("Attempting to parse handshake. Buffer length:", buffer.length);
	if (buffer.length < 3) {
		console.log("Buffer too short for handshake");
		return null;
	}

	let offset = 0;
	const packetLength = readVarInt(buffer, offset);
	if (!packetLength) {
		console.log("Failed to read packet length");
		return null;
	}
	offset += packetLength.bytes;

	if (buffer.length < offset + packetLength.value) {
		console.log("Buffer does not contain full packet");
		return null;
	}

	const packetId = readVarInt(buffer, offset);
	if (!packetId || packetId.value !== 0x00) {
		console.log(
			"Invalid packet ID:",
			packetId ? packetId.value : "undefined"
		);
		return null;
	}
	offset += packetId.bytes;

	const protocolVersion = readVarInt(buffer, offset);
	if (!protocolVersion) {
		console.log("Failed to read protocol version");
		return null;
	}
	offset += protocolVersion.bytes;

	const hostnameLength = readVarInt(buffer, offset);
	if (!hostnameLength) {
		console.log("Failed to read hostname length");
		return null;
	}
	offset += hostnameLength.bytes;

	if (buffer.length < offset + hostnameLength.value) {
		console.log("Buffer does not contain full hostname");
		return null;
	}

	const hostname = buffer.toString(
		"utf8",
		offset,
		offset + hostnameLength.value
	);

	return { hostname, protocolVersion: protocolVersion.value };
}

function readVarInt(buffer, offset) {
	let value = 0;
	let length = 0;
	let currentByte;

	do {
		if (offset + length >= buffer.length) {
			console.log("Buffer overflow while reading VarInt");
			return null;
		}
		currentByte = buffer.readUInt8(offset + length);
		value |= (currentByte & 0x7f) << (length * 7);
		length++;
		if (length > 5) {
			console.log("VarInt too big");
			return null;
		}
	} while ((currentByte & 0x80) !== 0);

	return { value, bytes: length };
}

function selectTarget(hostname) {
	console.log("Selecting target for hostname:", hostname);
	const target = targets[hostname];
	console.log("Selected target:", target);
	return target || null;
}

function connectToTarget(client, target, buffer) {
	console.log(`Connecting to target: ${target.host}:${target.port}`);
	const targetSocket = net.createConnection(target, () => {
		console.log("Connected to target server");
		console.log("Forwarding initial data:", buffer.length, "bytes");
		targetSocket.write(buffer);
	});

	client.pipe(targetSocket);
	targetSocket.pipe(client);

	targetSocket.on("data", (data) => {
		console.log("Received data from target:", data.length, "bytes");
	});

	targetSocket.on("end", () => {
		console.log("Disconnected from target server");
		client.end();
	});

	targetSocket.on("error", (err) => {
		console.error("Target connection error:", err);
		client.end();
	});
}

// 監聽 25565 端口
server.listen(25565, () => {
	console.log("Minecraft TCP proxy server running on port 25565");
});

// 錯誤處理
server.on("error", (err) => {
	console.error("Server error:", err);
});
