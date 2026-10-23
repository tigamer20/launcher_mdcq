// Update window: shows what the updater is doing (src/main/updater.js), like Discord's updater.
const $ = (id) => document.getElementById(id);

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
}

function formatTime(seconds) {
  if (seconds == null || !isFinite(seconds)) return 'calcul du temps restant...';
  if (seconds < 1) return "moins d'une seconde restante";
  if (seconds < 60) return `${Math.ceil(seconds)} s restantes`;
  return `${Math.floor(seconds / 60)} min ${Math.ceil(seconds % 60)} s restantes`;
}

const channelLabel = (channel) => (channel === 'beta' ? 'bêta' : 'officielle');

window.updater.onState((state) => {
  $('footer').textContent = state.current ? `Version actuelle : ${state.current}` : $('footer').textContent;
  $('beta-choice').hidden = state.phase !== 'beta-available';
  $('progress-box').hidden = !['preparing', 'downloading', 'installing'].includes(state.phase);
  $('logo').classList.toggle('spin', ['checking', 'restarting'].includes(state.phase));

  switch (state.phase) {
    case 'checking':
      $('title').textContent = 'Recherche de mises à jour';
      $('subtitle').textContent = 'Connexion à GitHub...';
      break;
    case 'beta-available':
      $('title').textContent = `Bêta ${state.version} disponible`;
      $('subtitle').textContent = 'Une nouvelle version bêta est sortie. Tu peux la tester ou rester sur la version publique.';
      break;
    case 'preparing':
      $('title').textContent = `Mise à jour ${state.version}`;
      $('subtitle').textContent = 'Préparation...';
      $('bar').classList.add('indeterminate');
      break;
    case 'downloading': {
      const pct = state.bytesTotal ? (state.bytesDone / state.bytesTotal) * 100 : 0;
      $('title').textContent = `Mise à jour ${channelLabel(state.channel)} ${state.version}`;
      $('subtitle').textContent = state.fullInstaller
        ? 'Téléchargement de la nouvelle version complète'
        : 'Téléchargement des fichiers modifiés';
      $('bar').classList.remove('indeterminate');
      $('bar').style.width = `${pct}%`;
      $('bytes').textContent = `${formatBytes(state.bytesDone)} / ${formatBytes(state.bytesTotal)}`;
      $('percent').textContent = `${Math.floor(pct)} %`;
      $('speed').textContent = `${formatBytes(state.speed)}/s`;
      $('eta').textContent = formatTime(state.eta);
      $('files').textContent = state.fullInstaller
        ? ''
        : `${state.filesChanged} fichier(s) modifié(s) sur ${state.filesTotal}`;
      break;
    }
    case 'installing':
      $('title').textContent = `Installation de la version ${state.version}`;
      $('subtitle').textContent = 'Vérification des fichiers...';
      $('bar').classList.remove('indeterminate');
      $('bar').style.width = '100%';
      $('eta').textContent = '';
      $('speed').textContent = '';
      break;
    case 'restarting':
      $('title').textContent = 'Redémarrage';
      $('subtitle').textContent = `Lancement de la version ${state.version}...`;
      break;
    case 'error':
      $('title').textContent = 'Mise à jour impossible';
      $('subtitle').textContent = `${state.message} Le launcher démarre sur la version actuelle.`;
      break;
    default:
      break;
  }
});

$('btn-beta').onclick = () => window.updater.choose('beta');
$('btn-public').onclick = () => window.updater.choose('public');
