#!/usr/bin/env node
// ModdedQC agent: runs on the PC/VPS that hosts Paper, so the admin website (on Render) can
// manage plugins and send console commands. No dependencies, only Node.js.
//
//   AGENT_SECRET=... PAPER_DIR=/path/to/paper RCON_PASSWORD=... node agent.js
//
// Every request must be signed with AGENT_SECRET (see signing.js). RCON stays local to this machine.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { rcon } = require('./rcon');
const { sha256, verify } = require('./signing');

const PORT = Number(process.env.AGENT_PORT) || 8765;
const SECRET = process.env.AGENT_SECRET;
const PAPER_DIR = process.env.PAPER_DIR && path.resolve(process.env.PAPER_DIR);
const PLUGINS_DIR = PAPER_DIR && path.join(PAPER_DIR, 'plugins');
const RCON = process.env.RCON_PASSWORD
  ? { host: process.env.RCON_HOST || '127.0.0.1', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD }
  : null;
const MAX_UPLOAD = 200 * 1024 * 1024;

if (!SECRET || SECRET.length < 32) {
  console.error('AGENT_SECRET doit faire au moins 32 caractères (le même que sur Render).');
  process.exit(1);
}
if (!PAPER_DIR || !fs.existsSync(PAPER_DIR)) {
  console.error('PAPER_DIR doit pointer vers le dossier du serveur Paper.');
  process.exit(1);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------------------
// Plugins: plugins/Name.jar (enabled) or plugins/Name.jar.disabled
// ---------------------------------------------------------------------------

function pluginPath(name) {
  if (!/^[\w .+()-]+\.jar(\.disabled)?$/.test(String(name))) throw httpError(400, 'Nom de plugin invalide (fichier .jar)');
  return path.join(PLUGINS_DIR, name);
}

function listPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.jar(\.disabled)?$/.test(e.name))
    .map((e) => ({ name: e.name, enabled: e.name.endsWith('.jar'), size: fs.statSync(path.join(PLUGINS_DIR, e.name)).size }));
}

// Saves the request body to `dest`, checking it matches the hash that was signed.
async function saveBody(req, dest, expectedHash) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.upload`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw httpError(413, 'Fichier trop gros');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (hash.digest('hex') !== expectedHash) throw httpError(400, 'Fichier corrompu pendant l\'envoi');
    fs.renameSync(tmp, dest);
  } finally {
    out.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

async function readJson(req, expectedHash) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw httpError(413, 'Requête trop grande');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (sha256(body) !== expectedHash) throw httpError(400, 'Requête modifiée');
  return JSON.parse(body.toString('utf8') || '{}');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = {
  'GET /info': () => ({ plugins: true, rcon: Boolean(RCON) }),

  'GET /plugins': () => ({ plugins: listPlugins() }),

  'PUT /plugins': async (req, url, bodyHash) => {
    const dest = pluginPath(url.searchParams.get('name'));
    await saveBody(req, dest, bodyHash);
    fs.rmSync(`${dest}.disabled`, { force: true });
    return { plugins: listPlugins() };
  },

  'DELETE /plugins': (req, url) => {
    fs.rmSync(pluginPath(url.searchParams.get('name')), { force: true });
    return { plugins: listPlugins() };
  },

  'POST /plugins/toggle': async (req, url, bodyHash) => {
    const { name } = await readJson(req, bodyHash);
    const from = pluginPath(name);
    const to = name.endsWith('.disabled') ? from.slice(0, -'.disabled'.length) : `${from}.disabled`;
    fs.renameSync(from, to);
    return { plugins: listPlugins() };
  },

  'POST /rcon': async (req, url, bodyHash) => {
    const { command } = await readJson(req, bodyHash);
    if (!RCON) throw httpError(400, 'RCON n\'est pas configuré sur l\'agent (RCON_PASSWORD)');
    if (!command || typeof command !== 'string') throw httpError(400, 'Commande vide');
    try {
      return { output: await rcon(RCON, command.replace(/^\//, '')) };
    } catch (err) {
      throw httpError(502, err.message);
    }
  },
};

http
  .createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const bodyHash = verify(SECRET, req);
      if (!bodyHash) throw httpError(401, 'Signature invalide (vérifie AGENT_SECRET et l\'heure du PC)');
      const url = new URL(req.url, 'http://agent');
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw httpError(404, 'Introuvable');
      send(200, await route(req, url, bodyHash));
    } catch (err) {
      if (!err.status) console.error(err);
      send(err.status || 500, { error: err.status ? err.message : 'Erreur de l\'agent' });
    }
  })
  .listen(PORT, () => {
    console.log(`Agent ModdedQC prêt sur le port ${PORT}`);
    console.log(`Plugins: ${PLUGINS_DIR}`);
    console.log(`Console RCON: ${RCON ? `${RCON.host}:${RCON.port}` : 'désactivée (RCON_PASSWORD manquant)'}`);
  });
