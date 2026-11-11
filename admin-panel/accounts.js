// Admin website accounts. The owner logs in as "admin" with ADMIN_PASSWORD and can do everything;
// the other accounts (created in the "Comptes" tab) only see and change what their permissions allow.
//
// Passwords are stored as scrypt hashes, and the whole list is saved encrypted (AES-256-GCM, key from DATA_KEY or
// ADMIN_PASSWORD) because the admin-data branch is in a public repository. Changing that password makes the old
// list unreadable: the accounts then have to be created again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const FILE = 'accounts.enc';
const OWNER = 'admin';

// What an account can be allowed to do (one per tab of the website). The dashboard is open to every account.
const PERMISSIONS = {
  maintenance: 'Mode maintenance',
  server: 'Réglages du serveur',
  players: 'Joueurs',
  modpack: 'Modpack',
  plugins: 'Mods du serveur',
  serverFiles: 'Fichiers du serveur',
  console: 'Console',
  news: 'Nouvelles',
  files: 'Fichiers joueurs',
  launcher: 'Versions du launcher',
  accounts: 'Comptes',
};

let accounts = {}; // lower-case name -> { name, hash, salt, permissions, createdAt, createdBy }
let file = null;
let key = null;
let ownerPassword = null;
let persist = null; // (relativePath, buffer) => Promise, saves on GitHub

const fail = (status, message) => Object.assign(new Error(message), { status });

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

/** Loads the saved accounts (after the data was restored from GitHub). */
function init({ dataDir, secret, password, save }) {
  file = path.join(dataDir, FILE);
  key = secret ? crypto.scryptSync(secret, 'atm-accounts', 32) : null;
  ownerPassword = password;
  persist = save;
  if (!key || !fs.existsSync(file)) return;
  try {
    accounts = JSON.parse(decrypt(fs.readFileSync(file)));
  } catch {
    console.warn('Comptes admin illisibles (mot de passe changé ?) : seul le compte admin fonctionne.');
  }
}

async function save() {
  if (!key) throw fail(503, 'ADMIN_PASSWORD n\'est pas configuré : impossible d\'enregistrer des comptes.');
  const buffer = encrypt(JSON.stringify(accounts));
  fs.writeFileSync(file, buffer);
  if (persist) {
    await persist(FILE, buffer).catch((err) => {
      throw fail(502, `Appliqué, mais pas sauvegardé sur GitHub (perdu au prochain redémarrage) : ${err.message}`);
    });
  }
}

async function hashPassword(password, salt) {
  return (await scrypt(String(password), Buffer.from(salt, 'hex'), 64)).toString('hex');
}

const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function checkName(name) {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(clean)) throw fail(400, 'Nom invalide : 2 à 32 lettres, chiffres, points, tirets ou _');
  if (clean.toLowerCase() === OWNER) throw fail(400, `« ${OWNER} » est réservé au compte propriétaire`);
  return clean;
}

function checkPassword(password) {
  if (String(password || '').length < 8) throw fail(400, 'Mot de passe trop court (8 caractères minimum)');
  return String(password);
}

const cleanPermissions = (list) => [...new Set((Array.isArray(list) ? list : []).filter((p) => p in PERMISSIONS))];

/** The logged-in user ({ name, owner, permissions }) for a name, or null if the account no longer exists. */
function user(name) {
  if (name === OWNER) return { name: OWNER, owner: true, permissions: Object.keys(PERMISSIONS) };
  const account = accounts[String(name).toLowerCase()];
  return account ? { name: account.name, owner: false, permissions: [...account.permissions] } : null;
}

/** Checks a login. Returns the account name, or null. Always takes about the same time. */
async function login(name, password) {
  const given = String(name || '').trim() || OWNER; // empty name: the owner, like before accounts existed
  if (given.toLowerCase() === OWNER) return ownerPassword && sameText(password, ownerPassword) ? OWNER : null;
  const account = accounts[given.toLowerCase()];
  const hash = await hashPassword(password, account?.salt || '00');
  return account && sameText(hash, account.hash) ? account.name : null;
}

function list() {
  const items = Object.values(accounts)
    .map(({ name, permissions, createdAt, createdBy }) => ({ name, permissions, createdAt, createdBy }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { owner: OWNER, accounts: items, permissions: PERMISSIONS };
}

// Nobody can give a permission they don't have themselves.
function allowed(by, permissions) {
  const mine = new Set(user(by)?.permissions || []);
  const extra = permissions.filter((p) => !mine.has(p));
  if (extra.length) throw fail(403, `Tu ne peux pas donner une permission que tu n'as pas : ${extra.map((p) => PERMISSIONS[p]).join(', ')}`);
}

async function create(by, { name, password, permissions }) {
  const clean = checkName(name);
  if (accounts[clean.toLowerCase()]) throw fail(409, `Le compte « ${clean} » existe déjà`);
  const perms = cleanPermissions(permissions);
  allowed(by, perms);
  const salt = crypto.randomBytes(16).toString('hex');
  accounts[clean.toLowerCase()] = {
    name: clean,
    salt,
    hash: await hashPassword(checkPassword(password), salt),
    permissions: perms,
    createdAt: new Date().toISOString(),
    createdBy: by,
  };
  await save();
  return list();
}

function existing(name) {
  const account = accounts[String(name || '').toLowerCase()];
  if (!account) throw fail(404, 'Compte introuvable');
  return account;
}

async function update(by, { name, permissions, password }) {
  const account = existing(name);
  if (account.name.toLowerCase() === String(by).toLowerCase() && permissions) {
    throw fail(400, 'Tu ne peux pas changer tes propres permissions');
  }
  if (permissions) {
    const perms = cleanPermissions(permissions);
    // Only the permissions being added are checked: removing one the editor doesn't have is fine.
    allowed(by, perms.filter((p) => !account.permissions.includes(p)));
    account.permissions = perms;
  }
  if (password) {
    account.salt = crypto.randomBytes(16).toString('hex');
    account.hash = await hashPassword(checkPassword(password), account.salt);
  }
  await save();
  return list();
}

async function remove(by, name) {
  const account = existing(name);
  if (account.name.toLowerCase() === String(by).toLowerCase()) throw fail(400, 'Tu ne peux pas supprimer ton propre compte');
  delete accounts[account.name.toLowerCase()];
  await save();
  return list();
}

/** An account changes its own password (the owner changes ADMIN_PASSWORD on Render instead). */
async function changeOwnPassword(name, current, password) {
  if (name === OWNER) throw fail(400, 'Le mot de passe admin se change dans ADMIN_PASSWORD (Render > Environment)');
  const account = existing(name);
  if (!sameText(await hashPassword(current, account.salt), account.hash)) throw fail(400, 'Mot de passe actuel incorrect');
  account.salt = crypto.randomBytes(16).toString('hex');
  account.hash = await hashPassword(checkPassword(password), account.salt);
  await save();
}

module.exports = { init, user, login, list, create, update, remove, changeOwnPassword, PERMISSIONS, OWNER, FILE };
