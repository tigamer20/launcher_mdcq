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
const legacy = require('./legacy');
const presence = require('./presence');
const control = require('./control');
const discord = require('./discord');

const config = require('../../launcher.config.json');
// Version of the files actually running (they can come from an update, see src/bootstrap.js).
const { version: VERSION, releaseName: RELEASE_NAME } = require('../../package.json'); // "1.0.0", "Sweet Minecraft Treat"
// ATM_SERVER_URL lets you test against a local admin panel without editing the config.
const SERVER_URL = process.env.ATM_SERVER_URL || config.serverUrl;
// Shared files (Java, Minecraft, NeoForge, assets) in ROOT; each season gets its own game folder
// (mods, configs, saves...) in ROOT/instances/<season>, so a new season starts clean.
const ROOT = path.join(app.getPath('appData'), '.atm');
const instanceDir = (season) =>
  path.join(ROOT, 'instances', String(season || 'Saison 3').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'saison-3');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

let win;
let playing = false;

// Discord status: what the player is doing, with the server's player count from the last check (every 15 s).
const discordState = { season: null, players: null, game: null }; // game: { startedAt, noServer }
function updateDiscord() {
  const { season, players, game } = discordState;
  if (!game) return discord.setStatus({ details: 'Dans le launcher', state: season, players });
  discord.setStatus({
    details: game.noServer ? 'En jeu' : `En jeu sur ${season || 'le serveur'}`,
    state: game.noServer ? season : 'Sur le serveur',
    startedAt: game.startedAt,
    players: game.noServer ? null : players,
  });
}

function loadSettings() {
  // All the Mods 10 needs a lot of memory: 8 Go when the PC has 16 Go or more, 6 Go otherwise.
  const ramMb = os.totalmem() >= 15 * 1024 ** 3 ? 8192 : 6144;
  const defaults = { ramMb, hideOnLaunch: false, discordStatus: true, maximized: false, devTab: false, beta: { enabled: false, key: '' }, declinedBeta: null };
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
    const settings = loadSettings();
    if (settings.maximized) win.maximize(); // opens the way the player left it
    win.show();
    discord.setEnabled(settings.discordStatus);
    updateDiscord();
    updater.confirmCurrentVersion(VERSION); // this version starts fine: keep it
    legacy.removeOldApp(); // the old ModdedQC app, replaced by ATM Launcher
    // A player already signed in shows up in the admin website's "Joueurs" tab when the launcher opens.
    if (auth.loadAccount()) {
      auth.refresh(config.azureClientId).then((account) => presence.report(SERVER_URL, account, 'open', VERSION)).catch(() => {});
    }
  });

  // Maximized or not is remembered for the next start.
  const onMaximizeChange = () => {
    win.webContents.send('maximized', win.isMaximized());
    saveSettings({ maximized: win.isMaximized() });
  };
  win.on('maximize', onMaximizeChange);
  win.on('unmaximize', onMaximizeChange);

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
    releaseName: RELEASE_NAME || null,
  };
});

// Called at startup and every 15 seconds so changes made on the admin website show up quickly.
// The Minecraft server's address from the last pack read: its status is checked on its own every 10 seconds
// (server-status below), straight from this PC, even when the website is slow or asleep.
let lastServer = null;

async function serverStatus() {
  if (!lastServer?.host) return null;
  const status = await pingServer(lastServer.host, lastServer.port, { minecraftVersion: lastServer.minecraftVersion });
  discordState.players = status?.online ? status.players : null;
  updateDiscord();
  return status;
}

ipcMain.handle('server-status', () => serverStatus().catch(() => null));

// An admin can log a player's account out from the website (✕ in the "Joueurs" tab): checked every minute.
let lastKickCheck = 0;
async function checkLoggedOut() {
  const account = auth.loadAccount();
  if (!account || !(await presence.loggedOut(SERVER_URL, account))) return false;
  auth.logout();
  win?.webContents.send('logged-out', 'Ton compte a été déconnecté par un administrateur. Reconnecte-toi pour jouer.');
  return true;
}

ipcMain.handle('pack', async () => {
  if (Date.now() - lastKickCheck > 60_000) {
    lastKickCheck = Date.now();
    checkLoggedOut();
  }
  try {
    const pack = await files.fetchManifest(SERVER_URL);
    lastServer = pack.server?.host ? { ...pack.server, minecraftVersion: pack.modpack?.minecraft || pack.versionId } : null;
    discordState.season = pack.season || 'Saison 3';
    const server = await serverStatus();
    const installed = modpack.installedState(instanceDir(pack.season));
    return {
      name: pack.name,
      season: pack.season || 'Saison 3',
      version: pack.version,
      news: pack.news || [],
      server: pack.server,
      minecraft: pack.versionId,
      serverStatus: server,
      maintenance: pack.maintenance?.enabled ? pack.maintenance : null,
      modpackHidden: Boolean(pack.modpackHidden), // hidden from the admin website
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
  if (playing) return; // never close the launcher while the game or an installation runs
  app.relaunch();
  app.exit(0); // the startup update window installs the new version
});

// While the launcher stays open, look for a new launcher version every 15 minutes. When there is one, the window
// shows a small "Redémarrer" button next to the version (the update itself happens at the restart).
let announcedUpdate = null;
async function lookForLauncherUpdate() {
  if (!app.isPackaged && !process.env.ATM_FORCE_UPDATER) return;
  try {
    const settings = loadSettings();
    const beta = settings.beta.enabled && Boolean(settings.beta.key);
    const found = await updater.checkForUpdates({ repo: config.updateRepo, current: VERSION, beta });
    const target = found.beta && updater.versionOf(found.beta) !== settings.declinedBeta ? found.beta : found.official;
    if (!target || updater.versionOf(target) === announcedUpdate) return;
    announcedUpdate = updater.versionOf(target);
    win?.webContents.send('launcher-update', { version: announcedUpdate, label: updater.labelOf(target) });
  } catch {
    // GitHub unreachable: try again next time
  }
}

ipcMain.handle('login', async () => {
  const account = await auth.login(config.azureClientId, win);
  presence.report(SERVER_URL, account, 'login', VERSION); // shown in the admin website's "Joueurs" tab
  return { name: account.name, uuid: account.uuid };
});

ipcMain.handle('logout', () => auth.logout());

function saveSettings(settings) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...settings }));
}

ipcMain.handle('save-settings', (_event, settings) => {
  saveSettings(settings);
  if ('discordStatus' in settings) {
    discord.setEnabled(settings.discordStatus);
    updateDiscord();
  }
});

// Settings > "Supprimer le modpack installé": empties this season's game folder, so the button becomes INSTALLER.
// keepPersonal keeps the player's worlds, screenshots, settings and maps. Java, Minecraft and NeoForge (shared by
// every season) stay, so installing again is quicker.
const PERSONAL = new Set(['saves', 'screenshots', 'schematics', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat', 'journeymap', 'XaeroWaypoints', 'XaeroWorldMap', 'shaderpacks', 'resourcepacks']);
ipcMain.handle('delete-modpack', async (_event, { keepPersonal = true } = {}) => {
  if (playing) throw new Error("Attends la fin de l'installation ou ferme le jeu avant de supprimer le modpack.");
  const pack = await files.fetchManifest(SERVER_URL).catch(() => ({}));
  const dir = instanceDir(pack.season);
  if (!fs.existsSync(dir)) return { deleted: 0 };
  let deleted = 0;
  for (const name of fs.readdirSync(dir)) {
    if (keepPersonal && PERSONAL.has(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 });
    deleted++;
  }
  return { deleted };
});

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

// allowMaintenance: the developer section can still start the game (without the server) to test the modpack.
async function loadPackForGame({ allowMaintenance = false } = {}) {
  const pack = await files.fetchManifest(SERVER_URL);
  if (pack.maintenance?.enabled && !allowMaintenance) throw new Error(pack.maintenance.message || 'Le serveur est en maintenance.');
  return pack;
}

// INSTALLER: first download of everything (no Microsoft account needed for that).
ipcMain.handle('install', async () => {
  if (playing) return;
  playing = true;
  control.begin(); // the Pause and Annuler buttons of the installation panel
  try {
    await prepare(await loadPackForGame());
    win.webContents.send('status', { step: 'done', text: 'Installation terminée!', progress: 1 });
  } finally {
    control.end();
    playing = false;
  }
});

ipcMain.handle('install-control', (_event, action) => {
  if (action === 'pause') control.pause();
  if (action === 'resume') control.resume();
  if (action === 'cancel') control.cancel();
});
control.onChange((state) => win?.webContents.send('install-control', state));

// JOUER: apply updates if any, log in, start NeoForge and join the server.
// { noServer: true } (developer section): same, but the game stays on its title screen.
ipcMain.handle('play', async (_event, options = {}) => {
  if (playing) return;
  playing = true;
  const noServer = Boolean(options?.noServer);
  try {
    const settings = loadSettings();
    const pack = await loadPackForGame({ allowMaintenance: noServer });
    const { installed, gameDir } = await prepare(pack);

    status('Connexion au compte...', null);
    if (await checkLoggedOut()) throw new Error('Ton compte a été déconnecté par un administrateur. Reconnecte-toi pour jouer.');
    const account = await auth.refresh(config.azureClientId);
    presence.report(SERVER_URL, account, 'play', VERSION);

    status('Lancement du jeu (le premier démarrage de NeoForge peut prendre quelques minutes)...', null);
    const server = !noServer && pack.autoConnect && pack.server;
    const child = minecraft.launch(ROOT, installed, { account, ramMb: settings.ramMb, server, gameDir });

    win.webContents.send('game-started');
    discordState.game = { startedAt: Date.now(), noServer: !server };
    updateDiscord();
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
  discordState.game = null;
  updateDiscord();
  if (!win) return;
  win.show();
  win.restore();
  win.webContents.send('game-closed', error);
}

ipcMain.on('window', (_event, action) => {
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
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
  if (!app.isPackaged && !process.env.ATM_FORCE_UPDATER) return false; // "npm start": no updates
  const splash = createUpdateWindow();
  await new Promise((resolve) => splash.webContents.once('did-finish-load', resolve));
  const send = (state) => !splash.isDestroyed() && splash.webContents.send('updater-state', { current: VERSION, ...state });
  send({ phase: 'checking' });

  try {
    const settings = loadSettings();
    let beta = settings.beta.enabled && Boolean(settings.beta.key);
    if (beta) beta = await checkBetaKey(settings.beta.key).catch(() => true); // website down: keep the player's choice

    const found = await withTimeout(updater.checkForUpdates({ repo: config.updateRepo, current: VERSION, beta, force: legacy.isOldApp() }), 10_000);
    let target = null;
    if (found.beta && updater.versionOf(found.beta) !== settings.declinedBeta) {
      send({ phase: 'beta-available', version: updater.versionOf(found.beta), label: updater.labelOf(found.beta) });
      const choice = await new Promise((resolve) => ipcMain.once('updater-choice', (_event, value) => resolve(value)));
      if (choice === 'beta') target = found.beta;
      else saveSettings({ declinedBeta: updater.versionOf(found.beta) });
    }
    if (!target) target = found.official;
    if (!target) {
      splash.close();
      return false;
    }

    const label = updater.labelOf(target); // "v1.0.0 - Sweet Minecraft Treat"
    const result = await updater.installUpdate(target, (state) => send({ ...state, label }));
    send({ phase: 'restarting', version: updater.versionOf(target), label });
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
  setInterval(lookForLauncherUpdate, 15 * 60_000);
});
app.on('before-quit', () => discord.stop());
app.on('window-all-closed', () => {
  if (!startingUp) app.quit();
});
