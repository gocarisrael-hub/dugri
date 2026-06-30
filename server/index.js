// Dugri server: serves the static site/ and a tiny JSON API for the
// collaborative word-collection feature.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const pelecard = require('./pelecard');

const app = express();
app.use(express.json({ limit: '1mb' }));
// PeleCard posts its server-side callback as a urlencoded form; accept both.
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Absolute base URL for the PeleCard return/callback URLs. We require an
// explicit PUBLIC_BASE_URL and never derive it from request headers: a spoofed
// Host header would otherwise redirect the payment callback to an attacker, so
// a real charge would never reach us. Returns null when unconfigured.
function paymentBaseUrl() {
  return process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : null;
}

// Shallow+nested redaction of secret-ish fields for debug logging (the
// ConfirmationKey is the anti-forgery secret; card/cvv/token must never be
// logged either).
function redactSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (/confirm|cvv|card|token|password/i.test(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object') out[k] = redactSecrets(v);
    else out[k] = v;
  }
  return out;
}

const SITE_DIR = path.join(__dirname, '..', 'site');

function publicView(c) {
  const words = db.listWords(c.id);
  return {
    id: c.id,
    honoree_name: c.honoree_name,
    status: db.effectiveStatus(c),
    expires_at: c.expires_at,
    // Whether the order has been marked paid (manually in admin, or by the
    // PeleCard callback). Drives the pay-to-unlock prompts on collect.html.
    // The address is NOT exposed.
    paid: !!(c.order && c.order.paid),
    // Whether online card payment is available (PeleCard credentials present).
    // Lets collect.html show the credit-card button only when it will work.
    card_enabled: pelecard.isConfigured(),
    count: words.length,
    words: words.map((w) => ({
      id: w.id,
      text: w.text,
      added_by: w.added_by,
      created_at: w.created_at,
    })),
  };
}

// Create a collection -> returns the secret owner_token (only time it's sent).
app.post('/api/collections', (req, res) => {
  const b = req.body || {};
  const name = (b.honoree_name || '').trim();
  if (!name) return res.status(400).json({ error: 'honoree_name required' });
  const c = db.createCollection(name, {
    email: b.email,
    phone: b.phone,
    design: b.design,
    color: b.color,
    chasers: b.chasers,
  });
  res.status(201).json({ id: c.id, owner_token: c.owner_token, expires_at: c.expires_at });
});

// Admin (orders) — protected by a shared secret key (ADMIN_KEY env).
// In production ADMIN_KEY must be set; in dev it falls back to a local default.
const ADMIN_KEY =
  process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? null : 'dugri-admin');
function adminKeyOk(provided) {
  if (!ADMIN_KEY) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.get('/api/admin/collections', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin disabled: set ADMIN_KEY' });
  if (!adminKeyOk(req.query.key)) return res.status(403).json({ error: 'forbidden' });
  res.json({ collections: db.listAllCollections() });
});

// Admin: mark an order as paid.
app.post('/api/admin/collections/:id/paid', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin disabled: set ADMIN_KEY' });
  if (!adminKeyOk(req.query.key)) return res.status(403).json({ error: 'forbidden' });
  if (!db.markPaid(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Public read: anyone with the link can see the words.
app.get('/api/collections/:id', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(publicView(c));
});

// Add words (rejected when closed/expired).
app.post('/api/collections/:id/words', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const words = Array.isArray(req.body && req.body.words) ? req.body.words : [];
  if (!words.length) return res.status(400).json({ error: 'words required' });
  if (words.length > 500) return res.status(400).json({ error: 'too many words at once' });
  const r = db.addWords(req.params.id, words, req.body && req.body.added_by);
  if (r && r.closed) return res.status(409).json({ error: 'collection closed' });
  res.json({ added: r.added, skipped: r.skipped, count: db.listWords(req.params.id).length });
});

// Owner-only: close collection.
app.post('/api/collections/:id/close', (req, res) => {
  const token = req.body && req.body.owner_token;
  if (!db.closeCollection(req.params.id, token)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ status: 'closed' });
});

// Owner-only: set the order (version + price + optional delivery address).
app.post('/api/collections/:id/order', (req, res) => {
  const b = req.body || {};
  const r = db.setOrder(req.params.id, b.owner_token, {
    version: b.version,
    address: b.address,
  });
  if (r && r.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (r && r.error) return res.status(400).json({ error: r.error });
  res.json({ version: r.version, total: r.total });
});

// Owner-only: delete a word (moderation).
app.delete('/api/collections/:id/words/:wordId', (req, res) => {
  const token = req.body && req.body.owner_token;
  if (!db.deleteWord(req.params.id, req.params.wordId, token)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ ok: true });
});

// Owner-only: start a PeleCard card payment for this collection's order.
// Persists/refreshes the order first (same validation as /order), then asks
// PeleCard for an iframe URL and stashes the ConfirmationKey for later
// verification. Returns { url } for the browser to load in an <iframe>.
app.post('/api/collections/:id/pay/init', async (req, res) => {
  if (!pelecard.isConfigured()) {
    return res.status(503).json({ error: 'card payment not configured' });
  }
  const base = paymentBaseUrl();
  if (!base) return res.status(503).json({ error: 'payment base url not configured' });

  const b = req.body || {};
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== b.owner_token) return res.status(403).json({ error: 'forbidden' });
  // Never re-open payment on an order that is already paid (re-clicking the card
  // button must not rebuild the order and discard the recorded payment).
  if (c.order && c.order.paid) return res.status(409).json({ error: 'already paid' });

  // Reuse an existing unpaid order of the same non-delivery version so its
  // in-flight ConfirmationKeys survive a second init; otherwise (re)create it
  // (delivery always re-set to capture the latest address).
  let order = c.order;
  const reuse = order && !order.paid && order.version === b.version && b.version !== 'delivery';
  if (!reuse) {
    order = db.setOrder(req.params.id, b.owner_token, { version: b.version, address: b.address });
    if (order && order.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    if (order && order.error) return res.status(400).json({ error: order.error });
  }

  try {
    const { url, confirmationKey } = await pelecard.init({
      amountNis: order.total,
      paramX: req.params.id,
      urls: {
        goodUrl: base + '/pay-done.html',
        errorUrl: base + '/pay-done.html?error=1',
        serverGoodUrl: base + '/api/payment/callback',
        serverErrorUrl: base + '/api/payment/callback?error=1',
      },
    });
    db.recordPaymentInit(req.params.id, { confirmationKey });
    res.json({ url, total: order.total });
  } catch (e) {
    res.status(502).json({ error: 'payment init failed' });
  }
});

// PeleCard server-side callback (ServerSideGoodFeedbackURL). PeleCard POSTs the
// transaction result here. We locate the order by ParamX (the collection id we
// sent at init), verify status + ConfirmationKey + amount, and only then mark
// it paid. Always answer 200 so PeleCard doesn't retry a handled callback.
app.post('/api/payment/callback', (req, res) => {
  // Temporary diagnostics for the first real charge: PeleCard's callback field
  // names can vary by account, and parseCallback() guesses common ones. With
  // PELECARD_DEBUG=1 we log the raw body once so we can confirm/fix the mapping.
  // Off by default (no payment data in logs unless explicitly enabled).
  if (process.env.PELECARD_DEBUG === '1') {
    console.log('[pelecard callback] raw body:', JSON.stringify(redactSecrets(req.body || {})));
  }
  const parsed = pelecard.parseCallback(req.body || {});
  const id = parsed.paramX;
  const c = id && db.getCollection(id);
  if (c && c.order) {
    const expected = {
      confirmationKeys: (c.order.pelecard && c.order.pelecard.confirmation_keys) || [],
      amountNis: c.order.total,
    };
    if (!c.order.paid && pelecard.verifyCallback(parsed, expected)) {
      db.markPaid(id, {
        method: 'pelecard',
        transactionId: parsed.transactionId,
        approvalNo: parsed.approvalNo,
      });
    }
  }
  res.json({ ok: true });
});

// Unknown API routes -> JSON 404 (must come before static/catch-all).
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Static site (so /collect resolves to collect.html, etc.). HTML is served
// with no-cache so visitors always get the latest page (and the iPhone/Instagram
// browsers stop showing a stale copy); other assets keep their default validators.
app.use(
  express.static(SITE_DIR, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Navigation fallback: serve the landing page only for extension-less routes.
// A request for a missing asset (it has a file extension) gets a real 404
// instead of the HTML homepage, which in-app browsers (Instagram) mishandle.
app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.status(404).type('txt').send('Not found');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(SITE_DIR, 'index.html'));
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`dugri server listening on ${PORT}`));
}

module.exports = app;
