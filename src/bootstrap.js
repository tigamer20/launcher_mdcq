// Launcher entry point. Updates replace the launcher's files without reinstalling it:
// they are saved in <userData>/app/<version>/ and this file starts the newest working copy.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { isNewer } = require('./main/semver');

const BUNDLED_ROOT = path.join(__dirname, '..');
const MAX_FAILED_STARTS = 2;

function appRoot() {
  if (!app.isPackaged && !process.env.MODDEDQC_FORCE_UPDATER) return BUNDLED_ROOT;
  const updatesDir = path.join(app.getPath('userData'), 'app');
  const stateFile = path.join(updatesDir, 'current.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const root = path.join(updatesDir, state.version);
    const bundled = require(path.join(BUNDLED_ROOT, 'package.json')).version;
    const usable =
      state.electron === process.versions.electron && // same Electron runtime as the files were built for
      isNewer(state.version, bundled) && // a reinstall with a newer installer wins
      fs.existsSync(path.join(root, 'src', 'main', 'main.js')) &&
      (state.confirmed || (state.attempts || 0) < MAX_FAILED_STARTS); // an update that keeps crashing is skipped
    if (!usable) return BUNDLED_ROOT;
    if (!state.confirmed) fs.writeFileSync(stateFile, JSON.stringify({ ...state, attempts: (state.attempts || 0) + 1 }));
    return root;
  } catch {
    return BUNDLED_ROOT;
  }
}

require(path.join(appRoot(), 'src', 'main', 'main.js'));
