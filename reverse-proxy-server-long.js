const net = require("net");
const fs = require("fs");
const path = require("path");
const { execSync } = require('child_process');

// 全局變量
let server;
let config;
let targets = new Map();
let verboseLevel = parseInt(process.env.VERBOSE_LEVEL) || 3;

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
            // 支援新的配置格式，同時向後兼容舊格式
            const target = {
                host: item.send_url || 'localhost',
                port: item.send_port || item.port, // 向後兼容舊的 port 欄位
                proxyProtocol: item.proxy_protocol || {
                    receive: false,
                    send: false,
                    version: 1
                }
            };
            targets.set(item.url_name, target);
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

// Proxy Protocol 處理函數
function parseProxyProtocol(buffer) {
    if (buffer.length < 8) return null;

    // 檢查是否為 Proxy Protocol v1
    const headerStart = buffer.toString('ascii', 0, 5);
    if (headerStart === 'PROXY') {
        return parseProxyProtocolV1(buffer);
    }

    // 檢查是否為 Proxy Protocol v2
    const v2Signature = Buffer.from([0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A]);
    if (buffer.length >= 12 && buffer.subarray(0, 12).equals(v2Signature)) {
        log(1, "檢測到 Proxy Protocol v2，目前僅支援 v1");
        return null;
    }

    return null;
}

function parseProxyProtocolV1(buffer) {
    // 尋找行結束符 \r\n
    let lineEnd = -1;
    for (let i = 0; i < Math.min(buffer.length, 107); i++) {
        if (buffer[i] === 0x0D && i + 1 < buffer.length && buffer[i + 1] === 0x0A) {
            lineEnd = i;
            break;
        }
    }

    if (lineEnd === -1) return null; // 尚未收到完整的行

    const line = buffer.toString('ascii', 0, lineEnd);
    const parts = line.split(' ');

    // PROXY TCP4/TCP6 srcIP destIP srcPort destPort
    if (parts.length !== 6 || parts[0] !== 'PROXY') {
        log(1, "無效的 Proxy Protocol v1 格式:", line);
        return null;
    }

    const [, protocol, srcIP, destIP, srcPort, destPort] = parts;

    if (protocol !== 'TCP4' && protocol !== 'TCP6') {
        log(1, "不支援的協議:", protocol);
        return null;
    }

    return {
        version: 1,
        protocol: protocol,
        srcIP: srcIP,
        destIP: destIP,
        srcPort: parseInt(srcPort),
        destPort: parseInt(destPort),
        headerLength: lineEnd + 2 // 包含 \r\n
    };
}

function generateProxyProtocolV1(srcIP, destIP, srcPort, destPort) {
    // 判斷是 IPv4 還是 IPv6
    const protocol = srcIP.includes(':') ? 'TCP6' : 'TCP4';
    const header = `PROXY ${protocol} ${srcIP} ${destIP} ${srcPort} ${destPort}\r\n`;
    return Buffer.from(header, 'ascii');
}

// 主要的服務器邏輯
function createServer() {
    server = net.createServer((client) => {
        log(2, "客戶端連接自:", client.remoteAddress);

        let target = null;
        let handshakeBuffer = Buffer.alloc(256);
        let handshakeOffset = 0;
        let handshakeCompleted = false;
        let proxyProtocolParsed = false;
        let originalClientInfo = {
            ip: client.remoteAddress,
            port: client.remotePort
        };

        client.on("data", (data) => {
            try {
                log(1, "從客戶端接收數據:", data.length, "字節");

                if (!handshakeCompleted) {
                    const remainingSpace = handshakeBuffer.length - handshakeOffset;
                    const copyLength = Math.min(remainingSpace, data.length);
                    data.copy(handshakeBuffer, handshakeOffset, 0, copyLength);
                    handshakeOffset += copyLength;

                    let dataToProcess = handshakeBuffer.slice(0, handshakeOffset);
                    let dataOffset = 0;

                    // 首先嘗試解析 Proxy Protocol（如果尚未解析）
                    if (!proxyProtocolParsed) {
                        const proxyProtocol = parseProxyProtocol(dataToProcess);
                        if (proxyProtocol) {
                            log(1, "解析到 Proxy Protocol:", proxyProtocol);
                            originalClientInfo.ip = proxyProtocol.srcIP;
                            originalClientInfo.port = proxyProtocol.srcPort;
                            dataOffset = proxyProtocol.headerLength;
                            proxyProtocolParsed = true;
                            log(2, "原始客戶端:", originalClientInfo.ip + ":" + originalClientInfo.port);
                        } else {
                            // 沒有 Proxy Protocol 標頭，標記為已解析
                            proxyProtocolParsed = true;
                        }
                    }

                    // 解析 Minecraft 握手包
                    const handshakeData = dataToProcess.slice(dataOffset);
                    const handshake = parseHandshake(handshakeData);
                    if (handshake) {
                        log(1, "解析的握手:", handshake);
                        target = selectTarget(handshake.hostname);
                        if (target) {
                            log(2, `路由到 ${target.host}:${target.port}`);
                            const remainingData = Buffer.concat([
                                handshakeData,
                                data.slice(copyLength)
                            ]);
                            connectToTarget(client, target, remainingData, originalClientInfo);
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

function connectToTarget(client, target, initialData, originalClientInfo) {
    log(1, `連接到目標: ${target.host}:${target.port}`);
    const targetSocket = net.createConnection({ host: target.host, port: target.port }, () => {
        log(1, "已連接到目標伺服器");

        // 檢查是否需要發送 Proxy Protocol 標頭
        if (target.proxyProtocol && target.proxyProtocol.send) {
            const proxyHeader = generateProxyProtocolV1(
                originalClientInfo.ip,
                targetSocket.localAddress,
                originalClientInfo.port,
                targetSocket.localPort
            );
            log(1, "發送 Proxy Protocol 標頭:", proxyHeader.toString('ascii').trim());
            targetSocket.write(proxyHeader);
        }

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