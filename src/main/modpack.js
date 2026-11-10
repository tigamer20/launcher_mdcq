// Installs and updates the season's modpack in the game folder.
//
// The modpack is published from the server's Mac (paper-agent, "Publier le modpack" on the admin website)
// as GitHub release assets, described by a manifest:
//   { version, minecraft, neoforge,
//     files:  [{ path, sha1, size, url }],          mods and big files, one download each
//     bundle: { url, sha1, size, files: [paths] },   all the small files (configs, scripts...) in one zip
//     syncDirs: ["mods"], keepPlayerChanges: ["options.txt", ...] }
// Only files whose SHA-1 changed are downloaded, so updates are quick.
const fs = require('fs');
const path = require('path');
const { downloadAll, fetchJson } = require('./download');
const { extractZip } = require('./unzip');
const { progressTracker } = require('./progress');

const stateFile = (gameDir) => path.join(gameDir, '.launcher', 'modpack.json');

// Refuses paths that would escape the game folder (e.g. "../../something").
function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`Chemin refusé dans le modpack: ${relative}`);
  return target;
}

const matches = (relative, patterns) =>
  (patterns || []).some((p) => relative === p || relative.startsWith(p.replace(/\/?$/, '/')));

/** What's installed in this game folder: { version, neoforge, minecraft, bundleSha1 } or null. */
function installedState(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(gameDir), 'utf8'));
  } catch {
    return null;
  }
}

function fetchModpackManifest(url) {
  return fetchJson(url);
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * Brings the game folder to `manifest`'s version.
 * onStatus({ step: 'modpack', text, progress, download }) receives the progress.
 */
async function syncModpack(gameDir, manifest, onStatus) {
  const status = (text, progress, download) => onStatus({ step: 'modpack', text, progress, download });
  fs.mkdirSync(path.join(gameDir, '.launcher'), { recursive: true });

  // 1. Mods and big files: download only what's missing or changed.
  status('Vérification des mods...', null);
  const tasks = manifest.files.map((f) => ({ url: f.url, dest: safeJoin(gameDir, f.path), sha1: f.sha1, size: f.size }));
  await downloadAll(
    tasks,
    progressTracker((p) => status('Téléchargement du modpack...', p.bytesTotal ? p.bytesDone / p.bytesTotal : null, p)),
  );

  // 2. Small files (configs, scripts...): one zip, re-applied only when it changed.
  const previous = installedState(gameDir);
  const bundle = manifest.bundle;
  if (bundle && (previous?.bundleSha1 !== bundle.sha1 || bundle.files.some((f) => !fs.existsSync(safeJoin(gameDir, f))))) {
    status('Téléchargement des configurations...', null);
    const zip = path.join(gameDir, '.launcher', 'bundle.zip');
    await downloadAll(
      [{ url: bundle.url, dest: zip, sha1: bundle.sha1, size: bundle.size }],
      progressTracker((p) => status('Téléchargement des configurations...', p.bytesTotal ? p.bytesDone / p.bytesTotal : null, p)),
    );
    status('Installation des configurations...', null);
    const temp = path.join(gameDir, '.launcher', 'bundle');
    fs.rmSync(temp, { recursive: true, force: true });
    extractZip(zip, temp);
    for (const full of listFiles(temp)) {
      const relative = path.relative(temp, full).split(path.sep).join('/');
      const dest = safeJoin(gameDir, relative);
      if (matches(relative, manifest.keepPlayerChanges) && fs.existsSync(dest)) continue; // the player's own settings
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
    }
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }

  // 3. Remove mods the server no longer uses (only in syncDirs, e.g. "mods").
  const expected = new Set([...manifest.files.map((f) => f.path), ...(bundle?.files || [])]);
  for (const dir of manifest.syncDirs || ['mods']) {
    for (const full of listFiles(safeJoin(gameDir, dir))) {
      const relative = path.relative(gameDir, full).split(path.sep).join('/');
      if (!expected.has(relative)) fs.rmSync(full);
    }
  }

  fs.writeFileSync(
    stateFile(gameDir),
    JSON.stringify({ version: manifest.version, minecraft: manifest.minecraft, neoforge: manifest.neoforge, bundleSha1: bundle?.sha1 || null }),
  );
}

module.exports = { syncModpack, installedState, fetchModpackManifest };
