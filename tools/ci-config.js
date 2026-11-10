#!/usr/bin/env node
// Used by the GitHub Action before building the installer:
// writes launcher.config.json from repository variables and sets the app version.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { SERVER_URL, RELEASE_VERSION, GITHUB_REPOSITORY } = process.env;

// The Azure app ID approved by Microsoft for Minecraft is kept in launcher.config.json (it is not a secret:
// every installed launcher contains it). It wins over the AZURE_CLIENT_ID variable, which is only a fallback.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const committed = JSON.parse(fs.readFileSync(path.join(root, 'launcher.config.json'), 'utf8')).azureClientId;
const AZURE_CLIENT_ID = GUID.test(committed || '') ? committed : process.env.AZURE_CLIENT_ID;
if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_ID !== AZURE_CLIENT_ID) {
  console.warn(`AZURE_CLIENT_ID (${process.env.AZURE_CLIENT_ID}) ignoré : launcher.config.json utilise ${AZURE_CLIENT_ID}.`);
}

if (!SERVER_URL || !AZURE_CLIENT_ID) {
  console.error('Ajoute les variables SERVER_URL et AZURE_CLIENT_ID dans GitHub: Settings > Secrets and variables > Actions > Variables.');
  process.exit(1);
}

// updateRepo: where installed launchers look for new versions.
fs.writeFileSync(
  path.join(root, 'launcher.config.json'),
  JSON.stringify({ serverUrl: SERVER_URL, azureClientId: AZURE_CLIENT_ID, updateRepo: GITHUB_REPOSITORY }, null, 2) + '\n',
);

// The version from "[off_update] [1.2.0]" becomes the app version (shown in the launcher and in Windows).
if (RELEASE_VERSION) {
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = RELEASE_VERSION;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`Launcher ${RELEASE_VERSION || ''} configuré pour ${SERVER_URL} (application Azure ${AZURE_CLIENT_ID})`);
