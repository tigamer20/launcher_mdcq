// UI logic. Talks to the launcher through window.launcher (see src/preload.js).
const $ = (id) => document.getElementById(id);

const state = { account: null, packReady: false, maintenance: false, busy: false, settings: {} };

// ---------- Helpers ----------

function cleanError(err) {
  // Electron prefixes errors with "Error invoking remote method 'x': Error: "
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let toastTimer;
function showError(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 8000);
}

function setStatus(text, progress) {
  $('status-text').textContent = text;
  const bar = $('progress-bar');
  bar.classList.toggle('indeterminate', progress == null);
  bar.style.width = progress == null ? '' : `${Math.round(progress * 100)}%`;
}

function resetStatus(text = 'Prêt à jouer') {
  setStatus(text, 0);
}

function refreshButtons() {
  $('btn-play').disabled = state.busy || !state.account || !state.packReady || state.maintenance;
  $('btn-play').textContent = state.busy ? '...' : state.maintenance ? 'MAINTENANCE' : 'JOUER';
  $('btn-login').disabled = state.busy;
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
  $('pack-name').textContent = pack.name || 'ModdedQC';
  $('pack-subtitle').textContent = pack.subtitle || '';
  $('pack-version').textContent = `Minecraft ${pack.minecraft}`;
  $('server-address').textContent = pack.server?.host || '';
  $('server-line').hidden = !pack.server?.host;
  const status = pack.serverStatus;
  $('server-line').classList.toggle('offline', !status?.online);
  $('server-players').textContent = status?.online
    ? `En ligne · ${status.players.online}/${status.players.max} joueurs`
    : 'Hors ligne';
  $('maintenance').hidden = !pack.maintenance;
  $('maintenance-message').textContent = pack.maintenance?.message || '';
  renderNews(pack.news);
  if (!state.busy) resetStatus(state.maintenance ? 'Le serveur est en maintenance' : 'Prêt à jouer');
  refreshButtons();
}

async function init() {
  const data = await window.launcher.init();
  $('app-version').textContent = `v${data.version}`;
  state.settings = data.settings;
  showAccount(data.account);
  await loadPack();

  // Settings dialog values
  const ram = $('ram');
  ram.max = Math.max(2048, Math.floor((data.maxRamMb - 2048) / 512) * 512);
  ram.value = Math.min(state.settings.ramMb, ram.max);
  $('hide-on-launch').checked = state.settings.hideOnLaunch;
  updateRamLabel();
  refreshButtons();

  // A newer launcher on GitHub? It downloads, installs and restarts by itself.
  window.launcher.selfUpdate().catch((err) => {
    $('self-update').hidden = true;
    state.busy = false;
    refreshButtons();
    showError(`Mise à jour du launcher impossible: ${cleanError(err)}`);
  });
}

function updateRamLabel() {
  $('ram-value').textContent = `${(Number($('ram').value) / 1024).toFixed(1)} Go`;
}

// ---------- Events ----------

$('btn-minimize').onclick = () => window.launcher.minimize();
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

$('btn-play').onclick = async () => {
  state.busy = true;
  refreshButtons();
  try {
    await window.launcher.play();
  } catch (err) {
    state.busy = false;
    refreshButtons();
    showError(cleanError(err));
    resetStatus('Erreur, réessaie');
  }
};

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

window.launcher.onStatus(({ text, progress }) => setStatus(text, progress));

window.launcher.onSelfUpdate(({ version, progress }) => {
  state.busy = true;
  refreshButtons();
  $('self-update').hidden = false;
  $('self-update-text').textContent =
    progress == null ? `Version ${version} trouvée...` : `Téléchargement de la version ${version} : ${Math.round(progress * 100)} %`;
  $('self-update-bar').classList.toggle('indeterminate', progress == null);
  $('self-update-bar').style.width = progress == null ? '' : `${Math.round(progress * 100)}%`;
});

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
