const net = require('net');
const fs = require('fs');
const path = require('path');

// 讀取 config.json 文件
const configPath = path.join(__dirname, 'config.json');
let config;

try {
  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  console.log('Successfully loaded config.json');
} catch (err) {
  console.error('Error loading config.json:', err);
  process.exit(1);
}

// 將配置轉換為目標對象
const targets = {};
config.forEach(item => {
  targets[item.url_name] = { host: 'localhost', port: item.port };
});

// 創建 TCP 服務器
const server = net.createServer((client) => {
  console.log('Client connected');

  let target = null;
  let buffer = Buffer.alloc(0);

  client.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);

    if (!target) {
      // 嘗試解析握手包以獲取主機名
      const handshake = parseHandshake(buffer);
      if (handshake) {
        target = selectTarget(handshake.hostname);
        if (target) {
          console.log(`Routing to ${target.host}:${target.port}`);
          connectToTarget(client, target, buffer);
        } else {
          console.log('No matching target found');
          client.end();
        }
      }
    }
  });

  client.on('end', () => {
    console.log('Client disconnected');
  });
});

function parseHandshake(buffer) {
  if (buffer.length < 3) return null;

  const length = buffer.readUInt16BE(0);
  if (buffer.length < length + 2) return null;

  const packetId = buffer.readUInt8(2);
  if (packetId !== 0x00) return null;

  let offset = 3;
  const protocolVersion = readVarInt(buffer, offset);
  offset += protocolVersion.bytes;

  const hostnameLength = readVarInt(buffer, offset);
  offset += hostnameLength.bytes;

  const hostname = buffer.toString('utf8', offset, offset + hostnameLength.value);

  return { hostname };
}

function readVarInt(buffer, offset) {
  let value = 0;
  let length = 0;
  let currentByte;

  do {
    currentByte = buffer.readUInt8(offset + length);
    value |= (currentByte & 0x7F) << (length * 7);
    length++;
    if (length > 5) {
      throw new Error('VarInt too big');
    }
  } while ((currentByte & 0x80) !== 0);

  return { value, bytes: length };
}

function selectTarget(hostname) {
  return targets[hostname] || null;
}

function connectToTarget(client, target, buffer) {
  const targetSocket = net.createConnection(target, () => {
    console.log('Connected to target server');
    targetSocket.write(buffer);
  });

  client.pipe(targetSocket);
  targetSocket.pipe(client);

  targetSocket.on('end', () => {
    console.log('Disconnected from target server');
    client.end();
  });

  targetSocket.on('error', (err) => {
    console.error('Target connection error:', err);
    client.end();
  });
}

// 監聽 25565 端口
server.listen(25565, () => {
  console.log('Minecraft TCP proxy server running on port 25565');
});

// 錯誤處理
server.on('error', (err) => {
  console.error('Server error:', err);
});
