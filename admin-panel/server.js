#!/usr/bin/env node
// ModdedQC admin website + file server for the launcher. No dependencies, only Node.js.
//
//   ADMIN_PASSWORD=secret node admin-panel/server.js
//
// Optional, to control the Paper server from the website:
//   PAPER_DIR=/path/to/paper      -> manage plugins (the plugins/ folder)
//   RCON_PASSWORD=...             -> console + maintenance closes the server (whitelist)
//   RCON_HOST=127.0.0.1  RCON_PORT=25575
//
// The launcher reads:  /manifest.json  and  /files/...
// Admins go to:        /admin/
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { buildManifest } = require('../tools/build-manifest');
const { pingServer } = require('../src/main/status');
const { rcon } = require('./rcon');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_HOURS = 12;
const PLUGINS_DIR = process.env.PAPER_DIR ? path.resolve(process.env.PAPER_DIR, 'plugins') : null;
const RCON = process.env.RCON_PASSWORD
  ? { host: process.env.RCON_HOST || '127.0.0.1', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD }
  : null;

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('Définis un mot de passe admin d\'au moins 8 caractères: ADMIN_PASSWORD=... node admin-panel/server.js');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Data (pack.json + files/), created with defaults on first start
// ---------------------------------------------------------------------------

const packFile = path.join(DATA_DIR, 'pack.json');
if (!fs.existsSync(packFile)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(
    packFile,
    JSON.stringify(
      {
        name: 'ModdedQC',
        subtitle: 'Serveur Minecraft du Québec',
        version: '1.0.0',
        versionId: '1.21.4',
        server: { host: 'play.moddedqc.ca', port: 25565 },
        autoConnect: true,
        maintenance: { enabled: false, message: '' },
        syncDirs: [],
        keepPlayerChanges: ['options.txt'],
        news: [],
      },
      null,
      2,
    ),
  );
}
buildManifest(DATA_DIR);

const readPack = () => JSON.parse(fs.readFileSync(packFile, 'utf8'));

function savePack(pack) {
  fs.writeFileSync(packFile, JSON.stringify(pack, null, 2));
  buildManifest(DATA_DIR);
}

// 1.0.4 -> 1.0.5 (used when files change, so players see a new modpack version)
function bumpVersion(pack) {
  const parts = String(pack.version || '1.0.0').split('.');
  parts[parts.length - 1] = String(Number(parts[parts.length - 1] || 0) + 1);
  pack.version = parts.join('.');
}

// Refuses paths that would escape files/ (e.g. "../pack.json").
function filePath(relative) {
  const target = path.resolve(FILES_DIR, String(relative || ''));
  if (!target.startsWith(FILES_DIR + path.sep)) throw httpError(400, 'Chemin invalide');
  return target;
}

function listFiles(dir = FILES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.')) return [];
    if (entry.isDirectory()) return listFiles(full);
    const stat = fs.statSync(full);
    return [{ path: path.relative(FILES_DIR, full).split(path.sep).join('/'), size: stat.size, modified: stat.mtimeMs }];
  });
}

// Plugins live on the Paper server: plugins/Name.jar (enabled) or plugins/Name.jar.disabled
function pluginPath(name) {
  if (!PLUGINS_DIR) throw httpError(400, 'PAPER_DIR n\'est pas configuré');
  if (!/^[\w .+()-]+\.jar(\.disabled)?$/.test(String(name))) throw httpError(400, 'Nom de plugin invalide (fichier .jar)');
  return path.join(PLUGINS_DIR, name);
}

function listPlugins() {
  if (!PLUGINS_DIR || !fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.jar(\.disabled)?$/.test(e.name))
    .map((e) => ({
      name: e.name,
      enabled: e.name.endsWith('.jar'),
      size: fs.statSync(path.join(PLUGINS_DIR, e.name)).size,
    }));
}

function requireRcon() {
  if (!RCON) throw httpError(400, 'RCON n\'est pas configuré (RCON_PASSWORD)');
  return RCON;
}

// ---------------------------------------------------------------------------
// Login sessions (cookie) with protection against password guessing
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> expiry time
const failures = new Map(); // ip -> { count, until }

function checkPassword(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function getSession(req) {
  const match = /(?:^|;\s*)session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const expiry = match && sessions.get(match[1]);
  if (!expiry || expiry < Date.now()) return null;
  return match[1];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw httpError(413, 'Requête trop grande');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw httpError(400, 'JSON invalide');
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Introuvable' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

const api = {
  'GET /api/state': () => ({
    pack: readPack(),
    files: listFiles(),
    plugins: listPlugins(),
    features: { plugins: Boolean(PLUGINS_DIR), rcon: Boolean(RCON) },
  }),

  // Live status of the Minecraft server (players, version...)
  'GET /api/status': async () => {
    const { server } = readPack();
    return server?.host ? pingServer(server.host, server.port) : { online: false };
  },

  'POST /api/console': async (req) => {
    const { command } = await readJson(req);
    if (!command || typeof command !== 'string') throw httpError(400, 'Commande vide');
    try {
      return { output: await rcon(requireRcon(), command.replace(/^\//, '')) };
    } catch (err) {
      throw err.status ? err : httpError(502, err.message);
    }
  },

  // Upload a plugin: the .jar is the request body. Paper loads it at the next restart.
  'PUT /api/plugins': async (req, url) => {
    const dest = pluginPath(url.searchParams.get('name'));
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.upload`;
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      fs.rmSync(`${dest}.disabled`, { force: true });
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { plugins: listPlugins() };
  },

  'DELETE /api/plugins': async (req, url) => {
    fs.rmSync(pluginPath(url.searchParams.get('name')), { force: true });
    return { plugins: listPlugins() };
  },

  // Enable/disable = rename Name.jar <-> Name.jar.disabled (Paper ignores .disabled files)
  'POST /api/plugins/toggle': async (req) => {
    const { name } = await readJson(req);
    const from = pluginPath(name);
    const to = name.endsWith('.disabled') ? from.slice(0, -'.disabled'.length) : `${from}.disabled`;
    fs.renameSync(from, to);
    return { plugins: listPlugins() };
  },

  // Server info: name, subtitle, Minecraft version, address...
  'PUT /api/pack': async (req) => {
    const body = await readJson(req);
    const pack = readPack();
    for (const key of ['name', 'subtitle', 'version', 'versionId', 'autoConnect', 'syncDirs', 'keepPlayerChanges']) {
      if (key in body) pack[key] = body[key];
    }
    if (body.server) pack.server = { host: String(body.server.host || ''), port: Number(body.server.port) || 25565 };
    savePack(pack);
    return { pack };
  },

  'PUT /api/news': async (req) => {
    const { news } = await readJson(req);
    if (!Array.isArray(news)) throw httpError(400, 'Liste de nouvelles invalide');
    const pack = readPack();
    pack.news = news.map((n) => ({
      title: String(n.title || ''),
      date: String(n.date || ''),
      body: String(n.body || ''),
      ...(n.url ? { url: String(n.url) } : {}),
    }));
    savePack(pack);
    return { pack };
  },

  'PUT /api/maintenance': async (req) => {
    const { enabled, message } = await readJson(req);
    const pack = readPack();
    pack.maintenance = { enabled: Boolean(enabled), message: String(message || '') };
    savePack(pack);
    // Also close the Paper server itself, so players using another launcher can't join either.
    // Staff on the whitelist can still connect. With enforce-whitelist=true, others online get kicked.
    let warning = null;
    if (RCON) {
      await rcon(RCON, pack.maintenance.enabled ? 'whitelist on' : 'whitelist off').catch((err) => {
        warning = pack.maintenance.enabled
          ? `Launchers bloqués, mais la whitelist n'a pas pu être activée: ${err.message}`
          : `Launchers débloqués, mais la whitelist n'a pas pu être désactivée: ${err.message}`;
      });
    }
    return { pack, warning };
  },

  // Upload: the raw file is the request body, its destination is ?path=mods/name.jar
  'PUT /api/files': async (req, url) => {
    const dest = filePath(url.searchParams.get('path'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.upload`;
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const pack = readPack();
    bumpVersion(pack);
    savePack(pack);
    return { pack, files: listFiles() };
  },

  'DELETE /api/files': async (req, url) => {
    const target = filePath(url.searchParams.get('path'));
    fs.rmSync(target, { force: true });
    // Remove folders that became empty (but never files/ itself).
    for (let dir = path.dirname(target); dir !== FILES_DIR && fs.readdirSync(dir).length === 0; dir = path.dirname(dir)) {
      fs.rmdirSync(dir);
    }
    const pack = readPack();
    bumpVersion(pack);
    savePack(pack);
    return { pack, files: listFiles() };
  },
};

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress;

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const fail = failures.get(ip);
    if (fail && fail.until > Date.now()) throw httpError(429, 'Trop d\'essais. Réessaie dans quelques minutes.');
    const { password } = await readJson(req);
    if (!checkPassword(password)) {
      const count = (fail?.count || 0) + 1;
      failures.set(ip, { count, until: count >= 5 ? Date.now() + 10 * 60_000 : 0 });
      await new Promise((r) => setTimeout(r, 1000));
      throw httpError(401, 'Mot de passe incorrect');
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_HOURS * 3600_000);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
    });
  }

  const token = getSession(req);
  if (!token) throw httpError(401, 'Connexion requise');
  // Blocks requests made by other websites (CSRF): browsers can't add this header cross-site.
  if (req.method !== 'GET' && req.headers['x-admin'] !== '1') throw httpError(403, 'Requête refusée');

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
  }

  const handler = api[`${req.method} ${url.pathname}`];
  if (!handler) throw httpError(404, 'Introuvable');
  sendJson(res, 200, await handler(req, url));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // Launcher endpoints (public)
    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      return sendFile(res, path.join(DATA_DIR, 'manifest.json'), 'no-store');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      return sendFile(res, filePath(decodeURIComponent(url.pathname.slice('/files/'.length))));
    }

    // Admin website
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/' || url.pathname === '/admin') {
      res.writeHead(302, { Location: '/admin/' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname.startsWith('/admin/')) {
      const name = url.pathname.slice('/admin/'.length) || 'index.html';
      const file = path.resolve(PUBLIC_DIR, name);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(400, 'Chemin invalide');
      return sendFile(res, file);
    }
    throw httpError(404, 'Introuvable');
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Erreur serveur' });
  }
});

server.listen(PORT, () => {
  console.log(`Site admin:      http://localhost:${PORT}/admin/`);
  console.log(`URL du launcher: http://localhost:${PORT}/  (serverUrl dans launcher.config.json)`);
});
