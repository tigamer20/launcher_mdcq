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
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const release = require('../paper-agent/publish');
const { ZipWriter } = require('./zip-writer');
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

const JOB_NAMES = { import: 'un import', publish: 'une publication', export: 'un export' };

function startJob(kind, fn) {
  if (job.state === 'running') throw bad(`Patiente : ${JOB_NAMES[job.kind] || 'une opération'} est en cours`, 409);
  Object.assign(job, { state: 'running', kind, step: 'Démarrage', done: 0, total: 0, message: '', result: null });
  locked(fn)
    .then((result) => Object.assign(job, { state: 'done', step: 'Terminé', result: result || null }))
    .catch((err) => {
      console.error(`Éditeur du modpack (${kind}) : ${err.message}`);
      Object.assign(job, { state: 'error', message: err.message });
    });
  return { job };
}

// GitHub release "modpack": uploads a file from disk once (files are named by their SHA-1).
// Everything goes through the disk: Render's free plan has only 512 MB of memory.
async function storeFile(rel, assets, name, file) {
  if (!assets.has(name)) assets.set(name, await release.uploadFile(rel, name, file));
  return assets.get(name).browser_download_url;
}

const tmpFile = (label) => path.join(TMP, `${label}-${crypto.randomBytes(8).toString('hex')}.tmp`);

async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
    // Small files go one by one into a zip on disk (sorted, so the same files always give the same zip).
    overrides.sort((a, b) => a.name.localeCompare(b.name));
    const bundleFile = tmpFile('bundle');
    const bundleZip = new ZipWriter(bundleFile);
    for (const [i, entry] of overrides.entries()) {
      step('Envoi des fichiers du modpack sur GitHub', i + 1, overrides.length);
      const relative = entry.name.slice(prefix.length);
      const parts = relative.split('/');
      // player data, hidden files and odd paths ("..") are never sent: the launcher would refuse the whole modpack
      if (release.EXCLUDE.has(parts[0]) || parts.some((p) => !p || p.startsWith('.') || p.includes(':'))) continue;
      const disabled = relative.endsWith('.disabled');
      if (disabled && parts[0] !== 'mods') continue;
      if (parts[0] === 'mods' || entry.size > release.BIG_FILE) {
        const temp = tmpFile('file');
        try {
          const { sha1: hash, size } = await zip.extract(entry, temp);
          const ext = path.extname(disabled ? relative.slice(0, -9) : relative).toLowerCase().replace(/[^.a-z0-9]/g, '');
          const url = await storeFile(rel, assets, `editor-${hash}${ext}`, temp);
          if (parts[0] === 'mods') {
            const fileName = parts.slice(1).join('/').replace(/\.disabled$/, '');
            // The jar of a CurseForge mod that can't be downloaded automatically: fill it in.
            const known = mods.find((m) => !m.url && m.fileName === fileName);
            if (known) Object.assign(known, { url, sha1: hash, size });
            else mods.push({ id: `file-${hash}`, source: 'file', name: fileName.replace(/\.jar$/i, ''), folder: 'mods', fileName, sha1: hash, size, url, enabled: !disabled });
          } else {
            extras.push({ path: relative, sha1: hash, size, url });
          }
        } finally {
          fs.rmSync(temp, { force: true });
        }
      } else {
        bundleZip.add(relative, zip.read(entry));
      }
    }

    let bundle = null;
    const written = bundleZip.close();
    try {
      if (written.files.length) {
        step('Envoi des configurations');
        const url = await storeFile(rel, assets, `editor-bundle-${written.sha1}.zip`, bundleFile);
        bundle = { url, sha1: written.sha1, size: written.size, files: written.files };
      }
    } finally {
      fs.rmSync(bundleFile, { force: true });
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
    const hash = await sha1File(file);
    const size = fs.statSync(file).size;
    const { rel, assets } = await openRelease();
    const url = await storeFile(rel, assets, `editor-${hash}.jar`, file);
    let mod = id ? findMod(id) : null;
    if (mod) {
      Object.assign(mod, { url, sha1: hash, size, fileName: mod.source === 'curseforge' ? mod.fileName : name });
    } else {
      mod = draft.mods.find((m) => m.sha1 === hash) || { id: `file-${hash}`, source: 'file', folder: 'mods', enabled: true };
      if (!draft.mods.includes(mod)) draft.mods.push(mod);
      Object.assign(mod, { name: name.replace(/\.jar$/i, ''), fileName: name, sha1: hash, size, url });
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
    const temp = tmpFile('download');
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temp));
      if ((await sha1File(temp)) !== draft.bundle.sha1) throw new Error('Configurations corrompues sur GitHub : réimporte le modpack');
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
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

/**
 * Saves a file (typed in the editor or sent from the PC). `source` is a Buffer, or { file } for a file on disk.
 * Big files go on GitHub's release like mods (streamed from disk).
 */
const writeFile = (input, source) => locked(async () => {
  const relative = cleanPath(input);
  const d = needDraft();
  const size = Buffer.isBuffer(source) ? source.length : fs.statSync(source.file).size;
  d.extras = d.extras.filter((e) => e.path !== relative);
  d.deleted = d.deleted.filter((p) => p !== relative);
  if (size > release.BIG_FILE) {
    let file = source.file;
    if (!file) fs.writeFileSync((file = tmpFile('write')), source);
    try {
      const hash = await sha1File(file);
      const { rel, assets } = await openRelease();
      const ext = path.extname(relative).toLowerCase().replace(/[^.a-z0-9]/g, '');
      d.extras.push({ path: relative, sha1: hash, size, url: await storeFile(rel, assets, `editor-${hash}${ext}`, file) });
    } finally {
      if (!source.file) fs.rmSync(file, { force: true });
    }
    if (d.edits.includes(relative)) await forgetEdit(relative);
    // the old small copy in the zip must not come back
    if ((d.bundle?.files || []).includes(relative)) d.deleted.push(relative);
  } else {
    const data = Buffer.isBuffer(source) ? source : fs.readFileSync(source.file);
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
  return writeFile(input, { file }).finally(() => fs.rmSync(file, { force: true }));
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
    // Rebuilt one file at a time on disk (sorted): the published zip + the website's changes - deleted files.
    const edits = new Set(d.edits);
    const base = await baseBundle();
    const zip = base && openZip(base);
    const bundleFile = tmpFile('bundle');
    try {
      const sources = [
        ...(zip ? zip.entries.filter((e) => !deleted.has(e.name) && !edits.has(e.name)).map((entry) => ({ name: entry.name, entry })) : []),
        ...d.edits.map((name) => ({ name, edit: path.join(dataDir, EDITS, name) })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      const writer = new ZipWriter(bundleFile);
      for (const src of sources) writer.add(src.name, src.entry ? zip.read(src.entry) : fs.readFileSync(src.edit));
      const written = writer.close();
      bundle = null;
      if (written.files.length) {
        step('Envoi des configurations sur GitHub');
        const url = await storeFile(rel, assets, `editor-bundle-${written.sha1}.zip`, bundleFile);
        bundle = { url, sha1: written.sha1, size: written.size, files: written.files };
      }
    } finally {
      zip?.close();
      fs.rmSync(bundleFile, { force: true });
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
// Export: the current modpack as a CurseForge export (.zip), the same format as the one imported
// (manifest.json + overrides/). It can be imported again here or in the CurseForge app (Import → .zip).
// ---------------------------------------------------------------------------

const EXPORT_FILE = path.join(TMP, 'export.zip');
let exported = null; // { fileName, size, at } of the last export, downloaded with exportFile()

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
}

async function exportZip() {
  const d = needDraft();
  const hosted = (url) => String(url || '').startsWith('https://github.com/'); // on the "modpack" release, not CurseForge
  const curseforgeMods = d.mods.filter((m) => m.source === 'curseforge');
  // Jars that are not downloaded from CurseForge: added by hand, or CurseForge mods whose author forbids other apps
  // (the original export had those in overrides/mods too).
  const jars = d.mods.filter((m) => m.url && (m.source !== 'curseforge' || hosted(m.url)));

  // Configuration files: the published zip + the website's changes - deleted files (like a publish)
  const deleted = new Set(d.deleted);
  const edits = new Set(d.edits);
  const base = await baseBundle();
  const bundle = base && openZip(base);
  const out = tmpFile('export');
  const writer = new ZipWriter(out);
  try {
    step('Préparation du manifest');
    const manifest = {
      minecraft: { version: d.minecraft, modLoaders: [{ id: `neoforge-${d.neoforge}`, primary: true }] },
      manifestType: 'minecraftModpack',
      manifestVersion: 1,
      name: d.name,
      version: d.version,
      author: '',
      files: curseforgeMods.map((m) => ({ projectID: m.projectId, fileID: m.fileId, required: m.enabled })),
      overrides: 'overrides',
    };
    writer.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    const sources = [
      ...(bundle ? bundle.entries.filter((e) => !deleted.has(e.name) && !edits.has(e.name)).map((entry) => ({ name: entry.name, entry })) : []),
      ...d.edits.map((name) => ({ name, edit: path.join(dataDir, EDITS, name) })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    for (const [i, src] of sources.entries()) {
      step('Ajout des configurations', i + 1, sources.length);
      writer.add(`overrides/${src.name}`, src.entry ? bundle.read(src.entry) : fs.readFileSync(src.edit));
    }

    // Big files and jars: downloaded one at a time from GitHub (through the disk, like everything else)
    const downloads = [
      ...d.extras.map((e) => ({ name: e.path, url: e.url })),
      ...jars.map((m) => ({ name: `${m.folder}/${m.fileName}${m.enabled ? '' : '.disabled'}`, url: m.url })),
    ];
    for (const [i, item] of downloads.entries()) {
      step('Téléchargement des fichiers', i + 1, downloads.length);
      const temp = tmpFile('export-file');
      try {
        await download(item.url, temp);
        writer.add(`overrides/${item.name}`, fs.readFileSync(temp));
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
  } catch (err) {
    writer.close();
    fs.rmSync(out, { force: true });
    throw err;
  } finally {
    bundle?.close();
  }
  const { size } = writer.close();
  fs.renameSync(out, EXPORT_FILE);
  const safeName = `${d.name}-${d.version}`.replace(/[^\w.-]+/g, '_');
  exported = { fileName: `${safeName}.zip`, size, at: new Date().toISOString() };
  return { export: exported, mods: d.mods.length, files: fileCount(d) };
}

const fileCount = (d) =>
  (d.bundle?.files.filter((p) => !d.deleted.includes(p)).length || 0) + d.extras.length + d.edits.filter((p) => !(d.bundle?.files || []).includes(p)).length;

/** The last export, for the download: { file, fileName, size } or an error. */
function exportFile() {
  if (!exported || !fs.existsSync(EXPORT_FILE)) throw bad('Aucun export prêt : clique d\'abord sur « Exporter le .zip »', 404);
  return { file: EXPORT_FILE, ...exported };
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
    exported,
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
  startExport: () => {
    needDraft();
    return startJob('export', exportZip);
  },
  exportFile,
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
