const net = require("net");
const fs = require("fs");
const path = require("path");

// 解析命令行參數
const args = process.argv.slice(2);
let verboseLevel = 3; // 預設不顯示日誌

if (args.includes("-verbose")) {
	const index = args.indexOf("-verbose");
	if (index + 1 < args.length) {
		verboseLevel = parseInt(args[index + 1]);
		if (isNaN(verboseLevel) || verboseLevel < 1 || verboseLevel > 3) {
			console.error("無效的詳細程度。使用預設值 (3)。");
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
	log(1, "成功載入 config.json:", config);
} catch (err) {
	console.error("讀取 config.json 時發生錯誤:", err);
	process.exit(1);
}

// 將配置轉換為目標對象
const targets = new Map();
config.forEach((item) => {
	targets.set(item.url_name, { host: item.url_name, port: item.port });
});

// 創建 TCP 伺服器
const server = net.createServer((client) => {
	log(2, "客戶端連接自:", client.remoteAddress);

	let target = null;
	let handshakeBuffer = Buffer.alloc(256); // 分配一個小緩衝區用於握手
	let handshakeOffset = 0;

	client.on("data", (data) => {
		log(1, "從客戶端接收數據:", data.length, "字節");

		if (!target) {
			// 嘗試解析握手包
			const remainingSpace = handshakeBuffer.length - handshakeOffset;
			const copyLength = Math.min(remainingSpace, data.length);
			data.copy(handshakeBuffer, handshakeOffset, 0, copyLength);
			handshakeOffset += copyLength;

			const handshake = parseHandshake(
				handshakeBuffer.slice(0, handshakeOffset)
			);
			if (handshake) {
				log(1, "解析的握手:", handshake);
				target = selectTarget(handshake.hostname);
				if (target) {
					log(2, `路由到 ${target.host}:${target.port}`);
					connectToTarget(
						client,
						target,
						Buffer.concat([
							handshakeBuffer.slice(0, handshakeOffset),
							data.slice(copyLength),
						])
					);
				} else {
					log(2, "未找到匹配的目標主機名:", handshake.hostname);
					client.end();
				}
				handshakeBuffer = null; // 釋放握手緩衝區
			} else if (handshakeOffset === handshakeBuffer.length) {
				log(1, "握手緩衝區已滿，但解析不完整");
				client.end();
				handshakeBuffer = null; // 釋放握手緩衝區
			}
		} else {
			// 如果已經選擇了目標，但又收到了數據，這可能是一個錯誤狀態
			log(2, "收到意外的數據。結束連接。");
			client.end();
		}
	});

	client.on("end", () => {
		log(2, "客戶端斷開連接");
		handshakeBuffer = null; // 確保釋放握手緩衝區
	});

	client.on("error", (err) => {
		log(2, "客戶端連接錯誤:", err);
		handshakeBuffer = null; // 確保釋放握手緩衝區
	});
});

function parseHandshake(buffer) {
	if (buffer.length < 3) return null;

	let offset = 0;
	const packetLength = readVarInt(buffer, offset);
	if (!packetLength) return null;
	offset += packetLength.bytes;

	if (buffer.length < offset + packetLength.value) return null;

	const packetId = readVarInt(buffer, offset);
	if (!packetId || packetId.value !== 0x00) return null;
	offset += packetId.bytes;

	const protocolVersion = readVarInt(buffer, offset);
	if (!protocolVersion) return null;
	offset += protocolVersion.bytes;

	const hostnameLength = readVarInt(buffer, offset);
	if (!hostnameLength) return null;
	offset += hostnameLength.bytes;

	if (buffer.length < offset + hostnameLength.value) return null;

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
		if (offset + length >= buffer.length) return null;
		currentByte = buffer.readUInt8(offset + length);
		value |= (currentByte & 0x7f) << (length * 7);
		length++;
		if (length > 5) return null;
	} while ((currentByte & 0x80) !== 0);

	return { value, bytes: length };
}

function selectTarget(hostname) {
	log(1, "為主機名選擇目標:", hostname);
	const target = targets.get(hostname);
	log(1, "選擇的目標:", target);
	return target || null;
}

function connectToTarget(client, target, initialData) {
	log(1, `連接到目標: ${target.host}:${target.port}`);
	const targetSocket = net.createConnection(target, () => {
		log(1, "已連接到目標伺服器");
		log(1, "轉發初始數據:", initialData.length, "字節");
		targetSocket.write(initialData);

		// 使用 pipe 進行雙向數據傳輸
		client.pipe(targetSocket);
		targetSocket.pipe(client);
	});

	targetSocket.on("end", () => {
		log(2, "與目標伺服器斷開連接");
		client.end();
	});

	targetSocket.on("error", (err) => {
		log(2, "目標連接錯誤:", err);
		client.end();
	});
}

// 監聽 25565 端口
server.listen(25565, () => {
	log(2, "Minecraft TCP 代理伺服器運行在端口 25565");
});

// 錯誤處理
server.on("error", (err) => {
	console.error("伺服器錯誤:", err);
});

log(2, `詳細程度設置為 ${verboseLevel}`);
