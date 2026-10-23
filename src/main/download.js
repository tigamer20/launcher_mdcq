// Small download engine: parallel downloads, SHA-1 checks, retries and progress.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PARALLEL = 8;
const RETRIES = 3;

async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// True when the file exists and matches the expected size/hash (when known).
async function isValid(file, { sha1, size } = {}) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return false;
  }
  if (size != null && stat.size !== size) return false;
  if (sha1) return (await sha1File(file)) === sha1;
  return true;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} en téléchargeant ${url}`);
  return res.json();
}

async function downloadOne(task, onBytes) {
  await fs.promises.mkdir(path.dirname(task.dest), { recursive: true });
  const tmp = task.dest + '.part';
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let received = 0;
    try {
      const res = await fetch(task.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hash = crypto.createHash('sha1');
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        onBytes(chunk.length);
      });
      await pipeline(body, fs.createWriteStream(tmp));
      if (task.sha1 && hash.digest('hex') !== task.sha1) throw new Error('somme SHA-1 invalide');
      await fs.promises.rename(tmp, task.dest);
      if (task.executable) await fs.promises.chmod(task.dest, 0o755);
      return;
    } catch (err) {
      onBytes(-received); // roll back progress for the failed attempt
      lastError = err;
    }
  }
  await fs.promises.rm(tmp, { force: true });
  throw new Error(`Échec du téléchargement de ${task.url} (${lastError.message})`);
}

/**
 * Downloads every task that is missing or outdated.
 * task = { url, dest, sha1?, size?, executable? }
 * onProgress({ done, total }) is called with byte counts.
 */
async function downloadAll(tasks, onProgress = () => {}) {
  const needed = [];
  for (const task of tasks) {
    if (!(await isValid(task.dest, task))) needed.push(task);
  }
  if (needed.length === 0) return 0;

  const total = needed.reduce((sum, t) => sum + (t.size || 0), 0);
  let done = 0;
  const report = (n) => {
    done += n;
    onProgress({ done, total: Math.max(total, done) });
  };

  const queue = [...needed];
  const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) await downloadOne(queue.shift(), report);
  });
  await Promise.all(workers);
  return needed.length;
}

module.exports = { downloadAll, fetchJson, isValid, sha1File };
