// ============================================================
// CB GRILLZ — Netlify Function
// Admin-facing companion to backup.js. backup.js is a SCHEDULED function
// (runs nightly via netlify.toml cron) — Netlify's platform blocks all
// direct HTTP requests to any scheduled function's endpoint (always 403),
// so the Admin panel's "Run Backup Now" / list / download calls can't go
// through that one. This unscheduled function does the same Firebase work,
// reachable over normal HTTP, gated by APP_KEY for list/download.
//
// Actions (POST body { action, key, date }):
//   - "run"      : requires key === APP_KEY. On-demand snapshot
//                  /cbgrillz -> cbgrillz_backups/<YYYY-MM-DD>.json ("Run
//                  Backup Now" button), also prunes backups >30 days old.
//   - "list"     : requires key === APP_KEY. Returns available backup dates.
//   - "download" : requires key === APP_KEY + a date. Returns that day's
//                  full JSON snapshot.
//
// DEPLOY:
// 1. Place this file at: netlify/functions/backup-admin.js
// 2. netlify.toml already has the /api/backup-admin redirect (no schedule).
// 3. No env vars, no npm deps (matches this project's other functions).
// ============================================================

const https = require('https');

const APP_KEY = '04ee314dba723514529a2ea557c779e834740e95ef113e0d'; // must match DB_KEY in index.html
const FB_SECRET = 'teTSYFHtMSgJKMp4oqhXbQhBb068H2FiXYV2GAao'; // Firebase legacy database secret
const FB_HOST = 'zpvisuals2-da861-default-rtdb.firebaseio.com';
const SRC_ROOT = 'cbgrillz';
const BACKUP_ROOT = 'cbgrillz_backups';
const RETENTION_DAYS = 30;

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

function todayStr(d) {
  d = d || new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function fbRequest(method, path, data, extraQuery) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: FB_HOST,
      path: '/' + path + '.json?auth=' + FB_SECRET + (extraQuery ? '&' + extraQuery : ''),
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

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function runBackup() {
  const snap = await fbRequest('GET', SRC_ROOT);
  if (snap.status >= 400) throw new Error('Firebase read failed: ' + snap.status);
  const date = todayStr();
  const put = await fbRequest('PUT', BACKUP_ROOT + '/' + date, { date, ts: Date.now(), data: snap.data });
  if (put.status >= 400) throw new Error('Firebase backup write failed: ' + put.status);

  const list = await fbRequest('GET', BACKUP_ROOT, null, 'shallow=true');
  const keys = (list.status < 400 && list.data) ? Object.keys(list.data) : [];
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const k of keys) {
    if (!validDate(k)) continue;
    const t = new Date(k + 'T00:00:00Z').getTime();
    if (t < cutoff) {
      await fbRequest('DELETE', BACKUP_ROOT + '/' + k).catch(() => {});
    }
  }
  return { date, prunedBefore: todayStr(new Date(cutoff)) };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimit(ip, 30, 10 * 60 * 1000)) {
    return { statusCode: 429, headers: corsHeaders(), body: JSON.stringify({ error: 'Too many requests' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid request body' }) }; }

  if (body.key !== APP_KEY) {
    return { statusCode: 403, headers: corsHeaders(), body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    if (body.action === 'run') {
      const result = await runBackup();
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, ...result }) };
    }

    if (body.action === 'list') {
      const list = await fbRequest('GET', BACKUP_ROOT, null, 'shallow=true');
      const dates = (list.status < 400 && list.data) ? Object.keys(list.data).filter(validDate).sort().reverse() : [];
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, dates }) };
    }

    if (body.action === 'download') {
      if (!validDate(body.date)) return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid date' }) };
      const rec = await fbRequest('GET', BACKUP_ROOT + '/' + body.date);
      if (rec.status >= 400 || !rec.data) return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'Backup not found' }) };
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(rec.data) };
    }

    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};
