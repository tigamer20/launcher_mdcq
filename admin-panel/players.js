// Who uses the launcher: every launcher reports its Microsoft logins and game launches here.
//
// Names can't be faked: like a Minecraft server, the launcher "joins" a random session id with the player's
// Minecraft token at Mojang (sessionserver), and this website asks Mojang whether that player really joined it.
// The player's token never reaches this website.
//
// The list is saved encrypted (AES-256-GCM, key from DATA_KEY or ADMIN_PASSWORD) because the admin-data branch
// is in a public repository. Changing that password starts a new, empty list.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_SERVER = process.env.MOJANG_SESSION_SERVER || 'https://sessionserver.mojang.com';
const FILE = 'players.enc';
const MAX_EVENTS = 300; // recent activity kept in the history
const GITHUB_DELAY = 2 * 60_000; // at most one GitHub commit every 2 minutes

let data = { players: {}, events: [], revoked: {} }; // revoked: uuid -> time an admin logged that account out
let file = null;
let key = null;
let persist = null; // (relativePath, buffer) => Promise, saves on GitHub
let pending = null; // timer of the next GitHub save
const usedIds = new Map(); // session id -> time, so a report can't be sent twice

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(buffer) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

/** Loads the saved list (after the data was restored from GitHub). */
function init({ dataDir, secret, save }) {
  file = path.join(dataDir, FILE);
  key = secret ? crypto.scryptSync(secret, 'atm-players', 32) : null;
  persist = save;
  if (!key || !fs.existsSync(file)) return;
  try {
    data = { revoked: {}, ...JSON.parse(decrypt(fs.readFileSync(file))) };
  } catch {
    console.warn('Liste des joueurs illisible (mot de passe changé ?) : une nouvelle liste commence.');
  }
}

// Sends the latest list to GitHub now (only if it changed since the last time).
async function flush() {
  if (!pending) return;
  clearTimeout(pending);
  pending = null;
  if (!key || !persist) return;
  await persist(FILE, fs.readFileSync(file)).catch((err) => console.error(`Joueurs non sauvegardés sur GitHub : ${err.message}`));
}

function save() {
  if (!key) return; // no password: nothing is stored
  fs.writeFileSync(file, encrypt(JSON.stringify(data)));
  if (!pending) pending = setTimeout(flush, GITHUB_DELAY);
}

// Asks Mojang which player joined this session id (null if nobody did).
async function verify(name, serverId) {
  const url = `${SESSION_SERVER}/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${serverId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status !== 200) return null;
  const profile = await res.json().catch(() => null);
  return profile?.id && profile?.name ? profile : null;
}

const EVENTS = { open: 'Ouverture du launcher', login: 'Connexion Microsoft', play: 'Lancement du jeu' };

/** Records a verified login or game launch. Throws { status, message } when refused. */
async function record({ name, serverId, event, version }) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!/^[A-Za-z0-9_]{1,16}$/.test(String(name)) || !/^[0-9a-f]{40}$/.test(String(serverId)) || !EVENTS[event]) {
    throw fail(400, 'Données invalides');
  }
  const now = Date.now();
  for (const [id, time] of usedIds) if (now - time > 5 * 60_000) usedIds.delete(id);
  if (usedIds.has(serverId)) throw fail(409, 'Déjà reçu');
  usedIds.set(serverId, now);

  const profile = await verify(name, serverId).catch(() => null);
  if (!profile) throw fail(403, 'Compte non vérifié par Mojang');
  // Logged out by an admin: only a new Microsoft login brings the player back in the list.
  if (data.revoked[profile.id]) {
    if (event !== 'login') throw fail(403, 'Compte déconnecté par un administrateur');
    delete data.revoked[profile.id];
  }

  const at = new Date(now).toISOString();
  const launcherVersion = /^[0-9][0-9A-Za-z.+-]{0,30}$/.test(String(version)) ? String(version) : null;
  const player = data.players[profile.id] || { uuid: profile.id, firstSeen: at, logins: 0, launches: 0 };
  player.name = profile.name;
  player.lastSeen = at;
  if (launcherVersion) player.launcherVersion = launcherVersion;
  if (event === 'login') {
    player.logins += 1;
    player.lastLogin = at;
  } else if (event === 'play') {
    player.launches += 1;
    player.lastPlay = at;
  }
  data.players[profile.id] = player;
  data.events.unshift({ uuid: profile.id, name: profile.name, event, version: launcherVersion, at });
  data.events.length = Math.min(data.events.length, MAX_EVENTS);
  save();
}

/** For the admin website: players (most recent first) and recent activity. */
function list() {
  const players = Object.values(data.players).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  return { enabled: Boolean(key), players, events: data.events.slice(0, 100), labels: EVENTS };
}

/** "Effacer l'historique": only the recent activity, the players stay. */
function clearHistory() {
  data.events = [];
  save();
}

/**
 * The ✕ next to a player: removes them from the list and logs their account out of the launcher
 * (the launcher asks sessionStatus() regularly). A new Microsoft login brings them back.
 */
function remove(uuid) {
  const id = String(uuid || '');
  if (!data.players[id]) throw Object.assign(new Error('Joueur introuvable'), { status: 404 });
  delete data.players[id];
  data.revoked[id] = new Date().toISOString();
  save();
}

/** For the launcher: was this account logged out by an admin after `since` (ms, when it logged in)? */
function sessionStatus(uuid, since) {
  const revokedAt = data.revoked[String(uuid || '').replace(/-/g, '')];
  return { loggedOut: Boolean(revokedAt && Date.parse(revokedAt) > (Number(since) || 0)) };
}

module.exports = { init, record, list, clearHistory, remove, sessionStatus, flush, FILE };
