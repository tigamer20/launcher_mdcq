// Permanent storage for the website's data (pack.json = address, news, maintenance... and the player files),
// kept in the "admin-data" branch of the GitHub repository. Needed on Render's free plan, which erases
// the website's files on every restart: at startup everything is restored from GitHub, and every change
// is saved there right away. Uses the same GITHUB_TOKEN as the server file editor.
const fs = require('fs');
const path = require('path');
const github = require('./github');

const BRANCH = 'admin-data';
const FOLDER = 'data'; // inside the branch: data/pack.json, data/files/...
const MAX_FILE = 95 * 1024 * 1024; // GitHub refuses files over 100 MB

const shas = new Map(); // relative path -> blob sha on GitHub (needed to update/delete a file)
const repoPath = (relative) => `${FOLDER}/${relative}`.split('/').map(encodeURIComponent).join('/');

// GitHub refuses two changes to the same branch at the same time: save one after the other.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Restores the data from GitHub into dataDir (GitHub wins over local files).
 * If the branch doesn't exist yet, creates it with the local data. Returns 'restored' or 'created'.
 */
async function restore(dataDir) {
  const ref = await github.gh('GET', `/git/ref/heads/${BRANCH}`);
  if (!ref) {
    await createBranch(dataDir);
    return 'created';
  }
  const commit = await github.gh('GET', `/git/commits/${ref.object.sha}`);
  const tree = await github.gh('GET', `/git/trees/${commit.tree.sha}?recursive=1`);
  const root = path.resolve(dataDir);

  fs.rmSync(path.join(root, 'files'), { recursive: true, force: true });
  for (const item of tree.tree) {
    if (item.type !== 'blob' || !item.path.startsWith(`${FOLDER}/`)) continue;
    const relative = item.path.slice(FOLDER.length + 1);
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) continue;
    const blob = await github.gh('GET', `/git/blobs/${item.sha}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(blob.content, 'base64'));
    shas.set(relative, item.sha);
  }
  return 'restored';
}

// First start: a new branch that only contains the data (no code), with what's on disk now.
async function createBranch(dataDir) {
  const entries = [];
  for (const full of walk(dataDir)) {
    const relative = path.relative(dataDir, full).split(path.sep).join('/');
    if (relative === 'manifest.json' || relative.startsWith('.')) continue; // manifest.json is rebuilt
    const blob = await github.gh('POST', '/git/blobs', { content: fs.readFileSync(full).toString('base64'), encoding: 'base64' });
    entries.push({ path: `${FOLDER}/${relative}`, mode: '100644', type: 'blob', sha: blob.sha });
    shas.set(relative, blob.sha);
  }
  const tree = await github.gh('POST', '/git/trees', { tree: entries });
  const commit = await github.gh('POST', '/git/commits', { message: 'Données du site admin', tree: tree.sha, parents: [] });
  await github.gh('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
}

/** Saves one data file (e.g. "pack.json" or "files/resourcepacks/pack.zip") on GitHub. */
function saveFile(relative, buffer) {
  if (buffer.length > MAX_FILE) return Promise.reject(new Error('fichier trop gros pour GitHub (95 Mo max)'));
  return enqueue(async () => {
    const body = { message: `Site admin : ${relative}`, content: buffer.toString('base64'), branch: BRANCH };
    if (shas.has(relative)) body.sha = shas.get(relative);
    let result;
    try {
      result = await github.gh('PUT', `/contents/${repoPath(relative)}`, body);
    } catch {
      // Our copy of the file's sha was out of date: ask GitHub for the current one and retry once.
      const current = await github.gh('GET', `/contents/${repoPath(relative)}?ref=${BRANCH}`);
      if (current?.sha) body.sha = current.sha;
      else delete body.sha;
      result = await github.gh('PUT', `/contents/${repoPath(relative)}`, body);
    }
    shas.set(relative, result.content.sha);
  });
}

/** Deletes one data file on GitHub. */
function deleteFile(relative) {
  return enqueue(async () => {
    let sha = shas.get(relative);
    if (!sha) sha = (await github.gh('GET', `/contents/${repoPath(relative)}?ref=${BRANCH}`))?.sha;
    if (!sha) return;
    await github.gh('DELETE', `/contents/${repoPath(relative)}`, { message: `Site admin : suppression de ${relative}`, sha, branch: BRANCH });
    shas.delete(relative);
  });
}

module.exports = { configured: github.configured, restore, saveFile, deleteFile, BRANCH };
