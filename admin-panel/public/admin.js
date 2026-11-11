// Admin website logic. Talks to admin-panel/server.js through /api/...
const $ = (id) => document.getElementById(id);

let pack = null;
let files = [];
let plugins = [];
let features = {};
let serverStatus = null;
let me = { name: '', owner: false, permissions: [] }; // the logged-in account
let permissionNames = {}; // permission -> label, from the server
const can = (permission) => me.permissions.includes(permission);

// ---------- Helpers ----------

async function api(method, url, body, isFile = false) {
  const res = await fetch(url, {
    method,
    headers: isFile ? { 'X-Admin': '1' } : { 'Content-Type': 'application/json', 'X-Admin': '1' },
    body: isFile ? body : body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') showLogin();
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error-toast', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- Views ----------

function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  ($('username').value ? $('password') : $('username')).focus();
}

async function showApp() {
  const state = await api('GET', '/api/state');
  ({ pack, files, plugins, features, me } = state);
  permissionNames = state.permissions;
  features.checking = features.agent; // what the server agent can do arrives a bit later (loadAgent)
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  applyPermissions();
  render();
  refreshStatus();
  loadAgent();
}

// The server agent runs on the Minecraft PC: asking it can take a few seconds, so the menu doesn't wait for it.
async function loadAgent() {
  if (!features.agent) return;
  try {
    const result = await api('GET', '/api/agent');
    features = result.features;
    plugins = result.plugins;
  } catch (err) {
    features = { ...features, checking: false, error: err.message };
  }
  render();
  // A tab opened while the agent was being checked: load what it needed now.
  const active = document.querySelector('.nav.active')?.dataset.tab;
  if (active === 'editor' || active === 'modpack') document.querySelector('.nav.active').click();
}

// Only the tabs and buttons this account is allowed to use.
function applyPermissions() {
  $('me-name').textContent = me.name;
  $('btn-my-password').hidden = me.owner;
  document.querySelectorAll('.nav[data-perm]').forEach((button) => (button.hidden = !can(button.dataset.perm)));
  $('maintenance-card').hidden = !can('maintenance');
  const active = document.querySelector('.nav.active');
  if (active?.hidden) document.querySelector('.nav[data-tab="dashboard"]').click();
}

function render() {
  renderDashboard();
  renderServerForm();
  renderPlugins();
  renderNews();
  renderFiles();
  $('agent-error').hidden = !features.error && !features.checking;
  $('agent-error').textContent = features.checking
    ? 'Connexion à l\'agent du serveur...'
    : features.error ? `Agent du serveur : ${features.error}` : '';
  applyServerType();
  $('console-off').hidden = features.rcon;
  $('console-on').hidden = !features.rcon;
  $('maintenance-rcon').hidden = !features.rcon;
  renderModpack();
  $('editor-off').hidden = features.plugins;
  $('editor-on').hidden = !features.plugins;
  $('editor-github').hidden = !features.github;
  $('btn-merge').hidden = !features.github || !can('launcher');
}

// Live server status (players, version), refreshed every 10 seconds.
async function refreshStatus() {
  if ($('app-view').hidden) return;
  serverStatus = await api('GET', '/api/status').catch(() => null);
  renderDashboard();
}
setInterval(refreshStatus, 10000);

function renderDashboard() {
  const maintenance = pack.maintenance?.enabled;
  const online = serverStatus?.online;
  $('stat-status').textContent = maintenance ? 'Maintenance' : online ? 'En ligne' : serverStatus ? 'Hors ligne' : '...';
  $('stat-status').className = maintenance ? 'status-maintenance' : online ? 'status-online' : 'status-offline';
  $('stat-players').textContent = online ? `${serverStatus.players.online} / ${serverStatus.players.max}` : '-';
  $('stat-version').textContent = online ? serverStatus.version : '-';
  $('stat-plugins').textContent = features.plugins ? String(plugins.filter((p) => p.enabled).length) : '-';
  const names = online ? serverStatus.players.list : [];
  $('players-card').hidden = names.length === 0;
  // Why it's offline + the address actually tried (helps with playit.gg ports).
  const offline = serverStatus && !online;
  $('offline-reason').hidden = !offline;
  if (offline) {
    $('offline-reason').textContent = serverStatus.reason
      ? `Hors ligne : ${serverStatus.reason}. Adresse testée : ${serverStatus.tried}.`
      : 'Hors ligne : aucune adresse de serveur dans l\'onglet Serveur.';
  }
  $('players-list').replaceChildren(...names.map((n) => el('span', { textContent: n })));
  $('maintenance-enabled').checked = Boolean(maintenance);
  $('maintenance-message').value = pack.maintenance?.message || '';
  $('maintenance-card').classList.toggle('on', Boolean(maintenance));
}

function renderServerForm() {
  const form = $('server-form');
  form.packName.value = pack.name || '';
  form.season.value = pack.season || 'Saison 3';
  form.host.value = pack.server?.host || '';
  form.port.value = pack.server?.port || 25565;
  form.versionId.value = pack.versionId || '';
  form.version.value = pack.version || '';
  form.autoConnect.checked = Boolean(pack.autoConnect);
  form.betaKey.value = '';
  form.betaKey.placeholder = pack.betaKeySet
    ? 'Une clé est active (cachée). Tape ou génère une nouvelle clé pour la remplacer.'
    : 'Aucune clé : la bêta est désactivée pour tout le monde';
  $('btn-del-beta').hidden = !pack.betaKeySet;
}

function newsItem(item = {}) {
  // New news: written by the logged-in account. Existing ones keep their author.
  const author = item.id ? item.author || 'inconnu' : me.name;
  const card = el('div', { className: 'card news-item' }, [
    el('p', { className: 'news-author muted', textContent: `Auteur : ${author}` }),
    el('input', { className: 'news-title', placeholder: 'Titre', value: item.title || '' }),
    el('input', { className: 'news-date', type: 'date', value: item.date || new Date().toISOString().slice(0, 10) }),
    el('textarea', { className: 'news-body', placeholder: 'Texte de la nouvelle', value: item.body || '' }),
    el('input', { className: 'news-url', placeholder: 'Lien (optionnel) https://...', value: item.url || '' }),
    el('div', { className: 'row end' }, [
      el('button', { className: 'danger', textContent: 'Supprimer', onclick: () => card.remove() }),
    ]),
  ]);
  card.dataset.id = item.id || '';
  return card;
}

function renderNews() {
  $('news-editor').replaceChildren(...(pack.news || []).map(newsItem));
}

function renderPlugins() {
  $('plugins-off').hidden = features.plugins;
  $('plugins-on').hidden = !features.plugins;
  const sorted = [...plugins].sort((a, b) => a.name.localeCompare(b.name));
  $('plugin-list').replaceChildren(
    ...sorted.map((p) =>
      el('tr', {}, [
        el('td', { textContent: p.name.replace(/\.disabled$/, '') }),
        el('td', { textContent: formatSize(p.size) }),
        el('td', {}, [el('span', { className: `badge ${p.enabled ? 'on' : 'off'}`, textContent: p.enabled ? 'Activé' : 'Désactivé' })]),
        el('td', {}, [
          el('button', { className: 'ghost small', textContent: p.enabled ? 'Désactiver' : 'Activer', onclick: () => togglePlugin(p.name) }),
          el('button', { className: 'danger', textContent: 'Supprimer', onclick: () => deletePlugin(p.name) }),
        ]),
      ]),
    ),
  );
}

function renderFiles() {
  const filter = $('file-filter').value.toLowerCase();
  const shown = files.filter((f) => f.path.toLowerCase().includes(filter)).sort((a, b) => a.path.localeCompare(b.path));
  $('file-summary').textContent = `${shown.length} fichier(s)`;
  $('file-list').replaceChildren(
    ...shown.map((f) =>
      el('tr', {}, [
        el('td', { textContent: f.path }),
        el('td', { textContent: formatSize(f.size) }),
        el('td', {}, [el('button', { className: 'danger', textContent: 'Supprimer', onclick: () => deleteFile(f.path) })]),
      ]),
    ),
  );
}

// ---------- Actions ----------

$('login-form').onsubmit = async (event) => {
  event.preventDefault();
  $('login-error').hidden = true;
  try {
    await api('POST', '/api/login', { username: $('username').value.trim(), password: $('password').value });
    $('password').value = '';
    await showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
};

$('btn-logout').onclick = async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
};

document.querySelectorAll('.nav').forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b === button));
    document.querySelectorAll('.tab').forEach((tab) => (tab.hidden = tab.id !== `tab-${button.dataset.tab}`));
    if (button.dataset.tab === 'players') loadPlayers();
    if (button.dataset.tab === 'accounts') loadAccounts();
    if (button.dataset.tab === 'modpack') {
      loadEditor();
      if (features.modpack) followPublish();
      loadGithubVersions();
    }
    if (button.dataset.tab === 'editor' && !editor.loaded && features.plugins) {
      editor.loaded = true;
      openDir('');
      refreshPending();
    }
  };
});

$('btn-maintenance').onclick = async () => {
  try {
    let warning;
    ({ pack, warning } = await api('PUT', '/api/maintenance', {
      enabled: $('maintenance-enabled').checked,
      message: $('maintenance-message').value,
    }));
    renderDashboard();
    toast(pack.maintenance.enabled ? 'Mode maintenance activé' : 'Serveur de nouveau ouvert');
    if (warning) toast(warning, true);
  } catch (err) {
    toast(err.message, true);
  }
};

$('server-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  const newBetaKey = form.betaKey.value.trim();
  try {
    ({ pack } = await api('PUT', '/api/pack', {
      name: form.packName.value,
      season: form.season.value.trim() || 'Saison 3',
      version: form.version.value,
      versionId: form.versionId.value,
      autoConnect: form.autoConnect.checked,
      ...(newBetaKey ? { betaKey: newBetaKey } : {}),
      server: { host: form.host.value, port: form.port.value },
    }));
    render();
    toast(newBetaKey ? `Enregistré. Nouvelle clé bêta : ${newBetaKey} (copie-la, elle ne sera plus affichée)` : 'Informations du serveur enregistrées');
    if (newBetaKey) form.betaKey.value = newBetaKey; // still visible until the page is reloaded
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-add-news').onclick = () => $('news-editor').prepend(newsItem());

$('btn-save-news').onclick = async () => {
  const news = [...document.querySelectorAll('.news-item')].map((card) => ({
    id: card.dataset.id || undefined,
    title: card.querySelector('.news-title').value,
    date: card.querySelector('.news-date').value,
    body: card.querySelector('.news-body').value,
    url: card.querySelector('.news-url').value,
  }));
  try {
    ({ pack } = await api('PUT', '/api/news', { news }));
    renderNews(); // the new news now have their id and author
    toast('Nouvelles publiées');
  } catch (err) {
    toast(err.message, true);
  }
};

async function uploadFiles(list) {
  const dir = $('upload-dir').value.trim().replace(/^\/+|\/+$/g, '');
  const progress = $('upload-progress');
  progress.hidden = false;
  try {
    for (const [i, file] of [...list].entries()) {
      progress.textContent = `Envoi ${i + 1}/${list.length}: ${file.name}...`;
      const target = dir ? `${dir}/${file.name}` : file.name;
      ({ pack, files } = await api('PUT', `/api/files?path=${encodeURIComponent(target)}`, file, true));
    }
    render();
    toast(`${list.length} fichier(s) ajouté(s) · version ${pack.version}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    progress.hidden = true;
    $('file-input').value = '';
  }
}

async function deleteFile(filePath) {
  if (!confirm(`Supprimer ${filePath}? Il sera aussi retiré chez les joueurs.`)) return;
  try {
    ({ pack, files } = await api('DELETE', `/api/files?path=${encodeURIComponent(filePath)}`));
    render();
    toast(`Fichier supprimé · version ${pack.version}`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Server mods (NeoForge) or plugins (Paper) ----------

const isPaper = () => features.serverType === 'paper';
const addonWord = (n = 1) => (isPaper() ? 'plugin' : 'mod') + (n > 1 ? 's' : '');

// The agent says which server it manages: the website talks about mods (NeoForge) or plugins (Paper).
function applyServerType() {
  const paper = isPaper();
  $('nav-addons').textContent = paper ? 'Plugins' : 'Mods du serveur';
  $('addons-title').textContent = paper ? 'Plugins' : 'Mods du serveur';
  $('stat-addons-label').textContent = paper ? 'Plugins actifs' : 'Mods du serveur';
  $('addons-column').textContent = paper ? 'Plugin' : 'Mod';
  $('addons-drop').textContent = paper ? 'Glisse un plugin (.jar) ici' : 'Glisse un mod (.jar) ici';
  $('addons-drop-hint').textContent = `ou clique pour choisir · un ${addonWord()} existant avec le même nom est remplacé (mise à jour)`;
  if (paper) $('addons-notice').textContent = 'Les changements de plugins s\'appliquent au prochain redémarrage du serveur Paper.';
  $('quick-plugins').hidden = !paper;
  $('quick-tps').dataset.cmd = paper ? 'tps' : 'neoforge tps';
}

async function uploadPlugins(list) {
  try {
    for (const file of list) {
      if (!file.name.endsWith('.jar')) throw new Error(`${file.name} n'est pas un fichier .jar`);
      ({ plugins } = await api('PUT', `/api/plugins?name=${encodeURIComponent(file.name)}`, file, true));
    }
    renderPlugins();
    renderDashboard();
    toast(`${list.length} ${addonWord(list.length)} installé(s) · redémarre le serveur pour les charger`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('plugin-input').value = '';
  }
}

async function togglePlugin(name) {
  try {
    ({ plugins } = await api('POST', '/api/plugins/toggle', { name }));
    renderPlugins();
    renderDashboard();
    toast(name.endsWith('.disabled') ? 'Activé · redémarre le serveur' : 'Désactivé · redémarre le serveur');
  } catch (err) {
    toast(err.message, true);
  }
}

async function deletePlugin(name) {
  if (!confirm(`Supprimer ${name} du serveur ?`)) return;
  try {
    ({ plugins } = await api('DELETE', `/api/plugins?name=${encodeURIComponent(name)}`));
    renderPlugins();
    renderDashboard();
    toast('Supprimé · redémarre le serveur');
  } catch (err) {
    toast(err.message, true);
  }
}

$('plugin-input').onchange = (event) => uploadPlugins([...event.target.files]);
setupDropZone($('plugin-drop'), (list) => uploadPlugins([...list]));

// A random beta key that's easy to share: e.g. "QC-7F3K-9P2M-X4TB"
$('btn-del-beta').onclick = async () => {
  if (!confirm('Supprimer la clé bêta? Plus personne ne recevra les versions dev.')) return;
  try {
    ({ pack } = await api('PUT', '/api/pack', { betaKey: null }));
    render();
    toast('Clé bêta supprimée');
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-gen-beta').onclick = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = crypto.getRandomValues(new Uint8Array(12));
  const part = (from) => [...random.slice(from, from + 4)].map((n) => chars[n % chars.length]).join('');
  $('server-form').betaKey.value = `QC-${part(0)}-${part(4)}-${part(8)}`;
};

// ---------- Modpack ----------

function renderModpack() {
  const mp = pack.modpack;
  $('modpack-current').replaceChildren(
    el('span', { className: 'muted', textContent: 'Version publiée' }),
    mp
      ? el('div', { className: 'modpack-facts' }, [
          el('div', {}, [el('strong', { textContent: mp.version }), el('span', { className: 'muted', textContent: 'Modpack' })]),
          el('div', {}, [el('strong', { textContent: mp.minecraft }), el('span', { className: 'muted', textContent: 'Minecraft' })]),
          el('div', {}, [el('strong', { textContent: mp.neoforge }), el('span', { className: 'muted', textContent: 'NeoForge' })]),
          el('div', {}, [
            el('strong', { textContent: `${mp.files} · ${formatSize(mp.size)}` }),
            el('span', { className: 'muted', textContent: 'Fichiers' }),
          ]),
        ])
      : el('p', { textContent: "Aucun modpack publié : les launchers affichent « Le modpack n'est pas encore publié »." }),
  );
  // Hide / show / remove the active modpack
  if (mp) {
    $('modpack-current').append(
      el('div', { className: 'row wrap modpack-actions' }, [
        pack.modpackHidden
          ? el('span', { className: 'badge warn', textContent: 'Masqué : les joueurs ne le voient pas' })
          : el('span', { className: 'badge on', textContent: 'Visible par les joueurs' }),
        el('button', {
          className: 'ghost',
          textContent: pack.modpackHidden ? 'Afficher aux joueurs' : 'Masquer aux joueurs',
          onclick: () => setModpackVisibility(!pack.modpackHidden),
        }),
        el('button', { className: 'danger', textContent: 'Retirer le modpack', onclick: removeModpack }),
      ]),
    );
  }
  const form = $('modpack-form');
  $('modpack-off').hidden = Boolean(features.modpack);
  form.hidden = !features.modpack;
  if (mp && !form.neoforge.value) form.neoforge.value = mp.neoforge;
  if (mp && form.minecraft.value === '1.21.1') form.minecraft.value = mp.minecraft;
}

// Versions on GitHub (published from the server's PC or with publish-modpack.bat on another PC)
async function loadGithubVersions() {
  if (!features.github) return;
  try {
    const { versions, active } = await api('GET', '/api/modpack/github');
    $('modpack-github').hidden = versions.length === 0;
    $('modpack-versions').replaceChildren(
      ...versions.map((v) =>
        el('tr', {}, [
          el('td', { textContent: `Modpack ${v.version}` }),
          el('td', { textContent: `NeoForge ${v.neoforge} · ${v.files} fichiers · ${formatSize(v.size)}` }),
          el('td', {}, [
            ...(v.manifestUrl === active
              ? [el('span', { className: 'badge on', textContent: 'Active' })]
              : [
                  el('button', { className: 'primary', textContent: 'Activer', onclick: () => activateVersion(v) }),
                  el('button', { className: 'danger', textContent: 'Supprimer', onclick: () => deleteVersion(v) }),
                ]),
          ]),
        ]),
      ),
    );
  } catch (err) {
    toast(err.message, true);
  }
}

async function setModpackVisibility(visible) {
  const question = visible
    ? 'Afficher le modpack ? Les joueurs pourront de nouveau installer et jouer.'
    : "Masquer le modpack ? Les launchers afficheront qu'il n'est pas disponible et ne pourront plus installer ni jouer, jusqu'à ce que tu l'affiches de nouveau.";
  if (!confirm(question)) return;
  try {
    ({ pack } = await api('POST', '/api/modpack/visibility', { hidden: !visible }));
    renderModpack();
    toast(visible ? 'Modpack visible par les joueurs' : 'Modpack masqué');
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeModpack() {
  if (!confirm("Retirer le modpack actif ? Les launchers afficheront « pas encore publié ». Ses fichiers restent sur GitHub : « Activer » dans la liste le remet.")) return;
  try {
    ({ pack } = await api('POST', '/api/modpack/remove'));
    renderModpack();
    loadGithubVersions();
    toast('Modpack retiré');
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteVersion(v) {
  if (!confirm(`Supprimer le modpack ${v.version} de GitHub ? Il ne pourra plus être activé.`)) return;
  try {
    await api('POST', '/api/modpack/delete-version', { manifestUrl: v.manifestUrl });
    loadGithubVersions();
    toast(`Modpack ${v.version} supprimé`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function activateVersion(v) {
  if (!confirm(`Activer le modpack ${v.version}? Les joueurs l'installeront au prochain JOUER.`)) return;
  try {
    ({ modpack: pack.modpack } = await api('POST', '/api/modpack/activate', { manifestUrl: v.manifestUrl }));
    renderModpack();
    loadGithubVersions();
    toast(`Modpack ${v.version} activé`);
  } catch (err) {
    toast(err.message, true);
  }
}

let publishTimer = null;
let lastPublishState = null; // only announce the end of a publish we watched running
async function followPublish() {
  try {
    const { job, modpack } = await api('GET', '/api/modpack/status');
    const justFinished = lastPublishState === 'running' && job.state !== 'running';
    lastPublishState = job.state;
    $('publish-progress').hidden = job.state === 'idle';
    $('publish-step').textContent =
      job.state === 'error' ? `Échec : ${job.message}` : job.state === 'done' ? `Modpack ${job.result.version} publié!` : `${job.step}...`;
    $('publish-detail').textContent = job.total ? `${job.done} / ${job.total}` : '';
    $('publish-bar').style.width = job.state === 'done' ? '100%' : job.total ? `${(job.done / job.total) * 100}%` : '5%';
    $('btn-publish').disabled = job.state === 'running';
    if (job.state === 'running') {
      publishTimer = setTimeout(followPublish, 1500);
    } else if (job.state === 'done' && modpack) {
      pack.modpack = modpack;
      renderModpack();
      if (justFinished) toast(`Modpack ${modpack.version} publié : les joueurs l'auront au prochain JOUER`);
      if (justFinished) loadGithubVersions();
    } else if (job.state === 'error' && justFinished) {
      toast(job.message, true);
    }
  } catch (err) {
    toast(err.message, true);
    $('btn-publish').disabled = false;
  }
}

$('modpack-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    clearTimeout(publishTimer);
    await api('POST', '/api/modpack/publish', {
      version: form.version.value.trim(),
      minecraft: form.minecraft.value.trim(),
      neoforge: form.neoforge.value.trim(),
    });
    followPublish();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- Server file editor ----------

const editor = { loaded: false, dir: '', file: null, original: '' };
const isDirty = () => editor.file !== null && $('editor').value !== editor.original;

function confirmDiscard() {
  return !isDirty() || confirm('Tu as des modifications non enregistrées. Les abandonner?');
}

function renderBreadcrumb() {
  const parts = editor.dir ? editor.dir.split('/') : [];
  const crumbs = [el('button', { textContent: 'serveur', onclick: () => openDir('') })];
  parts.forEach((part, i) => {
    crumbs.push(el('span', { className: 'muted', textContent: '/' }));
    crumbs.push(el('button', { textContent: part, onclick: () => openDir(parts.slice(0, i + 1).join('/')) }));
  });
  $('breadcrumb').replaceChildren(...crumbs);
}

async function openDir(dir) {
  try {
    const { entries } = await api('GET', `/api/server-files?dir=${encodeURIComponent(dir)}`);
    editor.dir = dir;
    renderBreadcrumb();
    const join = (name) => (dir ? `${dir}/${name}` : name);
    const items = [];
    if (dir) items.push(el('li', {}, [el('button', { textContent: '⬑ ..', onclick: () => openDir(dir.split('/').slice(0, -1).join('/')) })]));
    for (const entry of entries) {
      const full = join(entry.name);
      const button = entry.type === 'dir'
        ? el('button', { textContent: `📁 ${entry.name}`, onclick: () => openDir(full) })
        : el('button', {
            textContent: `📄 ${entry.name}`,
            title: entry.editable ? full : 'Ce type de fichier ne peut pas être modifié ici',
            disabled: !entry.editable,
            className: full === editor.file ? 'active' : '',
            onclick: () => openFile(full),
          });
      items.push(el('li', {}, [button]));
    }
    $('dir-list').replaceChildren(...items);
  } catch (err) {
    toast(err.message, true);
  }
}

async function openFile(filePath) {
  if (!confirmDiscard()) return;
  try {
    const { content } = await api('GET', `/api/server-file?path=${encodeURIComponent(filePath)}`);
    editor.file = filePath;
    editor.original = content;
    $('editor').value = content;
    $('editor').disabled = false;
    $('btn-save-file').disabled = false;
    $('editor-path').textContent = filePath;
    $('editor-status').textContent = '';
    document.querySelectorAll('.dir-list button').forEach((b) => b.classList.toggle('active', b.title === filePath));
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveFile() {
  if (editor.file === null) return;
  const content = $('editor').value;
  $('btn-save-file').disabled = true;
  try {
    const result = await api('PUT', `/api/server-file?path=${encodeURIComponent(editor.file)}`, content, true);
    editor.original = content;
    $('editor-status').textContent = `Enregistré à ${new Date().toLocaleTimeString('fr-CA')}`;
    if (result.warning) toast(result.warning, true);
    else toast('Enregistré sur le serveur + commit sur admin-website');
    refreshPending();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('btn-save-file').disabled = false;
  }
}

async function refreshPending() {
  if (!features.github || !can('launcher')) return;
  try {
    const { pending } = await api('GET', '/api/versions');
    $('pending-count').textContent = pending ? `${pending} modification(s) en attente de fusion.` : 'Aucune modification en attente.';
  } catch {
    $('pending-count').textContent = '';
  }
}

$('btn-save-file').onclick = saveFile;
$('editor').oninput = () => {
  $('editor-status').textContent = isDirty() ? 'Modifications non enregistrées' : '';
};
$('editor').onkeydown = (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    saveFile();
  } else if (event.key === 'Tab') {
    // Tab inserts spaces instead of leaving the editor (YAML doesn't allow tab characters).
    event.preventDefault();
    event.target.setRangeText('  ', event.target.selectionStart, event.target.selectionEnd, 'end');
  }
};
window.addEventListener('beforeunload', (event) => {
  if (isDirty()) event.preventDefault();
});

// ---------- Merge into main ----------

$('btn-merge').onclick = async () => {
  try {
    const { official, officialName, dev, pending } = await api('GET', '/api/versions');
    $('current-official').textContent = official ? `${official}${officialName ? ` - ${officialName}` : ''}` : 'aucune';
    $('merge-name').value = '';
    $('merge-name-hint').textContent = officialName
      ? `Vide : la nouvelle version garde le nom « ${officialName} ».`
      : 'Vide : la nouvelle version garde le nom actuel.';
    $('current-dev').textContent = dev || 'aucune';
    $('merge-pending').textContent = pending
      ? `${pending} modification(s) de la branche admin-website seront fusionnées dans main.`
      : 'Aucune modification en attente : enregistre un fichier d\'abord.';
    $('btn-merge-confirm').disabled = !pending;
    $('merge-error').hidden = true;
    $('merge-version').value = '';
    $('merge-dialog').showModal();
    $('merge-version').focus();
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-merge-cancel').onclick = () => $('merge-dialog').close();

$('merge-form').onsubmit = async (event) => {
  event.preventDefault();
  const channel = event.target.channel.value;
  $('btn-merge-confirm').disabled = true;
  $('merge-error').hidden = true;
  try {
    const { number } = await api('POST', '/api/merge', { channel, version: $('merge-version').value, name: $('merge-name').value });
    $('merge-dialog').close();
    toast(`Pull request #${number} créée et fusionnée dans main`);
    refreshPending();
  } catch (err) {
    $('merge-error').textContent = err.message;
    $('merge-error').hidden = false;
  } finally {
    $('btn-merge-confirm').disabled = false;
  }
};

// ---------- Console ----------

async function runCommand(command) {
  const out = $('console-output');
  out.append(el('div', { className: 'cmd', textContent: `> ${command}` }));
  try {
    const { output } = await api('POST', '/api/console', { command });
    out.append(el('div', { textContent: output || '(aucune réponse)' }));
  } catch (err) {
    out.append(el('div', { className: 'err', textContent: err.message }));
  }
  out.scrollTop = out.scrollHeight;
}

$('console-form').onsubmit = (event) => {
  event.preventDefault();
  const command = $('console-input').value.trim();
  if (!command) return;
  $('console-input').value = '';
  runCommand(command);
};
document.querySelectorAll('.quick').forEach((button) => (button.onclick = () => runCommand(button.dataset.cmd)));

// ---------- Player files ----------

$('file-input').onchange = (event) => uploadFiles(event.target.files);
$('file-filter').oninput = renderFiles;

function setupDropZone(zone, onFiles) {
  zone.ondragover = (event) => {
    event.preventDefault();
    zone.classList.add('dragging');
  };
  zone.ondragleave = () => zone.classList.remove('dragging');
  zone.ondrop = (event) => {
    event.preventDefault();
    zone.classList.remove('dragging');
    onFiles(event.dataTransfer.files);
  };
}
setupDropZone($('drop-zone'), uploadFiles);

// ---------- Start ----------

showApp().catch(showLogin);

// ---------- Players who logged in to the launcher ----------

const dateFormat = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeStyle: 'short' });
const when = (iso) => (iso ? dateFormat.format(new Date(iso)) : '-');

// removable: a ✕ that removes the player from the list and logs their account out of the launcher
function playerCell(name, uuid, removable = false) {
  return el('td', {}, [
    el('span', { className: 'player' }, [
      el('img', { src: `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/24`, alt: '', width: 24, height: 24 }),
      el('span', { textContent: name }),
      ...(removable
        ? [el('button', { className: 'player-remove', textContent: '✕', title: 'Déconnecter ce compte du launcher et le retirer de la liste', onclick: () => removePlayer(name, uuid) })]
        : []),
    ]),
  ]);
}

async function removePlayer(name, uuid) {
  if (!confirm(`Déconnecter ${name} du launcher et le retirer de la liste ?\nIl devra se reconnecter avec son compte Microsoft pour jouer.`)) return;
  try {
    renderPlayers(await api('POST', '/api/players/remove', { uuid }));
    toast(`${name} déconnecté du launcher`);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderPlayers(data) {
  $('players-off').hidden = data.enabled;
  const now = Date.now();
  const activeSince = (ms) => data.players.filter((p) => now - Date.parse(p.lastSeen) < ms).length;
  $('players-count').textContent = data.players.length;
  $('players-today').textContent = activeSince(24 * 3600_000);
  $('players-week').textContent = activeSince(7 * 24 * 3600_000);
  $('players-empty').hidden = data.players.length > 0;
  $('launcher-players').replaceChildren(
    ...data.players.map((p) =>
      el('tr', {}, [
        playerCell(p.name, p.uuid, true),
        el('td', { textContent: when(p.lastSeen) }),
        el('td', { textContent: when(p.lastLogin) }),
        el('td', { textContent: when(p.lastPlay) }),
        el('td', { textContent: String(p.launches) }),
        el('td', { textContent: p.launcherVersion ? `v${p.launcherVersion}` : '-' }),
      ]),
    ),
  );
  $('players-events').replaceChildren(
    ...data.events.map((e) =>
      el('tr', {}, [
        playerCell(e.name, e.uuid),
        el('td', { textContent: data.labels[e.event] || e.event }),
        el('td', { textContent: when(e.at) }),
        el('td', { textContent: e.version ? `v${e.version}` : '' }),
      ]),
    ),
  );
}

async function loadPlayers() {
  try {
    renderPlayers(await api('GET', '/api/players'));
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-players-refresh').onclick = loadPlayers;
$('btn-players-clear').onclick = async () => {
  if (!confirm("Effacer l'historique des activités ? La liste des joueurs est gardée.")) return;
  try {
    renderPlayers(await api('POST', '/api/players/clear'));
    toast('Historique effacé');
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- Modpack editor (admin-panel/modpack-editor.js) ----------

const ed = { status: null, files: [], current: null, versionMod: null, timer: null, lastJob: null };
const CHUNK = 8 * 1024 * 1024;

// Sends a file in 8 MB pieces (big exports would be refused in one request). Returns the upload id.
async function sendInPieces(file, onProgress) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK) {
    const piece = file.slice(offset, offset + CHUNK);
    await api('PUT', `/api/editor/upload?id=${id}&offset=${offset}`, piece, true);
    onProgress?.(Math.min(offset + CHUNK, file.size), file.size);
    if (file.size === 0) break;
  }
  return id;
}

function edProgress(text, done, total) {
  $('ed-progress').hidden = !text;
  $('ed-step').textContent = text || '';
  $('ed-detail').textContent = total ? `${done} / ${total}` : '';
  $('ed-bar').style.width = total ? `${Math.max(3, (done / total) * 100)}%` : '5%';
}

async function loadEditor() {
  try {
    ed.status = await api('GET', '/api/editor');
    renderEditor();
    if (ed.status.job.state === 'running') followEditorJob();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderEditor() {
  const { configured, draft, job } = ed.status;
  const setup = [];
  if (!configured.curseforge) setup.push('ajoute CURSEFORGE_API_KEY sur Render (clé gratuite sur console.curseforge.com → API Keys)');
  if (!configured.github) setup.push('ajoute GITHUB_TOKEN sur Render');
  $('ed-setup').hidden = setup.length === 0;
  $('ed-setup-text').textContent = setup.length ? `Pour utiliser l'éditeur, ${setup.join(' et ')}, puis redéploie le site.` : '';
  $('ed-import-file').disabled = setup.length > 0 || job.state === 'running';

  $('ed-main').hidden = !draft;
  if (!draft) return;
  $('ed-title').textContent = `${draft.name} · Minecraft ${draft.minecraft} · NeoForge ${draft.neoforge}`;
  $('ed-summary').textContent =
    `Importé le ${when(draft.importedAt)}${draft.publishedAt ? ` · dernière publication : ${draft.version} le ${when(draft.publishedAt)}` : ''}. ` +
    'Réimporter un export remplace la liste des mods et les configurations.';
  $('ed-import-label').textContent = 'Réimporter un export (.zip)';

  const enabled = draft.mods.filter((m) => m.enabled).length;
  $('ed-mods-count').textContent = `(${enabled})`;
  $('ed-files-count').textContent = `(${draft.files})`;
  const changes = draft.edits.length + draft.deleted.length;
  $('ed-pending').replaceChildren(
    el('strong', { textContent: draft.unpublished ? 'Changements pas encore publiés' : 'Tout est publié' }),
    el('span', {
      className: 'muted',
      textContent: draft.unpublished
        ? `${enabled} mods activés${changes ? ` · ${changes} configuration(s) modifiée(s)` : ''}. Les joueurs reçoivent les changements quand tu publies.`
        : `Version ${draft.version} : les joueurs l'installent au prochain JOUER.`,
    }),
  );
  const form = $('ed-publish-form');
  if (!form.version.value || form.dataset.from !== draft.version) {
    form.version.value = nextVersion(draft.version);
    form.dataset.from = draft.version;
  }
  $('btn-ed-publish').disabled = job.state === 'running' || draft.missing > 0;
  $('ed-missing').hidden = draft.missing === 0;
  $('ed-missing').textContent = `${draft.missing} mod(s) ne peuvent pas être téléchargés automatiquement (choix de leur auteur sur CurseForge) : clique « Téléverser » sur leur ligne et envoie le .jar (téléchargé depuis leur page CurseForge). La publication est bloquée d'ici là.`;
  renderMods();
}

// 1.0.0 -> 1.0.1 (the admin can change it)
function nextVersion(version) {
  const m = /^(.*?)(\d+)$/.exec(String(version || ''));
  return m ? `${m[1]}${Number(m[2]) + 1}` : '1.0.0';
}

function renderMods() {
  const draft = ed.status.draft;
  const filter = $('ed-mod-filter').value.trim().toLowerCase();
  const mods = draft.mods.filter((m) => !filter || `${m.name} ${m.fileName}`.toLowerCase().includes(filter));
  $('ed-mod-summary').textContent = `${mods.length} / ${draft.mods.length} mods`;
  $('ed-mod-list').replaceChildren(
    ...mods.map((m) => {
      const actions = [];
      if (m.source === 'curseforge') actions.push(el('button', { className: 'ghost', textContent: 'Version', onclick: () => chooseVersion(m) }));
      if (!m.url || m.source === 'file') actions.push(uploadButton(m.url ? 'Remplacer' : 'Téléverser', (file) => uploadJar(file, m.source === 'curseforge' ? m.id : null)));
      actions.push(el('button', { className: 'ghost', textContent: m.enabled ? 'Désactiver' : 'Activer', onclick: () => modAction('toggle', m) }));
      actions.push(el('button', { className: 'danger', textContent: 'Retirer', onclick: () => modAction('remove', m) }));
      const state = !m.url
        ? el('span', { className: 'badge warn', textContent: 'À téléverser' })
        : el('span', { className: `badge ${m.enabled ? 'on' : 'off'}`, textContent: m.enabled ? (m.source === 'file' ? 'Activé · .jar' : 'Activé') : 'Désactivé' });
      return el('tr', { className: m.enabled ? '' : 'disabled' }, [
        el('td', {}, [m.link ? el('a', { href: m.link, target: '_blank', rel: 'noopener', textContent: m.name }) : el('strong', { textContent: m.name })]),
        el('td', { textContent: m.folder === 'mods' ? m.fileName : `${m.folder}/${m.fileName}` }),
        el('td', {}, [state]),
        el('td', {}, actions),
      ]);
    }),
  );
}

function uploadButton(text, onFile) {
  const input = el('input', { type: 'file', accept: '.jar', hidden: true });
  input.onchange = () => input.files[0] && onFile(input.files[0]);
  return el('label', { className: 'ghost file-button' }, [input, el('span', { textContent: text })]);
}

async function modAction(action, mod) {
  if (action === 'remove' && !confirm(`Retirer ${mod.name} du modpack ?`)) return;
  try {
    await api('POST', `/api/editor/mods/${action}`, { id: mod.id });
    await loadEditor();
  } catch (err) {
    toast(err.message, true);
  }
}

async function uploadJar(file, id) {
  try {
    edProgress(`Envoi de ${file.name}`, 0, 0);
    const uploadId = await sendInPieces(file, (done, total) => edProgress(`Envoi de ${file.name}`, Math.round(done / 1048576), Math.round(total / 1048576)));
    edProgress(`Envoi de ${file.name} sur GitHub`, 0, 0);
    const { mod } = await api('POST', '/api/editor/mods/upload', { uploadId, fileName: file.name, id });
    toast(`${mod.name} ajouté`);
    await loadEditor();
  } catch (err) {
    toast(err.message, true);
  } finally {
    edProgress('');
  }
}

// Several .jar files: sent one after the other (never at the same time), so the website's memory stays low
// on Render's free plan (512 MB). Each file goes through the disk in 8 MB pieces, then to GitHub as a stream.
async function uploadJars(list) {
  const jars = [...list].filter((f) => /\.jar$/i.test(f.name));
  const skipped = list.length - jars.length;
  if (!jars.length) return toast('Choisis des fichiers .jar', true);
  const failed = [];
  for (const [i, file] of jars.entries()) {
    const label = `${i + 1}/${jars.length} · ${file.name}`;
    try {
      const uploadId = await sendInPieces(file, (done, total) => edProgress(`Envoi ${label}`, Math.round(done / 1048576), Math.round(total / 1048576)));
      edProgress(`Envoi sur GitHub ${label}`, i + 1, jars.length);
      await api('POST', '/api/editor/mods/upload', { uploadId, fileName: file.name });
    } catch (err) {
      failed.push(`${file.name} (${err.message})`);
    }
  }
  edProgress('');
  await loadEditor();
  const added = jars.length - failed.length;
  if (failed.length) toast(`${added} mod(s) ajouté(s), ${failed.length} en échec : ${failed.join(' · ')}`, true);
  else toast(`${added} mod(s) ajouté(s)${skipped ? ` (${skipped} fichier(s) ignoré(s) : pas des .jar)` : ''}`);
}

async function chooseVersion(mod) {
  ed.versionMod = mod;
  $('ed-version-title').textContent = mod.name;
  $('ed-version-mc').textContent = ed.status.draft.minecraft;
  const select = $('ed-version-select');
  select.replaceChildren(el('option', { textContent: 'Chargement...', disabled: true }));
  $('ed-version-dialog').showModal();
  try {
    const { versions, current } = await api('GET', `/api/editor/mods/versions?id=${encodeURIComponent(mod.id)}`);
    const types = { 1: '', 2: ' (bêta)', 3: ' (alpha)' };
    select.replaceChildren(
      ...versions.map((v) =>
        el('option', {
          value: v.fileId,
          selected: v.fileId === current,
          textContent: `${v.displayName}${types[v.releaseType] || ''} · ${new Date(v.date).toLocaleDateString('fr-CA')}${v.fileId === current ? ' · actuelle' : ''}${v.url ? '' : ' · à téléverser'}`,
        }),
      ),
    );
    if (!versions.length) select.replaceChildren(el('option', { textContent: 'Aucune version pour cette version de Minecraft', disabled: true }));
  } catch (err) {
    $('ed-version-dialog').close();
    toast(err.message, true);
  }
}

$('btn-ed-version-cancel').onclick = () => $('ed-version-dialog').close();
$('btn-ed-version-ok').onclick = async () => {
  const fileId = $('ed-version-select').value;
  if (!fileId || !ed.versionMod) return;
  try {
    const { mod } = await api('POST', '/api/editor/mods/version', { id: ed.versionMod.id, fileId: Number(fileId) });
    $('ed-version-dialog').close();
    toast(`${mod.name} : ${mod.fileName}`);
    await loadEditor();
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-ed-add').onclick = async () => {
  const input = $('ed-add-input').value.trim();
  if (!input) return;
  $('btn-ed-add').disabled = true;
  try {
    const { mod } = await api('POST', '/api/editor/mods/add', { input });
    $('ed-add-input').value = '';
    toast(`${mod.name} ajouté (${mod.fileName})`);
    await loadEditor();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('btn-ed-add').disabled = false;
  }
};

$('ed-jar-file').onchange = (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) uploadJars(files);
};
setupDropZone($('ed-mods'), (files) => uploadJars([...files]));
$('ed-mod-filter').oninput = renderMods;

// Import and publish run in the background on the website: follow them.
async function followEditorJob() {
  clearTimeout(ed.timer);
  try {
    ed.status = await api('GET', '/api/editor');
    const { job } = ed.status;
    const finished = ed.lastJob === 'running' && job.state !== 'running';
    ed.lastJob = job.state;
    if (job.state === 'running') {
      edProgress(`${job.step}...`, job.done, job.total);
      renderEditor();
      ed.timer = setTimeout(followEditorJob, 1500);
      return;
    }
    edProgress('');
    renderEditor();
    if (finished && job.state === 'error') toast(job.message, true);
    if (finished && job.state === 'done' && job.kind === 'import') {
      const r = job.result;
      toast(`Modpack importé : ${r.mods} mods, ${r.files} fichiers${r.missing ? ` (${r.missing} à téléverser)` : ''}`);
      ed.files = [];
    }
    if (finished && job.state === 'done' && job.kind === 'publish') {
      toast(`Modpack ${job.result.version} publié : les joueurs l'auront au prochain JOUER`);
      ({ pack } = await api('GET', '/api/state'));
      renderModpack();
      loadGithubVersions();
      ed.files = [];
    }
  } catch (err) {
    toast(err.message, true);
  }
}

$('ed-import-file').onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (ed.status?.draft && !confirm('Réimporter remplace la liste des mods et les configurations (les changements pas encore publiés seront perdus). Continuer ?')) return;
  try {
    const uploadId = await sendInPieces(file, (done, total) =>
      edProgress(`Envoi de ${file.name} (${formatSize(done)} / ${formatSize(total)})`, done, total),
    );
    await api('POST', '/api/editor/import', { uploadId });
    ed.lastJob = 'running';
    followEditorJob();
  } catch (err) {
    edProgress('');
    toast(err.message, true);
  }
};

$('ed-publish-form').onsubmit = async (event) => {
  event.preventDefault();
  const version = event.target.version.value.trim();
  if (!confirm(`Publier le modpack ${version} ? Tous les joueurs l'installeront au prochain JOUER.`)) return;
  try {
    await api('POST', '/api/editor/publish', { version });
    ed.lastJob = 'running';
    followEditorJob();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---- Configuration files ----

document.querySelectorAll('.ed-tab').forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll('.ed-tab').forEach((b) => b.classList.toggle('active', b === button));
    $('ed-mods').hidden = button.dataset.ed !== 'mods';
    $('ed-files').hidden = button.dataset.ed !== 'files';
    if (button.dataset.ed === 'files') loadEditorFiles();
  };
});

async function loadEditorFiles() {
  try {
    ({ files: ed.files } = await api('GET', '/api/editor/files'));
    renderEditorFiles();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderEditorFiles() {
  const filter = $('ed-file-filter').value.trim().toLowerCase();
  const shown = ed.files.filter((f) => !filter || f.path.toLowerCase().includes(filter)).slice(0, 400);
  $('ed-file-list').replaceChildren(
    ...shown.map((f) =>
      el('li', {}, [
        el('button', { className: ed.current?.path === f.path ? 'active' : '', title: f.path, onclick: () => openEditorFile(f.path) }, [
          document.createTextNode(f.path),
          ...(f.state ? [el('span', { className: 'state', textContent: f.state })] : []),
        ]),
      ]),
    ),
    ...(shown.length === 400 ? [el('li', { className: 'muted', textContent: 'Affine la recherche pour voir les autres fichiers.' })] : []),
  );
}

$('ed-file-filter').oninput = renderEditorFiles;

async function openEditorFile(filePath) {
  try {
    const file = await api('GET', `/api/editor/file?path=${encodeURIComponent(filePath)}`);
    ed.current = file;
    const info = ed.files.find((f) => f.path === filePath);
    $('ed-file-path').textContent = filePath;
    $('ed-file-content').value = file.binary ? '' : file.content;
    $('ed-file-content').disabled = Boolean(file.binary);
    $('ed-file-info').textContent = file.binary
      ? `Fichier binaire (${formatSize(file.size)}) : utilise « Téléverser » avec le même chemin pour le remplacer.`
      : info?.state ? `Modifié sur le site, pas encore publié.` : '';
    $('btn-ed-save').disabled = Boolean(file.binary);
    $('btn-ed-delete').hidden = false;
    $('btn-ed-revert').hidden = !info?.state;
    renderEditorFiles();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveEditorFile(filePath, body) {
  await api('PUT', `/api/editor/file?path=${encodeURIComponent(filePath)}`, body, true);
  await Promise.all([loadEditorFiles(), loadEditor()]);
}

$('btn-ed-save').onclick = async () => {
  if (!ed.current) return;
  try {
    await saveEditorFile(ed.current.path, new Blob([$('ed-file-content').value]));
    toast('Enregistré (sera envoyé aux joueurs à la prochaine publication)');
    openEditorFile(ed.current.path);
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-ed-delete').onclick = async () => {
  if (!ed.current || !confirm(`Supprimer ${ed.current.path} du modpack ?`)) return;
  try {
    await api('DELETE', `/api/editor/file?path=${encodeURIComponent(ed.current.path)}`);
    ed.current = null;
    $('ed-file-path').textContent = 'Choisis un fichier à gauche';
    $('ed-file-content').value = '';
    $('btn-ed-save').disabled = true;
    $('btn-ed-delete').hidden = true;
    $('btn-ed-revert').hidden = true;
    await Promise.all([loadEditorFiles(), loadEditor()]);
    toast('Supprimé (à la prochaine publication)');
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-ed-revert').onclick = async () => {
  if (!ed.current) return;
  try {
    await api('POST', '/api/editor/file/revert', { path: ed.current.path });
    await Promise.all([loadEditorFiles(), loadEditor()]);
    openEditorFile(ed.current.path).catch(() => {});
    toast('Changements annulés');
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-ed-new').onclick = async () => {
  const filePath = prompt('Chemin du nouveau fichier (ex. config/monmod-client.toml) :');
  if (!filePath) return;
  try {
    await saveEditorFile(filePath.trim(), new Blob(['']));
    openEditorFile(filePath.trim().replace(/\\/g, '/').replace(/^\/+/, ''));
  } catch (err) {
    toast(err.message, true);
  }
};

$('ed-file-upload').onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const target = prompt('Chemin dans le modpack :', ed.current ? ed.current.path : `config/${file.name}`);
  if (!target) return;
  try {
    const uploadId = await sendInPieces(file, (done, total) => edProgress(`Envoi de ${file.name}`, Math.round(done / 1024), Math.round(total / 1024)));
    edProgress(`Enregistrement de ${target}`, 0, 0);
    await api('POST', '/api/editor/file/upload', { uploadId, path: target.trim() });
    await Promise.all([loadEditorFiles(), loadEditor()]);
    toast(`${target} enregistré`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    edProgress('');
  }
};

// ---------- Accounts ----------

// Checkboxes for the permissions; the ones this account doesn't have can't be given.
function permissionBoxes(checked = []) {
  return Object.entries(permissionNames).map(([key, label]) =>
    el('label', { className: 'check' }, [
      el('input', { type: 'checkbox', value: key, checked: checked.includes(key), disabled: !can(key) }),
      ` ${label}`,
    ]),
  );
}

const checkedPermissions = (container) => [...container.querySelectorAll('input[type=checkbox]:checked')].map((b) => b.value);

function renderAccounts({ owner, accounts }) {
  $('account-form-perms').replaceChildren(...permissionBoxes());
  const ownerCard = el('div', { className: 'card account' }, [
    el('div', { className: 'row between' }, [
      el('div', {}, [el('strong', { textContent: owner }), el('span', { className: 'badge on', textContent: 'Propriétaire · tout' })]),
    ]),
  ]);
  const cards = accounts.map((account) => {
    const perms = el('div', { className: 'perm-grid' }, permissionBoxes(account.permissions));
    const self = account.name.toLowerCase() === me.name.toLowerCase();
    if (self) perms.querySelectorAll('input').forEach((box) => (box.disabled = true));
    const created = account.createdAt ? `Créé le ${new Date(account.createdAt).toLocaleDateString('fr-CA')} par ${account.createdBy}` : '';
    return el('div', { className: 'card account' }, [
      el('div', { className: 'row between' }, [
        el('div', {}, [el('strong', { textContent: account.name }), el('small', { className: 'muted', textContent: ` ${created}` })]),
        el('div', { className: 'row' }, [
          el('button', { className: 'ghost small', textContent: 'Nouveau mot de passe', onclick: () => resetAccountPassword(account.name) }),
          ...(self ? [] : [el('button', { className: 'danger', textContent: 'Supprimer', onclick: () => deleteAccount(account.name) })]),
        ]),
      ]),
      perms,
      ...(self
        ? [el('p', { className: 'muted', textContent: 'C\'est ton compte : un autre compte avec la permission « Comptes » peut changer tes permissions.' })]
        : [el('div', { className: 'row end' }, [
            el('button', { className: 'primary', textContent: 'Enregistrer les permissions', onclick: () => saveAccount(account.name, checkedPermissions(perms)) }),
          ])]),
    ]);
  });
  $('account-list').replaceChildren(ownerCard, ...cards);
}

async function loadAccounts() {
  try {
    renderAccounts(await api('GET', '/api/accounts'));
  } catch (err) {
    toast(err.message, true);
  }
}

$('account-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    renderAccounts(await api('POST', '/api/accounts', {
      name: form.name.value.trim(),
      password: form.password.value,
      permissions: checkedPermissions($('account-form-perms')),
    }));
    toast(`Compte ${form.name.value.trim()} créé`);
    form.reset();
  } catch (err) {
    toast(err.message, true);
  }
};

async function saveAccount(name, permissions) {
  try {
    renderAccounts(await api('PUT', '/api/accounts', { name, permissions }));
    toast(`Permissions de ${name} enregistrées`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function resetAccountPassword(name) {
  const password = prompt(`Nouveau mot de passe pour ${name} (8 caractères minimum) :`);
  if (!password) return;
  try {
    renderAccounts(await api('PUT', '/api/accounts', { name, password }));
    toast(`Mot de passe de ${name} changé`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteAccount(name) {
  if (!confirm(`Supprimer le compte ${name} ? Il sera déconnecté tout de suite.`)) return;
  try {
    renderAccounts(await api('DELETE', `/api/accounts?name=${encodeURIComponent(name)}`));
    toast(`Compte ${name} supprimé`);
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-my-password').onclick = async () => {
  const current = prompt('Mot de passe actuel :');
  if (!current) return;
  const password = prompt('Nouveau mot de passe (8 caractères minimum) :');
  if (!password) return;
  try {
    await api('POST', '/api/me/password', { current, password });
    toast('Mot de passe changé');
  } catch (err) {
    toast(err.message, true);
  }
};
