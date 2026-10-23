// Microsoft account login: Microsoft -> Xbox Live -> XSTS -> Minecraft.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, safeStorage, session } = require('electron');

const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const MS_OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

const accountFile = () => path.join(app.getPath('userData'), 'account.json');

// ---------------------------------------------------------------------------
// Saved account (the refresh token is encrypted with the OS keychain when one is available;
// on Linux without a keyring it is stored in a file only the current user can read)
// ---------------------------------------------------------------------------

function loadAccount() {
  try {
    const saved = JSON.parse(fs.readFileSync(accountFile(), 'utf8'));
    if (!saved.plain) saved.refreshToken = safeStorage.decryptString(Buffer.from(saved.refreshToken, 'base64'));
    return saved;
  } catch {
    return null;
  }
}

function saveAccount({ name, uuid, refreshToken }) {
  const data = safeStorage.isEncryptionAvailable()
    ? { name, uuid, refreshToken: safeStorage.encryptString(refreshToken).toString('base64') }
    : { name, uuid, refreshToken, plain: true };
  fs.writeFileSync(accountFile(), JSON.stringify(data), { mode: 0o600 });
}

function logout() {
  fs.rmSync(accountFile(), { force: true });
  session.fromPartition('msauth').clearStorageData();
}

// ---------------------------------------------------------------------------
// Microsoft OAuth (authorization code + PKCE in a popup window)
// ---------------------------------------------------------------------------

function askForCode(clientId, parent) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url =
    `${MS_OAUTH}/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 500,
      height: 650,
      title: 'Connexion Microsoft',
      autoHideMenuBar: true,
      webPreferences: { partition: 'msauth' },
    });
    let finished = false;

    const check = (event, navUrl) => {
      if (!navUrl.startsWith(REDIRECT_URI)) return;
      event?.preventDefault?.();
      finished = true;
      const params = new URL(navUrl).searchParams;
      win.close();
      if (params.get('code')) resolve({ code: params.get('code'), verifier });
      else reject(new Error(params.get('error_description') || 'Connexion annulée.'));
    };
    win.webContents.on('will-redirect', check);
    win.webContents.on('will-navigate', check);
    win.on('closed', () => {
      if (!finished) reject(new Error('Connexion annulée.'));
    });
    win.loadURL(url);
  });
}

async function postForm(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || 'Connexion Microsoft refusée.');
  return json;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { ok: res.ok, status: res.status, json };
}

// ---------------------------------------------------------------------------
// Xbox Live + Minecraft
// ---------------------------------------------------------------------------

const XSTS_ERRORS = {
  2148916233: "Ce compte Microsoft n'a pas de profil Xbox. Crée-en un sur xbox.com puis réessaie.",
  2148916235: "Xbox Live n'est pas disponible dans ton pays.",
  2148916236: 'Ce compte doit être vérifié comme adulte (Corée du Sud).',
  2148916237: 'Ce compte doit être vérifié comme adulte (Corée du Sud).',
  2148916238: "Ce compte est un compte enfant: il doit être ajouté à une famille Microsoft par un adulte.",
};

async function minecraftLogin(msAccessToken) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (!xbl.ok) throw new Error('Connexion à Xbox Live impossible.');

  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.json.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  if (!xsts.ok) throw new Error(XSTS_ERRORS[xsts.json.XErr] || 'Autorisation Xbox refusée.');
  const userHash = xsts.json.DisplayClaims.xui[0].uhs;

  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${userHash};${xsts.json.Token}`,
  });
  if (!mc.ok) throw new Error('Connexion aux serveurs Minecraft impossible.');

  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.json.access_token}` },
  });
  if (res.status === 404) throw new Error("Ce compte ne possède pas Minecraft Java Edition.");
  if (!res.ok) throw new Error('Impossible de lire le profil Minecraft.');
  const profile = await res.json();

  return { name: profile.name, uuid: profile.id, accessToken: mc.json.access_token };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Opens the Microsoft login popup and saves the account.
async function login(clientId, parentWindow) {
  const { code, verifier } = await askForCode(clientId, parentWindow);
  const tokens = await postForm(`${MS_OAUTH}/token`, {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });
  const account = await minecraftLogin(tokens.access_token);
  saveAccount({ ...account, refreshToken: tokens.refresh_token });
  return account;
}

// Gets a fresh Minecraft token for the saved account (used every time the game starts).
async function refresh(clientId) {
  const saved = loadAccount();
  if (!saved) throw new Error('Connecte-toi avec ton compte Microsoft.');
  const tokens = await postForm(`${MS_OAUTH}/token`, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: saved.refreshToken,
    scope: SCOPE,
  }).catch(() => {
    throw new Error('Ta session a expiré, reconnecte-toi.');
  });
  const account = await minecraftLogin(tokens.access_token);
  saveAccount({ ...account, refreshToken: tokens.refresh_token || saved.refreshToken });
  return account;
}

module.exports = { login, refresh, logout, loadAccount };
