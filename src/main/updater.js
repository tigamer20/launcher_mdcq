// Launcher self-update from GitHub Releases.
//
// Each release (built by .github/workflows/release.yml) contains:
//   app-update.json            list of the launcher's files with their SHA-256
//   <sha256> assets            the files themselves, named by their hash
//   ATM-Setup.exe(.sha256) the full installer, for new players
//
// Normal update: only the files whose hash changed are downloaded into <userData>/app/<version>/,
// then the launcher restarts on them (see src/bootstrap.js). Nothing to install.
// The full installer is only used when the Electron runtime itself changed (Windows).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const legacy = require('./legacy');
const { downloadAll, sha256File } = require('./download');
const { isNewer } = require('./semver');
const { progressTracker } = require('./progress');

const INSTALLER = 'ATM-Setup.exe';
const RUNNING_ROOT = path.join(__dirname, '..', '..');
const updatesDir = () => path.join(app.getPath('userData'), 'app');
// ATM_GITHUB_API lets you test updates against a fake GitHub (like ATM_SERVER_URL for the website).
const GITHUB_API = process.env.ATM_GITHUB_API || 'https://api.github.com';

async function github(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ATM-Launcher', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res;
}

const versionOf = (release) => release.tag_name.replace(/^v/, '');

/**
 * Looks for newer versions. Returns { official, beta } (each a release or null).
 * beta is only filled when beta updates are on and the dev version is newer than everything else.
 */
// force: also return the latest official version when it is the current one (old ModdedQC app, see legacy.js).
async function checkForUpdates({ repo, current, beta, force = false }) {
  if (!repo) return { official: null, beta: null };
  const releases = (await (await github(`${GITHUB_API}/repos/${repo}/releases?per_page=30`)).json()).filter(
    (r) => !r.draft && /^v\d+\.\d+\.\d+(-dev)?$/.test(r.tag_name),
  );
  const official = releases.find((r) => !r.prerelease) || null;
  const dev = releases.find((r) => r.prerelease) || null;
  return {
    official: official && (force || isNewer(versionOf(official), current)) ? official : null,
    beta:
      beta && dev && isNewer(versionOf(dev), current) && (!official || isNewer(versionOf(dev), versionOf(official)))
        ? dev
        : null,
  };
}


async function readAssetJson(release, name) {
  const asset = release.assets.find((a) => a.name === name);
  return asset ? (await github(asset.browser_download_url)).json() : null;
}

// Downloads the changed files only, then marks the new version as the one to start.
async function fileUpdate(release, manifest, onProgress) {
  const version = versionOf(release);
  const staging = path.join(updatesDir(), `${version}.partial`);
  const target = path.join(updatesDir(), version);
  fs.rmSync(staging, { recursive: true, force: true });

  const tasks = [];
  for (const file of manifest.files) {
    const dest = path.join(staging, file.path);
    if (!dest.startsWith(staging + path.sep)) throw new Error(`Chemin refusé dans la mise à jour: ${file.path}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const local = path.join(RUNNING_ROOT, file.path);
    if (fs.existsSync(local) && (await sha256File(local)) === file.sha256) {
      fs.copyFileSync(local, dest); // unchanged: reuse the file already on the PC
      continue;
    }
    const asset = release.assets.find((a) => a.name === file.sha256);
    if (!asset) throw new Error(`Fichier manquant dans la mise à jour: ${file.path}`);
    tasks.push({ url: asset.browser_download_url, dest, size: file.size, file });
  }

  const info = { version, channel: release.prerelease ? 'beta' : 'official', filesChanged: tasks.length, filesTotal: manifest.files.length };
  await downloadAll(tasks, progressTracker(onProgress, info));
  onProgress({ ...info, phase: 'installing' });
  for (const task of tasks) {
    if ((await sha256File(task.dest)) !== task.file.sha256) throw new Error(`Fichier corrompu: ${task.file.path}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  fs.writeFileSync(
    path.join(updatesDir(), 'current.json'),
    JSON.stringify({ version, electron: manifest.electron, confirmed: false, attempts: 0 }),
  );
  // Keep only the new version and the one running now (to fall back on).
  for (const entry of fs.readdirSync(updatesDir())) {
    const full = path.join(updatesDir(), entry);
    if (entry !== version && full !== RUNNING_ROOT && fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
  }
  return 'restart';
}

// Rare case (new Electron runtime): download the full installer and run it silently.
async function installerUpdate(release, onProgress, { fresh = false } = {}) {
  const asset = (name) => release.assets.find((a) => a.name === name);
  const installer = asset(INSTALLER);
  const checksum = asset(`${INSTALLER}.sha256`);
  if (process.platform !== 'win32' || !installer || !checksum) {
    throw new Error('Cette mise à jour doit être installée à la main depuis la page de téléchargement du launcher ATM.');
  }
  const version = versionOf(release);
  const expected = (await (await github(checksum.browser_download_url)).text()).trim().split(/\s+/)[0].toLowerCase();
  const dest = path.join(os.tmpdir(), `ATM-Setup-${version}.exe`);
  fs.rmSync(dest, { force: true });
  const info = { version, channel: release.prerelease ? 'beta' : 'official', filesChanged: 1, filesTotal: 1, fullInstaller: true };
  await downloadAll([{ url: installer.browser_download_url, dest, size: installer.size }], progressTracker(onProgress, info));
  onProgress({ ...info, phase: 'installing' });
  if ((await sha256File(dest)) !== expected) {
    fs.rmSync(dest, { force: true });
    throw new Error('Mise à jour corrompue, réessaie plus tard.');
  }
  // /S = silent install, --updated = keep shortcuts, --force-run = start the launcher afterwards.
  // A fresh install (old ModdedQC app) leaves out --updated so the ATM shortcuts are created.
  const args = fresh ? ['/S', '--force-run'] : ['--updated', '/S', '--force-run'];
  spawn(dest, args, { detached: true, stdio: 'ignore' }).unref();
  return 'quit';
}

/** Installs `release`. Returns 'restart' (relaunch on the new files) or 'quit' (the installer takes over). */
async function installUpdate(release, onProgress) {
  onProgress({ phase: 'preparing', version: versionOf(release) });
  const manifest = await readAssetJson(release, 'app-update.json');
  // The old ModdedQC app needs the ATM installer once to get the new name, logo and shortcuts.
  if (legacy.isOldApp()) return installerUpdate(release, onProgress, { fresh: true });
  if (manifest && manifest.electron === process.versions.electron) return fileUpdate(release, manifest, onProgress);
  return installerUpdate(release, onProgress);
}

// Called once the window of an updated launcher has opened: the update works, keep it.
function confirmCurrentVersion(version) {
  const stateFile = path.join(updatesDir(), 'current.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.version === version && !state.confirmed) fs.writeFileSync(stateFile, JSON.stringify({ ...state, confirmed: true }));
  } catch {
    // no update installed yet
  }
}

module.exports = { checkForUpdates, installUpdate, confirmCurrentVersion, isNewer, versionOf };
