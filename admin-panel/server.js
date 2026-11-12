#!/usr/bin/env node
// ATM admin website + file server for the launcher. No dependencies, only Node.js.
//
//   ADMIN_PASSWORD=secret node admin-panel/server.js
//
// Optional, to control the Minecraft server (mods or plugins, files, console, whitelist) through paper-agent/:
//   AGENT_URL=http://my-pc:8765/   AGENT_SECRET=same-as-the-agent
// Or only AGENT_SECRET: an agent started with CLOUDFLARE_TUNNEL=1 sends its own (changing) address, see agentUrl().
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
const { signHeaders, verify: verifySignature, sha256 } = require('../paper-agent/signing');
const github = require('./github');
const storage = require('./storage');
const players = require('./players');
const editor = require('./modpack-editor');
const accounts = require('./accounts');

const PORT = Number(process.env.PORT) || 8080;
const LOCAL_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = writableDataDir(path.resolve(process.env.DATA_DIR || LOCAL_DATA_DIR));
const FILES_DIR = path.join(DATA_DIR, 'files');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_HOURS = 12;
const AGENT_URL_ENV = process.env.AGENT_URL && process.env.AGENT_URL.replace(/\/?$/, '');
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

function ensureDefaultPack() {
  if (fs.existsSync(packFile)) return;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(
    packFile,
    JSON.stringify(
      {
        name: 'All the Mod',
        season: 'Saison 3',
        version: '1.0.0',
        versionId: '1.21.1',
        server: { host: 'exemple.gl.joinmc.link', port: 25565 },
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

const readPack = () => JSON.parse(fs.readFileSync(packFile, 'utf8'));

// Saves pack.json on disk, rebuilds manifest.json, and keeps a permanent copy on GitHub (see storage.js).
async function savePack(pack) {
  const json = JSON.stringify(pack, null, 2);
  fs.writeFileSync(packFile, json);
  buildManifest(DATA_DIR);
  await keepOnGitHub(() => storage.saveFile('pack.json', Buffer.from(json)));
}

// Editor errors from CurseForge/GitHub are shown to the admin as they are (not "Erreur serveur").
async function editorCall(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    throw err.status ? err : httpError(502, err.message);
  }
}

// Without GITHUB_TOKEN the data only lives on disk (fine with a Render disk, lost on the free plan).
async function keepOnGitHub(save) {
  if (!storage.configured()) return;
  try {
    await save();
  } catch (err) {
    throw httpError(502, `Appliqué, mais pas sauvegardé sur GitHub (perdu au prochain redémarrage) : ${err.message}`);
  }
}

// Makes `info` ({ version, minecraft, neoforge, manifestUrl, files, size }) the modpack the launchers install.
async function activateModpack(info) {
  if (!String(info.manifestUrl).startsWith(`https://github.com/${github.REPO}/releases/download/modpack/`)) {
    throw httpError(502, 'Adresse du modpack inattendue');
  }
  const pack = readPack();
  pack.modpack = {
    version: info.version,
    minecraft: info.minecraft,
    neoforge: info.neoforge,
    manifestUrl: info.manifestUrl,
    files: info.files,
    size: info.size,
    publishedAt: new Date().toISOString(),
  };
  pack.versionId = info.minecraft;
  await savePack(pack);
  return pack.modpack;
}

// The beta key is never stored in clear text (the GitHub repository is public): only its SHA-256.
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

// pack.json as the admin pages see it: no hash, just whether a beta key exists.
function publicPack(pack) {
  const { betaKeyHash, betaKey, ...rest } = pack;
  return { ...rest, betaKeySet: Boolean(betaKeyHash || betaKey) };
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
// Server agent (runs on the Minecraft machine, NeoForge or Paper, see paper-agent/)
// ---------------------------------------------------------------------------

// The agent's address: the one it sent itself (Cloudflare tunnel without a domain, which changes at every start),
// or else AGENT_URL from Render.
const agentUrlFile = () => path.join(DATA_DIR, 'agent-url.json');
let reportedAgentUrl = null;
const agentUrl = () => reportedAgentUrl || AGENT_URL_ENV || null;

function loadReportedAgentUrl() {
  try {
    reportedAgentUrl = JSON.parse(fs.readFileSync(agentUrlFile(), 'utf8')).url || null;
  } catch {
    reportedAgentUrl = null;
  }
}

// POST /api/agent/url from the agent, signed with AGENT_SECRET like the website's requests to the agent.
async function receiveAgentUrl(req) {
  if (!AGENT_SECRET) throw httpError(400, 'AGENT_SECRET n\'est pas configuré sur Render');
  const bodyHash = verifySignature(AGENT_SECRET, req);
  if (!bodyHash) throw httpError(401, 'Signature invalide (vérifie AGENT_SECRET et l\'heure du PC)');
  const body = await readBuffer(req, 4096);
  if (sha256(body) !== bodyHash) throw httpError(400, 'Contenu modifié');
  const url = String(JSON.parse(body.toString('utf8') || '{}').url || '').replace(/\/?$/, '');
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url)) throw httpError(400, 'Adresse invalide');
  if (url !== reportedAgentUrl) {
    reportedAgentUrl = url;
    const json = JSON.stringify({ url, at: new Date().toISOString() });
    fs.writeFileSync(agentUrlFile(), json);
    console.log(`Nouvelle adresse de l'agent : ${url}`);
    await keepOnGitHub(() => storage.saveFile('agent-url.json', Buffer.from(json))).catch((err) => console.error(err.message));
  }
  return { ok: true };
}

async function agent(method, pathWithQuery, body, timeoutMs = 60_000) {
  const AGENT_URL = agentUrl();
  if (!AGENT_URL || !AGENT_SECRET) throw httpError(400, 'Agent non configuré (AGENT_URL et AGENT_SECRET)');
  const data = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  let res;
  try {
    res = await fetch(AGENT_URL + pathWithQuery, {
      method,
      headers: { 'Content-Type': 'application/octet-stream', ...signHeaders(AGENT_SECRET, method, pathWithQuery, data) },
      body: data.length ? data : undefined,
      signal: AbortSignal.timeout(timeoutMs),
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
  if (!agentUrl()) return { plugins: false, rcon: false, modpack: false, error: null };
  try {
    const info = await agent('GET', '/info', undefined, 8000);
    // Older agents (Paper only) don't send serverType.
    const serverType = info.serverType === 'neoforge' ? 'neoforge' : 'paper';
    return { plugins: Boolean(info.plugins), serverType, rcon: Boolean(info.rcon), modpack: Boolean(info.modpack), error: null };
  } catch (err) {
    return { plugins: false, rcon: false, modpack: false, error: err.message };
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

const sessions = new Map(); // token -> { expiry, name }
const failures = new Map(); // ip -> { count, until }

// The logged-in session: { token, user } (user = { name, owner, permissions }), or null.
// Looked up on every request, so a deleted account or a changed permission applies right away.
function getSession(req) {
  const match = /(?:^|;\s*)session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const session = match && sessions.get(match[1]);
  if (!session || session.expiry < Date.now()) return null;
  const user = accounts.user(session.name);
  if (!user) {
    sessions.delete(match[1]);
    return null;
  }
  return { token: match[1], user };
}

// Which permission each part of the API needs (see accounts.js). Not listed: open to every account.
const PERMISSION_RULES = [
  [/^\/api\/(modpack|editor)\//, 'modpack'],
  [/^\/api\/editor$/, 'modpack'],
  [/^\/api\/console$/, 'console'],
  [/^\/api\/server-files?$/, 'serverFiles'],
  [/^\/api\/(versions|merge)$/, 'launcher'],
  [/^\/api\/plugins(\/|$)/, 'plugins'],
  [/^\/api\/pack$/, 'server'],
  [/^\/api\/news$/, 'news'],
  [/^\/api\/maintenance$/, 'maintenance'],
  [/^\/api\/files$/, 'files'],
  [/^\/api\/players(\/|$)/, 'players'],
  [/^\/api\/accounts$/, 'accounts'],
];
const permissionFor = (pathname) => PERMISSION_RULES.find(([pattern]) => pattern.test(pathname))?.[1] || null;

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
  // Answers right away (the menu shows at once); what the server agent can do comes from /api/agent,
  // which can take a few seconds when the agent's PC is off or far away.
  'GET /api/state': async (req, url, user) => ({
    pack: publicPack(readPack()),
    files: listFiles(),
    plugins: [],
    features: { plugins: false, rcon: false, modpack: false, agent: Boolean(agentUrl()), github: github.configured() },
    me: user,
    permissions: accounts.PERMISSIONS,
  }),

  'GET /api/agent': async () => {
    const features = await agentFeatures();
    const plugins = features.plugins ? (await agent('GET', '/plugins').catch(() => ({ plugins: [] }))).plugins : [];
    return { features: { ...features, agent: Boolean(agentUrl()), github: github.configured() }, plugins };
  },

  // Accounts tab: create accounts and choose what each one can do.
  'GET /api/accounts': () => accounts.list(),
  'POST /api/accounts': async (req, url, user) => accounts.create(user.name, await readJson(req)),
  'PUT /api/accounts': async (req, url, user) => accounts.update(user.name, await readJson(req)),
  'DELETE /api/accounts': async (req, url, user) => {
    const result = await accounts.remove(user.name, url.searchParams.get('name'));
    return result;
  },
  // Every account (but the owner's) can change its own password.
  'POST /api/me/password': async (req, url, user) => {
    const { current, password } = await readJson(req);
    await accounts.changeOwnPassword(user.name, current, password);
    return { ok: true };
  },

  // Live status of the Minecraft server (players, version...)
  // Modpack: published from the Mac by the agent (paper-agent/publish.js), then announced to the launchers here.
  'POST /api/modpack/publish': async (req) => {
    const { version, minecraft, neoforge } = await readJson(req);
    return agent('POST', '/modpack/publish', { version, minecraft, neoforge });
  },

  'GET /api/modpack/status': async () => {
    const job = await agent('GET', '/modpack/status');
    const result = job.result;
    // Publishing finished on the Mac: launchers start using the new version.
    if (job.state === 'done' && result?.manifestUrl && result.manifestUrl !== readPack().modpack?.manifestUrl) {
      await activateModpack(result);
    }
    return { job, modpack: readPack().modpack || null };
  },

  // Versions published on GitHub (also from a PC with publish-modpack.bat), to activate one.
  'GET /api/modpack/github': async () => {
    if (!github.configured()) throw httpError(400, 'GITHUB_TOKEN n\'est pas configuré');
    try {
      return { versions: await github.listModpackVersions(), active: readPack().modpack?.manifestUrl || null };
    } catch (err) {
      throw httpError(502, err.message);
    }
  },

  // Modpack editor (admin-panel/modpack-editor.js): import a CurseForge export, change mods and files, publish.
  'GET /api/editor': () => editor.status(),
  'PUT /api/editor/upload': async (req, url) =>
    editor.uploadChunk(url.searchParams.get('id'), url.searchParams.get('offset'), await readBuffer(req, 16 * 1024 * 1024)),
  'POST /api/editor/import': async (req) => editor.startImport((await readJson(req)).uploadId),
  'POST /api/editor/publish': async (req) => editor.startPublish((await readJson(req)).version),
  // The current modpack as a CurseForge export (.zip): built in the background, then downloaded (see handleApi).
  'POST /api/editor/export': () => editor.startExport(),
  'POST /api/editor/mods/toggle': async (req) => ({ mod: await editorCall(editor.toggleMod, (await readJson(req)).id) }),
  'POST /api/editor/mods/remove': async (req) => editorCall(editor.removeMod, (await readJson(req)).id).then(() => ({ ok: true })),
  'GET /api/editor/mods/versions': (req, url) => editorCall(editor.modVersions, url.searchParams.get('id')),
  'POST /api/editor/mods/version': async (req) => {
    const { id, fileId } = await readJson(req);
    return { mod: await editorCall(editor.setModVersion, id, fileId) };
  },
  'POST /api/editor/mods/add': async (req) => ({ mod: await editorCall(editor.addMod, (await readJson(req)).input) }),
  'POST /api/editor/mods/upload': async (req) => {
    const { uploadId, fileName, id } = await readJson(req);
    return { mod: await editorCall(editor.uploadMod, uploadId, fileName, id) };
  },
  'GET /api/editor/files': () => editor.listFiles(),
  'GET /api/editor/file': (req, url) => editorCall(editor.readFile, url.searchParams.get('path')),
  'PUT /api/editor/file': async (req, url) =>
    editorCall(editor.writeFile, url.searchParams.get('path'), await readBuffer(req, 2 * 1024 * 1024)).then(() => ({ ok: true })),
  'POST /api/editor/file/upload': async (req) => {
    const { uploadId, path: target } = await readJson(req);
    return editorCall(editor.uploadAsFile, uploadId, target).then(() => ({ ok: true }));
  },
  'DELETE /api/editor/file': (req, url) => editorCall(editor.deleteFile, url.searchParams.get('path')).then(() => ({ ok: true })),
  'POST /api/editor/file/revert': async (req) => editorCall(editor.revertFile, (await readJson(req)).path).then(() => ({ ok: true })),

  // Hide the modpack from the players (and show it again), without losing it.
  'POST /api/modpack/visibility': async (req) => {
    const { hidden } = await readJson(req);
    const pack = readPack();
    if (hidden) pack.modpackHidden = true;
    else delete pack.modpackHidden;
    await savePack(pack);
    return { pack: publicPack(pack) };
  },

  // Remove the active modpack: launchers show "pas encore publié". Its files stay on GitHub (Activer brings it back).
  'POST /api/modpack/remove': async () => {
    const pack = readPack();
    delete pack.modpack;
    delete pack.modpackHidden;
    await savePack(pack);
    return { pack: publicPack(pack) };
  },

  // Delete a version from GitHub (not the active one).
  'POST /api/modpack/delete-version': async (req) => {
    const { manifestUrl } = await readJson(req);
    if (manifestUrl === readPack().modpack?.manifestUrl) throw httpError(400, "C'est la version active : retire-la ou active une autre version d'abord");
    const release = await github.gh('GET', '/releases/tags/modpack');
    const asset = (release?.assets || []).find((a) => a.browser_download_url === manifestUrl && /^modpack-.*\.json$/.test(a.name));
    if (!asset) throw httpError(404, 'Version introuvable sur GitHub');
    await github.gh('DELETE', `/releases/assets/${asset.id}`);
    return { ok: true };
  },

  'POST /api/modpack/activate': async (req) => {
    const { manifestUrl } = await readJson(req);
    const version = (await github.listModpackVersions()).find((v) => v.manifestUrl === manifestUrl);
    if (!version) throw httpError(404, 'Version introuvable sur GitHub');
    return { modpack: await activateModpack(version) };
  },

  'GET /api/status': async () => {
    const { server, versionId } = readPack();
    return server?.host ? pingServer(server.host, server.port, { minecraftVersion: versionId }) : { online: false };
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
    const { official, officialName, dev, pending } = await github.status().catch((err) => {
      throw httpError(502, err.message);
    });
    return { official, officialName, dev, pending };
  },

  // Opens a pull request admin-website -> main and merges it with "[off_update]" or "[dev_update]".
  'POST /api/merge': async (req) => {
    if (!github.configured()) throw httpError(400, 'GITHUB_TOKEN n\'est pas configuré');
    const { channel, version, name } = await readJson(req);
    try {
      return await github.mergeToMain(channel, String(version || '').trim().replace(/^v/, ''), name);
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
    for (const key of ['name', 'season', 'subtitle', 'version', 'versionId', 'autoConnect', 'syncDirs', 'keepPlayerChanges']) {
      if (key in body) pack[key] = body[key];
    }
    // betaKey: a new key replaces the old one, null removes it, empty/absent keeps it.
    if (body.betaKey === null) delete pack.betaKeyHash;
    else if (typeof body.betaKey === 'string' && body.betaKey.trim()) pack.betaKeyHash = hashKey(body.betaKey.trim());
    delete pack.betaKey;
    if (body.server) pack.server = { host: String(body.server.host || ''), port: Number(body.server.port) || 25565 };
    await savePack(pack);
    return { pack: publicPack(pack) };
  },

  // Each news keeps an id and its author: the account that wrote it (editing it later doesn't change the author).
  'PUT /api/news': async (req, url, user) => {
    const { news } = await readJson(req);
    if (!Array.isArray(news)) throw httpError(400, 'Liste de nouvelles invalide');
    const pack = readPack();
    const existing = new Map((pack.news || []).filter((n) => n.id).map((n) => [n.id, n]));
    pack.news = news.map((n) => {
      const previous = existing.get(String(n.id || ''));
      const author = previous ? previous.author : user.name;
      return {
        id: previous ? previous.id : crypto.randomBytes(6).toString('hex'),
        title: String(n.title || ''),
        date: String(n.date || ''),
        body: String(n.body || ''),
        ...(author ? { author } : {}),
        ...(n.url ? { url: String(n.url) } : {}),
      };
    });
    await savePack(pack);
    return { pack: publicPack(pack) };
  },

  'PUT /api/maintenance': async (req) => {
    const { enabled, message } = await readJson(req);
    const pack = readPack();
    pack.maintenance = { enabled: Boolean(enabled), message: String(message || '') };
    await savePack(pack);
    // Also close the Paper server itself, so players using another launcher can't join either.
    // Staff on the whitelist can still connect. With enforce-whitelist=true, others online get kicked.
    let warning = null;
    if (agentUrl()) {
      await agent('POST', '/rcon', { command: pack.maintenance.enabled ? 'whitelist on' : 'whitelist off' }).catch((err) => {
        warning = pack.maintenance.enabled
          ? `Launchers bloqués, mais la whitelist n'a pas pu être activée: ${err.message}`
          : `Launchers débloqués, mais la whitelist n'a pas pu être désactivée: ${err.message}`;
      });
    }
    return { pack: publicPack(pack), warning };
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
    const relative = path.relative(DATA_DIR, dest).split(path.sep).join('/');
    await keepOnGitHub(() => storage.saveFile(relative, fs.readFileSync(dest)));
    const pack = readPack();
    bumpVersion(pack);
    await savePack(pack);
    return { pack: publicPack(pack), files: listFiles() };
  },

  'DELETE /api/files': async (req, url) => {
    const target = filePath(url.searchParams.get('path'));
    fs.rmSync(target, { force: true });
    await keepOnGitHub(() => storage.deleteFile(path.relative(DATA_DIR, target).split(path.sep).join('/')));
    // Remove folders that became empty (but never files/ itself).
    for (let dir = path.dirname(target); dir !== FILES_DIR && fs.readdirSync(dir).length === 0; dir = path.dirname(dir)) {
      fs.rmdirSync(dir);
    }
    const pack = readPack();
    bumpVersion(pack);
    await savePack(pack);
    return { pack: publicPack(pack), files: listFiles() };
  },
};

async function handleApi(req, res, url) {
  // Behind Render's proxy every request comes from the proxy: use the visitor IP it forwards.
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const fail = failures.get(ip);
    if (!PASSWORD_OK) throw httpError(503, 'ADMIN_PASSWORD n\'est pas configuré sur le serveur (8 caractères minimum).');
    if (fail && fail.until > Date.now()) throw httpError(429, 'Trop d\'essais. Réessaie dans quelques minutes.');
    const { username, password } = await readJson(req);
    const name = await accounts.login(username, password);
    if (!name) {
      const count = (fail?.count || 0) + 1;
      failures.set(ip, { count, until: count >= 5 ? Date.now() + 10 * 60_000 : 0 });
      await new Promise((r) => setTimeout(r, 1000));
      throw httpError(401, 'Nom d\'utilisateur ou mot de passe incorrect');
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expiry: Date.now() + SESSION_HOURS * 3600_000, name });
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`,
    });
  }

  // Public: launchers report Microsoft logins and game launches (checked with Mojang, see players.js).
  if (req.method === 'POST' && url.pathname === '/api/players/seen') {
    const limit = failures.get(`seen:${ip}`);
    const now = Date.now();
    const count = limit && limit.until > now ? limit.count + 1 : 1;
    failures.set(`seen:${ip}`, { count, until: limit && limit.until > now ? limit.until : now + 10 * 60_000 });
    if (count > 30) throw httpError(429, 'Trop de requêtes');
    await players.record(await readJson(req));
    return sendJson(res, 200, { ok: true });
  }

  // The agent sends its address (signed with AGENT_SECRET): see receiveAgentUrl().
  if (req.method === 'POST' && url.pathname === '/api/agent/url') return sendJson(res, 200, await receiveAgentUrl(req));

  // Public: launchers ask regularly whether an admin logged their account out (✕ in the Joueurs tab).
  if (req.method === 'POST' && url.pathname === '/api/players/session') {
    const limit = failures.get(`session:${ip}`);
    const now = Date.now();
    const count = limit && limit.until > now ? limit.count + 1 : 1;
    failures.set(`session:${ip}`, { count, until: limit && limit.until > now ? limit.until : now + 10 * 60_000 });
    if (count > 120) throw httpError(429, 'Trop de requêtes');
    const { uuid, since } = await readJson(req);
    return sendJson(res, 200, players.sessionStatus(uuid, since));
  }

  // Public: launchers check the beta key players type in their hidden dev section.
  if (req.method === 'POST' && url.pathname === '/api/beta/check') {
    const fail = failures.get(`beta:${ip}`);
    if (fail && fail.until > Date.now()) throw httpError(429, 'Trop d\'essais. Réessaie dans quelques minutes.');
    const { key } = await readJson(req);
    const expected = readPack().betaKeyHash || '';
    const valid = expected.length === 64 && crypto.timingSafeEqual(Buffer.from(hashKey(String(key || '').trim()), 'hex'), Buffer.from(expected, 'hex'));
    if (!valid) {
      const count = (fail?.count || 0) + 1;
      failures.set(`beta:${ip}`, { count, until: count >= 10 ? Date.now() + 10 * 60_000 : 0 });
    } else {
      failures.delete(`beta:${ip}`);
    }
    return sendJson(res, 200, { valid });
  }

  const session = getSession(req);
  if (!session) throw httpError(401, 'Connexion requise');
  const { token, user } = session;
  // Blocks requests made by other websites (CSRF): browsers can't add this header cross-site.
  if (req.method !== 'GET' && req.headers['x-admin'] !== '1') throw httpError(403, 'Requête refusée');

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
  }

  const needed = permissionFor(url.pathname);
  if (needed && !user.permissions.includes(needed)) {
    throw httpError(403, `Ton compte n'a pas la permission « ${accounts.PERMISSIONS[needed]} »`);
  }

  // Download of the modpack export made with POST /api/editor/export
  if (req.method === 'GET' && url.pathname === '/api/editor/export') {
    const { file, fileName, size } = editor.exportFile();
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(file).pipe(res);
  }

  // Players who used the launcher
  if (req.method === 'GET' && url.pathname === '/api/players') return sendJson(res, 200, players.list());
  // "Effacer l'historique": the recent activity only, the players stay.
  if (req.method === 'POST' && url.pathname === '/api/players/clear') {
    players.clearHistory();
    return sendJson(res, 200, players.list());
  }
  // ✕ next to a player: removed from the list and logged out of the launcher.
  if (req.method === 'POST' && url.pathname === '/api/players/remove') {
    players.remove((await readJson(req)).uuid);
    return sendJson(res, 200, players.list());
  }

  const handler = api[`${req.method} ${url.pathname}`];
  if (!handler) throw httpError(404, 'Introuvable');
  sendJson(res, 200, await handler(req, url, user));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// The website answers Render's health check right away, while its data is still coming back from GitHub.
let ready = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, ready });
    if (!ready) {
      return sendJson(res, 503, { error: 'Le site démarre (récupération des données), réessaie dans quelques secondes.' }, { 'Retry-After': '5' });
    }

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

// Startup: get the data back from GitHub (Render's free plan erased it), then start serving.
// Never let one unexpected error stop the whole website (Render would restart it in a loop): log it instead.
process.on('unhandledRejection', (err) => console.error('Erreur non gérée :', err));
process.on('uncaughtException', (err) => console.error('Exception non gérée :', err));

async function start() {
  // Open the port first: Render restarts a website that doesn't answer its health check in time.
  server.listen(PORT, () => console.log(`Port ${PORT} ouvert, récupération des données...`));
  // Default data first: on a first start (or Render's free plan wiping the disk) it is what goes into the new branch.
  // When the branch exists, GitHub's data replaces it.
  ensureDefaultPack();
  if (storage.configured()) {
    try {
      const result = await storage.restore(DATA_DIR);
      console.log(result === 'created'
        ? `Données: branche ${storage.BRANCH} créée sur GitHub.`
        : `Données: restaurées depuis la branche ${storage.BRANCH} sur GitHub.`);
    } catch (err) {
      console.error(`ATTENTION: impossible de lire les données sur GitHub (${err.message}). Données locales utilisées.`);
    }
  } else {
    console.warn('GITHUB_TOKEN absent: les données restent seulement sur le disque du serveur.');
  }
  ensureDefaultPack();
  players.init({
    dataDir: DATA_DIR,
    secret: process.env.DATA_KEY || (PASSWORD_OK ? PASSWORD : null),
    save: storage.configured() ? (relative, buffer) => storage.saveFile(relative, buffer) : null,
  });
  loadReportedAgentUrl();
  editor.init({ dataDir: DATA_DIR, storage, activate: activateModpack, activeModpack: () => readPack().modpack || null });
  accounts.init({
    dataDir: DATA_DIR,
    secret: process.env.DATA_KEY || (PASSWORD_OK ? PASSWORD : null),
    password: PASSWORD_OK ? PASSWORD : null,
    save: storage.configured() ? (relative, buffer) => storage.saveFile(relative, buffer) : null,
  });
  // Render stops the website when it sleeps or redeploys: save the latest players on GitHub first.
  process.once('SIGTERM', () => players.flush().finally(() => process.exit(0)));
  // Old versions stored the beta key in clear text: keep only its hash.
  const pack = readPack();
  // News written before authors existed get an id (their author stays unknown), so editing them keeps it that way.
  if ((pack.news || []).some((n) => !n.id)) {
    pack.news = pack.news.map((n) => (n.id ? n : { id: crypto.randomBytes(6).toString('hex'), ...n }));
    await savePack(pack).catch((err) => console.error(err.message));
  }
  if (pack.betaKey) {
    pack.betaKeyHash = hashKey(pack.betaKey);
    delete pack.betaKey;
    await savePack(pack).catch((err) => console.error(err.message));
  }
  buildManifest(DATA_DIR);
  ready = true;
  console.log(`Prêt. Données: ${DATA_DIR}`);
  console.log(`Site admin:      http://localhost:${PORT}/admin/`);
  console.log(`URL du launcher: http://localhost:${PORT}/  (serverUrl dans launcher.config.json)`);
}

start().catch((err) => {
  console.error('Démarrage impossible :', err);
  process.exit(1);
});
