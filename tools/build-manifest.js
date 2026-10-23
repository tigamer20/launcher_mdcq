#!/usr/bin/env node
// Generates manifest.json for the file server.
// Usage: node tools/build-manifest.js <server-folder>
// The folder must contain pack.json and a files/ folder (see server-example/).
// The admin website (admin-panel/) uses the same function every time something changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SHA-1 of files we already hashed, keyed by path + size + modification time.
const hashCache = new Map();

function walk(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.name.startsWith('.')) return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function sha1(full, stat) {
  const key = `${full}:${stat.size}:${stat.mtimeMs}`;
  if (!hashCache.has(key)) {
    hashCache.set(key, crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'));
  }
  return hashCache.get(key);
}

function buildManifest(dir) {
  const filesDir = path.join(dir, 'files');
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  const keepPlayerChanges = pack.keepPlayerChanges || [];

  const files = walk(filesDir).map((full) => {
    const stat = fs.statSync(full);
    const relative = path.relative(filesDir, full).split(path.sep).join('/');
    const file = { path: relative, size: stat.size, sha1: sha1(full, stat) };
    if (keepPlayerChanges.some((p) => relative === p || relative.startsWith(p.replace(/\/?$/, '/')))) {
      file.overwrite = false;
    }
    return file;
  });

  const { keepPlayerChanges: _, ...manifest } = pack;
  manifest.files = files;
  // Write to a temp file first so the launcher never reads a half-written manifest.
  const target = path.join(dir, 'manifest.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(manifest, null, 2));
  fs.renameSync(target + '.tmp', target);
  return manifest;
}

if (require.main === module) {
  const manifest = buildManifest(path.resolve(process.argv[2] || 'server-example'));
  console.log(`manifest.json créé: ${manifest.files.length} fichiers, modpack v${manifest.version}`);
}

module.exports = { buildManifest };
