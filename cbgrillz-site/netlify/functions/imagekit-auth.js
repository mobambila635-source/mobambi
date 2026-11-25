// ============================================================
// CB GRILLZ — Netlify Function
// Issues short-lived signed params for direct-to-ImageKit uploads.
// The private key never reaches the browser — only token/expire/signature do.
// ============================================================

const crypto = require('crypto');

const IK_PRIVATE_KEY = 'private_mEt/djSc30qhXvnvhlHTBN49DFY=';

const ipLog = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const hits = (ipLog.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  ipLog.set(ip, hits);
  return hits.length > max;
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const ip = event.headers['x-forwarded-for'] || 'unknown';
  if (rateLimit(ip, 30, 60 * 60 * 1000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 60 * 10;
  const signature = crypto.createHmac('sha1', IK_PRIVATE_KEY).update(token + expire).digest('hex');

  return { statusCode: 200, headers, body: JSON.stringify({ token, expire, signature }) };
};
