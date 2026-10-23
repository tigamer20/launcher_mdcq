#!/usr/bin/env node
// ModdedQC admin website + file server for the launcher. No dependencies, only Node.js.
//
//   ADMIN_PASSWORD=secret node admin-panel/server.js
//
// Optional, to control the Paper server (plugins, console, whitelist) through paper-agent/:
//   AGENT_URL=http://my-pc:8765/   AGENT_SECRET=same-as-the-agent
// Behind a proxy like Render, also set TRUST_PROXY=1 (real visitor IPs for the login protection).
// Server file editor history on GitHub: GITHUB_TOKEN=... (see admin-panel/github.js).
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
const { signHeaders } = require('../paper-agent/signing');
const github = require('./github');

const PORT = Number(process.env.PORT) || 8080;
const LOCAL_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = writableDataDir(path.resolve(process.env.DATA_DIR || LOCAL_DATA_DIR));
const FILES_DIR = path.join(DATA_DIR, 'files');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_HOURS = 12;
const AGENT_URL = process.env.AGENT_URL && process.env.AGENT_URL.replace(/\/?$/, '');
const AGENT_SECRET = process.env.AGENT_SECRET;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_UPLOAD = 200 * 1024 * 1024;

// Without a valid password the site still starts (the launcher keeps working) but nobody can log in.
const PASSWORD_OK = Boolean(PASSWORD && PASSWORD.length >= 8);
if (!PASSWORD_OK) {
  console.error('ATTENTION: ADMIN_PASSWORD manquant ou trop court (8 caractères minimum). Connexion admin désactivée.');
  console.error('Sur Render: ouvre le service > Environment > ajoute ADMIN_PASSWORD, puis redéploie.');
}

// The data folder must be writable. On Render it's the disk mounted at /var/data; if the disk is missing
// (free plan), use a local folder so the site still starts, and say that the data won't survive restarts.
function writableDataDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (err) {
    console.error(`ATTENTION: impossible d'écrire dans ${dir} (${err.code}). Utilisation de ${LOCAL_DATA_DIR} à la place.`);
    console.error('Les nouvelles, réglages et fichiers seront PERDUS à chaque redémarrage.');
    console.error('Sur Render: ajoute un disque (service > Disks, chemin /var/data). Il faut un plan payant (Starter).');
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
    return LOCAL_DATA_DIR;
  }
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

// ---------------------------------------------------------------------------
// Paper agent (runs on the Minecraft machine, see paper-agent/)
// ---------------------------------------------------------------------------

async function agent(method, pathWithQuery, body) {
  if (!AGENT_URL || !AGENT_SECRET) throw httpError(400, 'Agent non configuré (AGENT_URL et AGENT_SECRET)');
  const data = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  let res;
  try {
    res = await fetch(AGENT_URL + pathWithQuery, {
      method,
      headers: { 'Content-Type': 'application/octet-stream', ...signHeaders(AGENT_SECRET, method, pathWithQuery, data) },
      body: data.length ? data : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw httpError(502, 'Agent injoignable: vérifie qu\'il tourne sur le PC du serveur et que le port est ouvert');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, json.error || `Erreur de l'agent (${res.status})`);
  return json;
}

// What the agent can do. Never throws: an unreachable agent just disables the tabs.
async function agentFeatures() {
  if (!AGENT_URL) return { plugins: false, rcon: false, error: null };
  try {
    const info = await agent('GET', '/info');
    return { plugins: Boolean(info.plugins), rcon: Boolean(info.rcon), error: null };
  } catch (err) {
    return { plugins: false, rcon: false, error: err.message };
  }
}

async function readBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Fichier trop gros');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Login sessions (cookie) with protection against password guessing
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> expiry time
const failures = new Map(); // ip -> { count, until }

function checkPassword(given) {
  if (!PASSWORD_OK) return false;
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
  'GET /api/state': async () => {
    const features = await agentFeatures();
    const plugins = features.plugins ? (await agent('GET', '/plugins')).plugins : [];
    return { pack: readPack(), files: listFiles(), plugins, features: { ...features, github: github.configured() } };
  },

  // Live status of the Minecraft server (players, version...)
  'GET /api/status': async () => {
    const { server } = readPack();
    return server?.host ? pingServer(server.host, server.port) : { online: false };
  },

  'POST /api/console': async (req) => {
    const { command } = await readJson(req);
    if (!command || typeof command !== 'string') throw httpError(400, 'Commande vide');
    return agent('POST', '/rcon', { command });
  },

  // Server file editor: files live on the Paper machine (through the agent),
  // every save is also committed on the "admin-website" branch on GitHub (secrets masked).
  'GET /api/server-files': (req, url) => agent('GET', `/files?dir=${encodeURIComponent(url.searchParams.get('dir') || '')}`),

  'GET /api/server-file': (req, url) => agent('GET', `/file?path=${encodeURIComponent(url.searchParams.get('path') || '')}`),

  'PUT /api/server-file': async (req, url) => {
    const relative = String(url.searchParams.get('path') || '').replace(/^\/+/, '');
    const content = await readBuffer(req, 1024 * 1024);
    await agent('PUT', `/file?path=${encodeURIComponent(relative)}`, content);
    if (!github.configured()) return { saved: true, warning: 'Enregistré sur le serveur. GITHUB_TOKEN manquant: pas de commit.' };
    try {
      return { saved: true, commit: await github.commitServerFile(relative, content.toString('utf8')) };
    } catch (err) {
      return { saved: true, warning: `Enregistré sur le serveur, mais le commit GitHub a échoué: ${err.message}` };
    }
  },

  'GET /api/versions': async () => {
    if (!github.configured()) throw httpError(400, 'GITHUB_TOKEN n\'est pas configuré');
    const { official, dev, pending } = await github.status().catch((err) => {
      throw httpError(502, err.message);
    });
    return { official, dev, pending };
  },

  // Opens a pull request admin-website -> main and merges it with "[off_update]" or "[dev_update]".
  'POST /api/merge': async (req) => {
    if (!github.configured()) throw httpError(400, 'GITHUB_TOKEN n\'est pas configuré');
    const { channel, version } = await readJson(req);
    try {
      return await github.mergeToMain(channel, String(version || '').trim().replace(/^v/, ''));
    } catch (err) {
      throw httpError(400, err.message);
    }
  },

  // Plugins: the website forwards everything to the agent. Paper loads changes at the next restart.
  'PUT /api/plugins': async (req, url) => {
    const name = encodeURIComponent(url.searchParams.get('name') || '');
    return agent('PUT', `/plugins?name=${name}`, await readBuffer(req, MAX_UPLOAD));
  },

  'DELETE /api/plugins': (req, url) => agent('DELETE', `/plugins?name=${encodeURIComponent(url.searchParams.get('name') || '')}`),

  'POST /api/plugins/toggle': async (req) => agent('POST', '/plugins/toggle', { name: (await readJson(req)).name }),

  'PUT /api/pack': async (req) => {
    const body = await readJson(req);
    const pack = readPack();
    for (const key of ['name', 'subtitle', 'version', 'versionId', 'autoConnect', 'syncDirs', 'keepPlayerChanges', 'betaKey']) {
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
    if (AGENT_URL) {
      await agent('POST', '/rcon', { command: pack.maintenance.enabled ? 'whitelist on' : 'whitelist off' }).catch((err) => {
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
  // Behind Render's proxy every request comes from the proxy: use the visitor IP it forwards.
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const fail = failures.get(ip);
    if (!PASSWORD_OK) throw httpError(503, 'ADMIN_PASSWORD n\'est pas configuré sur le serveur (8 caractères minimum).');
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

  // Public: launchers check the beta key players type in their hidden dev section.
  if (req.method === 'POST' && url.pathname === '/api/beta/check') {
    const fail = failures.get(`beta:${ip}`);
    if (fail && fail.until > Date.now()) throw httpError(429, 'Trop d\'essais. Réessaie dans quelques minutes.');
    const { key } = await readJson(req);
    const expected = String(readPack().betaKey || '');
    const valid = expected.length > 0 && crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(key || '')).digest(),
      crypto.createHash('sha256').update(expected).digest(),
    );
    if (!valid) {
      const count = (fail?.count || 0) + 1;
      failures.set(`beta:${ip}`, { count, until: count >= 10 ? Date.now() + 10 * 60_000 : 0 });
    } else {
      failures.delete(`beta:${ip}`);
    }
    return sendJson(res, 200, { valid });
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
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

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
  console.log(`Données: ${DATA_DIR}`);
  console.log(`Site admin:      http://localhost:${PORT}/admin/`);
  console.log(`URL du launcher: http://localhost:${PORT}/  (serverUrl dans launcher.config.json)`);
});
