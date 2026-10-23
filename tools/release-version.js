#!/usr/bin/env node
// Used by the GitHub Action: finds "[off_update] [1.2.0]" in the pushed commit messages,
// checks the version is higher than the last release, and gives it to the next steps.
const fs = require('fs');
const path = require('path');

const MARKER = /\[off_update\]/i;
const VERSION = /\[off_update\]\s*\[?\s*v?(\d+\.\d+\.\d+)\s*\]?/i;

function isNewer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

// Manual run (Actions tab) or the last pushed commit that contains [off_update].
let version = process.env.MANUAL_VERSION?.trim().replace(/^v/, '');
let notes = 'Mise à jour du launcher.';
if (!version) {
  const commits = JSON.parse(process.env.COMMITS_JSON || '[]');
  const commit = [...commits].reverse().find((c) => MARKER.test(c.message));
  if (!commit) fail('Aucun commit avec [off_update] trouvé.');
  const match = VERSION.exec(commit.message);
  if (!match) fail(`Version manquante. Écris par exemple: [off_update] [1.2.0] (commit: "${commit.message.split('\n')[0]}")`);
  version = match[1];
  notes = commit.message.replace(VERSION, '').trim() || notes;
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Version invalide: "${version}". Format attendu: 1.2.0`);

const latest = (process.env.LATEST_TAG || '').replace(/^v/, '');
if (latest && !isNewer(version, latest)) fail(`La version ${version} doit être plus grande que la dernière (${latest}).`);

fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
fs.writeFileSync(path.join(process.env.RUNNER_TEMP || '.', 'release-notes.md'), notes);
console.log(`Nouvelle version du launcher: ${version} (précédente: ${latest || 'aucune'})`);
