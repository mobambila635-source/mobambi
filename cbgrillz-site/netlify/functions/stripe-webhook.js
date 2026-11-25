// ============================================================
// CB GRILLZ — Netlify Function
// Stripe webhook — reconciliation backstop for paid orders.
// The client already writes the order to Firebase right after a
// successful confirmPayment(), so this only fills in orders that
// never made it there (tab closed mid-redirect for Klarna/Clearpay/
// Revolut Pay, etc.).
// ============================================================
// DEPLOY:
// 1. Place this file at: netlify/functions/stripe-webhook.js
// 2. Netlify dashboard → Site → Environment Variables
//    Add: STRIPE_SECRET_KEY = sk_live_...
//    Add: STRIPE_WEBHOOK_SECRET = whsec_... (from Stripe Dashboard → Webhooks)
// 3. Stripe Dashboard → Developers → Webhooks → Add endpoint:
//    URL: https://<your-site>.netlify.app/api/stripe-webhook
//    Event: payment_intent.succeeded
// ============================================================

const crypto = require('crypto');

const FB_BASE = 'https://zpvisuals2-da861-default-rtdb.firebaseio.com/cbgrillz';
const FB_SECRET = 'teTSYFHtMSgJKMp4oqhXbQhBb068H2FiXYV2GAao'; // Firebase legacy database secret — matches netlify/functions/db-write.js. Needed because cbgrillz.write is now locked to false; without this the backstop write below silently fails.
const WEB3FORMS_KEY = 'c7495b6a-17dd-4b5d-bf19-bf8da020fe93';

function verifySignature(payload, sig, secret) {
  if (!sig || !secret) return false;
  const timestamp = sig.split(',').find(p => p.startsWith('t='))?.split('=')[1];
  const signatures = sig.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!timestamp || !signatures.length) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return signatures.some(s => {
    try { return crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
  });
}

async function fbGetJson(path) {
  const res = await fetch(`${FB_BASE}/${path}.json`);
  if (!res.ok) return null;
  return res.json();
}
async function fbPut(path, value) {
  const res = await fetch(`${FB_BASE}/${path}.json?auth=${FB_SECRET}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  if (!res.ok) throw new Error('Firebase write failed: ' + res.status);
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  if (!verifySignature(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let webhookEvent;
  try { webhookEvent = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: 'Invalid payload' }; }

  if (webhookEvent.type !== 'payment_intent.succeeded') return { statusCode: 200, body: 'ok' };

  const intent = webhookEvent.data.object;
  const meta = intent.metadata || {};
  const orderRef = meta.orderRef;
  if (!orderRef) return { statusCode: 200, body: 'ok' };

  try {
    // Only backstop-write if the client never made it to Firebase (e.g. tab closed during a
    // Klarna/Clearpay/Revolut Pay redirect). Never clobber a richer client-written record.
    const existing = await fbGetJson(`orders/${orderRef}`);
    if (!existing) {
      const order = {
        orderRef,
        name: meta.name || '',
        email: meta.email || '',
        phone: meta.phone || '',
        address: meta.address || '',
        items: meta.items || '',
        subtotal: Number(meta.subtotal || 0),
        shipping: Number(meta.shipping || 0),
        total: Number(meta.total || 0),
        status: 'paid',
        currency: (intent.currency || 'eur').toUpperCase(),
        stripePaymentIntent: intent.id,
        ts: Date.now(),
        source: 'webhook_backstop',
      };
      await fbPut(`orders/${orderRef}`, order);

      if (WEB3FORMS_KEY) {
        await fetch('https://api.web3forms.com/submit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_key: WEB3FORMS_KEY,
            subject: 'New Order (webhook backstop) — CB Grillz — ' + order.name,
            from_name: 'CB Grillz Website',
            name: order.name, email: order.email,
            message: 'New order paid (client-side write did not arrive, recovered via webhook)!\n\n' +
              'Order Ref: ' + orderRef + '\nCustomer: ' + order.name + '\nEmail: ' + order.email + '\nPhone: ' + order.phone +
              '\nItems: ' + order.items + '\nSubtotal: €' + order.subtotal.toFixed(2) + '\nShipping: €' + order.shipping.toFixed(2) +
              '\nTotal Paid: €' + order.total.toFixed(2) +
              '\nShip To: ' + order.address,
          }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    // Stripe retries on non-2xx, but our own logic errors shouldn't cause endless retries for a bad record.
    return { statusCode: 200, body: 'ok (logged error)' };
  }

  return { statusCode: 200, body: 'ok' };
};
