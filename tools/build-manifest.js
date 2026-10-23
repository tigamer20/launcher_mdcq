#!/usr/bin/env node
// Generates manifest.json for the file server.
// Usage: node tools/build-manifest.js <server-folder>
// The folder must contain pack.json and a files/ folder (see server-example/).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(process.argv[2] || 'server-example');
const filesDir = path.join(dir, 'files');
const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
const keepPlayerChanges = pack.keepPlayerChanges || [];

function walk(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.name.startsWith('.')) return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(filesDir).map((full) => {
  const data = fs.readFileSync(full);
  const relative = path.relative(filesDir, full).split(path.sep).join('/');
  const file = { path: relative, size: data.length, sha1: crypto.createHash('sha1').update(data).digest('hex') };
  if (keepPlayerChanges.some((p) => relative === p || relative.startsWith(p.replace(/\/?$/, '/')))) {
    file.overwrite = false;
  }
  return file;
});

const { keepPlayerChanges: _, ...manifest } = pack;
manifest.files = files;
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest.json créé: ${files.length} fichiers, modpack v${pack.version}`);
