// ============================================================
// CB GRILLZ — Google Apps Script
// Sends the CLIENT a confirmation email for these events:
//   - type=appointment      → appointment request received
//   - type=order_confirmed  → order paid in full at checkout
//   - type=custom_order     → admin created a custom quote, client can pay
//   - type=deposit          → (unused) order placed / deposit paid —
//     kept for a future split deposit+balance flow, not wired up today
//     since checkout currently takes full payment upfront.
//   - type=balance          → (unused) balance paid — same as above.
// The site owner is notified separately via Web3Forms for all
// events — this script only handles client-facing emails.
// ============================================================
// DEPLOY (first time):
// 1. Go to script.google.com → New Project. Delete the default
//    code and paste this whole file in.
// 2. Change OWNER_EMAIL below to the real inbox that should show
//    as the reply-to address on these emails.
// 3. Deploy → New deployment → type: "Web app".
//    - Execute as: Me
//    - Who has access: Anyone
// 4. Click Deploy, authorize the script with your Google account
//    when prompted, then copy the Web App URL it gives you
//    (ends in /exec).
// 5. Paste that URL into CB Grillz admin → Settings →
//    "Google Apps Script Web App URL (client confirmation emails)".
//
// UPDATING (already deployed before, e.g. re-pasting this file):
// You do NOT need a new URL. In script.google.com: paste this
// updated code over the old code → Deploy → Manage deployments →
// click the pencil/edit icon on the existing deployment → Version:
// "New version" → Deploy. The existing /exec URL keeps working.
// ============================================================

var OWNER_EMAIL = 'cbgrillz@gmail.com';
var BUSINESS_ADDRESS = 'Lassallestraße 46a, 21073 Hamburg-Harburg, Germany';
// Sender address on the verified domain. Doesn't need to be a real inbox —
// replies go to OWNER_EMAIL via the reply-to header set below.
var FROM_EMAIL = 'CB Grillz <no-reply@cbgrillz.com>';

// ------------------------------------------------------------
// Sends via Resend (domain-verified, better inbox placement).
// Reads the API key from Script Properties — Project Settings →
// Script Properties → RESEND_API_KEY — never hardcoded here.
// Falls back to GmailApp if no key is set yet, or if the Resend
// call fails for any reason, so emails never silently stop sending.
// ------------------------------------------------------------
function sendClientEmail(to, subject, m) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('RESEND_API_KEY');

  if (apiKey) {
    try {
      var res = UrlFetchApp.fetch('https://api.resend.com/emails', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + apiKey },
        payload: JSON.stringify({
          from: FROM_EMAIL,
          to: [to],
          reply_to: OWNER_EMAIL,
          subject: subject,
          html: m.html,
          text: m.text
        }),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code >= 200 && code < 300) return; // sent successfully via Resend
      Logger.log('Resend failed (' + code + '): ' + res.getContentText());
      // fall through to Gmail fallback below
    } catch (err) {
      Logger.log('Resend error: ' + err);
      // fall through to Gmail fallback below
    }
  }

  // Fallback: Gmail (used only if no API key is set, or Resend call failed)
  GmailApp.sendEmail(to, subject, m.text, {
    htmlBody: m.html,
    name: 'CB Grillz',
    replyTo: OWNER_EMAIL
  });
}

function doGet(e) {
  var type = e.parameter.type || 'appointment';
  var to = e.parameter.to || '';
  if (!to) return ContentService.createTextOutput('OK');

  if (type === 'deposit') {
    sendClientEmail(to, 'Order Confirmed — CB Grillz', buildDepositEmail(e.parameter));
  } else if (type === 'balance') {
    sendClientEmail(to, 'Payment Complete — CB Grillz', buildBalanceEmail(e.parameter));
  } else if (type === 'custom_order') {
    sendClientEmail(to, 'Your Custom Quote — CB Grillz', buildCustomOrderEmail(e.parameter));
  } else if (type === 'order_confirmed') {
    sendClientEmail(to, 'Order Confirmed — CB Grillz', buildOrderConfirmedEmail(e.parameter));
  } else if (type === 'design_request') {
    sendClientEmail(to, 'Design Request Received — CB Grillz', buildDesignRequestEmail(e.parameter));
  } else {
    sendClientEmail(to, 'Appointment Request Received — CB Grillz', buildAppointmentEmail(e.parameter));
  }

  return ContentService.createTextOutput('OK');
}

// ------------------------------------------------------------
// Plain-text footer shared by every email's text alternative
// ------------------------------------------------------------
function plainFooter() {
  return '\n\n--\nQuestions? Reply to this email or find us on Instagram @cbgrillz\nCB Grillz · Hamburg, Germany\n' + BUSINESS_ADDRESS;
}

// ------------------------------------------------------------
// Shared wrapper — header/footer identical across all email types
// ------------------------------------------------------------
function wrapEmail(headerTitle, bodyHtml) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
    + '<body style="margin:0;padding:0;background:#F5F5F5;font-family:\'Helvetica Neue\',Arial,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:40px 20px;">'
    + '<tr><td align="center">'
    + '<table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;max-width:560px;width:100%;">'

      // Header
      + '<tr><td style="padding:40px;background:#0A0A0A;text-align:center;">'
        + '<div style="font-size:11px;letter-spacing:5px;text-transform:uppercase;color:#E3B534;margin-bottom:8px;">CB Grillz</div>'
        + '<div style="font-size:22px;font-weight:300;color:#ffffff;letter-spacing:2px;">' + headerTitle + '</div>'
      + '</td></tr>'

      // Body (caller-supplied)
      + '<tr><td style="padding:36px 40px;">' + bodyHtml + '</td></tr>'

      // Footer
      + '<tr><td style="padding:20px 40px;text-align:center;border-top:1px solid #EFEFEF;">'
        + '<p style="color:#bbb;font-size:11px;letter-spacing:1px;margin:0 0 4px;">CB GRILLZ · HAMBURG, GERMANY</p>'
        + '<p style="color:#ccc;font-size:10.5px;letter-spacing:0.5px;margin:0;">' + BUSINESS_ADDRESS + '</p>'
      + '</td></tr>'

    + '</table></td></tr></table></body></html>';
}

// ------------------------------------------------------------
// Appointment request received
// ------------------------------------------------------------
function buildAppointmentEmail(p) {
  var name = p.name || '';
  var item = p.item || '';
  var date = p.date || '';
  var time = p.time || '';
  var whenLine = (date || time)
    ? ('Preferred: ' + (date || 'Date not specified') + (time ? (' at ' + time) : ''))
    : 'No preferred day/time given — we\'ll suggest some options.';
  var whenLineDE = (date || time)
    ? ('Bevorzugt: ' + (date || 'Kein Datum angegeben') + (time ? (' um ' + time) : ''))
    : 'Kein bevorzugter Tag/Uhrzeit angegeben — wir schlagen dir gerne Optionen vor.';

  var langTag = '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E3B534;margin-bottom:14px;">Deutsch</div>';
  var bodyDE = langTag
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hallo ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Vielen Dank für deine Anfrage — wir haben deine Terminanfrage erhalten und bestätigen dir Tag und Uhrzeit in Kürze.</p>'
    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Artikel</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + item + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Gewünschter Termin</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + whenLineDE + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Adresse</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">' + BUSINESS_ADDRESS + '</div>'
    + '</div>'
    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:8px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">Wie geht es weiter</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0;">Wir melden uns, um deinen Termin zu bestätigen, oder schlagen dir alternative Zeiten vor. Antworte einfach auf diese E-Mail, falls sich deine Pläne ändern.</p>'
    + '</div>';

  var bodyEN = '<hr style="border:none;border-top:1px solid #EFEFEF;margin:28px 0;">'
    + '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:14px;">English</div>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hi ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Thanks for reaching out — we\'ve received your appointment request and will confirm the exact day and time with you shortly.</p>'
    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Item</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + item + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Requested Time</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + whenLine + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Location</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">' + BUSINESS_ADDRESS + '</div>'
    + '</div>'
    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">What Happens Next</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0;">We\'ll reply to confirm your appointment, or suggest alternative times if needed. Reply to this email any time if your plans change.</p>'
    + '</div>';

  var body = bodyDE + bodyEN
    + '<p style="color:#aaa;font-size:12px;line-height:1.7;margin:0;">Fragen? Antworte auf diese E-Mail oder finde uns auf Instagram / Questions? Reply to this email or find us on Instagram <span style="color:#0A0A0A;">@cbgrillz</span></p>';

  var text = 'DEUTSCH\n\n'
    + 'Hallo ' + name + ',\n\n'
    + 'Vielen Dank für deine Anfrage — wir haben deine Terminanfrage erhalten und bestätigen dir Tag und Uhrzeit in Kürze.\n\n'
    + 'ARTIKEL: ' + item + '\n'
    + 'GEWÜNSCHTER TERMIN: ' + whenLineDE + '\n'
    + 'ADRESSE: ' + BUSINESS_ADDRESS + '\n\n'
    + 'WIE GEHT ES WEITER\n'
    + 'Wir melden uns, um deinen Termin zu bestätigen, oder schlagen dir alternative Zeiten vor. Antworte einfach auf diese E-Mail, falls sich deine Pläne ändern.\n\n'
    + '----------\n\nENGLISH\n\n'
    + 'Hi ' + name + ',\n\n'
    + 'Thanks for reaching out — we\'ve received your appointment request and will confirm the exact day and time with you shortly.\n\n'
    + 'ITEM: ' + item + '\n'
    + 'REQUESTED TIME: ' + whenLine + '\n'
    + 'LOCATION: ' + BUSINESS_ADDRESS + '\n\n'
    + 'WHAT HAPPENS NEXT\n'
    + 'We\'ll reply to confirm your appointment, or suggest alternative times if needed. Reply to this email any time if your plans change.'
    + plainFooter();

  return { html: wrapEmail('APPOINTMENT REQUEST RECEIVED', body), text: text };
}

// ------------------------------------------------------------
// Customer submitted a "Design Your Own" request from the site
// (category, material, notes, optional reference photo). No price
// yet — admin reviews and follows up with a custom quote.
// ------------------------------------------------------------
function buildDesignRequestEmail(p) {
  var name = p.name || '';
  var item = p.item || '';
  var notes = p.notes || '';

  var bodyDE = '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E3B534;margin-bottom:14px;">Deutsch</div>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hallo ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Danke für deine Design-Anfrage — wir haben sie (und dein Referenzfoto, falls du eines geschickt hast) erhalten und schauen sie uns an.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Gewünscht</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:' + (notes ? '14px' : '0') + ';">' + item + '</div>'
      + (notes ? ('<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Notizen</div>'
        + '<div style="font-size:14px;color:#0A0A0A;white-space:pre-line;">' + notes + '</div>') : '')
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">Wie geht es weiter</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0;">Wir melden uns innerhalb von 1-2 Werktagen mit einem festen Angebot und einem Zahlungslink. Antworte jederzeit auf diese E-Mail, falls du noch etwas ergänzen möchtest.</p>'
    + '</div>';

  var bodyEN = '<hr style="border:none;border-top:1px solid #EFEFEF;margin:28px 0;">'
    + '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E3B534;margin-bottom:14px;">English</div>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hi ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Thanks for your design request — we\'ve received it (and your reference photo, if you sent one) and we\'re taking a look.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Requested</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:' + (notes ? '14px' : '0') + ';">' + item + '</div>'
      + (notes ? ('<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Notes</div>'
        + '<div style="font-size:14px;color:#0A0A0A;white-space:pre-line;">' + notes + '</div>') : '')
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">What Happens Next</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0;">We\'ll get back to you within 1-2 business days with a firm quote and a payment link. Reply to this email any time if you want to add anything.</p>'
    + '</div>';

  var body = bodyDE + bodyEN
    + '<p style="color:#aaa;font-size:12px;line-height:1.7;margin:0;">Fragen? Antworte auf diese E-Mail oder finde uns auf Instagram / Questions? Reply to this email or find us on Instagram <span style="color:#0A0A0A;">@cbgrillz</span></p>';

  var text = 'DEUTSCH\n\n'
    + 'Hallo ' + name + ',\n\n'
    + 'Danke für deine Design-Anfrage — wir haben sie (und dein Referenzfoto, falls du eines geschickt hast) erhalten und schauen sie uns an.\n\n'
    + 'GEWÜNSCHT: ' + item + '\n'
    + (notes ? ('NOTIZEN: ' + notes + '\n') : '')
    + '\nWIE GEHT ES WEITER\n'
    + 'Wir melden uns innerhalb von 1-2 Werktagen mit einem festen Angebot und einem Zahlungslink. Antworte jederzeit auf diese E-Mail, falls du noch etwas ergänzen möchtest.\n\n'
    + '----------\n\nENGLISH\n\n'
    + 'Hi ' + name + ',\n\n'
    + 'Thanks for your design request — we\'ve received it (and your reference photo, if you sent one) and we\'re taking a look.\n\n'
    + 'REQUESTED: ' + item + '\n'
    + (notes ? ('NOTES: ' + notes + '\n') : '')
    + '\nWHAT HAPPENS NEXT\n'
    + 'We\'ll get back to you within 1-2 business days with a firm quote and a payment link. Reply to this email any time if you want to add anything.'
    + plainFooter();

  return { html: wrapEmail('DESIGN REQUEST RECEIVED', body), text: text };
}

// ------------------------------------------------------------
// Order paid in full at checkout (current site flow — no
// deposit/balance split)
// ------------------------------------------------------------
function buildOrderConfirmedEmail(p) {
  var name = p.name || '';
  var orderRef = p.orderRef || '';
  var items = p.items || '';
  var total = p.total || '0.00';

  var bodyDE = '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E3B534;margin-bottom:14px;">Deutsch</div>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hallo ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Vielen Dank für deine Bestellung — die Zahlung ist vollständig eingegangen und wir legen los.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Bestellnummer</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + orderRef + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:14px;">Artikel</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + items + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Gesamtbetrag</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">€' + total + '</div>'
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">Wie geht es weiter</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0;">Wir melden uns mit den nächsten Schritten (Abholung/Versand). Antworte jederzeit auf diese E-Mail, falls du Fragen hast.</p>'
    + '</div>';

  var bodyEN = '<hr style="border:none;border-top:1px solid #EFEFEF;margin:28px 0;">'
    + '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E3B534;margin-bottom:14px;">English</div>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hi ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Thanks for your order — payment has been received in full and we\'re getting started.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Order Ref</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + orderRef + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:14px;">Items</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + items + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Total Paid</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">€' + total + '</div>'
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">What Happens Next</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0;">We\'ll be in touch with next steps (collection/shipping). Reply to this email any time if you have questions.</p>'
    + '</div>';

  var body = bodyDE + bodyEN
    + '<p style="color:#aaa;font-size:12px;line-height:1.7;margin:0;">Fragen? Antworte auf diese E-Mail oder finde uns auf Instagram / Questions? Reply to this email or find us on Instagram <span style="color:#0A0A0A;">@cbgrillz</span></p>';

  var text = 'DEUTSCH\n\n'
    + 'Hallo ' + name + ',\n\n'
    + 'Vielen Dank für deine Bestellung — die Zahlung ist vollständig eingegangen und wir legen los.\n\n'
    + 'BESTELLNUMMER: ' + orderRef + '\n'
    + 'ARTIKEL: ' + items + '\n'
    + 'GESAMTBETRAG: €' + total + '\n\n'
    + 'WIE GEHT ES WEITER\n'
    + 'Wir melden uns mit den nächsten Schritten (Abholung/Versand). Antworte jederzeit auf diese E-Mail, falls du Fragen hast.\n\n'
    + '----------\n\nENGLISH\n\n'
    + 'Hi ' + name + ',\n\n'
    + 'Thanks for your order — payment has been received in full and we\'re getting started.\n\n'
    + 'ORDER REF: ' + orderRef + '\n'
    + 'ITEMS: ' + items + '\n'
    + 'TOTAL PAID: €' + total + '\n\n'
    + 'WHAT HAPPENS NEXT\n'
    + 'We\'ll be in touch with next steps (collection/shipping). Reply to this email any time if you have questions.'
    + plainFooter();

  return { html: wrapEmail('ORDER CONFIRMED', body), text: text };
}

// ------------------------------------------------------------
// Order placed / deposit paid (unused — kept for a future
// split deposit+balance flow)
// ------------------------------------------------------------
function buildDepositEmail(p) {
  var name = p.name || '';
  var orderRef = p.orderRef || '';
  var items = p.items || '';
  var depositPaid = p.depositPaid || '0.00';
  var balanceDue = p.balanceDue || '0.00';
  var balanceLink = p.balanceLink || '';

  var body = '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hi ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Thanks for your order — your deposit has been received and we\'re getting started.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Order Ref</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + orderRef + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Items</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + items + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Deposit Paid</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">€' + depositPaid + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Balance Due</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">€' + balanceDue + '</div>'
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">What Happens Next</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0 0 14px;">We\'ll be in touch about your order. When it\'s ready, use the link below to pay the remaining balance.</p>'
      + (balanceLink ? ('<a href="' + balanceLink + '" style="display:inline-block;background:#0A0A0A;color:#ffffff;font-size:12px;letter-spacing:1px;text-transform:uppercase;text-decoration:none;padding:12px 22px;">Pay Balance</a>') : '')
    + '</div>'

    + '<p style="color:#aaa;font-size:12px;line-height:1.7;margin:0;">Questions? Reply to this email or find us on Instagram <span style="color:#0A0A0A;">@cbgrillz</span></p>';

  var text = 'Hi ' + name + ',\n\n'
    + 'Thanks for your order — your deposit has been received and we\'re getting started.\n\n'
    + 'ORDER REF: ' + orderRef + '\n'
    + 'ITEMS: ' + items + '\n'
    + 'DEPOSIT PAID: €' + depositPaid + '\n'
    + 'BALANCE DUE: €' + balanceDue + '\n\n'
    + 'WHAT HAPPENS NEXT\n'
    + 'We\'ll be in touch about your order. When it\'s ready, use the link below to pay the remaining balance.'
    + (balanceLink ? ('\n' + balanceLink) : '')
    + plainFooter();

  return { html: wrapEmail('ORDER CONFIRMED', body), text: text };
}

// ------------------------------------------------------------
// Balance paid / order complete
// ------------------------------------------------------------
function buildBalanceEmail(p) {
  var name = p.name || '';
  var orderRef = p.orderRef || '';
  var balancePaid = p.balancePaid || '0.00';

  var body = '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hi ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Your balance payment has been received — your order is now paid in full.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Order Ref</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + orderRef + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Balance Paid</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">€' + balancePaid + '</div>'
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">What Happens Next</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0;">We\'ll be in touch with next steps (collection/shipping). Reply to this email any time if you have questions.</p>'
    + '</div>'

    + '<p style="color:#aaa;font-size:12px;line-height:1.7;margin:0;">Questions? Reply to this email or find us on Instagram <span style="color:#0A0A0A;">@cbgrillz</span></p>';

  var text = 'Hi ' + name + ',\n\n'
    + 'Your balance payment has been received — your order is now paid in full.\n\n'
    + 'ORDER REF: ' + orderRef + '\n'
    + 'BALANCE PAID: €' + balancePaid + '\n\n'
    + 'WHAT HAPPENS NEXT\n'
    + 'We\'ll be in touch with next steps (collection/shipping). Reply to this email any time if you have questions.'
    + plainFooter();

  return { html: wrapEmail('PAYMENT COMPLETE', body), text: text };
}

// ------------------------------------------------------------
// Custom quote ready to pay (created by the owner in admin, e.g.
// after agreeing a price for gold/diamond grillz at an appointment)
// ------------------------------------------------------------
function buildCustomOrderEmail(p) {
  var name = p.name || '';
  var description = p.description || '';
  var price = p.price || '0.00';
  var payLink = p.payLink || '';

  var bodyDE = '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E3B534;margin-bottom:14px;">Deutsch</div>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hallo ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Danke für deine Geduld — hier ist dein individuelles Angebot. Sobald du bereit bist, nutze den Link unten, um deine Bestellung abzuschließen.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Artikel</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + description + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Preis</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">€' + price + '</div>'
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">Wie geht es weiter</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0 0 14px;">Klicke unten, um deine Bestellung anzusehen und sicher zu bezahlen — sie wird direkt zu deinem Warenkorb hinzugefügt.</p>'
      + (payLink ? ('<a href="' + payLink + '" style="display:inline-block;background:#0A0A0A;color:#ffffff;font-size:12px;letter-spacing:1px;text-transform:uppercase;text-decoration:none;padding:12px 22px;">Bestellung abschließen</a>') : '')
    + '</div>';

  var bodyEN = '<hr style="border:none;border-top:1px solid #EFEFEF;margin:28px 0;">'
    + '<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#E3B534;margin-bottom:14px;">English</div>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 24px;">Hi ' + name + ',</p>'
    + '<p style="color:#444;font-size:14px;line-height:1.75;margin:0 0 28px;">Thanks for your patience — here\'s your custom quote. When you\'re ready, use the link below to complete your order.</p>'

    + '<div style="background:#F5F5F5;padding:20px 24px;margin-bottom:24px;">'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Item</div>'
      + '<div style="font-size:15px;color:#0A0A0A;margin-bottom:14px;">' + description + '</div>'
      + '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-bottom:10px;">Price</div>'
      + '<div style="font-size:15px;color:#0A0A0A;">€' + price + '</div>'
    + '</div>'

    + '<div style="border-left:2px solid #E3B534;padding:16px 20px;margin-bottom:28px;">'
      + '<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0A0A0A;margin-bottom:10px;">What Happens Next</div>'
      + '<p style="color:#888;font-size:13px;line-height:1.85;margin:0 0 14px;">Click below to review your order and pay securely — it\'ll be added straight to your cart.</p>'
      + (payLink ? ('<a href="' + payLink + '" style="display:inline-block;background:#0A0A0A;color:#ffffff;font-size:12px;letter-spacing:1px;text-transform:uppercase;text-decoration:none;padding:12px 22px;">Complete Your Order</a>') : '')
    + '</div>';

  var body = bodyDE + bodyEN
    + '<p style="color:#aaa;font-size:12px;line-height:1.7;margin:0;">Fragen? Antworte auf diese E-Mail oder finde uns auf Instagram / Questions? Reply to this email or find us on Instagram <span style="color:#0A0A0A;">@cbgrillz</span></p>';

  var text = 'DEUTSCH\n\n'
    + 'Hallo ' + name + ',\n\n'
    + 'Danke für deine Geduld — hier ist dein individuelles Angebot. Sobald du bereit bist, nutze den Link unten, um deine Bestellung abzuschließen.\n\n'
    + 'ARTIKEL: ' + description + '\n'
    + 'PREIS: €' + price + '\n\n'
    + 'WIE GEHT ES WEITER\n'
    + 'Klicke auf den Link unten, um deine Bestellung anzusehen und sicher zu bezahlen — sie wird direkt zu deinem Warenkorb hinzugefügt.'
    + (payLink ? ('\n' + payLink) : '')
    + '\n\n----------\n\nENGLISH\n\n'
    + 'Hi ' + name + ',\n\n'
    + 'Thanks for your patience — here\'s your custom quote. When you\'re ready, use the link below to complete your order.\n\n'
    + 'ITEM: ' + description + '\n'
    + 'PRICE: €' + price + '\n\n'
    + 'WHAT HAPPENS NEXT\n'
    + 'Click the link below to review your order and pay securely — it\'ll be added straight to your cart.'
    + (payLink ? ('\n' + payLink) : '')
    + plainFooter();

  return { html: wrapEmail('YOUR CUSTOM QUOTE', body), text: text };
}
