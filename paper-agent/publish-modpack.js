#!/usr/bin/env node
// Publishes the modpack from the PC where the CurseForge instance is (Windows or Mac), without the agent.
// Afterwards: admin website > Modpack tab > "Activer" on the new version.
// Needs MODPACK_DIR and GITHUB_TOKEN (see publish-modpack.example.bat).
const readline = require('readline');
const publish = require('./publish');

const formatSize = (bytes) => (bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} Go` : `${(bytes / 1024 ** 2).toFixed(1)} Mo`);

(async () => {
  if (!publish.configured()) {
    console.error('MODPACK_DIR et GITHUB_TOKEN doivent être remplis dans publish-modpack.bat.');
    process.exit(1);
  }
  const detected = publish.detectVersions();
  console.log(`Modpack : ${process.env.MODPACK_DIR}`);
  // Reads answers line by line (also works when answers are pasted all at once).
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question, fallback) => {
    process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ''} : `);
    const { value } = await lines.next();
    return String(value || '').trim() || fallback;
  };
  const version = await ask('Nouvelle version du modpack (ex. 1.0.1)');
  const minecraft = await ask('Version de Minecraft', detected.minecraft || '1.21.1');
  const neoforge = await ask('Version de NeoForge', detected.neoforge);
  rl.close();

  try {
    publish.start({ version, minecraft, neoforge });
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  let last = '';
  while (publish.status().state === 'running') {
    const job = publish.status();
    const line = `${job.step}${job.total ? ` : ${job.done} / ${job.total}` : ''}`;
    if (line !== last) process.stdout.write(`\r${line.padEnd(60)}`);
    last = line;
    await new Promise((r) => setTimeout(r, 500));
  }
  const job = publish.status();
  if (job.state === 'error') {
    console.error(`\n\nÉchec : ${job.message}`);
    process.exit(1);
  }
  const r = job.result;
  console.log(`\n\nModpack ${r.version} publié sur GitHub : ${r.files} fichiers, ${formatSize(r.size)} (${formatSize(r.uploadedBytes)} envoyés).`);
  console.log(`Dernière étape : site admin > onglet Modpack > "Activer" sur la version ${r.version}.`);
})();
