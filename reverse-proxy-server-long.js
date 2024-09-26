const net = require("net");
const fs = require("fs");
const path = require("path");
const { execSync } = require('child_process');

// 全局變量
let server;
let config;
let targets = new Map();
let verboseLevel = 3;

// 錯誤處理和日誌記錄
function log(level, ...messages) {
    if (level >= verboseLevel) {
        console.log(new Date().toISOString(), ...messages);
    }
}

function logError(error) {
    console.error(new Date().toISOString(), "錯誤:", error);
    // 這裡可以添加將錯誤寫入文件的邏輯
}

// 配置文件處理
function loadConfig() {
    const configPath = path.join(__dirname, "config.json");
    try {
        const configData = fs.readFileSync(configPath, "utf8");
        config = JSON.parse(configData);
        targets.clear();
        config.forEach((item) => {
            targets.set(item.url_name, { host: item.send_url, port: item.send_port });
        });
        log(1, "成功載入 config.json:", config);
    } catch (err) {
        logError("讀取 config.json 時發生錯誤: " + err);
        process.exit(1);
    }
}

// 監視配置文件變化
fs.watch(path.join(__dirname, "config.json"), (eventType, filename) => {
    if (eventType === 'change') {
        log(2, "檢測到配置文件變化，重新加載配置");
        loadConfig();
    }
});

// 主要的服務器邏輯
function createServer() {
    server = net.createServer((client) => {
        log(2, "客戶端連接自:", client.remoteAddress);

        let target = null;
        let handshakeBuffer = Buffer.alloc(256);
        let handshakeOffset = 0;
        let handshakeCompleted = false;

        client.on("data", (data) => {
            try {
                log(1, "從客戶端接收數據:", data.length, "字節");

                if (!handshakeCompleted) {
                    const remainingSpace = handshakeBuffer.length - handshakeOffset;
                    const copyLength = Math.min(remainingSpace, data.length);
                    data.copy(handshakeBuffer, handshakeOffset, 0, copyLength);
                    handshakeOffset += copyLength;

                    const handshake = parseHandshake(handshakeBuffer.slice(0, handshakeOffset));
                    if (handshake) {
                        log(1, "解析的握手:", handshake);
                        target = selectTarget(handshake.hostname);
                        if (target) {
                            log(2, `路由到 ${target.host}:${target.port}`);
                            connectToTarget(client, target, Buffer.concat([handshakeBuffer.slice(0, handshakeOffset), data.slice(copyLength)]));
                        } else {
                            log(2, "未找到匹配的目標主機名:", handshake.hostname);
                            sendErrorResponse(client, "未找到匹配的目標主機名");
                        }
                        handshakeCompleted = true;
                    } else if (handshakeOffset === handshakeBuffer.length) {
                        log(1, "握手緩衝區已滿，但解析不完整");
                        sendErrorResponse(client, "無效的握手數據");
                        handshakeCompleted = true;
                    }
                } else if (!target) {
                    client.end();
                }
            } catch (error) {
                logError("處理客戶端數據時發生錯誤: " + error);
                client.end();
            }
        });

        client.on("end", () => {
            log(2, "客戶端斷開連接");
        });

        client.on("error", (err) => {
            logError("客戶端連接錯誤: " + err);
        });
    });

    server.on("error", (err) => {
        logError("服務器錯誤: " + err);
        // 嘗試重新啟動服務器
        setTimeout(() => {
            log(2, "嘗試重新啟動服務器...");
            server.close(() => createServer());
        }, 5000);
    });

    server.listen(25565, () => {
        log(2, "Minecraft TCP 代理服務器運行在端口 25565");
    });
}

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

function sendErrorResponse(client, message) {
    const response = {
        text: JSON.stringify({
            text: message
        })
    };

    const jsonResponse = JSON.stringify(response);
    const data = Buffer.from(jsonResponse, 'utf8');

    const packet = Buffer.alloc(data.length + 5);
    let offset = 0;
    offset = writeVarInt(packet, data.length + 1, offset);
    offset = writeVarInt(packet, 0x00, offset); // Packet ID for disconnect
    data.copy(packet, offset);

    client.write(packet);
    client.end();
}

function writeVarInt(buffer, value, offset) {
    do {
        let temp = value & 0b01111111;
        value >>>= 7;
        if (value !== 0) {
            temp |= 0b10000000;
        }
        buffer.writeUInt8(temp, offset);
        offset++;
    } while (value !== 0);
    return offset;
}

// 定期健康檢查
setInterval(() => {
    const memoryUsage = process.memoryUsage();
    log(1, "內存使用情況:", 
        "RSS:", (memoryUsage.rss / 1024 / 1024).toFixed(2), "MB,",
        "堆總大小:", (memoryUsage.heapTotal / 1024 / 1024).toFixed(2), "MB,",
        "堆使用大小:", (memoryUsage.heapUsed / 1024 / 1024).toFixed(2), "MB");

    // 如果內存使用過高，可以在這裡添加重啟邏輯
    if (memoryUsage.heapUsed > 4 * 1024 * 1024 * 1024) { // 如果堆內存使用超過4GB
        log(2, "內存使用過高，重新啟動服務器");
        process.exit(1); // 退出進程，依賴外部進程管理器重啟
    }
}, 60000); // 每分鐘檢查一次

// 初始化
loadConfig();
createServer();

log(2, `詳細程度設置為 ${verboseLevel}`);

// 處理未捕獲的異常
process.on('uncaughtException', (error) => {
    logError("未捕獲的異常: " + error);
    // 可以在這裡添加重啟邏輯
});

process.on('unhandledRejection', (reason, promise) => {
    logError("未處理的 Promise 拒絕: " + reason);
    // 可以在這裡添加重啟邏輯
});