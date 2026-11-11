#!/usr/bin/env node
// Used by the GitHub Action: finds "[off_update] [1.2.0]" (official) or "[dev_update] [1.2.0]" (dev)
// in the pushed commit messages, checks the version, and gives it to the next steps.
// Official -> release v1.2.0 that every launcher installs. Dev -> pre-release v1.2.0-dev that launchers ignore.
//
// Release name: versions are called "v1.0.0 - Sweet Minecraft Treat". The name only changes when a release commit
// contains [name: New Name]; otherwise the latest release's name is kept (LATEST_NAME, its GitHub title), and
// package.json "releaseName" is the first one.
const fs = require('fs');
const path = require('path');

const MARKER = /\[(off|dev)_update\]/i;
const NAME = /\[\s*(?:name|nom)\s*:\s*([^\]]{1,60})\]/i;
const VERSION = /\[(off|dev)_update\]\s*\[?\s*v?(\d+\.\d+\.\d+)\s*\]?/i;

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
let channel = process.env.MANUAL_CHANNEL === 'dev' ? 'dev' : 'off';
let notes = 'Mise à jour du launcher.';
let newName = process.env.MANUAL_NAME?.trim() || null;
if (!version) {
  const commits = JSON.parse(process.env.COMMITS_JSON || '[]');
  const commit = [...commits].reverse().find((c) => MARKER.test(c.message));
  if (!commit) fail('Aucun commit avec [off_update] ou [dev_update] trouvé.');
  const match = VERSION.exec(commit.message);
  if (!match) fail(`Version manquante. Écris par exemple: [off_update] [1.2.0] (commit: "${commit.message.split('\n')[0]}")`);
  channel = match[1].toLowerCase();
  version = match[2];
  newName = NAME.exec(commit.message)?.[1].trim() || null;
  notes = commit.message.replace(VERSION, '').replace(NAME, '').trim() || notes;
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Version invalide: "${version}". Format attendu: 1.2.0`);

const latest = (process.env.LATEST_TAG || '').replace(/^v/, '');
if (latest && !isNewer(version, latest)) fail(`La version ${version} doit être plus grande que la dernière (${latest}).`);

// The name of the latest release ("v1.0.0 - Sweet Minecraft Treat" -> "Sweet Minecraft Treat"), kept unless changed.
const previousName = / - (.+)$/.exec(process.env.LATEST_NAME || '')?.[1]?.replace(/ \(dev\)$/, '').trim();
const pkgName = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).releaseName;
const releaseName = (newName || previousName || pkgName || 'ATM').replace(/[\r\n"]/g, '').trim();

const dev = channel === 'dev';
const appVersion = dev ? `${version}-dev` : version;
fs.appendFileSync(
  process.env.GITHUB_OUTPUT,
  `version=${appVersion}\ntag=v${appVersion}\nprerelease=${dev}\nname=${releaseName}\ntitle=v${appVersion} - ${releaseName}${dev ? ' (dev)' : ''}\n`,
);
fs.writeFileSync(path.join(process.env.RUNNER_TEMP || '.', 'release-notes.md'), notes);
console.log(`Nouvelle version ${dev ? 'dev' : 'officielle'} du launcher: v${appVersion} - ${releaseName}${newName ? ' (nouveau nom)' : ''} (officielle précédente: ${latest || 'aucune'})`);
