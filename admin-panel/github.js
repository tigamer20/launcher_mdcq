// GitHub side of the server file editor: every save becomes a commit on the "admin-website" branch,
// and "Fusionner" opens a pull request into main and merges it. Uses the GitHub REST API (no dependencies).
//
// Needs GITHUB_TOKEN: a fine-grained token for this repository with
// "Contents: Read and write" and "Pull requests: Read and write".
const API = process.env.GITHUB_API || 'https://api.github.com';
const REPO = process.env.GITHUB_REPO || 'tigamer20/launcher_mdcq';
const TOKEN = process.env.GITHUB_TOKEN;
const BRANCH = 'admin-website';
const BASE = 'main';
const FOLDER = 'paper-server'; // where the Mac's server files are stored in the repository

const configured = () => Boolean(TOKEN);

async function gh(method, url, body) {
  const res = await fetch(`${API}/repos/${REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ModdedQC-Admin',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 404) return null;
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub: ${json.message || res.status}`);
  return json;
}

// ---------------------------------------------------------------------------
// Secrets never go to GitHub (the repository is public)
// ---------------------------------------------------------------------------

const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_.]?key|private[-_.]?key|webhook|credentials?)/i;

// Replaces the value of every "password-like" setting, e.g. "rcon.password=abc" -> "rcon.password=********".
// Works for .properties (key=value), YAML/TOML/conf (key: value / key = value) and JSON ("key": "value").
function redact(content) {
  let blockIndent = -1; // inside a multi-line YAML secret ("key: |" or "key: >"): hide its lines too
  return content
    .split('\n')
    .map((line) => {
      const indent = line.search(/\S/);
      if (blockIndent >= 0) {
        if (indent === -1 || indent > blockIndent) return indent === -1 ? line : `${line.slice(0, indent)}********`;
        blockIndent = -1;
      }
      const json = /^(\s*"([^"]+)"\s*:\s*)("(?:[^"\\]|\\.)*"|[^,\s}]+)(.*)$/.exec(line);
      if (json && SECRET_KEY.test(json[2]) && !/^(true|false)$/.test(json[3])) return `${json[1]}"********"${json[4]}`;
      const kv = /^(\s*-?\s*([\w.\-]+)\s*[:=]\s*)(\S.*?)(\s*)$/.exec(line);
      if (!kv || !SECRET_KEY.test(kv[2]) || /^(true|false)$/i.test(kv[3])) return line;
      if (/^[|>]/.test(kv[3])) {
        blockIndent = indent;
        return line;
      }
      return `${kv[1]}********${kv[4]}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Branch + commits
// ---------------------------------------------------------------------------

async function ensureBranch() {
  if (await gh('GET', `/git/ref/heads/${BRANCH}`)) return;
  const base = await gh('GET', `/git/ref/heads/${BASE}`);
  await gh('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: base.object.sha });
}

/** Commits one server file (secrets masked) on the admin branch. Returns the commit URL. */
async function commitServerFile(relativePath, content, author) {
  await ensureBranch();
  const repoPath = `${FOLDER}/${relativePath}`.split('/').map(encodeURIComponent).join('/');
  const existing = await gh('GET', `/contents/${repoPath}?ref=${BRANCH}`);
  const result = await gh('PUT', `/contents/${repoPath}`, {
    message: `Modifier ${relativePath} (site admin${author ? `, ${author}` : ''})`,
    content: Buffer.from(redact(content), 'utf8').toString('base64'),
    branch: BRANCH,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  });
  return result.commit.html_url;
}

// ---------------------------------------------------------------------------
// Versions + merge
// ---------------------------------------------------------------------------

const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v || '') || []).slice(1).map(Number);
function isNewer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!y.length) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Latest official and dev versions + how many saved changes wait on the admin branch. */
async function status() {
  const releases = (await gh('GET', '/releases?per_page=50')) || [];
  const official = releases.find((r) => !r.prerelease && !r.draft);
  const dev = releases.find((r) => r.prerelease && !r.draft);
  const branch = await gh('GET', `/git/ref/heads/${BRANCH}`);
  const compare = branch ? await gh('GET', `/compare/${BASE}...${BRANCH}`) : null;
  return {
    official: official ? official.tag_name.replace(/^v/, '') : null,
    dev: dev ? dev.tag_name.replace(/^v/, '') : null,
    pending: compare ? compare.ahead_by : 0,
    tags: releases.map((r) => r.tag_name),
  };
}

/**
 * Opens a pull request admin-website -> main and merges it.
 * The merge title "[off_update] [x.y.z]" or "[dev_update] [x.y.z]" starts the release workflow.
 */
async function mergeToMain(channel, version) {
  if (!['dev', 'official'].includes(channel)) throw new Error('Choisis Dev ou Officielle');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version invalide, format attendu: 1.2.0');
  const current = await status();
  if (!current.pending) throw new Error('Aucune modification à fusionner');
  if (!isNewer(version, current.official)) {
    throw new Error(`La version doit être plus grande que la version officielle actuelle (${current.official})`);
  }
  const tag = channel === 'official' ? `v${version}` : `v${version}-dev`;
  if (current.tags.includes(tag)) throw new Error(`La version ${tag} existe déjà`);

  const label = channel === 'official' ? 'Officielle' : 'Dev';
  const marker = channel === 'official' ? 'off_update' : 'dev_update';
  const pr = await gh('POST', '/pulls', {
    title: `Version ${label} ${version} : fichiers du serveur`,
    head: BRANCH,
    base: BASE,
    body: `Modifications faites depuis le site admin (${current.pending} commit(s)).\n\nVersion **${label} ${version}**.`,
  });
  await gh('PUT', `/pulls/${pr.number}/merge`, {
    merge_method: 'merge',
    commit_title: `[${marker}] [${version}] Fichiers du serveur (site admin)`,
  });
  // Start the next batch of changes from the new main.
  await gh('DELETE', `/git/refs/heads/${BRANCH}`);
  return { url: pr.html_url, number: pr.number };
}

module.exports = { configured, commitServerFile, status, mergeToMain, redact, isNewer, gh, REPO };
