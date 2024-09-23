const net = require("net");
const fs = require("fs");
const path = require("path");

// 解析命令行參數
const args = process.argv.slice(2);
let verboseLevel = 3; // 默認不顯示日誌

if (args.includes("-verbose")) {
	const index = args.indexOf("-verbose");
	if (index + 1 < args.length) {
		verboseLevel = parseInt(args[index + 1]);
		if (isNaN(verboseLevel) || verboseLevel < 1 || verboseLevel > 3) {
			console.error("Invalid verbose level. Using default (3).");
			verboseLevel = 3;
		}
	}
}

// 自定義日誌函數
function log(level, ...messages) {
	if (level >= verboseLevel) {
		console.log(...messages);
	}
}

// 讀取 config.json 文件
const configPath = path.join(__dirname, "config.json");
let config;

try {
	const configData = fs.readFileSync(configPath, "utf8");
	config = JSON.parse(configData);
	log(1, "Successfully loaded config.json:", config);
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
	log(2, "Client connected from:", client.remoteAddress);

	let target = null;
	let buffer = Buffer.alloc(0);

	client.on("data", (data) => {
		log(1, "Received data from client:", data.length, "bytes");
		log(1, "Raw data:", data.toString("hex"));
		buffer = Buffer.concat([buffer, data]);

		if (!target) {
			// 嘗試解析握手包以獲取主機名
			const handshake = parseHandshake(buffer);
			if (handshake) {
				log(1, "Parsed handshake:", handshake);
				target = selectTarget(handshake.hostname);
				if (target) {
					log(2, `Routing to ${target.host}:${target.port}`);
					connectToTarget(client, target, buffer);
				} else {
					log(
						2,
						"No matching target found for hostname:",
						handshake.hostname
					);
					client.end();
				}
			} else {
				log(1, "Handshake parsing incomplete, buffering more data");
				log(1, "Current buffer:", buffer.toString("hex"));
			}
		}
	});

	client.on("end", () => {
		log(2, "Client disconnected");
	});

	client.on("error", (err) => {
		log(2, "Client connection error:", err);
	});
});

function parseHandshake(buffer) {
	log(1, "Attempting to parse handshake. Buffer length:", buffer.length);
	if (buffer.length < 3) {
		log(1, "Buffer too short for handshake");
		return null;
	}

	let offset = 0;
	const packetLength = readVarInt(buffer, offset);
	if (!packetLength) {
		log(1, "Failed to read packet length");
		return null;
	}
	offset += packetLength.bytes;

	if (buffer.length < offset + packetLength.value) {
		log(1, "Buffer does not contain full packet");
		return null;
	}

	const packetId = readVarInt(buffer, offset);
	if (!packetId || packetId.value !== 0x00) {
		log(1, "Invalid packet ID:", packetId ? packetId.value : "undefined");
		return null;
	}
	offset += packetId.bytes;

	const protocolVersion = readVarInt(buffer, offset);
	if (!protocolVersion) {
		log(1, "Failed to read protocol version");
		return null;
	}
	offset += protocolVersion.bytes;

	const hostnameLength = readVarInt(buffer, offset);
	if (!hostnameLength) {
		log(1, "Failed to read hostname length");
		return null;
	}
	offset += hostnameLength.bytes;

	if (buffer.length < offset + hostnameLength.value) {
		log(1, "Buffer does not contain full hostname");
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
			log(1, "Buffer overflow while reading VarInt");
			return null;
		}
		currentByte = buffer.readUInt8(offset + length);
		value |= (currentByte & 0x7f) << (length * 7);
		length++;
		if (length > 5) {
			log(1, "VarInt too big");
			return null;
		}
	} while ((currentByte & 0x80) !== 0);

	return { value, bytes: length };
}

function selectTarget(hostname) {
	log(1, "Selecting target for hostname:", hostname);
	const target = targets[hostname];
	log(1, "Selected target:", target);
	return target || null;
}

function connectToTarget(client, target, buffer) {
	log(1, `Connecting to target: ${target.host}:${target.port}`);
	const targetSocket = net.createConnection(target, () => {
		log(1, "Connected to target server");
		log(1, "Forwarding initial data:", buffer.length, "bytes");
		targetSocket.write(buffer);
	});

	client.pipe(targetSocket);
	targetSocket.pipe(client);

	targetSocket.on("data", (data) => {
		log(1, "Received data from target:", data.length, "bytes");
	});

	targetSocket.on("end", () => {
		log(2, "Disconnected from target server");
		client.end();
	});

	targetSocket.on("error", (err) => {
		log(2, "Target connection error:", err);
		client.end();
	});
}

// 監聽 25565 端口
server.listen(25565, () => {
	log(2, "Minecraft TCP proxy server running on port 25565");
});

// 錯誤處理
server.on("error", (err) => {
	console.error("Server error:", err);
});

log(2, `Verbose level set to ${verboseLevel}`);
