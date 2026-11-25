// ============================================================
// CB GRILLZ — Netlify Function
// Verifies the admin password SERVER-SIDE and issues a signed, time-limited
// session token. Added 2026-10-05 because the real password used to be a
// plain `const ADMIN_PW = '...'` sitting inside index.html — anyone who
// viewed page source got the password for free, no exploit needed.
//
// How it's used: index.html posts {password} here (action defaults to
// 'login'). On a correct password we return a token of the form
// "<expiresAtMs>.<hmacHex>", HMAC-signed with ADMIN_SESSION_SECRET (a value
// that only ever lives on the server — never shipped to the browser). The
// browser stores that token and sends it back on every write that should
// require admin rights; db-write.js verifies the signature + expiry there.
//
// UPDATED 2026-10-06: the password itself used to be a second hardcoded
// constant here (ADMIN_PW) — meaning the only way to ever change it was to
// edit this file and redeploy. After a real incident where the password
// ('cbgrillz2026', a guessable business-name+year pattern) was used to
// delete ~30 products and all reviews one item at a time, the owner needed
// to be able to rotate it themselves without a code change. So the password
// now lives in Firebase, salted + scrypt-hashed, at a top-level key
// (ADMIN_AUTH_PATH) that is NOT in the public read/write rules — same
// protection pattern as cbgrillz_backups in backup.js: an unlisted top-level
// key defaults to .read:false/.write:false, so only this function (using
// FB_SECRET, which bypasses rules entirely) can ever read or write it.
// FALLBACK_PW below is only used the very first time this runs, before any
// password has ever been set in Firebase — the moment someone successfully
// uses 'change' to set a real one, FALLBACK_PW stops working.
//
// New action: {action:'change', currentPassword, newPassword} — verifies
// currentPassword against whatever's currently active (stored hash, or
// FALLBACK_PW if nothing's been set yet), then stores newPassword's hash.
// Requires newPassword to be at least 10 characters.
//
// DEPLOY: just needs this file in netlify/functions/ — no env vars, no npm
// deps (matches this project's other functions). netlify.toml already has
// the /api/admin-login redirect.
// ============================================================

const https = require('https');
const crypto = require('crypto');

const FALLBACK_PW = 'cbgrillz2026'; // bootstrap only — stops working once a real password is ever set below
const ADMIN_SESSION_SECRET = 'e11ce83fc1f59bbd803b51175faa191f745ad2dbdf431a23a74b6448daa87472'; // must match db-write.js
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

const FB_SECRET = 'teTSYFHtMSgJKMp4oqhXbQhBb068H2FiXYV2GAao'; // Firebase legacy database secret — server-side only
const FB_HOST = 'zpvisuals2-da861-default-rtdb.firebaseio.com';
const ADMIN_AUTH_PATH = 'cbgrillz_admin_auth'; // unlisted top-level key — not covered by public rules, same as cbgrillz_backups

const ipLog = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const hits = (ipLog.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  ipLog.set(ip, hits);
  return hits.length > max;
}

function corsHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
}

function makeToken() {
  const expiresAt = Date.now() + SESSION_MS;
  const hmac = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(String(expiresAt)).digest('hex');
  return { token: expiresAt + '.' + hmac, expiresAt };
}

function fbRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: FB_HOST,
      path: '/' + path + '.json?auth=' + FB_SECRET,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    if (method === 'PUT' || method === 'POST' || method === 'PATCH') req.write(JSON.stringify(data));
    req.end();
  });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'hex'), bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch (e) { return false; }
}

// Returns true if `password` matches whatever's currently active (stored hash, or the
// bootstrap fallback if no password has ever been set in Firebase yet).
async function verifyPassword(password) {
  const rec = await fbRequest('GET', ADMIN_AUTH_PATH);
  const stored = rec.data;
  if (stored && stored.salt && stored.hash) {
    return safeEqual(hashPassword(password, stored.salt), stored.hash);
  }
  return password === FALLBACK_PW;
}

async function setPassword(newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  await fbRequest('PUT', ADMIN_AUTH_PATH, { salt, hash, updatedAt: Date.now() });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  // Brute-force guard — shared across login + change-password, both are password-gated.
  if (rateLimit(ip, 8, 10 * 60 * 1000)) {
    return { statusCode: 429, headers: corsHeaders(), body: JSON.stringify({ error: 'Too many attempts — please wait.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const action = body.action === 'change' ? 'change' : 'login';

  if (action === 'change') {
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing currentPassword or newPassword' }) };
    }
    if (body.newPassword.length < 10) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'New password must be at least 10 characters.' }) };
    }
    const ok = await verifyPassword(body.currentPassword);
    if (!ok) {
      return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ ok: false, error: 'Current password is incorrect' }) };
    }
    await setPassword(body.newPassword);
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true }) };
  }

  // action === 'login'
  if (typeof body.password !== 'string') {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing password' }) };
  }
  const ok = await verifyPassword(body.password);
  if (!ok) {
    return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ ok: false, error: 'Incorrect password' }) };
  }
  const { token, expiresAt } = makeToken();
  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, token, expiresAt }) };
};
