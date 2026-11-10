// Turns byte counts into speed and remaining time (averaged over the last few seconds).
// Used for every download the player sees: launcher updates, Java, Minecraft, NeoForge, modpack.
function progressTracker(onProgress, info = {}) {
  const samples = [];
  return ({ done, total, filesDone, filesTotal }) => {
    const now = Date.now();
    samples.push({ now, done });
    while (samples.length > 2 && now - samples[0].now > 3000) samples.shift();
    const first = samples[0];
    const speed = now > first.now ? ((done - first.done) * 1000) / (now - first.now) : 0;
    onProgress({
      ...info,
      phase: 'downloading',
      bytesDone: done,
      bytesTotal: total,
      filesDone,
      filesTotal,
      speed,
      eta: speed > 0 ? (total - done) / speed : null,
    });
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

function formatTime(seconds) {
  if (seconds == null || !isFinite(seconds)) return 'calcul du temps restant...';
  if (seconds < 1) return "moins d'une seconde";
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${String(Math.ceil(seconds % 60)).padStart(2, '0')} s`;
}

// "85.2 Mo / 1.20 Go · 8.4 Mo/s · 2 min 10 s · 120/450 fichiers"
function describe(progress) {
  const parts = [`${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`];
  if (progress.speed) parts.push(`${formatBytes(progress.speed)}/s`);
  parts.push(formatTime(progress.eta));
  if (progress.filesTotal > 1) parts.push(`${progress.filesDone}/${progress.filesTotal} fichiers`);
  return parts.join(' · ');
}

module.exports = { progressTracker, formatBytes, formatTime, describe };
