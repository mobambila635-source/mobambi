// ============================================================
// CB GRILLZ — Netlify Function (SCHEDULED — not for direct HTTP use)
// Nightly backup of the entire /cbgrillz Firebase tree.
// Added after the 2026-10-03 incident (open DB rules let a scanner wipe
// most of the site's data) so there's always something to restore from
// even if the live data gets corrupted or deleted again.
//
// Storage: backups are written to a brand-new top-level Firebase key,
// `cbgrillz_backups`, which is NOT listed anywhere in this project's
// Firebase rules file. An unlisted key inherits the rules root's default
// (.read:false, .write:false), so it's fully denied to public read/write —
// only this function (using the legacy FB_SECRET, which bypasses rules
// entirely) can ever touch it. That makes it safer than the live
// `cbgrillz` node, which has to stay publicly readable for the site to work.
//
// IMPORTANT: this function has a `schedule` set in netlify.toml. Once a
// function is scheduled, Netlify's platform itself blocks ALL direct HTTP
// requests to its endpoint (always 403, before our code even runs) — only
// Netlify's internal scheduler can invoke it. That's why the admin panel's
// "list backups" / "download backup" / "run backup now" calls live in a
// separate, unscheduled function: netlify/functions/backup-admin.js.
//
// DEPLOY:
// 1. Place this file at: netlify/functions/backup.js
// 2. netlify.toml already has the nightly schedule for it.
// 3. No env vars, no npm deps (matches this project's other functions).
// ============================================================

const https = require('https');

const FB_SECRET = 'teTSYFHtMSgJKMp4oqhXbQhBb068H2FiXYV2GAao'; // Firebase legacy database secret
const FB_HOST = 'zpvisuals2-da861-default-rtdb.firebaseio.com';
const SRC_ROOT = 'cbgrillz';
const BACKUP_ROOT = 'cbgrillz_backups';
const RETENTION_DAYS = 30;

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

  // Prune anything older than RETENTION_DAYS.
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

exports.handler = async function () {
  try {
    const result = await runBackup();
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};
