// ============================================================
// CB GRILLZ — Netlify Function
// Returns the caller's approximate location (from Netlify's edge geo data)
// so the admin panel can show a live "who's on the site right now" view,
// similar to Stripe's dashboard.
// Privacy note: no IP address or personal data is written anywhere — only
// the coarse city/country Netlify already resolves at the edge, and the
// browser is the one that decides to store that against a random session id.
// ============================================================

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

exports.handler = async function (event, context) {
  const headers = corsHeaders();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const ip = ((event.headers && event.headers['x-forwarded-for']) || 'unknown').split(',')[0].trim();
  // One session only needs this once (the result is cached client-side), so 60/hour per IP is
  // generous headroom even for someone with several tabs open.
  if (rateLimit(ip, 60, 60 * 60 * 1000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  // Classic Netlify Functions get geo on context.geo. Older/edge-cached requests sometimes only
  // carry the base64 x-nf-geo header instead — fall back to decoding that.
  let geo = context && context.geo;
  if (!geo && event.headers && event.headers['x-nf-geo']) {
    try { geo = JSON.parse(Buffer.from(event.headers['x-nf-geo'], 'base64').toString('utf8')); }
    catch (e) { geo = null; }
  }

  const city = (geo && geo.city) || '';
  const country = (geo && geo.country && geo.country.name) || '';
  const countryCode = (geo && geo.country && geo.country.code) || '';

  return { statusCode: 200, headers, body: JSON.stringify({ city, country, countryCode }) };
};
