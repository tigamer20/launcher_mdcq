// Tiny RCON client: sends console commands to the Paper server (enable-rcon=true in server.properties).
const net = require('net');

const AUTH = 3;
const COMMAND = 2;

function encode(id, type, body) {
  const text = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + text.length);
  buf.writeInt32LE(10 + text.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  text.copy(buf, 12);
  return buf; // the last two bytes stay 0 (string terminator + padding)
}

/** Runs one command and returns the server's answer as text. */
function rcon({ host, port, password }, command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let data = Buffer.alloc(0);
    let authenticated = false;
    const fail = (message) => {
      socket.destroy();
      reject(new Error(message));
    };
    socket.setTimeout(timeoutMs, () => fail('Le serveur Minecraft ne répond pas (RCON)'));
    socket.on('error', () => fail('Impossible de joindre le RCON du serveur Minecraft'));
    socket.on('connect', () => socket.write(encode(1, AUTH, password)));

    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const length = data.readInt32LE(0);
        const id = data.readInt32LE(4);
        const type = data.readInt32LE(8);
        const body = data.toString('utf8', 12, length + 2);
        data = data.subarray(length + 4);

        if (!authenticated) {
          if (type !== 2) continue; // some servers send an empty packet before the login answer
          if (id === -1) return fail('Mot de passe RCON incorrect');
          authenticated = true;
          socket.write(encode(2, COMMAND, command));
        } else if (id === 2) {
          socket.end();
          // Remove Minecraft color codes (§a, §l...) from the answer.
          return resolve(body.replace(/§./g, ''));
        }
      }
    });
  });
}

module.exports = { rcon };
