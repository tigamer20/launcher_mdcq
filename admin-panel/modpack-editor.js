// Modpack editor of the admin website ("Modpack" tab): import a CurseForge export once, then change the mods and
// configuration files from the website and publish new versions for the launchers. No PC needs to be on.
//
//  - Mods from CurseForge are downloaded by the launchers straight from CurseForge (nothing to store).
//  - Mods CurseForge doesn't let other apps download, and jars added by hand, go to the GitHub release "modpack".
//  - Small files (config, kubejs, defaultconfigs...) go in one zip on the same release; the ones changed on the
//    website are kept in the website's data (admin-data branch) until the next publish.
//
// The draft (what the next published version will contain) is data/modpack-draft.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const release = require('../paper-agent/publish');
const { createZip } = require('../paper-agent/zip');
const { openZip } = require('./zip-reader');
const curseforge = require('./curseforge');

const DRAFT = 'modpack-draft.json';
const EDITS = 'modpack-edits';
const TMP = path.join(os.tmpdir(), 'atm-editor');
const MAX_UPLOAD = 2 * 1024 ** 3;
const TEXT_LIMIT = 2 * 1024 * 1024; // bigger files are not opened in the text editor
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,40}$/;

let dataDir = null;
let storage = null; // { configured(), saveFile(relative, buffer), deleteFile(relative) }
let activate = null; // (info) => makes a published version the one the launchers install
let draft = null;
const job = { state: 'idle', kind: '', step: '', done: 0, total: 0, message: '', result: null };

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
const assetName = (url) => decodeURIComponent(String(url).split('/').pop());

// One change at a time (two admins clicking at once can't lose a change).
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

function init(options) {
  ({ dataDir, storage, activate } = options);
  fs.mkdirSync(TMP, { recursive: true });
  try {
    draft = JSON.parse(fs.readFileSync(path.join(dataDir, DRAFT), 'utf8'));
  } catch {
    draft = null;
  }
}

async function saveDraft() {
  draft.updatedAt = new Date().toISOString();
  const buffer = Buffer.from(JSON.stringify(draft, null, 1));
  fs.writeFileSync(path.join(dataDir, DRAFT), buffer);
  if (storage.configured()) await storage.saveFile(DRAFT, buffer);
}

function changed() {
  draft.unpublished = true;
  return saveDraft();
}

// A path inside the modpack, as typed by the admin: no "..", no absolute path, not a player folder.
function cleanPath(input) {
  const relative = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const parts = relative.split('/');
  if (!relative || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) throw bad('Chemin invalide');
  if (release.EXCLUDE.has(parts[0])) throw bad(`Le dossier ${parts[0]} n'est pas envoyé aux joueurs`);
  if (parts[0] === 'mods') throw bad('Les mods se gèrent dans la liste des mods');
  return relative;
}

// ---------------------------------------------------------------------------
// Uploads from the browser, in pieces (big exports would be refused in one request)
// ---------------------------------------------------------------------------

const uploadFile = (id) => {
  if (!/^[a-f0-9]{32}$/.test(String(id))) throw bad("Identifiant d'envoi invalide");
  return path.join(TMP, `${id}.upload`);
};

function cleanTmp() {
  for (const name of fs.readdirSync(TMP)) {
    const full = path.join(TMP, name);
    if (name.endsWith('.upload') && Date.now() - fs.statSync(full).mtimeMs > 6 * 3600_000) fs.rmSync(full, { force: true });
  }
}

/** Adds a piece at `offset`. Returns the size received so far. */
function uploadChunk(id, offset, data) {
  const file = uploadFile(id);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (Number(offset) === 0 && size) fs.rmSync(file); // a new upload with the same id starts over
  else if (Number(offset) !== size) throw bad(`Morceau inattendu (reçu ${size} octets)`, 409);
  if (Number(offset) + data.length > MAX_UPLOAD) throw bad('Fichier trop gros (2 Go maximum)', 413);
  if (Number(offset) === 0) cleanTmp();
  fs.appendFileSync(file, data);
  return { size: Number(offset) + data.length };
}

function takeUpload(id) {
  const file = uploadFile(id);
  if (!fs.existsSync(file)) throw bad('Fichier envoyé introuvable, recommence');
  return file;
}

// ---------------------------------------------------------------------------
// Background jobs (import, publish): the website follows them with status()
// ---------------------------------------------------------------------------

const step = (text, done = 0, total = 0) => Object.assign(job, { step: text, done, total });

function startJob(kind, fn) {
  if (job.state === 'running') throw bad(`Patiente : ${job.kind === 'import' ? 'un import' : 'une publication'} est en cours`, 409);
  Object.assign(job, { state: 'running', kind, step: 'Démarrage', done: 0, total: 0, message: '', result: null });
  locked(fn)
    .then((result) => Object.assign(job, { state: 'done', step: 'Terminé', result: result || null }))
    .catch((err) => {
      console.error(`Éditeur du modpack (${kind}) : ${err.message}`);
      Object.assign(job, { state: 'error', message: err.message });
    });
  return { job };
}

// GitHub release "modpack": uploads `data` once (files are named by their SHA-1).
async function store(rel, assets, name, data) {
  if (!assets.has(name)) assets.set(name, await release.upload(rel, name, data));
  return assets.get(name).browser_download_url;
}

async function openRelease() {
  const rel = await release.getRelease();
  if (!rel) throw new Error('Release GitHub "modpack" inaccessible (vérifie GITHUB_TOKEN)');
  return { rel, assets: new Map((await release.listAssets(rel)).map((a) => [a.name, a])) };
}

// ---------------------------------------------------------------------------
// Import a CurseForge export (.zip made with "Export Profile" in the CurseForge app)
// ---------------------------------------------------------------------------

async function importExport(uploadId) {
  const file = takeUpload(uploadId);
  const zip = openZip(file);
  try {
    step("Lecture de l'export");
    const manifestEntry = zip.entries.find((e) => e.name === 'manifest.json');
    if (!manifestEntry) {
      throw new Error("Ce .zip n'est pas un export CurseForge (manifest.json manquant). Dans CurseForge : ⋮ → Export Profile.");
    }
    const manifest = JSON.parse(zip.read(manifestEntry).toString('utf8'));
    const loader = (manifest.minecraft?.modLoaders || []).find((l) => l.primary) || manifest.minecraft?.modLoaders?.[0];
    const neoforge = /^neoforge-(.+)$/.exec(loader?.id || '')?.[1];
    if (!neoforge) throw new Error(`Ce modpack n'utilise pas NeoForge (${loader?.id || 'aucun loader'})`);
    const minecraft = manifest.minecraft.version;

    // 1. Mods listed by the export: their download links on CurseForge
    const list = manifest.files || [];
    step('Recherche des mods sur CurseForge', 0, list.length);
    const files = await curseforge.getFiles(list.map((f) => f.fileID));
    const projects = await curseforge.getMods([...new Set(list.map((f) => f.projectID))]);
    const mods = list.map((f) => {
      const cfFile = files.get(f.fileID);
      const project = projects.get(f.projectID) || { name: `Projet ${f.projectID}`, folder: 'mods', link: null };
      return {
        id: `cf-${f.projectID}`,
        source: 'curseforge',
        projectId: f.projectID,
        fileId: f.fileID,
        name: project.name,
        link: project.link,
        folder: project.folder,
        fileName: cfFile?.fileName || `${f.projectID}-${f.fileID}.jar`,
        sha1: cfFile?.sha1 || null,
        size: cfFile?.size || 0,
        url: cfFile?.url || null, // null: to upload by hand (the author forbids other apps)
        enabled: f.required !== false,
      };
    });

    // 2. Files of the export (overrides/): big ones on their own, small ones in one zip
    const prefix = `${manifest.overrides || 'overrides'}/`;
    const overrides = zip.entries.filter((e) => e.name.startsWith(prefix) && e.name.length > prefix.length);
    const { rel, assets } = await openRelease();
    const extras = [];
    const small = [];
    for (const [i, entry] of overrides.entries()) {
      step('Envoi des fichiers du modpack sur GitHub', i + 1, overrides.length);
      const relative = entry.name.slice(prefix.length);
      const parts = relative.split('/');
      // player data, hidden files and odd paths ("..") are never sent: the launcher would refuse the whole modpack
      if (release.EXCLUDE.has(parts[0]) || parts.some((p) => !p || p.startsWith('.') || p.includes(':'))) continue;
      const disabled = relative.endsWith('.disabled');
      if (disabled && parts[0] !== 'mods') continue;
      if (parts[0] === 'mods' || entry.size > release.BIG_FILE) {
        const data = zip.read(entry);
        const hash = sha1(data);
        const ext = path.extname(disabled ? relative.slice(0, -9) : relative).toLowerCase().replace(/[^.a-z0-9]/g, '');
        const url = await store(rel, assets, `editor-${hash}${ext}`, data);
        if (parts[0] === 'mods') {
          const fileName = parts.slice(1).join('/').replace(/\.disabled$/, '');
          // The jar of a CurseForge mod that can't be downloaded automatically: fill it in.
          const known = mods.find((m) => !m.url && m.fileName === fileName);
          if (known) Object.assign(known, { url, sha1: hash, size: data.length });
          else mods.push({ id: `file-${hash}`, source: 'file', name: fileName.replace(/\.jar$/i, ''), folder: 'mods', fileName, sha1: hash, size: data.length, url, enabled: !disabled });
        } else {
          extras.push({ path: relative, sha1: hash, size: data.length, url });
        }
      } else {
        small.push({ name: relative, data: zip.read(entry) });
      }
    }

    let bundle = null;
    if (small.length) {
      step('Envoi des configurations');
      small.sort((a, b) => a.name.localeCompare(b.name));
      const data = createZip(small);
      const hash = sha1(data);
      const url = await store(rel, assets, `editor-bundle-${hash}.zip`, data);
      bundle = { url, sha1: hash, size: data.length, files: small.map((f) => f.name) };
    }

    // 3. The new draft replaces the old one (and its unpublished changes)
    step('Enregistrement');
    await dropEdits();
    draft = {
      name: manifest.name || 'Modpack',
      version: manifest.version || '1.0.0',
      minecraft,
      neoforge,
      importedAt: new Date().toISOString(),
      mods: mods.sort((a, b) => a.name.localeCompare(b.name)),
      extras,
      bundle,
      deleted: [],
      edits: [],
      unpublished: true,
    };
    await saveDraft();
    const missing = mods.filter((m) => m.enabled && !m.url).length;
    return { mods: mods.length, files: (bundle?.files.length || 0) + extras.length, missing };
  } finally {
    zip.close();
    fs.rmSync(file, { force: true });
  }
}

// Forgets the configuration files changed on the website (after a publish or a new import).
async function dropEdits() {
  for (const relative of draft?.edits || []) {
    fs.rmSync(path.join(dataDir, EDITS, relative), { force: true });
    if (storage.configured()) await storage.deleteFile(`${EDITS}/${relative}`).catch(() => {});
  }
  fs.rmSync(path.join(dataDir, EDITS), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

function needDraft() {
  if (!draft) throw bad("Importe d'abord ton modpack (export CurseForge)");
  return draft;
}

function findMod(id) {
  const mod = needDraft().mods.find((m) => m.id === id);
  if (!mod) throw bad('Mod introuvable', 404);
  return mod;
}

const toggleMod = (id) => locked(async () => {
  const mod = findMod(id);
  mod.enabled = !mod.enabled;
  await changed();
  return mod;
});

const removeMod = (id) => locked(async () => {
  findMod(id);
  draft.mods = draft.mods.filter((m) => m.id !== id);
  await changed();
});

async function modVersions(id) {
  const mod = findMod(id);
  if (mod.source !== 'curseforge') throw bad('Ce mod a été ajouté à la main : téléverse une autre version du .jar');
  return { current: mod.fileId, versions: await curseforge.listVersions(mod.projectId, draft.minecraft) };
}

function applyFile(mod, file) {
  Object.assign(mod, { fileId: file.fileId, fileName: file.fileName, sha1: file.sha1, size: file.size, url: file.url });
}

const setModVersion = (id, fileId) => locked(async () => {
  const mod = findMod(id);
  const file = (await curseforge.getFiles([Number(fileId)])).get(Number(fileId));
  if (!file) throw bad('Version introuvable sur CurseForge', 404);
  applyFile(mod, file);
  await changed();
  return mod;
});

const addMod = (input) => locked(async () => {
  needDraft();
  const { mod: project, fileId } = await curseforge.findProject(input);
  let file;
  if (fileId) {
    file = (await curseforge.getFiles([fileId])).get(fileId);
  } else {
    const versions = await curseforge.listVersions(project.projectId, draft.minecraft);
    file = versions.find((v) => v.releaseType === 1) || versions[0];
  }
  if (!file) throw bad(`${project.name} n'a pas de version pour Minecraft ${draft.minecraft} avec NeoForge`);
  let mod = draft.mods.find((m) => m.projectId === project.projectId);
  if (!mod) {
    mod = { id: `cf-${project.projectId}`, source: 'curseforge', projectId: project.projectId, enabled: true };
    draft.mods.push(mod);
  }
  Object.assign(mod, { name: project.name, link: project.link, folder: project.folder, enabled: true });
  applyFile(mod, file);
  draft.mods.sort((a, b) => a.name.localeCompare(b.name));
  await changed();
  return mod;
});

/** A .jar sent from the website: a new mod, or the file of a CurseForge mod that can't be downloaded automatically. */
const uploadMod = (uploadId, fileName, id) => locked(async () => {
  needDraft();
  const name = path.basename(String(fileName || ''));
  if (!/^[^/\\]+\.jar$/i.test(name)) throw bad('Envoie un fichier .jar');
  const file = takeUpload(uploadId);
  try {
    const data = fs.readFileSync(file);
    const hash = sha1(data);
    const { rel, assets } = await openRelease();
    const url = await store(rel, assets, `editor-${hash}.jar`, data);
    let mod = id ? findMod(id) : null;
    if (mod) {
      Object.assign(mod, { url, sha1: hash, size: data.length, fileName: mod.source === 'curseforge' ? mod.fileName : name });
    } else {
      mod = draft.mods.find((m) => m.sha1 === hash) || { id: `file-${hash}`, source: 'file', folder: 'mods', enabled: true };
      if (!draft.mods.includes(mod)) draft.mods.push(mod);
      Object.assign(mod, { name: name.replace(/\.jar$/i, ''), fileName: name, sha1: hash, size: data.length, url });
      draft.mods.sort((a, b) => a.name.localeCompare(b.name));
    }
    await changed();
    return mod;
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Configuration files (everything that isn't a mod)
// ---------------------------------------------------------------------------

// The published zip of small files, kept on this server's disk while it's being used.
async function baseBundle() {
  if (!draft.bundle) return null;
  const file = path.join(TMP, `bundle-${draft.bundle.sha1}.zip`);
  if (!fs.existsSync(file)) {
    const res = await fetch(draft.bundle.url);
    if (!res.ok) throw new Error(`Configurations introuvables sur GitHub (${res.status}) : réimporte le modpack`);
    const data = Buffer.from(await res.arrayBuffer());
    if (sha1(data) !== draft.bundle.sha1) throw new Error('Configurations corrompues sur GitHub : réimporte le modpack');
    fs.writeFileSync(file, data);
  }
  return file;
}

function listFiles() {
  const d = needDraft();
  const deleted = new Set(d.deleted);
  const edits = new Set(d.edits);
  const out = new Map();
  for (const p of d.bundle?.files || []) if (!deleted.has(p)) out.set(p, { path: p, state: '' });
  for (const e of d.extras) out.set(e.path, { path: e.path, state: '', size: e.size, big: true });
  for (const p of edits) out.set(p, { path: p, state: (d.bundle?.files || []).includes(p) ? 'modifié' : 'ajouté' });
  return { files: [...out.values()].sort((a, b) => a.path.localeCompare(b.path)), deleted: d.deleted };
}

const isText = (data) => data.length <= TEXT_LIMIT && !data.subarray(0, 8000).includes(0);

async function readFile(input) {
  const relative = cleanPath(input);
  const d = needDraft();
  let data = null;
  if (d.edits.includes(relative)) {
    data = fs.readFileSync(path.join(dataDir, EDITS, relative));
  } else if ((d.bundle?.files || []).includes(relative) && !d.deleted.includes(relative)) {
    const zip = openZip(await baseBundle());
    try {
      const entry = zip.entries.find((e) => e.name === relative);
      if (entry) data = zip.read(entry);
    } finally {
      zip.close();
    }
  } else {
    const extra = d.extras.find((e) => e.path === relative);
    if (extra) return { path: relative, binary: true, size: extra.size, url: extra.url };
  }
  if (!data) throw bad('Fichier introuvable', 404);
  return isText(data) ? { path: relative, content: data.toString('utf8'), size: data.length } : { path: relative, binary: true, size: data.length };
}

/** Saves a file (typed in the editor or sent from the PC). Big files go on GitHub's release like mods. */
const writeFile = (input, data) => locked(async () => {
  const relative = cleanPath(input);
  const d = needDraft();
  d.extras = d.extras.filter((e) => e.path !== relative);
  d.deleted = d.deleted.filter((p) => p !== relative);
  if (data.length > release.BIG_FILE) {
    const hash = sha1(data);
    const { rel, assets } = await openRelease();
    const ext = path.extname(relative).toLowerCase().replace(/[^.a-z0-9]/g, '');
    d.extras.push({ path: relative, sha1: hash, size: data.length, url: await store(rel, assets, `editor-${hash}${ext}`, data) });
    if (d.edits.includes(relative)) await forgetEdit(relative);
    // the old small copy in the zip must not come back
    if ((d.bundle?.files || []).includes(relative)) d.deleted.push(relative);
  } else {
    const target = path.join(dataDir, EDITS, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (storage.configured()) await storage.saveFile(`${EDITS}/${relative}`, data);
    if (!d.edits.includes(relative)) d.edits.push(relative);
  }
  await changed();
});

async function forgetEdit(relative) {
  draft.edits = draft.edits.filter((p) => p !== relative);
  fs.rmSync(path.join(dataDir, EDITS, relative), { force: true });
  if (storage.configured()) await storage.deleteFile(`${EDITS}/${relative}`).catch(() => {});
}

const uploadAsFile = (uploadId, input) => {
  const file = takeUpload(uploadId);
  const data = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return writeFile(input, data);
};

const deleteFile = (input) => locked(async () => {
  const relative = cleanPath(input);
  const d = needDraft();
  if (d.edits.includes(relative)) await forgetEdit(relative);
  d.extras = d.extras.filter((e) => e.path !== relative);
  if ((d.bundle?.files || []).includes(relative) && !d.deleted.includes(relative)) d.deleted.push(relative);
  await changed();
});

/** Cancels the website's change to a file (back to the last published / imported content). */
const revertFile = (input) => locked(async () => {
  const relative = cleanPath(input);
  needDraft();
  if (draft.edits.includes(relative)) await forgetEdit(relative);
  draft.deleted = draft.deleted.filter((p) => p !== relative);
  await saveDraft();
});

// ---------------------------------------------------------------------------
// Publish: a new version for the launchers
// ---------------------------------------------------------------------------

async function publish(version) {
  const d = needDraft();
  const enabled = d.mods.filter((m) => m.enabled);
  const missing = enabled.filter((m) => !m.url);
  if (missing.length) {
    throw new Error(`${missing.length} mod(s) à téléverser à la main avant de publier : ${missing.slice(0, 5).map((m) => m.name).join(', ')}${missing.length > 5 ? '…' : ''}`);
  }
  const { rel, assets } = await openRelease();
  const manifestName = `modpack-${version}.json`;
  if (assets.has(manifestName)) throw new Error(`La version ${version} existe déjà : choisis un autre numéro`);

  // 1. Configurations: the published zip, with the website's changes
  step('Préparation des configurations');
  let bundle = d.bundle;
  const deleted = new Set(d.deleted);
  if (d.edits.length || d.deleted.length) {
    const edits = new Set(d.edits);
    const files = [];
    const base = await baseBundle();
    if (base) {
      const zip = openZip(base);
      try {
        for (const entry of zip.entries) if (!deleted.has(entry.name) && !edits.has(entry.name)) files.push({ name: entry.name, data: zip.read(entry) });
      } finally {
        zip.close();
      }
    }
    for (const relative of d.edits) files.push({ name: relative, data: fs.readFileSync(path.join(dataDir, EDITS, relative)) });
    files.sort((a, b) => a.name.localeCompare(b.name));
    bundle = null;
    if (files.length) {
      step('Envoi des configurations sur GitHub');
      const data = createZip(files);
      const hash = sha1(data);
      bundle = { url: await store(rel, assets, `editor-bundle-${hash}.zip`, data), sha1: hash, size: data.length, files: files.map((f) => f.name) };
    }
  }

  // 2. The list the launchers read (see src/main/modpack.js)
  step('Publication de la version');
  const files = [
    ...enabled.map((m) => ({ path: `${m.folder}/${m.fileName}`, sha1: m.sha1, size: m.size, url: m.url })),
    ...d.extras.map((e) => ({ path: e.path, sha1: e.sha1, size: e.size, url: e.url })),
  ];
  const manifest = {
    format: 1,
    version,
    minecraft: d.minecraft,
    neoforge: d.neoforge,
    publishedAt: new Date().toISOString(),
    source: 'editor',
    files,
    bundle: bundle && { url: bundle.url, sha1: bundle.sha1, size: bundle.size, files: bundle.files },
    syncDirs: ['mods'],
    keepPlayerChanges: release.KEEP_PLAYER_CHANGES,
  };
  const manifestAsset = await release.upload(rel, manifestName, Buffer.from(JSON.stringify(manifest)));
  assets.set(manifestName, manifestAsset);
  const size = files.reduce((s, f) => s + (f.size || 0), 0) + (bundle?.size || 0);
  const info = {
    manifestUrl: manifestAsset.browser_download_url,
    version,
    minecraft: d.minecraft,
    neoforge: d.neoforge,
    files: files.length + (bundle?.files.length || 0),
    size,
  };
  await activate(info);

  // 3. The published version becomes the new starting point
  step('Enregistrement');
  await dropEdits();
  Object.assign(d, { bundle, edits: [], deleted: [], version, publishedAt: manifest.publishedAt, unpublished: false });
  await saveDraft();

  // 4. Remove the editor's files no version uses anymore (GitHub allows 1000 files per release)
  step('Nettoyage');
  await cleanup(rel, assets).catch((err) => console.warn(`Nettoyage du modpack : ${err.message}`));
  return info;
}

async function cleanup(rel, assets) {
  const used = new Set();
  const mark = (url) => url && used.add(assetName(url));
  for (const [name, asset] of assets) {
    if (!/^modpack-.*\.json$/.test(name)) continue;
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) throw new Error(`lecture de ${name} impossible`);
    const m = await res.json();
    m.files.forEach((f) => mark(f.url));
    mark(m.bundle?.url);
  }
  draft.mods.forEach((m) => mark(m.url));
  draft.extras.forEach((e) => mark(e.url));
  mark(draft.bundle?.url);
  for (const [name, asset] of assets) {
    if (name.startsWith('editor-') && !used.has(name)) await release.gh('DELETE', `/releases/assets/${asset.id}`);
  }
}

// ---------------------------------------------------------------------------

function status() {
  return {
    configured: { curseforge: curseforge.configured(), github: storage.configured() },
    draft: draft && {
      ...draft,
      files: (draft.bundle?.files.filter((p) => !draft.deleted.includes(p)).length || 0) + draft.extras.length + draft.edits.filter((p) => !(draft.bundle?.files || []).includes(p)).length,
      missing: draft.mods.filter((m) => m.enabled && !m.url).length,
    },
    job: { ...job },
  };
}

module.exports = {
  init,
  status,
  uploadChunk,
  startImport: (uploadId) => {
    takeUpload(uploadId);
    if (!storage.configured()) throw bad('GITHUB_TOKEN manquant sur Render');
    return startJob('import', () => importExport(uploadId));
  },
  startPublish: (version) => {
    const v = String(version || '').trim();
    if (!VERSION.test(v)) throw bad('Numéro de version invalide (ex. 1.0.1)');
    needDraft();
    return startJob('publish', () => publish(v));
  },
  toggleMod,
  removeMod,
  modVersions,
  setModVersion,
  addMod,
  uploadMod,
  listFiles,
  readFile,
  writeFile,
  uploadAsFile,
  deleteFile,
  revertFile,
};
