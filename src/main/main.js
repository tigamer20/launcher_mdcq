// Electron main process: creates the window and connects the UI to the launcher logic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const auth = require('./auth');
const files = require('./sync');
const { pingServer } = require('./status');
const minecraft = require('./minecraft');
const modpack = require('./modpack');
const { describe } = require('./progress');
const updater = require('./updater');

const config = require('../../launcher.config.json');
// Version of the files actually running (they can come from an update, see src/bootstrap.js).
const VERSION = require('../../package.json').version;
// MODDEDQC_SERVER_URL lets you test against a local admin panel without editing the config.
const SERVER_URL = process.env.MODDEDQC_SERVER_URL || config.serverUrl;
// Shared files (Java, Minecraft, NeoForge, assets) in ROOT; each season gets its own game folder
// (mods, configs, saves...) in ROOT/instances/<season>, so a new season starts clean.
const ROOT = path.join(app.getPath('appData'), '.moddedqc');
const instanceDir = (season) =>
  path.join(ROOT, 'instances', String(season || 'Saison 3').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'saison-3');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

let win;
let playing = false;

function loadSettings() {
  // All the Mods 10 needs a lot of memory: 8 Go when the PC has 16 Go or more, 6 Go otherwise.
  const ramMb = os.totalmem() >= 15 * 1024 ** 3 ? 8192 : 6144;
  const defaults = { ramMb, hideOnLaunch: false, devTab: false, beta: { enabled: false, key: '' }, declinedBeta: null };
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
  win.once('ready-to-show', () => {
    win.show();
    updater.confirmCurrentVersion(VERSION); // this version starts fine: keep it
  });

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
    version: VERSION,
  };
});

// Called at startup and every 15 seconds so changes made on the admin website show up quickly.
ipcMain.handle('pack', async () => {
  try {
    const pack = await files.fetchManifest(SERVER_URL);
    const server = pack.server?.host ? await pingServer(pack.server.host, pack.server.port, { minecraftVersion: pack.modpack?.minecraft || pack.versionId }) : null;
    const installed = modpack.installedState(instanceDir(pack.season));
    return {
      name: pack.name,
      subtitle: pack.subtitle,
      season: pack.season || 'Saison 3',
      version: pack.version,
      news: pack.news || [],
      server: pack.server,
      minecraft: pack.versionId,
      serverStatus: server,
      maintenance: pack.maintenance?.enabled ? pack.maintenance : null,
      modpack: pack.modpack
        ? { version: pack.modpack.version, minecraft: pack.modpack.minecraft, neoforge: pack.modpack.neoforge, size: pack.modpack.size }
        : null,
      // INSTALLER until the modpack has been installed once in this season's folder, then JOUER.
      installed: Boolean(installed),
      installedVersion: installed?.version || null,
    };
  } catch (err) {
    return { error: `Serveur de fichiers injoignable (${err.message})` };
  }
});

// ---------------------------------------------------------------------------
// Beta updates (hidden dev section, Ctrl+Shift+D)
// ---------------------------------------------------------------------------

// The beta key is set by the admins on the website; the website says if a key is right.
async function checkBetaKey(key) {
  const res = await fetch(new URL('api/beta/check', SERVER_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return Boolean(data.valid);
}

ipcMain.handle('beta-check-key', async (_event, key) => {
  try {
    return { valid: await checkBetaKey(String(key || '').trim()) };
  } catch (err) {
    return { valid: false, error: `Vérification impossible: ${err.message}` };
  }
});

ipcMain.handle('beta-set', (_event, beta) => {
  const settings = loadSettings();
  settings.beta = { enabled: Boolean(beta.enabled), key: String(beta.key || '').trim() };
  if (settings.beta.enabled) settings.declinedBeta = null; // ask again for the current beta
  saveSettings(settings);
});

// "Vérifier les mises à jour": restart through the update window.
ipcMain.handle('check-updates-now', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('login', async () => {
  const account = await auth.login(config.azureClientId, win);
  return { name: account.name, uuid: account.uuid };
});

ipcMain.handle('logout', () => auth.logout());

function saveSettings(settings) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...settings }));
}

ipcMain.handle('save-settings', (_event, settings) => saveSettings(settings));

ipcMain.handle('open-folder', async () => {
  const pack = await files.fetchManifest(SERVER_URL).catch(() => ({}));
  const dir = instanceDir(pack.season);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

// Everything the game needs, in order: NeoForge (with Java + Minecraft), Minecraft's files, the modpack,
// then the extra files from the admin website. Already-installed parts are only checked, so this is also
// how updates are applied when the player clicks JOUER.
async function prepare(pack) {
  const send = (state) => {
    if (state.download) state.detail = describe(state.download);
    delete state.download;
    win?.webContents.send('status', state);
  };
  const mp = pack.modpack;
  if (!mp?.manifestUrl) throw new Error("Le modpack n'est pas encore publié. Reviens un peu plus tard!");
  const gameDir = instanceDir(pack.season);
  fs.mkdirSync(gameDir, { recursive: true });

  send({ step: 'modpack', text: 'Lecture du modpack...', progress: null });
  const manifest = await modpack.fetchModpackManifest(mp.manifestUrl);

  const versionId = await minecraft.installNeoForge(
    ROOT,
    { minecraftVersion: manifest.minecraft, neoforgeVersion: manifest.neoforge },
    send,
  );
  const installed = await minecraft.install(ROOT, versionId, (text, progress, download) =>
    send({ step: 'minecraft', text, progress, download }),
  );
  await modpack.syncModpack(gameDir, manifest, send);
  await files.sync(gameDir, SERVER_URL, pack, (text, progress) => send({ step: 'files', text, progress }));
  return { installed, gameDir };
}

async function loadPackForGame() {
  const pack = await files.fetchManifest(SERVER_URL);
  if (pack.maintenance?.enabled) throw new Error(pack.maintenance.message || 'Le serveur est en maintenance.');
  return pack;
}

// INSTALLER: first download of everything (no Microsoft account needed for that).
ipcMain.handle('install', async () => {
  if (playing) return;
  playing = true;
  try {
    await prepare(await loadPackForGame());
    win.webContents.send('status', { step: 'done', text: 'Installation terminée!', progress: 1 });
  } finally {
    playing = false;
  }
});

// JOUER: apply updates if any, log in, start NeoForge and join the server.
ipcMain.handle('play', async () => {
  if (playing) return;
  playing = true;
  try {
    const settings = loadSettings();
    const pack = await loadPackForGame();
    const { installed, gameDir } = await prepare(pack);

    status('Connexion au compte...', null);
    const account = await auth.refresh(config.azureClientId);

    status('Lancement du jeu (le premier démarrage de NeoForge peut prendre quelques minutes)...', null);
    const server = pack.autoConnect && pack.server;
    const child = minecraft.launch(ROOT, installed, { account, ramMb: settings.ramMb, server, gameDir });

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

// ---------------------------------------------------------------------------
// Startup update window (like Discord): check GitHub, update, then open the launcher
// ---------------------------------------------------------------------------

function createUpdateWindow() {
  const splash = new BrowserWindow({
    width: 380,
    height: 440,
    frame: false,
    resizable: false,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'updater-preload.js'), contextIsolation: true, sandbox: true },
  });
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'updater.html'));
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('GitHub ne répond pas')), ms))]);

/** Returns true when the launcher is restarting (or the installer took over). */
async function startupUpdate() {
  if (!app.isPackaged && !process.env.MODDEDQC_FORCE_UPDATER) return false; // "npm start": no updates
  const splash = createUpdateWindow();
  await new Promise((resolve) => splash.webContents.once('did-finish-load', resolve));
  const send = (state) => !splash.isDestroyed() && splash.webContents.send('updater-state', { current: VERSION, ...state });
  send({ phase: 'checking' });

  try {
    const settings = loadSettings();
    let beta = settings.beta.enabled && Boolean(settings.beta.key);
    if (beta) beta = await checkBetaKey(settings.beta.key).catch(() => true); // website down: keep the player's choice

    const found = await withTimeout(updater.checkForUpdates({ repo: config.updateRepo, current: VERSION, beta }), 10_000);
    let target = null;
    if (found.beta && updater.versionOf(found.beta) !== settings.declinedBeta) {
      send({ phase: 'beta-available', version: updater.versionOf(found.beta) });
      const choice = await new Promise((resolve) => ipcMain.once('updater-choice', (_event, value) => resolve(value)));
      if (choice === 'beta') target = found.beta;
      else saveSettings({ declinedBeta: updater.versionOf(found.beta) });
    }
    if (!target) target = found.official;
    if (!target) {
      splash.close();
      return false;
    }

    const result = await updater.installUpdate(target, send);
    send({ phase: 'restarting', version: updater.versionOf(target) });
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (result === 'restart') app.relaunch();
    app.exit(0);
    return true;
  } catch (err) {
    console.warn(`Mise à jour impossible: ${err.message}`);
    send({ phase: 'error', message: err.message });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (!splash.isDestroyed()) splash.close();
    return false;
  }
}

let startingUp = true; // the update window closes before the launcher window opens: don't quit then
app.whenReady().then(async () => {
  if (await startupUpdate()) return;
  createWindow();
  startingUp = false;
});
app.on('window-all-closed', () => {
  if (!startingUp) app.quit();
});
