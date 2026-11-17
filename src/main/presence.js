// Tells the admin website that a player logged in or launched the game (the "Joueurs" tab).
// Like a Minecraft server, the website checks the player with Mojang: the launcher "joins" a random session id
// with the player's Minecraft token at Mojang, then sends only the name and that id. The token stays here.
// Never blocks or breaks the launcher: any error is ignored.
const crypto = require('crypto');

const SESSION_SERVER = 'https://sessionserver.mojang.com';

// "Joins" a random session id at Mojang with the player's token: the website can then check who the player is.
async function joinSession(account) {
  const serverId = crypto.randomBytes(20).toString('hex');
  const joined = await fetch(`${SESSION_SERVER}/session/minecraft/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: account.accessToken, selectedProfile: account.uuid, serverId }),
    signal: AbortSignal.timeout(8000),
  });
  return joined.ok ? serverId : null;
}

async function report(serverUrl, account, event, version) {
  try {
    if (!serverUrl || !account?.accessToken) return;
    const serverId = await joinSession(account);
    if (!serverId) return;
    await fetch(new URL('api/players/seen', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: account.name, serverId, event, version }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // the website is asleep or offline: not important
  }
}

/**
 * Asks the website whether an admin logged this account out (✕ in the "Joueurs" tab) since it logged in.
 * Any error (website asleep, offline...) answers false: never logs a player out by mistake.
 */
async function loggedOut(serverUrl, account) {
  try {
    if (!serverUrl || !account?.uuid) return false;
    const res = await fetch(new URL('api/players/session', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: account.uuid, since: account.loginAt || 0 }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok && (await res.json()).loggedOut === true;
  } catch {
    return false;
  }
}

/** Sends a photo for the carousel. The website keeps it until an admin approves or refuses it. Throws on error. */
async function submitPhoto(serverUrl, account, name, bytes) {
  const serverId = await joinSession(account).catch(() => null);
  if (!serverId) throw new Error('Vérification du compte Minecraft impossible, réessaie');
  const res = await fetch(new URL(`api/gallery/request?name=${encodeURIComponent(name)}`, serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Player-Name': account.name, 'X-Server-Id': serverId },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
}

module.exports = { report, loggedOut, submitPhoto };
