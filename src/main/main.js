// Electron main process: creates the window and connects the UI to the launcher logic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const auth = require('./auth');
const files = require('./sync');
const { pingServer } = require('./status');
const minecraft = require('./minecraft');
const updater = require('./updater');

const config = require('../../launcher.config.json');
// MODDEDQC_SERVER_URL lets you test against a local admin panel without editing the config.
const SERVER_URL = process.env.MODDEDQC_SERVER_URL || config.serverUrl;
const GAME_DIR = path.join(app.getPath('appData'), '.moddedqc');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

let win;
let playing = false;

function loadSettings() {
  const defaults = { ramMb: 4096, hideOnLaunch: false };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 620,
    minWidth: 860,
    minHeight: 540,
    frame: false,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links in the news open in the normal web browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

const status = (text, progress) => win?.webContents.send('status', { text, progress });

// ---------------------------------------------------------------------------
// IPC handlers (called from src/preload.js)
// ---------------------------------------------------------------------------

ipcMain.handle('init', () => {
  const account = auth.loadAccount();
  return {
    account: account && { name: account.name, uuid: account.uuid },
    settings: loadSettings(),
    maxRamMb: Math.floor(os.totalmem() / 1024 / 1024),
    version: app.getVersion(),
  };
});

// Called once at startup: installs a newer launcher from GitHub if there is one.
// Returns false when there is nothing to do (or GitHub can't be reached), so the launcher just continues.
ipcMain.handle('self-update', async () => {
  let update;
  try {
    update = await updater.findUpdate(config.updateRepo);
  } catch (err) {
    console.warn(`Vérification de mise à jour impossible: ${err.message}`);
    return false;
  }
  if (!update) return false;
  win.webContents.send('self-update', { version: update.version, progress: null });
  await updater.installUpdate(update, (progress) => win.webContents.send('self-update', { version: update.version, progress }));
  return true;
});

// Called at startup and every 30 seconds so changes made on the admin website show up quickly.
ipcMain.handle('pack', async () => {
  try {
    const pack = await files.fetchManifest(SERVER_URL);
    const server = pack.server?.host ? await pingServer(pack.server.host, pack.server.port) : null;
    return {
      name: pack.name,
      subtitle: pack.subtitle,
      version: pack.version,
      news: pack.news || [],
      server: pack.server,
      minecraft: pack.versionId,
      serverStatus: server,
      maintenance: pack.maintenance?.enabled ? pack.maintenance : null,
    };
  } catch (err) {
    return { error: `Serveur de fichiers injoignable (${err.message})` };
  }
});

ipcMain.handle('login', async () => {
  const account = await auth.login(config.azureClientId, win);
  return { name: account.name, uuid: account.uuid };
});

ipcMain.handle('logout', () => auth.logout());

ipcMain.handle('save-settings', (_event, settings) => {
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...settings }));
});

ipcMain.handle('open-folder', () => {
  fs.mkdirSync(GAME_DIR, { recursive: true });
  shell.openPath(GAME_DIR);
});

ipcMain.handle('play', async () => {
  if (playing) return;
  playing = true;
  try {
    const settings = loadSettings();
    fs.mkdirSync(GAME_DIR, { recursive: true });

    status('Recherche de mises à jour...', null);
    const pack = await files.fetchManifest(SERVER_URL);
    if (pack.maintenance?.enabled) throw new Error(pack.maintenance.message || 'Le serveur est en maintenance.');
    await files.sync(GAME_DIR, SERVER_URL, pack, status);

    status('Connexion au compte...', null);
    const account = await auth.refresh(config.azureClientId);

    const installed = await minecraft.install(GAME_DIR, pack.versionId, status);

    status('Lancement du jeu...', null);
    const server = pack.autoConnect && pack.server;
    const child = minecraft.launch(GAME_DIR, installed, { account, ramMb: settings.ramMb, server });

    win.webContents.send('game-started');
    if (settings.hideOnLaunch) win.hide();
    else win.minimize();

    child.on('error', (err) => finish(`Java n'a pas pu démarrer: ${err.message}`));
    child.on('exit', (code) =>
      finish(code === 0 ? null : `Le jeu s'est arrêté avec une erreur (code ${code}). Voir logs/launcher-latest.log`),
    );
  } catch (err) {
    playing = false;
    throw err;
  }
});

function finish(error) {
  playing = false;
  if (!win) return;
  win.show();
  win.restore();
  win.webContents.send('game-closed', error);
}

ipcMain.on('window', (_event, action) => {
  if (action === 'minimize') win.minimize();
  if (action === 'close') win.close();
});

// ---------------------------------------------------------------------------

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
