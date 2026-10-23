// Request signing shared by the admin website and the agent.
// Each request carries an HMAC of (method, path, time, body hash) made with the shared secret,
// so the secret itself never travels over the network and old requests can't be replayed.
const crypto = require('crypto');

const MAX_AGE_MS = 60_000;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function signature(secret, method, pathWithQuery, time, bodyHash) {
  return crypto.createHmac('sha256', secret).update(`${method}\n${pathWithQuery}\n${time}\n${bodyHash}`).digest('hex');
}

// Headers for a request sent by the admin website.
function signHeaders(secret, method, pathWithQuery, body = Buffer.alloc(0)) {
  const time = String(Date.now());
  const bodyHash = sha256(body);
  return {
    'X-Agent-Time': time,
    'X-Body-Sha256': bodyHash,
    'X-Agent-Signature': signature(secret, method, pathWithQuery, time, bodyHash),
  };
}

// Checks a request received by the agent. Returns the body hash it promised (checked later against the body).
const seen = new Map(); // signature -> expiry, to refuse replays
function verify(secret, req) {
  const time = Number(req.headers['x-agent-time']);
  const bodyHash = String(req.headers['x-body-sha256'] || '');
  const given = Buffer.from(String(req.headers['x-agent-signature'] || ''), 'hex');
  const expected = Buffer.from(signature(secret, req.method, req.url, time, bodyHash), 'hex');

  if (!time || Math.abs(Date.now() - time) > MAX_AGE_MS) return null;
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const now = Date.now();
  for (const [sig, expiry] of seen) if (expiry < now) seen.delete(sig);
  const key = given.toString('hex');
  if (seen.has(key)) return null;
  seen.set(key, now + 2 * MAX_AGE_MS);
  return bodyHash;
}

module.exports = { sha256, signHeaders, verify };
