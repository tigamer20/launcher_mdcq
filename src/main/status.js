// Asks a Minecraft server (Paper, Spigot, vanilla...) for its status: players online, version, MOTD.
// Uses the standard "Server List Ping", the same thing the multiplayer menu does.
const net = require('net');
const dns = require('dns').promises;

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

// Like Minecraft: an address without a custom port can point to the real host/port with a DNS "SRV" record
// (_minecraft._tcp.<address>). playit.gg addresses (xxx.joinmc.link) work this way.
async function resolveAddress(host, port) {
  if (port !== 25565 || net.isIP(host)) return { host, port, srv: false };
  try {
    const [record] = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (record) return { host: record.name, port: record.port, srv: true };
  } catch {
    // no SRV record: use the address as typed
  }
  return { host, port, srv: false };
}

// Why the server didn't answer, in words the admins understand.
const REASONS = {
  ENOTFOUND: "adresse introuvable (vérifie l'orthographe de l'adresse)",
  EAI_AGAIN: "adresse introuvable pour l'instant (problème DNS)",
  ECONNREFUSED: "connexion refusée : rien n'écoute sur ce port (mauvais port ou serveur éteint)",
  ECONNRESET: 'connexion coupée par le serveur',
  EHOSTUNREACH: 'machine injoignable',
  ENETUNREACH: 'réseau injoignable',
  timeout: "pas de réponse dans les temps (mauvais port, tunnel playit.gg arrêté ou pare-feu)",
  invalid: "quelque chose répond sur ce port, mais ce n'est pas un serveur Minecraft",
};

// Protocol numbers sent by the real Minecraft client. Some anti-bot plugins and proxies cut
// connections that announce "any version" (-1), so the ping says which version it is, like the game.
const PROTOCOLS = {
  '1.20.1': 763, '1.20.2': 764, '1.20.3': 765, '1.20.4': 765, '1.20.5': 766, '1.20.6': 766,
  '1.21': 767, '1.21.1': 767, '1.21.2': 768, '1.21.3': 768, '1.21.4': 769, '1.21.5': 770,
  '1.21.6': 771, '1.21.7': 772, '1.21.8': 772,
};
const protocolFor = (minecraftVersion) => PROTOCOLS[minecraftVersion] || 769;

/**
 * Returns { online, players: { online, max, list }, version, motd, tried }.
 * When offline: { online: false, reason, tried } where tried is the "host:port" actually contacted.
 * options: { minecraftVersion: '1.21.4', timeoutMs: 3000 }
 */
async function pingServer(host, port = 25565, { minecraftVersion, timeoutMs = 3000 } = {}) {
  port = Number(port) || 25565;
  const target = await resolveAddress(host, port);
  const tried = `${target.host}:${target.port}${target.srv ? ' (via SRV)' : ''}`;
  // Like the game's server list: connect to the SRV target, but announce the address as the player typed it.
  const handshake = { host, port, protocol: protocolFor(minecraftVersion) };
  const result = await pingAddress(target.host, target.port, timeoutMs, handshake);
  if (!result.online) result.reason = REASONS[result.code] || `erreur ${result.code}`;
  return { ...result, tried };
}

function pingAddress(host, port, timeoutMs, handshake) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let data = Buffer.alloc(0);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ online: false, code: 'timeout' }));
    socket.on('error', (err) => done({ online: false, code: err.code || 'unknown' }));

    socket.on('connect', () => {
      const address = Buffer.from(handshake.host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(handshake.port);
      // Handshake (next state 1 = status) then status request, sent together like the game does.
      socket.write(
        Buffer.concat([
          packet(0x00, varInt(handshake.protocol), varInt(address.length), address, portBuf, varInt(1)),
          packet(0x00),
        ]),
      );
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
        done({ online: false, code: 'invalid' });
      }
    });
  });
}

module.exports = { pingServer };
