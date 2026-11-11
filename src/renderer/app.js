// UI logic. Talks to the launcher through window.launcher (see src/preload.js).
const $ = (id) => document.getElementById(id);

const state = {
  account: null,
  packReady: false,
  maintenance: false,
  busy: false,
  installing: false,
  installed: false, // INSTALLER until the modpack is installed once, then JOUER
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
  if (!state.modpackPublished) return "Le modpack n'est pas encore publié";
  if (!state.installed) return 'Clique sur INSTALLER pour télécharger le modpack';
  if (!state.account) return 'Connecte-toi avec ton compte Microsoft pour jouer';
  return 'Prêt à jouer';
}

function resetStatus(text = idleText()) {
  setStatus(text, 0);
}

function refreshButtons() {
  const button = $('btn-play');
  if (state.busy) {
    button.textContent = '...';
    button.disabled = true;
  } else if (state.maintenance) {
    button.textContent = 'MAINTENANCE';
    button.disabled = true;
  } else if (!state.installed) {
    // Installing doesn't need a Microsoft account: only playing does.
    button.textContent = 'INSTALLER';
    button.disabled = !state.packReady || !state.modpackPublished;
  } else {
    button.textContent = 'JOUER';
    button.disabled = !state.packReady || !state.account;
  }
  button.classList.toggle('install', !state.installed);
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
  $('play-offline-hint').textContent = offlineBlocker;
}

// ---------- Installation panel ----------

function showInstallPanel(visible) {
  $('install-panel').hidden = !visible;
  $('news-section').hidden = visible;
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

function renderNews(news) {
  const list = $('news-list');
  list.replaceChildren();
  if (!news.length) {
    list.innerHTML = '<p class="empty">Aucune nouvelle pour le moment.</p>';
    return;
  }
  for (const item of news) {
    const card = document.createElement('article');
    card.className = 'news-card';
    const title = document.createElement('h3');
    title.textContent = item.title;
    const date = document.createElement('time');
    date.textContent = item.date || '';
    const body = document.createElement('p');
    body.textContent = item.body || '';
    card.append(title, date, body);
    if (item.url?.startsWith('https://')) {
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.textContent = 'En savoir plus →';
      card.append(link);
    }
    list.append(card);
  }
}

// ---------- Startup ----------

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
  if (!state.installing) state.installed = pack.installed;
  $('pack-name').textContent = pack.name || 'All the Mod';
  $('pack-season').textContent = pack.season || 'Saison 3';
  $('pack-version').textContent = pack.modpack
    ? `Modpack ${pack.modpack.version} · NeoForge ${pack.modpack.neoforge}`
    : 'Modpack bientôt disponible';
  $('pack-update').hidden = !(pack.installed && pack.modpack && pack.installedVersion !== pack.modpack.version);
  // The address is only shown in the developer mode (Ctrl+Shift+D): players just click JOUER.
  const address = pack.server?.host ? (pack.server.port && pack.server.port !== 25565 ? `${pack.server.host}:${pack.server.port}` : pack.server.host) : '';
  $('server-address').textContent = address;
  $('dev-server-address').textContent = address || '-';
  $('server-address').hidden = !state.settings?.devTab;
  $('server-line').hidden = !pack.server?.host;
  const status = pack.serverStatus;
  $('server-line').classList.toggle('offline', !status?.online);
  $('server-players').textContent = status?.online
    ? `En ligne · ${status.players.online}/${status.players.max} joueurs`
    : 'Hors ligne';
  $('server-players').title = status?.online ? '' : status?.reason || '';
  $('maintenance').hidden = !pack.maintenance;
  $('maintenance-message').textContent = pack.maintenance?.message || '';
  renderNews(pack.news);
  if (!state.busy) resetStatus();
  refreshButtons();
}

async function init() {
  const data = await window.launcher.init();
  $('app-version').textContent = `v${data.version}`;
  state.settings = data.settings;
  showAccount(data.account);
  // Developer section (hidden until Ctrl+Shift+D)
  $('btn-dev').hidden = !state.settings.devTab;
  $('server-address').hidden = !state.settings.devTab;
  $('dev-version').textContent = `v${data.version}${data.version.includes('-') ? ' (bêta)' : ''}`;
  $('beta-key').value = state.settings.beta?.key || '';
  $('beta-enabled').checked = Boolean(state.settings.beta?.enabled);
  $('beta-enabled').disabled = !state.settings.beta?.key;

  await loadPack();

  // Settings dialog values
  const ram = $('ram');
  ram.max = Math.max(2048, Math.floor((data.maxRamMb - 2048) / 512) * 512);
  ram.value = Math.min(state.settings.ramMb, ram.max);
  $('hide-on-launch').checked = state.settings.hideOnLaunch;
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

$('btn-play').onclick = () => (state.installed ? play() : install());

// INSTALLER: downloads Java, NeoForge, Minecraft and the modpack, with the steps shown. Then the button becomes JOUER.
async function install() {
  state.busy = true;
  state.installing = true;
  refreshButtons();
  updateSteps('java');
  $('install-title').textContent = 'Installation du modpack';
  showInstallPanel(true);
  try {
    await window.launcher.install();
    state.installed = true;
    updateSteps('done');
    $('install-title').textContent = 'Installation terminée!';
    setBar($('install-bar'), 1);
    showInfo('Installation terminée! Tu peux maintenant jouer.');
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
$('ram').oninput = updateRamLabel;
$('btn-settings-close').onclick = async () => {
  await window.launcher.saveSettings({
    ramMb: Number($('ram').value),
    hideOnLaunch: $('hide-on-launch').checked,
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

window.launcher.onGameClosed((error) => {
  state.busy = false;
  refreshButtons();
  resetStatus();
  if (error) showError(error);
  loadPack();
});

// Check the server for changes (news, maintenance...) every 15 seconds and when the window gets focus.
setInterval(loadPack, 15000);
window.addEventListener('focus', loadPack);

init().catch((err) => showError(cleanError(err)));
