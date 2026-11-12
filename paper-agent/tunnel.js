// Cloudflare tunnel without a domain (trycloudflare.com), started by the agent itself.
//
// With CLOUDFLARE_TUNNEL=1 the agent runs "cloudflared tunnel --url http://localhost:<port>", reads the address
// Cloudflare gives (a new one every time cloudflared starts) and sends it to the admin website (WEBSITE_URL),
// signed with AGENT_SECRET. The website then uses it right away: nothing to change on Render after a restart.
const { spawn } = require('child_process');
const { signHeaders } = require('./signing');

const ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const RESTART_DELAY = 10_000; // cloudflared stopped: start it again
const REPORT_EVERY = 5 * 60_000; // send the address again regularly (the website may have restarted)

/** Sends the address to the website. Retries for a while: Render's free plan sleeps and takes ~1 min to wake up. */
async function report(website, secret, url) {
  const path = '/api/agent/url';
  const body = Buffer.from(JSON.stringify({ url }));
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(new URL(path, website), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signHeaders(secret, 'POST', path, body) },
        body,
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) return true;
      const error = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 400) {
        console.error(`Le site refuse l'adresse du tunnel : ${error}`);
        return false; // wrong secret or clock: retrying won't help
      }
      console.warn(`Envoi de l'adresse au site : ${error} (essai ${attempt}/6)`);
    } catch (err) {
      console.warn(`Envoi de l'adresse au site impossible : ${err.message} (essai ${attempt}/6)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  return false;
}

function start({ port, website, secret, command = 'cloudflared' }) {
  let current = null;
  let reporter = null;

  const run = () => {
    console.log('Tunnel Cloudflare : démarrage de cloudflared...');
    let missing = false;
    let child;
    try {
      child = spawn(command, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
    } catch (err) {
      console.error(`cloudflared introuvable (${err.message}). Installe-le : winget install --id Cloudflare.cloudflared`);
      return;
    }
    const read = (chunk) => {
      const found = ADDRESS.exec(String(chunk));
      if (!found || found[0] === current) return;
      current = found[0];
      console.log(`Tunnel Cloudflare : ${current}`);
      report(website, secret, current).then((ok) => ok && console.log('Adresse envoyée au site admin.'));
      clearInterval(reporter);
      reporter = setInterval(() => report(website, secret, current), REPORT_EVERY);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read); // cloudflared writes its logs (and the address) on stderr
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        missing = true;
        console.error('cloudflared introuvable. Installe-le (winget install --id Cloudflare.cloudflared) puis relance l\'agent.');
      } else {
        console.error(`cloudflared : ${err.message}`);
      }
    });
    child.on('close', (code) => {
      if (missing || (code === null && child.killed)) return;
      clearInterval(reporter);
      current = null;
      console.warn(`cloudflared s'est arrêté (code ${code}) : nouveau tunnel dans ${RESTART_DELAY / 1000} s.`);
      setTimeout(run, RESTART_DELAY);
    });
    process.once('exit', () => child.kill());
  };
  run();
}

module.exports = { start, report };
