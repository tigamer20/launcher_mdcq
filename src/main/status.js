// Asks a Minecraft server (Paper, Spigot, vanilla...) for its status: players online, version, MOTD.
// Uses the standard "Server List Ping", the same thing the multiplayer menu does.
const net = require('net');

function varInt(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

// Reads a VarInt at `offset`. Returns null if the buffer doesn't contain all of it yet.
function readVarInt(buf, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return { value, size: i + 1 };
  }
  throw new Error('VarInt invalide');
}

function packet(id, ...parts) {
  const body = Buffer.concat([varInt(id), ...parts]);
  return Buffer.concat([varInt(body.length), body]);
}

function text(component) {
  if (typeof component === 'string') return component;
  if (!component) return '';
  return (component.text || '') + (component.extra || []).map(text).join('');
}

/** Returns { online, players: { online, max, list }, version, motd } (online: false if unreachable). */
function pingServer(host, port = 25565, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let data = Buffer.alloc(0);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ online: false }));
    socket.on('error', () => done({ online: false }));

    socket.on('connect', () => {
      const address = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      // Handshake (protocol -1 = "any version", next state 1 = status) then status request.
      socket.write(packet(0x00, varInt(-1 >>> 0), varInt(address.length), address, portBuf, varInt(1)));
      socket.write(packet(0x00));
    });

    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      try {
        const length = readVarInt(data);
        if (!length || data.length < length.size + length.value) return;
        const id = readVarInt(data, length.size);
        const strLen = readVarInt(data, length.size + id.size);
        const start = length.size + id.size + strLen.size;
        const json = JSON.parse(data.toString('utf8', start, start + strLen.value));
        done({
          online: true,
          players: {
            online: json.players?.online ?? 0,
            max: json.players?.max ?? 0,
            list: (json.players?.sample || []).map((p) => p.name),
          },
          version: json.version?.name || '',
          motd: text(json.description),
        });
      } catch {
        done({ online: false });
      }
    });
  });
}

module.exports = { pingServer };
