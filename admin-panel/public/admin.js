// Admin website logic. Talks to admin-panel/server.js through /api/...
const $ = (id) => document.getElementById(id);

let pack = null;
let files = [];
let plugins = [];
let features = {};
let serverStatus = null;

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
  $('password').focus();
}

async function showApp() {
  const state = await api('GET', '/api/state');
  ({ pack, files, plugins, features } = state);
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  render();
  refreshStatus();
}

function render() {
  renderDashboard();
  renderServerForm();
  renderPlugins();
  renderNews();
  renderFiles();
  $('agent-error').hidden = !features.error;
  $('agent-error').textContent = features.error ? `Agent du serveur Paper : ${features.error}` : '';
  $('console-off').hidden = features.rcon;
  $('console-on').hidden = !features.rcon;
  $('maintenance-rcon').hidden = !features.rcon;
  $('editor-off').hidden = features.plugins;
  $('editor-on').hidden = !features.plugins;
  $('editor-github').hidden = !features.github;
  $('btn-merge').hidden = !features.github;
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
  $('players-list').replaceChildren(...names.map((n) => el('span', { textContent: n })));
  $('maintenance-enabled').checked = Boolean(maintenance);
  $('maintenance-message').value = pack.maintenance?.message || '';
  $('maintenance-card').classList.toggle('on', Boolean(maintenance));
}

function renderServerForm() {
  const form = $('server-form');
  form.packName.value = pack.name || '';
  form.subtitle.value = pack.subtitle || '';
  form.host.value = pack.server?.host || '';
  form.port.value = pack.server?.port || 25565;
  form.versionId.value = pack.versionId || '';
  form.version.value = pack.version || '';
  form.autoConnect.checked = Boolean(pack.autoConnect);
}

function newsItem(item = {}) {
  const card = el('div', { className: 'card news-item' }, [
    el('input', { className: 'news-title', placeholder: 'Titre', value: item.title || '' }),
    el('input', { className: 'news-date', type: 'date', value: item.date || new Date().toISOString().slice(0, 10) }),
    el('textarea', { className: 'news-body', placeholder: 'Texte de la nouvelle', value: item.body || '' }),
    el('input', { className: 'news-url', placeholder: 'Lien (optionnel) https://...', value: item.url || '' }),
    el('div', { className: 'row end' }, [
      el('button', { className: 'danger', textContent: 'Supprimer', onclick: () => card.remove() }),
    ]),
  ]);
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
    await api('POST', '/api/login', { password: $('password').value });
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
  try {
    ({ pack } = await api('PUT', '/api/pack', {
      name: form.packName.value,
      subtitle: form.subtitle.value,
      version: form.version.value,
      versionId: form.versionId.value,
      autoConnect: form.autoConnect.checked,
      server: { host: form.host.value, port: form.port.value },
    }));
    render();
    toast('Informations du serveur enregistrées');
  } catch (err) {
    toast(err.message, true);
  }
};

$('btn-add-news').onclick = () => $('news-editor').prepend(newsItem());

$('btn-save-news').onclick = async () => {
  const news = [...document.querySelectorAll('.news-item')].map((card) => ({
    title: card.querySelector('.news-title').value,
    date: card.querySelector('.news-date').value,
    body: card.querySelector('.news-body').value,
    url: card.querySelector('.news-url').value,
  }));
  try {
    ({ pack } = await api('PUT', '/api/news', { news }));
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

// ---------- Plugins ----------

async function uploadPlugins(list) {
  try {
    for (const file of list) {
      if (!file.name.endsWith('.jar')) throw new Error(`${file.name} n'est pas un plugin (.jar)`);
      ({ plugins } = await api('PUT', `/api/plugins?name=${encodeURIComponent(file.name)}`, file, true));
    }
    renderPlugins();
    renderDashboard();
    toast(`${list.length} plugin(s) installé(s) · redémarre le serveur pour les charger`);
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
    toast(name.endsWith('.disabled') ? 'Plugin activé' : 'Plugin désactivé');
  } catch (err) {
    toast(err.message, true);
  }
}

async function deletePlugin(name) {
  if (!confirm(`Supprimer le plugin ${name}?`)) return;
  try {
    ({ plugins } = await api('DELETE', `/api/plugins?name=${encodeURIComponent(name)}`));
    renderPlugins();
    renderDashboard();
    toast('Plugin supprimé');
  } catch (err) {
    toast(err.message, true);
  }
}

$('plugin-input').onchange = (event) => uploadPlugins([...event.target.files]);
setupDropZone($('plugin-drop'), (list) => uploadPlugins([...list]));

// ---------- Server file editor ----------

const editor = { loaded: false, dir: '', file: null, original: '' };
const isDirty = () => editor.file !== null && $('editor').value !== editor.original;

function confirmDiscard() {
  return !isDirty() || confirm('Tu as des modifications non enregistrées. Les abandonner?');
}

function renderBreadcrumb() {
  const parts = editor.dir ? editor.dir.split('/') : [];
  const crumbs = [el('button', { textContent: 'paper', onclick: () => openDir('') })];
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
  if (!features.github) return;
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
    const { official, dev, pending } = await api('GET', '/api/versions');
    $('current-official').textContent = official || 'aucune';
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
    const { number } = await api('POST', '/api/merge', { channel, version: $('merge-version').value });
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
