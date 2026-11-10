// Tells the admin website that a player logged in or launched the game (the "Joueurs" tab).
// Like a Minecraft server, the website checks the player with Mojang: the launcher "joins" a random session id
// with the player's Minecraft token at Mojang, then sends only the name and that id. The token stays here.
// Never blocks or breaks the launcher: any error is ignored.
const crypto = require('crypto');

const SESSION_SERVER = 'https://sessionserver.mojang.com';

async function report(serverUrl, account, event, version) {
  try {
    if (!serverUrl || !account?.accessToken) return;
    const serverId = crypto.randomBytes(20).toString('hex');
    const joined = await fetch(`${SESSION_SERVER}/session/minecraft/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken, selectedProfile: account.uuid, serverId }),
      signal: AbortSignal.timeout(8000),
    });
    if (!joined.ok) return;
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

module.exports = { report };
