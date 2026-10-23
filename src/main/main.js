// Electron main process: creates the window and connects the UI to the launcher logic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const auth = require('./auth');
const modpack = require('./modpack');
const minecraft = require('./minecraft');

const config = require('../../launcher.config.json');
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

ipcMain.handle('init', async () => {
  const account = auth.loadAccount();
  let pack = null;
  let packError = null;
  try {
    pack = await modpack.fetchManifest(config.serverUrl);
  } catch (err) {
    packError = `Serveur de fichiers injoignable (${err.message})`;
  }
  return {
    account: account && { name: account.name, uuid: account.uuid },
    settings: loadSettings(),
    maxRamMb: Math.floor(os.totalmem() / 1024 / 1024),
    pack: pack && { name: pack.name, version: pack.version, news: pack.news || [], server: pack.server },
    packError,
  };
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

    status('Connexion au compte...', null);
    const account = await auth.refresh(config.azureClientId);

    status('Recherche de mises à jour...', null);
    const pack = await modpack.fetchManifest(config.serverUrl);
    await modpack.sync(GAME_DIR, config.serverUrl, pack, status);

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
