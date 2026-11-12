// UI logic. Talks to the launcher through window.launcher (see src/preload.js).
const $ = (id) => document.getElementById(id);

const state = {
  account: null,
  packReady: false,
  maintenance: false,
  busy: false,
  installing: false,
  installed: false, // INSTALLER until the modpack is installed once, then JOUER
  updateAvailable: false, // a newer modpack version is active on the website: INSTALLER again
  modpackPublished: false,
  settings: {},
};
const STEPS = ['java', 'neoforge', 'minecraft', 'modpack', 'files'];

// ---------- Helpers ----------

function cleanError(err) {
  // Electron prefixes errors with "Error invoking remote method 'x': Error: "
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let toastTimer;
function showToast(message, isError) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('info', !isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), isError ? 8000 : 3500);
}

const showError = (message) => showToast(message, true);
const showInfo = (message) => showToast(message, false);

function setBar(bar, progress) {
  bar.classList.toggle('indeterminate', progress == null);
  bar.style.width = progress == null ? '' : `${Math.round(progress * 100)}%`;
}

function setStatus(text, progress, detail = '') {
  $('status-text').textContent = text;
  $('status-detail').textContent = detail;
  setBar($('progress-bar'), progress);
}

function idleText() {
  if (state.maintenance) return 'Le serveur est en maintenance';
  if (state.modpackHidden) return "Le modpack n'est pas disponible pour le moment";
  if (!state.modpackPublished) return "Le modpack n'est pas encore publié";
  if (!state.installed) return 'Clique sur INSTALLER pour télécharger le modpack';
  if (state.updateAvailable) return 'Mise à jour du modpack disponible : clique sur INSTALLER';
  if (!state.account) return 'Connecte-toi avec ton compte Microsoft pour jouer';
  if (state.serverOffline) return 'Serveur hors ligne · jeu en solo disponible';
  return 'Prêt à jouer';
}

function resetStatus(text = idleText()) {
  setStatus(text, 0);
}

function refreshButtons() {
  $('btn-launcher-update').disabled = state.busy; // no restart while the game or an installation runs
  $('btn-update-now').disabled = state.busy;
  const button = $('btn-play');
  if (state.busy) {
    button.textContent = '...';
    button.disabled = true;
  } else if (state.maintenance) {
    button.textContent = 'MAINTENANCE';
    button.disabled = true;
  } else if (!state.installed || state.updateAvailable) {
    // Installing doesn't need a Microsoft account: only playing does. A modpack update comes before everything
    // but a maintenance, even when the server is offline, so players are ready when it comes back.
    button.textContent = 'INSTALLER';
    button.disabled = !state.packReady || !state.modpackPublished;
  } else if (!state.modpackPublished) {
    // removed or hidden on the admin website
    button.textContent = 'INDISPONIBLE';
    button.disabled = true;
  } else if (state.serverOffline) {
    // The server is offline (checked every 15 seconds): the game can still be played alone.
    button.textContent = 'JOUER EN SOLO';
    button.disabled = !state.packReady || !state.account;
  } else {
    button.textContent = 'JOUER';
    button.disabled = !state.packReady || !state.account;
  }
  state.playMode = button.textContent === 'JOUER EN SOLO' ? 'solo' : 'server';
  button.classList.toggle('solo', state.playMode === 'solo');
  button.classList.toggle('install', !state.installed || state.updateAvailable);
  // The arrow (Jouer en solo) only next to JOUER: not while installing, in maintenance or with the server offline.
  const arrow = $('btn-play-menu');
  arrow.hidden = button.textContent !== 'JOUER';
  arrow.disabled = button.disabled;
  // Server offline, JOUER EN SOLO shown: say why the server can't be joined.
  $('offline-notice').hidden = state.playMode !== 'solo' || state.busy;
  $('btn-play-solo').disabled = button.disabled;
  if (arrow.hidden || arrow.disabled) closePlayMenu();
  $('btn-login').disabled = state.busy;
  // Developer section: start the game without the server (also during a maintenance)
  const offlineBlocker = state.busy
    ? 'Patiente, une opération est en cours.'
    : !state.installed
      ? "Installe d'abord le modpack (bouton INSTALLER)."
      : !state.account
        ? 'Connecte-toi avec ton compte Microsoft.'
        : '';
  $('btn-play-offline').disabled = Boolean(offlineBlocker);
  $('btn-delete-modpack').disabled = state.busy || !state.installed;
  $('play-offline-hint').textContent = offlineBlocker;
}

// ---------- Installation panel ----------

function showInstallPanel(visible) {
  $('install-panel').hidden = !visible;
  $('news-section').hidden = visible;
  if (!visible) updateNewsMore();
}

function updateSteps(current) {
  const index = STEPS.indexOf(current);
  document.querySelectorAll('#install-steps li').forEach((li) => {
    const i = STEPS.indexOf(li.dataset.step);
    li.className = current === 'done' || (index >= 0 && i < index) ? 'done' : i === index ? 'active' : '';
  });
}

function showAccount(account) {
  state.account = account;
  $('btn-login').hidden = Boolean(account);
  $('account-info').hidden = !account;
  if (account) {
    $('account-name').textContent = account.name;
    $('avatar').src = `https://mc-heads.net/avatar/${account.uuid}/88`;
  }
  refreshButtons();
}

let shownNews = null; // the news last drawn: the list is only redrawn when it changes (checked every 15 s)

function renderNews(news) {
  const key = JSON.stringify(news);
  if (key === shownNews) return;
  shownNews = key;
  const list = $('news-list');
  list.replaceChildren();
  if (!news.length) {
    list.innerHTML = '<p class="empty">Aucune nouvelle pour le moment.</p>';
    return;
  }
  for (const item of news) {
    const card = document.createElement('article');
    card.className = 'news-card';
    card.title = 'Cliquer pour lire en plein écran';
    const title = document.createElement('h3');
    title.textContent = item.title;
    const date = document.createElement('time');
    date.textContent = item.date || '';
    const author = document.createElement('span');
    author.className = 'news-author';
    author.textContent = item.author ? `Auteur : ${item.author}` : '';
    author.hidden = !item.author;
    const body = document.createElement('p');
    body.className = 'news-text clamped';
    body.textContent = item.body || '';
    const more = document.createElement('button');
    more.className = 'news-more';
    more.textContent = 'Afficher plus';
    more.hidden = true;
    const meta = document.createElement('div');
    meta.className = 'news-meta';
    meta.append(date, author);
    card.append(title, meta, body, more);
    if (item.url?.startsWith('https://')) {
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.textContent = 'En savoir plus →';
      link.onclick = (event) => event.stopPropagation(); // opens the link, not the full screen
      card.append(link);
    }
    card.onclick = () => openNews(item);
    list.append(card);
  }
  updateNewsMore();
}

// "Afficher plus" only on the news whose text is cut (more than 6 lines at the current window size).
function updateNewsMore() {
  for (const body of document.querySelectorAll('.news-card p.clamped')) {
    if (!body.clientHeight) continue; // the news are hidden (installation panel): checked again when shown
    body.parentElement.querySelector('.news-more').hidden = body.scrollHeight <= body.clientHeight + 1;
  }
}

function openNews(item) {
  $('news-viewer-title').textContent = item.title || '';
  $('news-viewer-date').textContent = item.date || '';
  $('news-viewer-author').textContent = item.author ? `Auteur : ${item.author}` : '';
  $('news-viewer-author').hidden = !item.author;
  $('news-viewer-body').textContent = item.body || '';
  const link = $('news-viewer-link');
  link.hidden = !item.url?.startsWith('https://');
  if (!link.hidden) link.href = item.url;
  $('news-viewer').showModal();
  $('news-viewer').scrollTop = 0;
}

$('btn-news-close').onclick = () => $('news-viewer').close();
window.addEventListener('resize', updateNewsMore);

// ---------- Startup ----------

// The Minecraft server's status (online, players). Only "offline" when it could be checked and answered so
// (no address configured: never blocked).
function showServerStatus(status) {
  state.serverOffline = Boolean(state.serverHost && status && !status.online);
  $('server-line').classList.toggle('offline', !status?.online);
  $('server-players').textContent = status?.online
    ? `En ligne · ${status.players.online}/${status.players.max} joueurs`
    : 'Hors ligne';
  $('server-players').title = status?.online ? '' : status?.reason || '';
}

// Every 10 seconds, between the full checks: the launcher pings the Minecraft server itself.
async function checkServer() {
  if (!state.packReady || !state.serverHost) return;
  const status = await window.launcher.serverStatus();
  if (!status) return;
  showServerStatus(status);
  if (!state.busy) resetStatus();
  refreshButtons();
}

// Shows the server info from manifest.json (name, news, maintenance...).
async function loadPack() {
  const pack = await window.launcher.pack();
  if (pack.error) {
    state.packReady = false;
    $('pack-version').textContent = 'Hors ligne';
    if (!state.busy) resetStatus('Impossible de joindre le serveur de fichiers');
    refreshButtons();
    return;
  }

  state.packReady = true;
  state.maintenance = Boolean(pack.maintenance);
  state.modpackPublished = Boolean(pack.modpack);
  state.modpackHidden = Boolean(pack.modpackHidden);
  state.serverHost = pack.server?.host || '';
  if (!state.installing) state.installed = pack.installed;
  $('pack-name').textContent = pack.name || 'All the Mod';
  $('pack-season').textContent = pack.season || 'Saison 3';
  $('pack-version').textContent = pack.modpack
    ? `Modpack ${pack.modpack.version} · NeoForge ${pack.modpack.neoforge}`
    : pack.modpackHidden
      ? 'Modpack indisponible'
      : 'Modpack bientôt disponible';
  const updateAvailable = Boolean(pack.installed && pack.modpack && pack.installedVersion !== pack.modpack.version);
  if (!state.installing) state.updateAvailable = updateAvailable;
  $('pack-update').hidden = !updateAvailable;
  // The address is only shown in the developer mode (Ctrl+Shift+D): players just click JOUER.
  const address = pack.server?.host ? (pack.server.port && pack.server.port !== 25565 ? `${pack.server.host}:${pack.server.port}` : pack.server.host) : '';
  $('server-address').textContent = address;
  $('dev-server-address').textContent = address || '-';
  $('server-address').hidden = !state.settings?.devTab;
  $('server-line').hidden = !pack.server?.host;
  showServerStatus(pack.serverStatus);
  $('maintenance').hidden = !pack.maintenance;
  $('maintenance-message').textContent = pack.maintenance?.message || '';
  renderNews(pack.news);
  if (!state.busy) resetStatus();
  refreshButtons();
}

async function init() {
  const data = await window.launcher.init();
  // "v1.0.0 - SMT" in the title bar (full name on hover), "v1.0.0 - Sweet Minecraft Treat" in the developer section
  const fullName = data.releaseName ? `v${data.version} - ${data.releaseName}` : `v${data.version}`;
  const shortName = data.releaseName ? data.releaseName.split(/\s+/).map((w) => w[0]).join('').toUpperCase() : '';
  $('app-version').textContent = shortName ? `v${data.version} - ${shortName}` : `v${data.version}`;
  $('app-version').title = fullName;
  state.settings = data.settings;
  showAccount(data.account);
  // Developer section (hidden until Ctrl+Shift+D)
  $('btn-dev').hidden = !state.settings.devTab;
  $('server-address').hidden = !state.settings.devTab;
  $('dev-version').textContent = `${fullName}${data.version.includes('-') ? ' (bêta)' : ''}`;
  $('beta-key').value = state.settings.beta?.key || '';
  $('beta-enabled').checked = Boolean(state.settings.beta?.enabled);
  $('beta-enabled').disabled = !state.settings.beta?.key;

  await loadPack();

  // Settings dialog values
  const ram = $('ram');
  ram.max = Math.max(2048, Math.floor((data.maxRamMb - 2048) / 512) * 512);
  ram.value = Math.min(state.settings.ramMb, ram.max);
  $('hide-on-launch').checked = state.settings.hideOnLaunch;
  $('discord-status').checked = state.settings.discordStatus !== false;
  applyTheme(state.settings.theme);
  renderThemes();
  updateRamLabel();
  refreshButtons();

}

function updateRamLabel() {
  $('ram-value').textContent = `${(Number($('ram').value) / 1024).toFixed(1)} Go`;
}

// ---------- Events ----------

$('btn-minimize').onclick = () => window.launcher.minimize();
// Like the Windows button: one square to maximize, two squares to restore. Double-clicking the title bar does the same.
$('btn-maximize').onclick = () => window.launcher.toggleMaximize();
window.launcher.onMaximized((on) => {
  $('maximize-icon').setAttribute('d', on ? 'M8 8h11v11H8zM5 16V5h11' : 'M5 5h14v14H5z');
  $('btn-maximize').title = on ? 'Restaurer' : 'Agrandir';
});
$('btn-close').onclick = () => window.launcher.close();

$('btn-login').onclick = async () => {
  state.busy = true;
  refreshButtons();
  setStatus('Connexion à Microsoft...', null);
  try {
    showAccount(await window.launcher.login());
    resetStatus();
  } catch (err) {
    showError(cleanError(err));
    resetStatus();
  } finally {
    state.busy = false;
    refreshButtons();
  }
};

$('btn-logout').onclick = async () => {
  await window.launcher.logout();
  showAccount(null);
};

$('btn-play').onclick = () => {
  if (!state.installed || state.updateAvailable) return install();
  play(state.playMode === 'solo' ? { noServer: true } : undefined);
};

// Arrow next to JOUER: a small menu with "Jouer en solo" (the game opens on its title screen).
function closePlayMenu() {
  $('play-menu').hidden = true;
  $('btn-play-menu').classList.remove('open');
}
$('btn-play-menu').onclick = (event) => {
  event.stopPropagation();
  const open = $('play-menu').hidden;
  $('play-menu').hidden = !open;
  $('btn-play-menu').classList.toggle('open', open);
};
// The status check can be wrong (slow tunnel, DNS...): the player can still try to join the server.
$('btn-join-anyway').onclick = () => play();
$('btn-play-solo').onclick = () => {
  closePlayMenu();
  play({ noServer: true });
};
document.addEventListener('click', (event) => {
  if (!$('play-group').contains(event.target)) closePlayMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePlayMenu();
});

// INSTALLER: downloads Java, NeoForge, Minecraft and the modpack, with the steps shown. Then the button becomes JOUER.
async function install() {
  const updating = state.installed;
  state.busy = true;
  state.installing = true;
  refreshButtons();
  updateSteps('java');
  $('install-title').textContent = updating ? 'Mise à jour du modpack' : 'Installation du modpack';
  showInstallPanel(true);
  try {
    await window.launcher.install();
    state.installed = true;
    state.updateAvailable = false;
    updateSteps('done');
    $('install-title').textContent = updating ? 'Mise à jour terminée!' : 'Installation terminée!';
    setBar($('install-bar'), 1);
    showInfo(updating ? 'Modpack à jour! Tu peux maintenant jouer.' : 'Installation terminée! Tu peux maintenant jouer.');
    setTimeout(() => showInstallPanel(false), 2500);
  } catch (err) {
    showInstallPanel(false);
    if (/Installation annulée/.test(err.message)) {
      showInfo("Installation annulée. Clique sur INSTALLER pour reprendre : ce qui est déjà téléchargé est gardé.");
    } else {
      showError(cleanError(err));
    }
  } finally {
    state.busy = false;
    state.installing = false;
    refreshButtons();
    resetStatus();
    loadPack().catch(() => {}); // the installed version changed: JOUER comes back right away
  }
}

// Pause / Reprendre and Annuler while installing
let installPaused = false;
$('btn-install-pause').onclick = () => window.launcher.installControl(installPaused ? 'resume' : 'pause');
$('btn-install-cancel').onclick = () => {
  if (confirm("Annuler l'installation ? Ce qui est déjà téléchargé est gardé pour la prochaine fois.")) {
    window.launcher.installControl('cancel');
  }
};
window.launcher.onInstallControl(({ active, paused, cancelled }) => {
  installPaused = paused;
  $('btn-install-pause').textContent = paused ? 'Reprendre' : 'Pause';
  $('btn-install-pause').disabled = !active || cancelled;
  $('btn-install-cancel').disabled = !active || cancelled;
  $('install-bar').classList.toggle('paused', paused);
  if (paused) {
    $('install-text').textContent = 'En pause';
    $('install-detail').textContent = 'Clique sur Reprendre pour continuer le téléchargement.';
    setStatus('Installation en pause', null);
  } else if (cancelled) {
    $('install-text').textContent = 'Annulation...';
  }
});

// JOUER: applies updates (only what changed), then starts the game and joins the server.
// play({ noServer: true }) from the developer section: the game stays on its title screen.
async function play(options) {
  state.busy = true;
  refreshButtons();
  try {
    await window.launcher.play(options);
  } catch (err) {
    state.busy = false;
    refreshButtons();
    showError(cleanError(err));
    resetStatus('Erreur, réessaie');
  }
}

$('btn-settings').onclick = () => $('settings').showModal();
$('btn-folder').onclick = () => window.launcher.openFolder();
$('btn-delete-modpack').onclick = async () => {
  const keepPersonal = $('delete-keep').checked;
  const question = keepPersonal
    ? 'Supprimer le modpack installé ? Tes mondes, captures d\'écran et réglages sont gardés.'
    : 'Supprimer le modpack installé ET tes mondes, captures d\'écran et réglages ? Ce ne peut pas être annulé.';
  if (!confirm(question)) return;
  try {
    await window.launcher.deleteModpack({ keepPersonal });
    $('settings').close();
    state.installed = false;
    showInfo('Modpack supprimé. Clique sur INSTALLER pour le réinstaller.');
    await loadPack();
  } catch (err) {
    showError(cleanError(err));
  }
};
$('ram').oninput = updateRamLabel;
$('btn-settings-close').onclick = async () => {
  await window.launcher.saveSettings({
    ramMb: Number($('ram').value),
    hideOnLaunch: $('hide-on-launch').checked,
    discordStatus: $('discord-status').checked,
  });
  $('settings').close();
};

window.launcher.onStatus(({ step, text, progress, detail }) => {
  setStatus(text, progress, detail || '');
  if (state.installing) {
    if (step) updateSteps(step);
    $('install-text').textContent = text;
    $('install-detail').textContent = detail || '';
    setBar($('install-bar'), progress);
  }
});

// ---------- Developer section: Ctrl+Shift+D shows/hides it (remembered) ----------

document.addEventListener('keydown', async (event) => {
  if (!(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd')) return;
  event.preventDefault();
  state.settings.devTab = !state.settings.devTab;
  await window.launcher.saveSettings({ devTab: state.settings.devTab });
  $('btn-dev').hidden = !state.settings.devTab;
  $('server-address').hidden = !state.settings.devTab;
  if (!state.settings.devTab && $('dev').open) $('dev').close();
  showInfo(state.settings.devTab ? 'Section développeur affichée' : 'Section développeur cachée');
});

$('btn-dev').onclick = () => $('dev').showModal();
$('btn-play-offline').onclick = () => {
  $('dev').close();
  play({ noServer: true });
};
$('btn-dev-close').onclick = () => $('dev').close();

$('btn-beta-check').onclick = async () => {
  const key = $('beta-key').value.trim();
  const status = $('beta-key-status');
  status.className = 'muted-text';
  status.textContent = 'Vérification...';
  const { valid, error } = await window.launcher.betaCheckKey(key);
  status.className = `muted-text ${valid ? 'ok' : 'bad'}`;
  status.textContent = valid ? 'Clé valide. Tu peux activer les mises à jour bêta.' : error || 'Clé invalide.';
  $('beta-enabled').disabled = !valid;
  if (!valid) $('beta-enabled').checked = false;
  await window.launcher.betaSet({ key: valid ? key : '', enabled: $('beta-enabled').checked });
};

$('beta-enabled').onchange = async () => {
  await window.launcher.betaSet({ key: $('beta-key').value.trim(), enabled: $('beta-enabled').checked });
  showInfo(
    $('beta-enabled').checked
      ? 'Bêta activée : le launcher te proposera les versions de test.'
      : 'Bêta désactivée : tu restes sur les versions publiques.',
  );
};

$('btn-check-updates').onclick = () => window.launcher.checkUpdatesNow();

window.launcher.onGameStarted(() => setStatus('Bon jeu! Minecraft est lancé.', 1));

// An admin logged this account out (✕ in the website's "Joueurs" tab).
window.launcher.onLoggedOut((message) => {
  showAccount(null);
  if (!state.busy) resetStatus(); // "Connecte-toi avec ton compte Microsoft pour jouer"
  showInfo(message);
});

// A new launcher version came out while the launcher is open: a thin info banner under the title bar.
// Hidden with ✕, a small button next to the version number stays until the restart.
window.launcher.onLauncherUpdate(({ version }) => {
  const button = $('btn-launcher-update');
  button.textContent = `v${version} disponible · Redémarrer`;
  button.title = 'Redémarre le launcher pour installer la nouvelle version';
  $('update-banner-text').textContent = `La version ${version} du launcher est disponible.`;
  $('update-banner').hidden = false;
  button.hidden = true;
  refreshButtons();
});
const restartForUpdate = () => window.launcher.checkUpdatesNow();
$('btn-launcher-update').onclick = restartForUpdate;
$('btn-update-now').onclick = restartForUpdate;
$('btn-update-later').onclick = () => {
  $('update-banner').hidden = true;
  $('btn-launcher-update').hidden = false;
};

window.launcher.onGameClosed((error) => {
  state.busy = false;
  refreshButtons();
  resetStatus();
  if (error) showError(error);
  loadPack();
});

// Check the website for changes (news, maintenance...) every 15 seconds and when the window gets focus,
// and the Minecraft server's status every 10 seconds.
setInterval(loadPack, 15000);
setInterval(checkServer, 10000);
window.addEventListener('focus', loadPack);

// ---------- Colour palettes (Paramètres > Couleurs du launcher) ----------

// accent: buttons, links, glows. accent2: the second colour (title, progress bar, background glow).
const THEMES = {
  violet: { name: 'Violet', accent: '#8b5cf6', accent2: '#fbbf24' },
  bleu: { name: 'Océan', accent: '#3b82f6', accent2: '#22d3ee' },
  vert: { name: 'Émeraude', accent: '#10b981', accent2: '#a3e635' },
  rouge: { name: 'Braise', accent: '#ef4444', accent2: '#fb923c' },
  rose: { name: 'Rose', accent: '#ec4899', accent2: '#c084fc' },
  cyan: { name: 'Glace', accent: '#06b6d4', accent2: '#e0f2fe' },
};

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// Mixes a colour with black (amount < 0) or white (amount > 0).
function shade(hex, amount) {
  const target = amount < 0 ? 0 : 255;
  const mixed = hexRgb(hex).map((c) => Math.round(c + (target - c) * Math.abs(amount)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** theme: { palette: 'violet' | 'bleu' | ... | 'custom', color: '#rrggbb' } (saved in the settings). */
function applyTheme(theme = {}) {
  const custom = theme.palette === 'custom' && /^#[0-9a-f]{6}$/i.test(theme.color || '');
  const { accent, accent2 } = custom ? { accent: theme.color, accent2: '#fbbf24' } : THEMES[theme.palette] || THEMES.violet;
  const root = document.documentElement.style;
  root.setProperty('--accent', accent);
  root.setProperty('--accent-mid', shade(accent, -0.12));
  root.setProperty('--accent-dark', shade(accent, -0.25));
  root.setProperty('--accent-rgb', hexRgb(accent).join(', '));
  root.setProperty('--accent-soft', shade(accent, 0.6));
  root.setProperty('--accent-2', accent2);
  root.setProperty('--accent-2-rgb', hexRgb(accent2).join(', '));
}

function renderThemes() {
  const current = state.settings.theme?.palette || 'violet';
  $('theme-list').replaceChildren(
    ...Object.entries(THEMES).map(([key, theme]) => {
      const button = document.createElement('button');
      button.className = `theme-swatch${key === current ? ' active' : ''}`;
      button.title = theme.name;
      const dot = document.createElement('i');
      dot.style.background = `linear-gradient(135deg, ${theme.accent} 50%, ${theme.accent2} 50%)`;
      button.append(dot, theme.name);
      button.onclick = () => setTheme({ palette: key });
      return button;
    }),
  );
  $('theme-color').value = state.settings.theme?.color || '#8b5cf6';
  $('theme-color').parentElement.classList.toggle('active', current === 'custom');
}

// Applied right away and remembered.
function setTheme(theme) {
  state.settings.theme = theme;
  applyTheme(theme);
  renderThemes();
  window.launcher.saveSettings({ theme });
}

$('theme-color').oninput = (event) => {
  state.settings.theme = { palette: 'custom', color: event.target.value };
  applyTheme(state.settings.theme);
};
$('theme-color').onchange = (event) => setTheme({ palette: 'custom', color: event.target.value });

init().catch((err) => showError(cleanError(err)));
