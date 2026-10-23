// Launcher self-update from GitHub Releases (Windows installer only).
// A release is published by .github/workflows/release.yml when a commit message contains
// "[off_update] [1.2.0]". It holds ModdedQC-Setup.exe and ModdedQC-Setup.exe.sha256.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const { downloadAll, sha256File } = require('./download');

const INSTALLER = 'ModdedQC-Setup.exe';

// "1.10.0" > "1.9.3", and an official "1.2.0" > a dev build "1.2.0-dev".
function isNewer(latest, current) {
  const parse = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) || [0, 0, 0, 0]).slice(1).map(Number);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return current.includes('-') && !latest.includes('-');
}

async function github(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ModdedQC-Launcher', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res;
}

/** Returns { version, installer, checksum } when GitHub has a newer launcher, otherwise null. */
async function findUpdate(repo) {
  // Updates only make sense for the installed Windows app (not "npm start").
  if (!repo || !app.isPackaged || process.platform !== 'win32') return null;
  const release = await (await github(`https://api.github.com/repos/${repo}/releases/latest`)).json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version) || !isNewer(version, app.getVersion())) return null;

  const asset = (name) => release.assets.find((a) => a.name === name);
  const installer = asset(INSTALLER);
  const checksum = asset(`${INSTALLER}.sha256`);
  if (!installer || !checksum) return null;
  return { version, installer, checksum };
}

/**
 * Downloads the new installer, checks its SHA-256, runs it silently and quits.
 * The installer reopens the launcher when it's done.
 */
async function installUpdate(update, onProgress) {
  const expected = (await (await github(update.checksum.browser_download_url)).text()).trim().split(/\s+/)[0].toLowerCase();
  const dest = path.join(os.tmpdir(), `ModdedQC-Setup-${update.version}.exe`);
  fs.rmSync(dest, { force: true });

  await downloadAll([{ url: update.installer.browser_download_url, dest, size: update.installer.size }], ({ done, total }) =>
    onProgress(total ? done / total : null),
  );
  if ((await sha256File(dest)) !== expected) {
    fs.rmSync(dest, { force: true });
    throw new Error('Mise à jour corrompue, réessaie plus tard.');
  }

  // /S = silent install, --updated = keep shortcuts, --force-run = start the launcher afterwards.
  spawn(dest, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

module.exports = { findUpdate, installUpdate, isNewer };
