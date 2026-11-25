// ============================================================
// CB GRILLZ — Netlify Function
// Creates a Stripe PaymentIntent for the full order total
// ============================================================
// DEPLOY:
// 1. Place this file at: netlify/functions/create-payment-intent.js
// 2. Netlify dashboard → Site → Environment Variables
//    Add: STRIPE_SECRET_KEY = sk_live_... (your Stripe secret key)
// 3. Deploy — endpoint available at /api/create-payment-intent
// ============================================================

const ipLog = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const hits = (ipLog.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  ipLog.set(ip, hits);
  return hits.length > max;
}

function sanitize(s, max) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim().slice(0, max || 300);
}

function corsHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
}

// ------------------------------------------------------------
// Adaptive payment-method resolution.
// We used to hardcode ['card','klarna','revolut_pay'] here. Problem: Stripe
// rejects the ENTIRE PaymentIntent if even one requested payment_method_type
// isn't actually active/verified on the account yet — so hand-maintaining
// this list is a landmine (one wrong entry breaks checkout for everyone,
// every method, until someone notices and redeploys).
//
// v2 fix (this version): the first version tried the whole wishlist as ONE
// batch and, on failure, parsed Stripe's error MESSAGE TEXT to guess which
// method(s) to drop. That shipped two real bugs: (1) it probed using a fake
// 50-cent amount, and methods like Klarna/Revolut Pay have real minimum
// order amounts — so they got misdiagnosed as "not enabled" when they were
// really just "too small for this test," and that wrong answer got cached
// for an hour and served to real checkouts; (2) matching Stripe's exact
// wording is fragile and was never verified against production.
//
// Fixed by testing every wishlist method INDIVIDUALLY, in parallel, against
// a realistic amount (the real order amount when we have it). Each method
// either works or it doesn't — no shared batch to fail together, no error
// text to guess at. Cache the good list for an hour so normal checkouts
// don't pay for 16 parallel probe calls, and so newly-enabled methods in
// the Dashboard get picked up automatically within the hour.
// ------------------------------------------------------------
// Note: 'blik' deliberately excluded — Stripe only allows it with PLN currency,
// and this site always charges 'eur'. It would fail on every request forever.
const PM_WISHLIST = ['card','klarna','revolut_pay','sepa_debit','paypal','bancontact','eps','giropay','ideal','p24','sofort','link','satispay','twint','mobilepay'];
// Clearpay/Afterpay is deliberately excluded — Stripe doesn't support it for accounts settling in Germany.
let pmCache = ['card', 'klarna', 'revolut_pay']; // last known-good baseline (confirmed live before this change)
let pmCacheAt = 0;
const PM_CACHE_MS = 60 * 60 * 1000;
// Floor for any amount used to (re)build the SHARED cache. A probe amount below this could wrongly
// mark a legit method "unavailable" just for being too small for THAT test, and that wrong answer
// would then get served to every other customer's checkout too. A one-off real charge smaller than
// this can still self-heal itself (see resolveAndCreate below) — it just never shrinks the shared
// cache for everyone else.
const PM_CACHE_FLOOR_AMOUNT = 5000; // €50

async function tryCreateIntent(sk, baseParams, types) {
  const p = new URLSearchParams(baseParams);
  types.forEach(t => p.append('payment_method_types[]', t));
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + sk,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2023-10-16'
    },
    body: p.toString()
  });
  const data = await res.json();
  return { ok: !data.error, data };
}

// Tests every wishlist method independently and in parallel against a given amount, and returns
// the full per-method detail (including Stripe's real rejection reason, if any) — used by the
// ?debug=1 branch below so we can see WHY a method failed instead of guessing.
async function discoverTypesDetailed(sk, amountCents) {
  const baseParams = {
    amount: String(Math.max(Math.round(amountCents) || PM_CACHE_FLOOR_AMOUNT, 50)),
    currency: 'eur',
    description: 'CB Grillz capability check'
  };
  return Promise.all(PM_WISHLIST.map(async type => {
    try {
      const attempt = await tryCreateIntent(sk, baseParams, [type]);
      return { type, ok: attempt.ok, error: attempt.ok ? null : (attempt.data.error && attempt.data.error.message) || 'unknown error' };
    } catch (e) {
      return { type, ok: false, error: String(e && e.message || e) };
    }
  }));
}

// Tests every wishlist method independently and in parallel against a given amount. No batching,
// no error-message parsing — each result is a direct "Stripe accepted this or it didn't."
async function discoverTypes(sk, amountCents) {
  const results = await discoverTypesDetailed(sk, amountCents);
  const working = results.filter(r => r.ok).map(r => r.type);
  return working.length ? working : ['card'];
}

function cacheTypes(types) {
  pmCache = types.slice();
  pmCacheAt = Date.now();
}

// Resolves the current working payment method list and creates a real PaymentIntent for it in the
// same round trip — avoids a separate throwaway probe call on the hot path (real checkouts).
async function resolveAndCreate(sk, baseParams) {
  const amountCents = Number(baseParams.amount) || 0;
  const fresh = Date.now() - pmCacheAt < PM_CACHE_MS;

  let firstTry = pmCache;
  if (!fresh) {
    firstTry = await discoverTypes(sk, Math.max(amountCents, PM_CACHE_FLOOR_AMOUNT));
    cacheTypes(firstTry);
  }

  let attempt = await tryCreateIntent(sk, baseParams, firstTry);
  if (attempt.ok) return { types: firstTry, attempt };

  // The cached/just-discovered list didn't work for THIS real amount (e.g. a method in it has a
  // minimum above this specific charge). Re-discover fresh against the real amount and retry once
  // — guaranteed correct because it's tested directly against Stripe, never guessed from error text.
  const rediscovered = await discoverTypes(sk, amountCents);
  attempt = await tryCreateIntent(sk, baseParams, rediscovered);
  if (attempt.ok) {
    // Only let this rewrite the SHARED cache if it was tested at a representative amount — a small
    // one-off balance payment shouldn't narrow what the next full-price customer gets offered.
    if (amountCents >= PM_CACHE_FLOOR_AMOUNT) cacheTypes(rediscovered);
    return { types: rediscovered, attempt };
  }

  // Even that failed (e.g. a transient Stripe issue) — last resort: card only, so checkout never
  // fully breaks.
  if (rediscovered.join(',') !== 'card') {
    attempt = await tryCreateIntent(sk, baseParams, ['card']);
    if (attempt.ok) return { types: ['card'], attempt };
  }
  return { types: rediscovered, attempt };
}

// Discovery-only helper for the GET branch — lets the front-end mount its Payment Element with the
// same list the backend will actually accept at submit time. Accepts the real order amount (in
// cents) when the front-end has one; falls back to a realistic default otherwise. Never lets a
// small amount shrink the shared cache (see PM_CACHE_FLOOR_AMOUNT above).
async function resolveTypesOnly(sk, amountCents) {
  if (Date.now() - pmCacheAt < PM_CACHE_MS) return pmCache;
  const probeAmount = Math.max(Number(amountCents) || 0, PM_CACHE_FLOOR_AMOUNT);
  const types = await discoverTypes(sk, probeAmount);
  cacheTypes(types);
  return types;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };

  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Stripe secret key not configured' }) };
  }

  if (event.httpMethod === 'GET') {
    const rawAmount = event.queryStringParameters && event.queryStringParameters.amount;
    const amountCents = rawAmount ? parseInt(rawAmount, 10) : 0;

    // Temporary diagnostic: /api/create-payment-intent?debug=1 — shows Stripe's real reason for
    // each payment method, one call, nothing hidden. Not linked from the site; safe to leave in
    // short-term since it exposes no secrets, only lists what's already visible in the Dashboard.
    if (event.queryStringParameters && event.queryStringParameters.debug === '1') {
      try {
        const details = await discoverTypesDetailed(sk, amountCents || PM_CACHE_FLOOR_AMOUNT);
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ amountUsed: amountCents || PM_CACHE_FLOOR_AMOUNT, details }, null, 2) };
      } catch (err) {
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ error: err.message || String(err) }) };
      }
    }

    // Temporary diagnostic: /api/create-payment-intent?debug=account — identifies exactly which
    // Stripe account this site's key belongs to (id/name/email only, never the key itself), so it
    // can be cross-checked against whatever account is open in the Stripe Dashboard in the browser.
    if (event.queryStringParameters && event.queryStringParameters.debug === 'account') {
      try {
        const res = await fetch('https://api.stripe.com/v1/account', {
          headers: { 'Authorization': 'Bearer ' + sk, 'Stripe-Version': '2023-10-16' }
        });
        const data = await res.json();
        if (data.error) {
          return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ error: data.error.message }) };
        }
        return {
          statusCode: 200,
          headers: corsHeaders(),
          body: JSON.stringify({
            accountId: data.id,
            businessName: (data.business_profile && data.business_profile.name) || data.settings?.dashboard?.display_name || null,
            email: data.email || null,
            country: data.country || null,
            defaultCurrency: data.default_currency || null,
            chargesEnabled: data.charges_enabled,
            payoutsEnabled: data.payouts_enabled,
            keyMode: sk.startsWith('sk_live_') ? 'LIVE' : sk.startsWith('sk_test_') ? 'TEST' : 'unknown'
          }, null, 2)
        };
      } catch (err) {
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ error: err.message || String(err) }) };
      }
    }

    // Temporary diagnostic (read-only): /api/create-payment-intent?debug=domain-status — checks the
    // current Apple Pay / Google Pay / Link verification status for this domain, no mutation.
    if (event.queryStringParameters && event.queryStringParameters.debug === 'domain-status') {
      try {
        const domain = event.queryStringParameters.domain || 'cbgrillz.com';
        const res = await fetch('https://api.stripe.com/v1/payment_method_domains?domain_name=' + encodeURIComponent(domain), {
          headers: { 'Authorization': 'Bearer ' + sk, 'Stripe-Version': '2023-10-16' }
        });
        const data = await res.json();
        const record = data.data && data.data[0];
        if (!record) {
          return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ error: 'Domain not registered', raw: data }) };
        }
        return {
          statusCode: 200,
          headers: corsHeaders(),
          body: JSON.stringify({
            domain: record.domain_name, enabled: record.enabled,
            applePay: record.apple_pay, googlePay: record.google_pay, link: record.link, paypal: record.paypal
          }, null, 2)
        };
      } catch (err) {
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ error: err.message || String(err) }) };
      }
    }

    try {
      const types = await resolveTypesOnly(sk, amountCents);
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ paymentMethodTypes: types }) };
    } catch (err) {
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ paymentMethodTypes: pmCache }) };
    }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  // 5 checkout attempts per IP per 10 minutes
  if (rateLimit(ip, 5, 10 * 60 * 1000)) {
    return { statusCode: 429, headers: corsHeaders(), body: JSON.stringify({ error: 'Too many requests — please wait a few minutes.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { amount, currency, description, customer_email, metadata } = body;

  if (!amount || amount < 50) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid amount' }) };
  }

  try {
    const baseParams = {
      amount: String(Math.round(amount)),
      currency: currency || 'eur',
      description: sanitize(description, 200) || 'CB Grillz Order',
      receipt_email: sanitize(customer_email, 100),
    };

    // Whitelist + sanitize metadata fields — never forward arbitrary client-supplied keys into Stripe metadata.
    if (metadata) {
      baseParams['metadata[orderRef]'] = sanitize(metadata.orderRef, 40);
      baseParams['metadata[name]'] = sanitize(metadata.name, 120);
      baseParams['metadata[email]'] = sanitize(metadata.email, 100);
      baseParams['metadata[phone]'] = sanitize(metadata.phone, 30);
      baseParams['metadata[address]'] = sanitize(metadata.address, 300);
      baseParams['metadata[items]'] = sanitize(metadata.items, 500);
      baseParams['metadata[subtotal]'] = sanitize(metadata.subtotal, 20);
      baseParams['metadata[shipping]'] = sanitize(metadata.shipping, 20);
      baseParams['metadata[total]'] = sanitize(metadata.total, 20);
      baseParams['metadata[discountCode]'] = sanitize(metadata.discountCode, 30);
      baseParams['metadata[discountAmount]'] = sanitize(metadata.discountAmount, 20);
    }

    // Adaptive method resolution — see resolveAndCreate() above. Tries every method the
    // account might have active and safely narrows down instead of hand-maintaining a list.
    const { types, attempt } = await resolveAndCreate(sk, baseParams);
    const data = attempt.data;

    if (data.error) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: data.error.message }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ clientSecret: data.client_secret, paymentMethodTypes: types })
    };

  } catch(err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};
