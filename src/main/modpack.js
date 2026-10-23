// Keeps the player's files (mods, configs, mod loader...) identical to the ones on the ModdedQC file server.
const fs = require('fs');
const path = require('path');
const { downloadAll, fetchJson } = require('./download');

const baseUrl = (serverUrl) => serverUrl.replace(/\/?$/, '/');

// Refuses paths that would escape the launcher folder (e.g. "../../something").
function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`Chemin refusé: ${relative}`);
  return target;
}

function fetchManifest(serverUrl) {
  return fetchJson(`${baseUrl(serverUrl)}manifest.json`);
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * Downloads new/changed files and deletes files the server removed
 * (only inside the folders listed in "syncDirs", e.g. "mods").
 */
async function sync(root, serverUrl, manifest, onStatus) {
  const base = baseUrl(serverUrl);
  const tasks = [];
  const expected = new Set();

  for (const file of manifest.files) {
    const dest = safeJoin(root, file.path);
    expected.add(dest);
    if (file.overwrite === false && fs.existsSync(dest)) continue; // the player may edit this one
    const url = base + 'files/' + file.path.split('/').map(encodeURIComponent).join('/');
    tasks.push({ url, dest, sha1: file.sha1, size: file.size });
  }

  onStatus('Vérification des fichiers du serveur...', null);
  await downloadAll(tasks, ({ done, total }) => onStatus('Mise à jour du modpack...', total ? done / total : null));

  for (const dir of manifest.syncDirs || ['mods']) {
    for (const file of listFiles(safeJoin(root, dir))) {
      if (!expected.has(file)) fs.rmSync(file);
    }
  }
}

module.exports = { fetchManifest, sync };
