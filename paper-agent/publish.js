// Publishes the client modpack (the folder MODPACK_DIR on this Mac) for the launchers, as assets of the
// GitHub release "modpack":
//   <sha1>.jar ...          each mod / big file, named by its SHA-1 (unchanged files are never re-uploaded)
//   bundle-<sha1>.zip       all the small files (configs, scripts...) in one zip
//   modpack-<version>.json  the list the launcher reads (see src/main/modpack.js)
// Started from the admin website ("Modpack" tab) through the agent. Needs GITHUB_TOKEN (Contents: read and write).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createZip } = require('./zip');

const API = process.env.GITHUB_API || 'https://api.github.com';
const UPLOADS = process.env.GITHUB_UPLOADS || 'https://uploads.github.com';
const REPO = process.env.GITHUB_REPO || 'tigamer20/launcher_mdcq';
const TOKEN = process.env.GITHUB_TOKEN;
const TAG = 'modpack';
const MAX_ASSETS = 990; // GitHub allows 1000 files per release
const BIG_FILE = 1024 * 1024; // bigger files get their own download

// Top-level folders and files of a Minecraft instance that are not part of the modpack.
const EXCLUDE = new Set([
  // the player's own data
  'saves', 'logs', 'crash-reports', 'screenshots', 'backups', 'simplebackups', 'schematics', 'journeymap', 'xaero',
  'XaeroWaypoints', 'XaeroWorldMap', 'local', 'servers.dat', 'command_history.txt', 'realms_persistence.json',
  'usercache.json', 'usernamecache.json', 'fancymenu_data',
  // caches rebuilt by the game or mods
  'downloads', 'cache', '.cache', '.launcher', 'dynamic-data-pack-cache', 'dynamic-resource-pack-cache',
  'moonlight-global-datapacks', '.mixin.out',
  // launcher / CurseForge files
  'launcher_profiles.json', 'instance.json', 'minecraftinstance.json', 'manifest.json', 'modlist.html', '.curseclient',
])
// Player settings: installed the first time only, never overwritten afterwards.
const KEEP_PLAYER_CHANGES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'config/jei/world', 'config/xaero'];

const job = { state: 'idle', step: '', done: 0, total: 0, message: '', result: null };
const configured = () => Boolean(process.env.MODPACK_DIR && TOKEN);

function walk(root, dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    // EXCLUDE is about the instance's top-level folders/files only (a config/foo/cache folder is kept).
    if (entry.name.startsWith('.') || EXCLUDE.has(relative)) return [];
    if (entry.name.endsWith('.disabled')) return []; // mods turned off in the CurseForge app
    if (entry.isDirectory()) return walk(root, full);
    return entry.isFile() ? [{ full, relative }] : [];
  });
}

async function gh(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `${API}/repos/${REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ATM-Agent',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 404) return null;
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub: ${json.message || res.status}`);
  return json;
}

async function upload(release, name, data) {
  const res = await fetch(`${UPLOADS}/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
      'User-Agent': 'ATM-Agent',
    },
    body: data,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Envoi de ${name} refusé par GitHub: ${json.message || res.status}`);
  return json;
}

async function getRelease() {
  const existing = await gh('GET', `/releases/tags/${TAG}`);
  if (existing) return existing;
  // A pre-release that is never "latest": the launcher's own download link keeps pointing to the launcher.
  return gh('POST', '/releases', {
    tag_name: TAG,
    target_commitish: 'main',
    name: 'Modpack (fichiers du launcher)',
    body: 'Fichiers du modpack téléchargés par le launcher. Publié automatiquement depuis le site admin, ne pas modifier à la main.',
    prerelease: true,
    make_latest: 'false',
  });
}

async function listAssets(release) {
  const assets = [];
  for (let page = 1; ; page++) {
    const batch = await gh('GET', `/releases/${release.id}/assets?per_page=100&page=${page}`);
    assets.push(...(batch || []));
    if (!batch || batch.length < 100) return assets;
  }
}

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');

/** Minecraft and NeoForge versions read from the CurseForge instance (manifest.json / minecraftinstance.json). */
function detectVersions(dir = process.env.MODPACK_DIR) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const loader = (manifest.minecraft?.modLoaders || []).find((l) => l.primary) || manifest.minecraft?.modLoaders?.[0];
    const neoforge = /^neoforge-(.+)$/.exec(loader?.id || '')?.[1];
    return { minecraft: manifest.minecraft?.version, neoforge, name: manifest.name, version: manifest.version };
  } catch {
    return {};
  }
}

async function publish({ version, minecraft, neoforge }) {
  const dir = path.resolve(process.env.MODPACK_DIR);
  const set = (step, done = 0, total = 0) => Object.assign(job, { step, done, total });

  // 1. Read the modpack folder
  const files = walk(dir);
  if (!files.some((f) => f.relative.startsWith('mods/'))) throw new Error(`Aucun dossier mods/ dans ${dir}`);
  const big = [];
  const small = [];
  files.forEach((file, i) => {
    set('Analyse des fichiers', i + 1, files.length);
    const size = fs.statSync(file.full).size;
    (file.relative.startsWith('mods/') || size > BIG_FILE ? big : small).push({ ...file, size });
  });
  if (big.length + 2 > MAX_ASSETS) throw new Error(`Trop de gros fichiers (${big.length}) : GitHub en accepte ${MAX_ASSETS}`);

  // 2. Upload what GitHub doesn't have yet
  set('Connexion à GitHub');
  const release = await getRelease();
  const assets = new Map((await listAssets(release)).map((a) => [a.name, a]));
  const entries = [];
  let uploadedBytes = 0;
  for (const [i, file] of big.entries()) {
    set('Envoi des mods sur GitHub', i + 1, big.length);
    const data = fs.readFileSync(file.full);
    const hash = sha1(data);
    const name = `${hash}${path.extname(file.relative).toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
    if (!assets.has(name)) {
      assets.set(name, await upload(release, name, data));
      uploadedBytes += data.length;
    }
    entries.push({ path: file.relative, sha1: hash, size: data.length, url: assets.get(name).browser_download_url });
  }

  set('Envoi des configurations');
  const zip = createZip(small.sort((a, b) => a.relative.localeCompare(b.relative)).map((f) => ({ name: f.relative, data: fs.readFileSync(f.full) })));
  const zipName = `bundle-${sha1(zip)}.zip`;
  if (!assets.has(zipName)) {
    assets.set(zipName, await upload(release, zipName, zip));
    uploadedBytes += zip.length;
  }

  // 3. The list the launchers read
  set('Publication de la version');
  const manifest = {
    format: 1,
    version,
    minecraft,
    neoforge,
    publishedAt: new Date().toISOString(),
    files: entries,
    bundle: { url: assets.get(zipName).browser_download_url, sha1: sha1(zip), size: zip.length, files: small.map((f) => f.relative) },
    syncDirs: ['mods'],
    keepPlayerChanges: KEEP_PLAYER_CHANGES,
  };
  const manifestName = `modpack-${version}.json`;
  if (assets.has(manifestName)) await gh('DELETE', `/releases/assets/${assets.get(manifestName).id}`);
  const manifestAsset = await upload(release, manifestName, Buffer.from(JSON.stringify(manifest)));

  // 4. Remove files no version uses anymore (keeps the release under GitHub's limit)
  set('Nettoyage');
  const used = new Set([...entries.map((e) => e.url.split('/').pop()), zipName, manifestName]);
  for (const [name, asset] of assets) {
    // editor-*: files of the admin website's modpack editor, it cleans them up itself
    if (!used.has(name) && !name.startsWith('editor-')) await gh('DELETE', `/releases/assets/${asset.id}`);
  }

  const size = entries.reduce((s, e) => s + e.size, 0) + zip.length;
  return { manifestUrl: manifestAsset.browser_download_url, version, minecraft, neoforge, files: files.length, size, uploadedBytes };
}

/** Starts publishing in the background; the website follows it with status(). */
function start(options) {
  if (!configured()) throw new Error('MODPACK_DIR et GITHUB_TOKEN doivent être définis dans start-agent');
  if (job.state === 'running') throw new Error('Une publication est déjà en cours');
  for (const key of ['version', 'minecraft', 'neoforge']) {
    if (!/^[0-9][0-9A-Za-z.+-]{0,40}$/.test(String(options[key] || ''))) throw new Error(`Valeur invalide pour ${key}`);
  }
  Object.assign(job, { state: 'running', step: 'Démarrage', done: 0, total: 0, message: '', result: null });
  publish(options)
    .then((result) => Object.assign(job, { state: 'done', step: 'Terminé', result }))
    .catch((err) => Object.assign(job, { state: 'error', message: err.message }));
}

const status = () => ({ ...job });

// Also used by the admin website's modpack editor (admin-panel/modpack-editor.js).
module.exports = {
  start, status, configured, detectVersions, publish, job,
  getRelease, listAssets, upload, gh, sha1, EXCLUDE, KEEP_PLAYER_CHANGES, MAX_ASSETS, BIG_FILE,
};
