// Dugri server: serves the static site/ and a tiny JSON API for the
// collaborative word-collection feature.
const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));

const SITE_DIR = path.join(__dirname, '..', 'site');

function publicView(c) {
  const words = db.listWords(c.id);
  return {
    id: c.id,
    honoree_name: c.honoree_name,
    status: db.effectiveStatus(c),
    expires_at: c.expires_at,
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
  const c = db.createCollection(name, { email: b.email, phone: b.phone });
  res.status(201).json({ id: c.id, owner_token: c.owner_token, expires_at: c.expires_at });
});

// Admin (orders) — protected by a shared secret key (ADMIN_KEY env).
const ADMIN_KEY = process.env.ADMIN_KEY || 'dugri-admin';
app.get('/api/admin/collections', (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  res.json({ collections: db.listAllCollections() });
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

// Owner-only: delete a word (moderation).
app.delete('/api/collections/:id/words/:wordId', (req, res) => {
  const token = (req.body && req.body.owner_token) || req.query.owner_token;
  if (!db.deleteWord(req.params.id, req.params.wordId, token)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ ok: true });
});

// Unknown API routes -> JSON 404 (must come before static/catch-all).
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Static site (so /collect resolves to collect.html, etc.).
app.use(express.static(SITE_DIR, { extensions: ['html'] }));

// Fallback to the landing page for any other GET.
app.get('*', (req, res) => res.sendFile(path.join(SITE_DIR, 'index.html')));

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`dugri server listening on ${PORT}`));
}

module.exports = app;
