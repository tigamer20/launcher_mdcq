// Discord status ("Rich Presence"): the player's Discord profile shows "Joue à ATM Launcher", what they are doing
// and how many players are on the server. Talks to the Discord app installed on this computer through its local
// connection (a named pipe on Windows, a socket on Linux/macOS), so no library and no internet request.
// Never blocks or breaks the launcher: without Discord (or with the browser version) nothing happens.
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const CLIENT_ID = '1570189924924264498'; // Discord Developer Portal > application "ATM Launcher"
const LARGE_IMAGE = 'logo'; // Rich Presence > Art Assets: an image uploaded with this name
const RETRY_MS = 20_000; // Discord started after the launcher: try again regularly

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

let enabled = true;
let socket = null;
let ready = false;
let retryTimer = null;
let activity = null; // the last status asked for, sent again after a reconnect

// Discord listens on discord-ipc-0 to discord-ipc-9 (one per Discord app running: stable, PTB, Canary...).
function candidates() {
  const ids = [...Array(10).keys()];
  if (process.platform === 'win32') return ids.map((i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const env = process.env;
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  // Discord installed with Flatpak or Snap puts its socket in a subfolder.
  const dirs = [base, path.join(base, 'app', 'com.discordapp.Discord'), path.join(base, 'snap.discord'), path.join(base, '.flatpak', 'dev.vencord.Vesktop', 'xdg-run')];
  return dirs.flatMap((dir) => ids.map((i) => path.join(dir, `discord-ipc-${i}`)));
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

function tryConnect(paths) {
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= paths.length) return resolve(null);
      const sock = net.createConnection(paths[i]);
      sock.once('connect', () => {
        sock.removeAllListeners('error');
        resolve(sock);
      });
      sock.once('error', () => next(i + 1));
    };
    next(0);
  });
}

function scheduleRetry() {
  if (!enabled || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, RETRY_MS);
  retryTimer.unref?.(); // never keeps the launcher open
}

function disconnect() {
  ready = false;
  if (socket) {
    socket.removeAllListeners();
    socket.on('error', () => {});
    socket.destroy();
    socket = null;
  }
}

async function connect() {
  if (!enabled || socket) return;
  const sock = await tryConnect(candidates()).catch(() => null);
  if (!sock) return scheduleRetry();
  if (!enabled) return sock.destroy();
  socket = sock;

  let buffer = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readInt32LE(0);
      const length = buffer.readInt32LE(4);
      if (buffer.length < 8 + length) break;
      let data = null;
      try {
        data = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8'));
      } catch {
        // ignore a broken message
      }
      buffer = buffer.subarray(8 + length);
      onMessage(op, data);
    }
  });
  const lost = () => {
    disconnect();
    scheduleRetry(); // Discord closed or restarted
  };
  sock.on('error', lost);
  sock.on('close', lost);
  sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID }));
}

function onMessage(op, data) {
  if (op === OP.PING) return socket?.write(encode(OP.PONG, data));
  if (op === OP.CLOSE) return disconnect(); // e.g. wrong application id: stay quiet
  if (op === OP.FRAME && data?.cmd === 'DISPATCH' && data.evt === 'READY') {
    ready = true;
    send();
  }
}

function send() {
  if (!ready || !socket) return;
  socket.write(
    encode(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: activity || undefined },
      nonce: crypto.randomUUID(),
    }),
  );
}

// Discord refuses texts shorter than 2 or longer than 128 characters.
const field = (value) => {
  const s = String(value ?? '').trim();
  return s.length >= 2 ? s.slice(0, 128) : undefined;
};

/**
 * Shows a status on the player's Discord profile.
 * { details, state, startedAt (ms), players: { online, max } }
 */
function setStatus({ details, state, startedAt, players } = {}) {
  activity = {
    details: field(details),
    state: field(state),
    timestamps: startedAt ? { start: startedAt } : undefined,
    assets: { large_image: LARGE_IMAGE, large_text: 'ATM Launcher' },
    // "(3 sur 10)" next to the state, only when there is a state to show it with and someone is online
    party: field(state) && players?.online > 0 && players.max > 0 ? { id: 'atm-server', size: [players.online, players.max] } : undefined,
    instance: false,
  };
  connect();
  send();
}

// Settings > "Afficher mon activité sur Discord"
function setEnabled(value) {
  enabled = Boolean(value);
  if (enabled) return connect().then(send);
  if (ready && socket) {
    activity = null;
    send(); // removes the status before leaving
  }
  clearTimeout(retryTimer);
  retryTimer = null;
  setTimeout(disconnect, 200).unref?.();
}

function stop() {
  enabled = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  disconnect();
}

module.exports = { setStatus, setEnabled, stop };
