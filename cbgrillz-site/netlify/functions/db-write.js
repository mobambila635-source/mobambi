// ============================================================
// CB GRILLZ — Netlify Function
// Proxies ALL Firebase writes/deletes for /cbgrillz. The browser never talks
// to Firebase directly for writes anymore (only reads, which stay public).
// This exists because the Firebase RTDB rules for this project are wide
// open across ~35 shared client sites ({cbgrillz: {read:true, write:true}}),
// and on 2026-10-03 an automated internet scanner found the open write door
// and deleted most of the site's data (products, reviews, orders, etc).
//
// Fix: Firebase rules get cbgrillz.write set to false (random bots hitting
// the raw REST URL get rejected). This function holds the project's legacy
// database secret, which bypasses rules entirely, so it can still perform
// writes on behalf of the real site — but only when the caller supplies
// APP_KEY, a value that only exists inside this site's own JS bundle. A
// generic Firebase-scanning bot has no way to discover or guess it; it
// never loads/parses index.html, it just probes the bare database URL.
//
// DEPLOY: just needs this file in netlify/functions/ — no env vars, no
// npm deps (matches this project's other functions).
// ============================================================

const https = require('https');
const crypto = require('crypto');

const APP_KEY = '04ee314dba723514529a2ea557c779e834740e95ef113e0d'; // must match DB_KEY in index.html
const FB_SECRET = 'teTSYFHtMSgJKMp4oqhXbQhBb068H2FiXYV2GAao'; // Firebase legacy database secret — server-side only, never sent to the browser
const FB_HOST = 'zpvisuals2-da861-default-rtdb.firebaseio.com';
const FB_ROOT = 'cbgrillz';

// Must match ADMIN_SESSION_SECRET in admin-login.js. Server-only, never shipped to the browser —
// this is what actually gates admin-only writes now. Added 2026-10-05: APP_KEY above is NOT secret
// (it's shipped in index.html, see comment below), and until now that was the ONLY check on every
// write, admin or not — meaning the admin login password was purely a client-side UI gate that
// didn't actually protect anything at the write layer. Anyone who read APP_KEY from page source
// could already call config/products/discountCodes writes directly, no password needed at all.
const ADMIN_SESSION_SECRET = 'e11ce83fc1f59bbd803b51175faa191f745ad2dbdf431a23a74b6448daa87472';

function isValidAdminToken(token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expiresAt = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(String(expiresAt)).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); }
  catch (e) { return false; }
}

// DEFAULT-DENY allowlist of the only (bucket, action) pairs a genuinely anonymous visitor's browser
// ever needs to call, traced from every fbSet/fbPush/fbDel call site in index.html. Everything NOT
// listed here requires a valid admin token — including actions nobody currently uses, on purpose,
// so adding a new write path later can't silently reopen a hole the way the first version of this
// function did (it only checked 'set' for config/faqs/text, so 'del'/'push' on those buckets stayed
// wide open — an attacker could read config.json's child keys via the public read endpoint, then
// delete them one at a time with just APP_KEY, achieving the same full wipe as a bare overwrite
// without ever tripping the bare-top-level guard below or this check in its old blocklist form).
const PUBLIC_WRITES = new Set([
  'presence:set',       // visitor heartbeat, every ~20s
  'presence:del',       // visitor's own browser pruning stale (24h+) presence entries
  'carts:set',          // visitor's own browser reporting its current cart contents ("about to buy" admin view)
  'carts:del',          // visitor's own browser clearing its cart snapshot (cart emptied / order placed / stale prune)
  'enquiries:push',     // appointment / design-your-own / book forms — anonymous submissions
  'orders:set',         // checkout writing the customer's own paid order
  'customOrders:set',   // checkout marking a custom-order link as paid (status/orderRef/paidTs only)
]);
function requiresAdminToken(path, action) {
  const bucket = path.split('/')[0];
  return !PUBLIC_WRITES.has(bucket + ':' + action);
}

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

// path must be a clean relative path under /cbgrillz — no leading slash, no "..", no raw ".json".
function validPath(path) {
  if (typeof path !== 'string' || !path.length || path.length > 200) return false;
  if (path.includes('..') || path.startsWith('/') || path.endsWith('/')) return false;
  return /^[a-zA-Z0-9_\-\/]+$/.test(path);
}

function fbRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const query = 'auth=' + FB_SECRET;
    const options = {
      hostname: FB_HOST,
      path: '/' + FB_ROOT + '/' + path + '.json?' + query,
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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  // Generous cap — this single endpoint now carries every write the whole site makes
  // (checkout, admin saves, enquiries, presence pings), not just one form.
  if (rateLimit(ip, 400, 10 * 60 * 1000)) {
    return { statusCode: 429, headers: corsHeaders(), body: JSON.stringify({ error: 'Too many requests' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { key, action, path, adminToken } = body;
  let { data } = body;
  if (key !== APP_KEY) {
    return { statusCode: 403, headers: corsHeaders(), body: JSON.stringify({ error: 'Forbidden' }) };
  }
  if (!validPath(path)) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid path' }) };
  }

  if (action === 'decrementStock') {
    // Narrow, public, self-contained: only ever reduces a product's own `stock` field by 1 (floor
    // 0). Can't be used to rewrite a product's name/price/images, so it's safe to leave open to
    // anyone with APP_KEY (i.e. the public) — unlike a generic 'set' on products, which now
    // requires an admin token (see requiresAdminToken above).
    if (!path.startsWith('products/') || path.split('/').length !== 3) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid path for decrementStock' }) };
    }
    try {
      const current = await fbRequest('GET', path, null);
      const stock = Math.max(0, (Number(current.data && current.data.stock) || 0) - 1);
      const result = await fbRequest('PATCH', path, { stock });
      if (result.status >= 400) {
        return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Firebase write failed', detail: result.data }) };
      }
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, stock }) };
    } catch (err) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message || 'Internal error' }) };
    }
  }

  const method = action === 'set' ? 'PUT' : action === 'push' ? 'POST' : action === 'del' ? 'DELETE' : null;
  if (!method) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid action' }) };
  }
  if (requiresAdminToken(path, action) && !isValidAdminToken(adminToken)) {
    return { statusCode: 403, headers: corsHeaders(), body: JSON.stringify({ error: 'Admin session required' }) };
  }
  // Blocks the exact failure mode from the 2026-10-03 incident: wiping an entire top-level
  // bucket (all products, all reviews, all orders...) in one call. Deletes must target a
  // specific child id, never a bare bucket root.
  if (method === 'DELETE' && !path.includes('/')) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Cannot delete a top-level bucket' }) };
  }
  // Same failure mode, different method: a PUT (action:'set') on a bare top-level path
  // replaces that whole bucket too — and DB_KEY is not actually secret, it's shipped in
  // plain text inside index.html, so anyone who views the page source can call this
  // endpoint directly. This is what actually wiped /reviews on 2026-10-05: a one-shot
  // {action:'set', path:'reviews', data:{}}-style call, which the DELETE guard above never
  // covered. Only 'config' and 'faqs' are ever legitimately replaced wholesale by the site
  // itself — every other bucket must target a specific child path.
  const ALLOWED_BARE_SET_BUCKETS = new Set(['config', 'faqs']);
  if (method === 'PUT' && !path.includes('/') && !ALLOWED_BARE_SET_BUCKETS.has(path)) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Cannot overwrite a whole top-level bucket via this path' }) };
  }

  // Both config and faqs were ALSO wiped blank on 2026-10-05 despite that allowlist and a valid
  // admin token — not by an attacker, but by the owner's own browser saving before it had finished
  // loading the real data (see CFG_LOADED/FAQS_LOADED comments in index.html). Those client-side
  // guards can't be trusted as the only line of defense since a bug (or anyone replaying the
  // request with APP_KEY + a valid token) bypasses them entirely. So the server independently
  // refuses to let a bare config/faqs PUT destroy data that's already there:
  if (method === 'PUT' && path === 'config') {
    // A plain key-presence merge isn't enough: index.html's hardcoded CFG skeleton (used before
    // the real config has loaded) already defines every key, just with blank values ('', [], etc)
    // — so every key is "present" in a stale save too, and Object.assign would just overwrite
    // everything anyway. Instead, per field: if the incoming value is blank (empty string/array/
    // null/undefined) and we already have a real, non-blank value stored, keep the stored one.
    // Non-blank incoming values (including intentional edits back to something real) still apply.
    const isBlank = (v) => v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    const current = await fbRequest('GET', 'config', null);
    const currentData = (current.data && typeof current.data === 'object') ? current.data : {};
    const incoming = (data && typeof data === 'object') ? data : {};
    const merged = Object.assign({}, currentData);
    for (const k of Object.keys(incoming)) {
      merged[k] = (isBlank(incoming[k]) && !isBlank(currentData[k])) ? currentData[k] : incoming[k];
    }
    data = merged;
  }
  if (method === 'PUT' && path === 'faqs') {
    // Arrays can't be merged key-wise, so instead block bulk loss: addFaq/removeFaq only ever
    // change the array by one item at a time, so a drop of more than 1 item in one write can only
    // be a stale/blank overwrite, never legitimate owner action.
    const current = await fbRequest('GET', 'faqs', null);
    const currentLen = Array.isArray(current.data) ? current.data.length : 0;
    const incomingLen = Array.isArray(data) ? data.length : 0;
    if (currentLen - incomingLen > 1) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Refusing to drop more than one FAQ in a single save — reload and try again.' }) };
    }
  }

  try {
    const result = await fbRequest(method, path, data);
    if (result.status >= 400) {
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Firebase write failed', detail: result.data }) };
    }
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, result: result.data }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};
