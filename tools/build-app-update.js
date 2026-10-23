#!/usr/bin/env node
// Used by the GitHub Action after tools/ci-config.js: prepares the files for file-by-file launcher updates.
// Writes dist/app-update/app-update.json (every launcher file with its SHA-256) and one copy of each file
// named by its hash. Installed launchers download only the files whose hash changed (src/main/updater.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'app-update');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

// Same files as the "files" list in package.json "build" (what goes inside the installed app).
const sources = [...walk(path.join(root, 'src')), path.join(root, 'launcher.config.json'), path.join(root, 'package.json')];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const files = sources.map((full) => {
  const data = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  fs.writeFileSync(path.join(out, sha256), data);
  return { path: path.relative(root, full).split(path.sep).join('/'), sha256, size: data.length };
});

const manifest = { version: pkg.version, electron: pkg.devDependencies.electron, files };
fs.writeFileSync(path.join(out, 'app-update.json'), JSON.stringify(manifest, null, 2));
console.log(`app-update.json: ${files.length} fichiers, version ${pkg.version}, Electron ${manifest.electron}`);
