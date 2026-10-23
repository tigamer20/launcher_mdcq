#!/usr/bin/env node
// Used by the GitHub Action before building the installer:
// writes launcher.config.json from repository variables and sets the app version from the git tag.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { SERVER_URL, AZURE_CLIENT_ID, GITHUB_REF_NAME } = process.env;

if (!SERVER_URL || !AZURE_CLIENT_ID) {
  console.error('Ajoute les variables SERVER_URL et AZURE_CLIENT_ID dans GitHub: Settings > Secrets and variables > Actions > Variables.');
  process.exit(1);
}

fs.writeFileSync(
  path.join(root, 'launcher.config.json'),
  JSON.stringify({ serverUrl: SERVER_URL, azureClientId: AZURE_CLIENT_ID }, null, 2) + '\n',
);

// Tag "v1.2.0" -> version 1.2.0 (shown in Windows "Apps & features")
const match = /^v(\d+\.\d+\.\d+)$/.exec(GITHUB_REF_NAME || '');
if (match) {
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = match[1];
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`Launcher configuré pour ${SERVER_URL}`);
