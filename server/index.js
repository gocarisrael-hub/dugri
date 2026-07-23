// Dugri server: serves the static site/ and a tiny JSON API for the
// collaborative word-collection feature.
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const express = require('express');
const db = require('./db');
const pelecard = require('./pelecard');
const notify = require('./notify');
const validate = require('./validate');
const templates = require('./templates');
const playbook = require('./playbook');
const content = require('./content');
const contentImport = require('./content-import');
const designImages = require('./design-images');
const settings = require('./settings');
const whatsapp = require('./whatsapp');
const waState = require('./wa-state');
const { makeRateLimiter, makePreviewCache } = require('./preview-cache');

const app = express();
// Behind Railway's proxy: trust X-Forwarded-For so req.ip is the real client
// address (used to rate-limit coupon validation per client, not per proxy).
app.set('trust proxy', true);
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

const SITE_DIR = path.join(__dirname, '..', 'site');
// Repo root (so we can invoke the Python generator) and the private directory
// where produced order PDFs are written. GENERATED_DIR lives under server/ (NOT
// site/) so express.static never exposes it — the only way out is the
// admin-key-gated download route below.
const REPO_ROOT = path.join(__dirname, '..');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, 'generated');
const PYTHON_BIN = process.env.PYTHON || 'python3';
// Repo root the admin template-onboarding endpoint writes NEW private templates
// into (resources/canva/templates/<slug>/ + generator/themes.json). Overridable
// via TEMPLATE_ROOT so tests can point it at a throwaway scaffold and never touch
// the real repo. Max multipart upload size for that endpoint (several SVGs + two
// fonts).
const TEMPLATE_ROOT = process.env.TEMPLATE_ROOT || REPO_ROOT;
// Raised from 30mb: a full template is several SVGs + two fonts in ONE multipart
// request, and Canva-exported SVGs that embed raster images get large fast, so a
// legitimate upload was hitting the body-parser limit and coming back as a bare
// 413. Still env-overridable for an unusually heavy template.
const TEMPLATE_UPLOAD_LIMIT = process.env.TEMPLATE_UPLOAD_LIMIT || '100mb';
// Max multipart body for a single content-editor photo upload. The store caps the
// image itself at ~4MB (server/content.js IMAGE_CAP); this leaves headroom for the
// multipart envelope so a valid image is never rejected at the body-parser layer.
const CONTENT_IMAGE_UPLOAD_LIMIT = process.env.CONTENT_IMAGE_UPLOAD_LIMIT || '6mb';
// Max multipart body for a pawn-images upload: up to 4 customer photos, each
// capped at ~4MB by the store (server/content.js IMAGE_CAP), plus envelope room.
const PAWN_UPLOAD_LIMIT = process.env.PAWN_UPLOAD_LIMIT || '20mb';
// Hard cap on a single generation run (Chrome renders one page at a time, so a
// large deck is slow); the child is SIGKILLed past this and the request 504s.
const GENERATE_TIMEOUT_MS = Number(process.env.GENERATE_TIMEOUT_MS || 120000);

// Spawn the Python generator for one order and resolve { pages } on success.
// Writes the words to a temp file (cleaned up after), streams the theme +
// honoree + optional word-font/extra-fields as CLI args, captures stderr for a
// useful error, and enforces a timeout. Never leaks the child process.
function runGenerator({ theme, name, words, outPdf, wordFont, extraFields, chasers, customTitle }) {
  return new Promise((resolve, reject) => {
    let wordsFile;
    try {
      fs.mkdirSync(GENERATED_DIR, { recursive: true });
      wordsFile = path.join(os.tmpdir(), 'dugri-words-' + crypto.randomUUID() + '.txt');
      fs.writeFileSync(wordsFile, words.join('\n') + '\n', 'utf8');
    } catch (e) {
      return reject(e);
    }
    const args = [
      path.join(REPO_ROOT, 'generator', 'order_to_pdf.py'),
      theme,
      name,
      wordsFile,
      outPdf,
    ];
    if (wordFont) args.push('--word-font', wordFont);
    for (const [k, v] of Object.entries(extraFields || {})) {
      args.push('--field', `${k}=${v}`);
    }
    // Chasers add-on: the generator swaps in the theme's chasers board variant
    // when it ships one (else falls back to the normal board — additive).
    if (chasers) args.push('--chasers');
    // Custom title (F7): override the theme-derived title on the cards + board.
    // --title=<value> (single token) so a title that starts with '-' (e.g. "-40",
    // "-רווקות") is never parsed by argparse as an option and crash the generator.
    if (customTitle) args.push('--title=' + customTitle);
    const child = spawn(PYTHON_BIN, args, { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GENERATE_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(wordsFile);
      } catch {
        /* best-effort cleanup */
      }
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(wordsFile);
      } catch {
        /* best-effort cleanup */
      }
      if (timedOut) return reject(new Error('generation timed out'));
      if (code !== 0) {
        return reject(new Error((stderr || stdout || 'exit ' + code).trim().slice(0, 800)));
      }
      const m = /\((\d+) pages?\)/.exec(stdout);
      resolve({ pages: m ? Number(m[1]) : null });
    });
  });
}

// --- Order preview (public) ---------------------------------------------------
// The generator preview script + the shared word-font pool it draws from.
const PREVIEW_SCRIPT = path.join(REPO_ROOT, 'generator', 'preview.py');
const WORD_FONTS_DIR = path.join(REPO_ROOT, 'generator', 'word-fonts');
// One preview render is a single Python process that renders card + board + back;
// keep the cap short so a public request can't tie up the box. The child is
// SIGKILLed past this and the request 504s.
const PREVIEW_TIMEOUT_MS = Number(process.env.PREVIEW_TIMEOUT_MS || 40000);

// Preview gets its OWN rate-limit bucket (separate limit + map) from the coupon
// oracle, and an LRU/TTL result cache so repeated identical names return without
// spawning Chrome. Cache hits bypass the limiter entirely (they're free), so an
// eager typer revisiting names never 429s — and never touches the pay/coupon flow.
const previewRate = makeRateLimiter({
  limit: Number(process.env.PREVIEW_RATE_LIMIT || 60),
  windowMs: 60 * 1000,
  maxKeys: Number(process.env.COUPON_RATE_MAX_KEYS || 10000),
});
// Each entry holds base64 data-URLs for card + board + back, so cap the count LOW
// and the TTL SHORT: ~40 entries keeps the steady-state footprint modest (tens of
// MB) on a memory-constrained Railway instance while still absorbing a typer's
// repeats. Eviction stays bounded regardless.
const previewCache = makePreviewCache({
  max: Number(process.env.PREVIEW_CACHE_MAX || 40),
  ttlMs: Number(process.env.PREVIEW_CACHE_TTL_MS || 5 * 60 * 1000),
});

// The shared word-font choices ([{label,file}]), read fresh (tiny file). Returns
// [] when missing/unparseable so a bad file never crashes a preview request.
function wordFontOptions() {
  try {
    const opts = JSON.parse(fs.readFileSync(path.join(WORD_FONTS_DIR, 'options.json'), 'utf8'));
    return Array.isArray(opts) ? opts.filter((o) => o && o.file) : [];
  } catch {
    return [];
  }
}

// Spawn the preview generator and resolve { card, board, back } as PNG data URLs.
// A SINGLE preview.py run renders the card, the game board AND the personalized
// card back into a private temp dir; we read them back as base64 and always
// remove the dir. Enforces a timeout and never leaks the child process. board
// and back are present only when the theme has that artwork (card is required).
function runPreview({ theme, name, wordFont, extraFields, chasers, customTitle }) {
  return new Promise((resolve, reject) => {
    let outDir;
    try {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-preview-'));
    } catch (e) {
      return reject(e);
    }
    const cleanup = () => {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    };
    const args = [PREVIEW_SCRIPT, theme, name, outDir];
    if (wordFont) args.push('--word-font', wordFont);
    for (const [k, v] of Object.entries(extraFields || {})) {
      args.push('--field', `${k}=${v}`);
    }
    // Chasers add-on: preview the theme's chasers board variant when it ships one
    // (else the normal board — additive), matching what production will generate.
    if (chasers) args.push('--chasers');
    // Custom title (F7): preview the EXACT overriding title (WYSIWYG), matching
    // what production will render.
    // --title=<value> (single token) so a title that starts with '-' (e.g. "-40",
    // "-רווקות") is never parsed by argparse as an option and crash the generator.
    if (customTitle) args.push('--title=' + customTitle);
    const child = spawn(PYTHON_BIN, args, { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PREVIEW_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        cleanup();
        return reject(new Error('preview timed out'));
      }
      if (code !== 0) {
        cleanup();
        return reject(new Error((stderr || stdout || 'exit ' + code).trim().slice(0, 800)));
      }
      try {
        // The script prints a JSON line of the produced PNG paths (last line).
        const produced = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        const out = {};
        for (const key of ['card', 'board', 'back']) {
          if (produced[key] && fs.existsSync(produced[key])) {
            out[key] = 'data:image/png;base64,' + fs.readFileSync(produced[key]).toString('base64');
          }
        }
        cleanup();
        if (!out.card) return reject(new Error('preview produced no card image'));
        resolve(out);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  });
}

function publicView(c, { owner = false } = {}) {
  const words = db.listWords(c.id);
  const order = c.order;
  // A public caller may only re-submit an admin-created or paid order's own
  // version (see db.setOrder's lock policy). `locked` tells collect.html to show
  // ONLY that version; an ordinary unpaid public order is unlocked (all enabled
  // options shown). The delivery address is exposed ONLY to the owner (owner_token
  // matched) so an owner reloading a locked delivery order can prefill it without
  // re-typing — it is never leaked to the public/contributor view.
  const locked = !!(order && (order.paid || order.source === 'admin'));
  return {
    id: c.id,
    honoree_name: c.honoree_name,
    // Honoree gender ('male' | 'female' | null) for gendered question phrasing.
    gender: c.gender || null,
    // Generator theme (a generator/themes.json key) the order resolved to. Lets
    // collect.html pick the right idea-prompt set per event (kid-appropriate for a
    // child's birthday, couple prompts for an anniversary). Not sensitive.
    theme: c.theme || null,
    status: db.effectiveStatus(c),
    expires_at: c.expires_at,
    // Whether the order has been marked paid (manually in admin, or by the
    // PeleCard callback). Drives the pay-to-unlock prompts on collect.html.
    // The address is NOT exposed.
    paid: !!(c.order && c.order.paid),
    // The placed order's version + stored total (+ a `locked` flag; the delivery
    // address only when the owner is authenticated). collect.html LOCKS checkout
    // to a locked (admin-created / paid) order so it is paid at its own version/
    // total and can never be downgraded client-side to a cheaper version. An
    // ordinary unpaid public order is NOT locked. null when no order placed yet.
    order: order
      ? {
          version: order.version,
          total: order.total,
          paid: !!order.paid,
          locked,
          ...(owner && order.version === 'delivery' && order.address
            ? { address: order.address }
            : {}),
        }
      : null,
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
    // Resolved generator theme + any theme-required extra fields (AGE, or
    // YEARS + NAME1 + NAME2); db.createCollection validates/sanitizes both.
    theme: b.theme,
    extra_fields: b.extra_fields,
    // Card word-font the customer picked in the preview (a filename in the
    // shared word-fonts/ pool); db.createCollection caps + defaults it.
    word_font: b.word_font,
    chasers: b.chasers,
    // Optional free-form custom title (F7); db sanitizes/caps and treats
    // empty/whitespace as absent (the theme's own title is used).
    custom_title: b.custom_title,
    gender: b.gender,
  });
  // A new lead just STARTED — fire the owner + buyer emails and open the WhatsApp
  // word-collection group now, so words start flowing before/without payment.
  // Idempotent, so the later order/pay step won't notify again.
  fireStartNotifications(c.id, paymentBaseUrl());
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
// Shared admin guard: sends the 503/403 response and returns false when the
// request is not an authorized admin; returns true to proceed.
function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ error: 'admin disabled: set ADMIN_KEY' });
    return false;
  }
  if (!adminKeyOk(req.query.key)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// Tiny in-memory sliding-window rate limiter. The coupon-preview (validate)
// endpoint is a brute-force oracle for short [A-Z0-9] codes, so we cap attempts
// per CLIENT IP (keying per collection alone is bypassable — collection creation
// is unauthenticated, so an attacker rotates fresh ids). State is per-process
// (fine for a single Railway instance); it resets on redeploy.
const COUPON_RATE_LIMIT = Number(process.env.COUPON_RATE_LIMIT || 20);
const COUPON_RATE_WINDOW_MS = 60 * 1000;
// Bound the bucket map so a flood of distinct IPs can't OOM the instance.
const MAX_RATE_KEYS = Number(process.env.COUPON_RATE_MAX_KEYS || 10000);
const _rateBuckets = new Map();
function couponRateOk(key) {
  const now = Date.now();
  const hits = (_rateBuckets.get(key) || []).filter((t) => now - t < COUPON_RATE_WINDOW_MS);
  if (hits.length >= COUPON_RATE_LIMIT) {
    _rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  // Prune buckets that have aged out entirely; otherwise keep the pruned list.
  if (hits.length === 0) _rateBuckets.delete(key);
  else _rateBuckets.set(key, hits);
  // Cap the map: Map preserves insertion order, so the first key is the oldest —
  // evict it (idle/stale) when over the limit.
  if (_rateBuckets.size > MAX_RATE_KEYS) {
    _rateBuckets.delete(_rateBuckets.keys().next().value);
  }
  return true;
}
// The client key for coupon-oracle rate limiting: the real client IP.
function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
app.get('/api/admin/collections', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ collections: db.listAllCollections() });
});

// Admin: mark an order as paid.
app.post('/api/admin/collections/:id/paid', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!db.markPaid(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Admin: create a bespoke "custom" (599₪) order on a collection and return the
// owner pay link, so the admin can hand-set an order to version:'custom' and send
// the customer a payment link. setOrder is called with the collection's own owner
// token (admin is already authenticated) and needs no address for custom.
app.post('/api/admin/collections/:id/custom', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  // admin:true bypasses the public version-enable gate so a bespoke custom order
  // can be created even while `custom` is hidden from public buyers (launch state).
  const order = db.setOrder(req.params.id, c.owner_token, { version: 'custom' }, { admin: true });
  if (order && order.error) return res.status(400).json({ error: order.error });
  const base = paymentBaseUrl();
  const payLink = base ? base + '/collect.html?c=' + c.id + '&k=' + c.owner_token : null;
  // Order created -> fire the one-time owner/buyer emails + WhatsApp group.
  onOrderCreated(req.params.id, base);
  res.json({ order, pay_link: payLink });
});

// Admin: operational playbook / notebook. The owner's organized notes (recipes,
// prompts, reminders) — read + add + edit + delete, all behind the admin key.
// Data persists under DATA_DIR (see server/playbook.js). The static page shell is
// site/admin-playbook.html; it holds no content until it loads this gated API.
app.get('/api/admin/playbook', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ notes: playbook.list() });
});
app.post('/api/admin/playbook', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { section, title, body, pinned } = req.body || {};
  if (!String(title || '').trim() && !String(body || '').trim()) {
    return res.status(400).json({ error: 'title or body required' });
  }
  res.status(201).json({ note: playbook.add({ section, title, body, pinned }) });
});
app.patch('/api/admin/playbook/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const note = playbook.update(req.params.id, req.body || {});
  if (!note) return res.status(404).json({ error: 'not found' });
  res.json({ note });
});
app.delete('/api/admin/playbook/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!playbook.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Admin: design asset inventory — READ-ONLY visibility into which per-design
// files exist on disk under site/assets/designs/<id>/ and which are MISSING, so
// gaps like the kids design shipping without a board (board.svg / thumb-board /
// gallery-board) are visible and tracked. The design catalog (id, Hebrew name,
// theme, public flag) is the single source of truth in the ESM module
// site/js/designs.js, dynamically imported into this CommonJS server.
const DESIGN_ASSETS_DIR = path.join(__dirname, '..', 'site', 'assets', 'designs');
// The full set of files a COMPLETE design ships, grouped by product part so the
// UI can label a gap by group (e.g. "חסר: לוח"). board-group files are
// legitimately absent for a boardless design — still reported missing on purpose.
const DESIGN_ASSET_GROUPS = [
  { group: 'front', label: 'חזית', files: ['front.svg', 'thumb-front.webp', 'gallery-front.webp'] },
  { group: 'back', label: 'גב', files: ['back.svg', 'thumb-back.webp', 'gallery-back.webp'] },
  { group: 'board', label: 'לוח', files: ['board.svg', 'thumb-board.webp', 'gallery-board.webp'] },
  { group: 'picker', label: 'ממוזערת', files: ['thumb.webp'] },
  { group: 'cover', label: 'שער', files: ['cover.webp'] },
  { group: 'store', label: 'חנות', files: ['store.webp'] },
];
// Flat list of every expected file with its group, in a stable display order.
const EXPECTED_DESIGN_ASSETS = DESIGN_ASSET_GROUPS.flatMap((g) =>
  g.files.map((file) => ({ file, group: g.group, groupLabel: g.label }))
);

app.get('/api/admin/designs', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let catalog;
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')));
    catalog = mod.DESIGNS || [];
  } catch (e) {
    return res.status(500).json({ error: 'failed to load design catalog: ' + e.message });
  }
  const designs = catalog.map((d) => {
    const dir = path.join(DESIGN_ASSETS_DIR, d.id);
    const assets = EXPECTED_DESIGN_ASSETS.map((a) => ({
      ...a,
      exists: fs.existsSync(path.join(dir, a.file)),
    }));
    const present = assets.filter((a) => a.exists).map((a) => a.file);
    const missing = assets.filter((a) => !a.exists).map((a) => a.file);
    // Group the missing files so the UI shows one badge per affected part.
    const missingGroups = DESIGN_ASSET_GROUPS.map((g) => ({
      group: g.group,
      label: g.label,
      files: g.files.filter((f) => missing.includes(f)),
    })).filter((g) => g.files.length > 0);
    return {
      id: d.id,
      name: d.name,
      theme: d.theme,
      visibility: d.visibility,
      public: d.public,
      thumb: 'assets/designs/' + d.id + '/thumb.webp',
      assets,
      present,
      missing,
      missingGroups,
      complete: missing.length === 0,
    };
  });
  res.json({ designs, expected: EXPECTED_DESIGN_ASSETS });
});

// Admin: generate the full print-ready PDF for a collection. The admin supplies
// the theme (a generator/themes.json key) — the design->theme mapping is a later
// workstream. Body: { theme, word_font?, extra_fields? }. Gathers the
// collection's words + honoree name, spawns the Python generator, stores the PDF
// under GENERATED_DIR/<id>.pdf, records order.production, and (when email is
// configured) mails a download link to the client + Dugri.
app.post('/api/admin/collections/:id/generate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const theme = String(b.theme || '').trim();
  if (!theme) return res.status(400).json({ error: 'theme required' });
  const words = db.listWords(c.id).map((w) => w.text);
  if (!words.length) return res.status(400).json({ error: 'no words to generate' });

  // Reject an unknown theme up front. An unknown key makes getTheme() null, which
  // makes validateOrderForProduction skip every theme-specific check (name
  // language, required extra fields) and still spawn the generator — so a bad
  // theme must fail fast here, before any validation is trusted or Chrome runs.
  const themeConfig = validate.getTheme(theme);
  if (!themeConfig) return res.status(400).json({ error: 'unknown theme' });

  // Validate the order BEFORE spending time/money on generation. On any problem
  // we do NOT run the generator: we record an 'error' production status (shown in
  // admin), email the client + Dugri what to fix, and 400 with the problem list.
  const problems = validate.validateOrderForProduction(c, themeConfig, words);
  if (problems.length) {
    const production = db.setProduction(c.id, {
      state: 'error',
      errors: problems,
      checked_at: new Date().toISOString(),
      theme,
    });
    const base = paymentBaseUrl();
    if (notify.isConfigured()) {
      notify.sendProductionError({ ...c, count: words.length }, base, problems).catch(() => {});
    }
    return res.status(400).json({ error: 'validation failed', problems, production });
  }

  const wordFont = b.word_font ? String(b.word_font) : null;
  const extraFields =
    b.extra_fields && typeof b.extra_fields === 'object' && !Array.isArray(b.extra_fields)
      ? b.extra_fields
      : {};
  // Use the stored (validated) id — never the raw param — for the output path.
  const outPdf = path.join(GENERATED_DIR, c.id + '.pdf');

  try {
    const { pages } = await runGenerator({
      theme,
      name: c.honoree_name || '',
      words,
      outPdf,
      wordFont,
      extraFields,
      chasers: !!c.chasers,
      customTitle: c.custom_title || null,
    });
    const production = db.setProduction(c.id, {
      state: 'generated',
      pdf_file: path.basename(outPdf),
      generated_at: new Date().toISOString(),
      theme,
      pages,
    });
    const base = paymentBaseUrl();
    // Two links, and they are NOT interchangeable:
    //  - adminLink carries the master ADMIN_KEY and is for Dugri's own inbox only.
    //  - customerLink carries this collection's per-order pdf_token capability
    //    (set by db.setProduction) so the CUSTOMER can download WITHOUT ever
    //    seeing the admin secret. The customer email must use customerLink.
    const adminLink = base
      ? base + '/api/admin/collections/' + c.id + '/pdf?key=' + encodeURIComponent(ADMIN_KEY)
      : null;
    const customerLink =
      base && production && production.pdf_token
        ? base + '/api/collections/' + c.id + '/pdf?t=' + encodeURIComponent(production.pdf_token)
        : null;
    if (notify.isConfigured() && (adminLink || customerLink)) {
      notify
        .sendPdfReady({ ...c, count: words.length }, base, {
          admin: adminLink,
          customer: customerLink,
        })
        .catch(() => {});
    }
    // The admin UI is already authenticated, so the response keeps the admin link.
    res.json({ ok: true, production, link: adminLink });
  } catch (e) {
    const detail = String((e && e.message) || e);
    // A clear, actionable status for the common "theme not calibrated" case.
    const status = /not calibrated|unknown theme/i.test(detail) ? 400 : 500;
    res.status(status).json({ error: 'generation failed', detail: detail.slice(0, 800) });
  }
});

// Admin: download a previously generated order PDF. Gated by the admin key (also
// how the emailed capability link works). 404 when the collection or PDF is
// absent. Uses the stored collection id (not the raw param) so the file path can
// never traverse out of GENERATED_DIR.
app.get('/api/admin/collections/:id/pdf', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const file = path.join(GENERATED_DIR, c.id + '.pdf');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no pdf' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="dugri-' + c.id + '.pdf"');
  res.sendFile(file);
});

// Constant-time compare of a supplied pdf capability token against the stored
// one, so the public download route can't be used as a timing oracle.
function pdfTokenOk(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// PUBLIC: download a generated order PDF via the per-collection capability token
// stored on order.production.pdf_token (NOT the admin key) — this is the link the
// customer's "PDF ready" email points at. 404 when the collection/PDF is absent;
// 403 on a missing/wrong token. Uses the stored id (never the raw param) so the
// path can never traverse out of GENERATED_DIR.
app.get('/api/collections/:id/pdf', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const production = (c.order && c.order.production) || c.production || null;
  const token = production && production.pdf_token;
  if (!pdfTokenOk(req.query.t, token)) return res.status(403).json({ error: 'forbidden' });
  const file = path.join(GENERATED_DIR, c.id + '.pdf');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no pdf' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="dugri-' + c.id + '.pdf"');
  res.sendFile(file);
});

// Admin: soft-cancel a collection (body {undo:true} to restore).
app.post('/api/admin/collections/:id/cancel', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const undo = !!(req.body && req.body.undo);
  if (!db.cancelCollection(req.params.id, undo))
    return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Admin: reopen a closed/expired collection so it accepts words again.
app.post('/api/admin/collections/:id/reopen', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const status = db.reopenCollection(req.params.id);
  if (!status) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, status });
});

// Admin: hard-delete a collection and its words.
app.delete('/api/admin/collections/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!db.deleteCollection(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Admin: list all discount coupons.
app.get('/api/admin/coupons', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ coupons: db.listCoupons() });
});

// Admin: create a coupon. 400 on invalid input or a duplicate code.
app.post('/api/admin/coupons', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const coupon = db.createCoupon({
    code: b.code,
    discount_pct: b.discount_pct,
    valid_until: b.valid_until,
  });
  if (coupon && coupon.error) return res.status(400).json({ error: coupon.error });
  res.status(201).json({ coupon });
});

// Admin: toggle a coupon's active flag. 404 when the id is unknown.
app.post('/api/admin/coupons/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const active = !!(req.body && req.body.active);
  const coupon = db.setCouponActive(req.params.id, active);
  if (!coupon) return res.status(404).json({ error: 'not found' });
  res.json({ coupon });
});

// Admin: delete a coupon. 404 when the id is unknown.
app.delete('/api/admin/coupons/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!db.deleteCoupon(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// --- Private-design access codes (admin CRUD) ----------------------------
// Mirrors the coupon admin routes. An access code unlocks a PRIVATE design in
// the order flow (see POST /api/design-code/validate). All gated by ADMIN_KEY.

// Admin: list all design access codes.
app.get('/api/admin/design-codes', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ design_codes: db.listDesignCodes() });
});

// Admin: create an access code. 400 on invalid input or a duplicate code.
app.post('/api/admin/design-codes', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const dc = db.createDesignCode({
    code: b.code,
    design_id: b.design_id,
    valid_until: b.valid_until,
  });
  if (dc && dc.error) return res.status(400).json({ error: dc.error });
  res.status(201).json({ design_code: dc });
});

// Admin: toggle an access code's active flag. 404 when the id is unknown.
app.post('/api/admin/design-codes/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const active = !!(req.body && req.body.active);
  const dc = db.setDesignCodeActive(req.params.id, active);
  if (!dc) return res.status(404).json({ error: 'not found' });
  res.json({ design_code: dc });
});

// Admin: delete an access code. 404 when the id is unknown.
app.delete('/api/admin/design-codes/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!db.deleteDesignCode(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// PUBLIC design-code validation: the client enters an access code in the order
// flow to unlock a PRIVATE design. Public (no owner token — a fresh visitor is
// choosing a design), but rate-limited per client IP like the coupon oracle to
// blunt code enumeration. Only the unlocked design id is ever leaked. On failure
// it returns a GENERIC { valid:false } with NO reason — distinguishing not_found
// from inactive/expired would turn this into an enumeration oracle (an attacker
// learns which codes exist). Detailed reasons stay internal (db.validateDesignCode).
app.post('/api/design-code/validate', (req, res) => {
  if (!couponRateOk('designcode:' + clientKey(req))) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  const r = db.validateDesignCode(req.body && req.body.code);
  if (!r.valid) return res.json({ valid: false });
  db.incrementDesignCodeUses(req.body && req.body.code);
  res.json({ valid: true, design: r.design_id });
});

// OWNER-SCOPED coupon validation so checkout can preview the discount. Requires
// the collection id + owner_token (so it is NOT a fully-open enumeration oracle)
// and is rate-limited per collection. Only the discount percentage is ever
// leaked — never the coupon list or other fields.
app.post('/api/collections/:id/coupon/validate', (req, res) => {
  const c = db.getCollection(req.params.id);
  const token = req.body && req.body.owner_token;
  if (!c || c.owner_token !== token) return res.status(403).json({ error: 'forbidden' });
  // Rate-limit by CLIENT IP (not collection — fresh collections are free to make)
  // to blunt code enumeration. This is the tight oracle budget; pay/init has its
  // own separate path so an owner's previews can't block their real payment.
  if (!couponRateOk('validate:' + clientKey(req))) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  const r = db.validateCoupon(req.body && req.body.code);
  if (!r.valid) return res.json({ valid: false, reason: r.reason });
  res.json({ valid: true, discount_pct: r.coupon.discount_pct });
});

// OWNER-SCOPED pawn-images upload: attach up to 4 optional customer photos
// ("פיונים") to a collection. Owner-token gated via ?k= (a query param, so we can
// authenticate BEFORE express.raw buffers the body — an unauthenticated client
// can't force a large allocation). Multipart, same magic-byte typing + 4MB/image
// cap as the content-photo route (content.saveImageBytes). Pictures are a
// nice-to-have: a single bad/oversized image part is SKIPPED, not fatal, so a
// partial batch still succeeds.
//
// The 4-image cap is enforced at WRITE time (POST /api/collections is public, so
// anyone gets a valid {id, owner_token} and could hammer this route): we compute
// how much ROOM is left for this collection and only ever write that many files, so
// disk writes are bounded by the 4-per-collection cap and repeated over-cap posts
// write nothing. Any file we DID write but that ends up unrecorded (a content-hash
// duplicate the DB de-dupes away) is reclaimed — but only when THIS request created
// it and nothing else references it (content-addressed files are shared).
app.post(
  '/api/collections/:id/pawns',
  (req, res, next) => {
    const c = db.getCollection(req.params.id);
    if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
    next();
  },
  express.raw({ type: () => true, limit: PAWN_UPLOAD_LIMIT }),
  (req, res) => {
    const boundary = templates.boundaryFromContentType(req.headers['content-type']);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'expected multipart/form-data upload' });
    }
    const { files } = templates.parseMultipart(req.body, boundary);
    const parts = Object.values(files).filter((f) => f && Buffer.isBuffer(f.data));
    // Reject an over-large batch UP FRONT so a single request can never write dozens
    // of files before the cap check (the buyer UI only ever sends up to 4).
    if (parts.length > 4) return res.status(400).json({ error: 'too many images (max 4)' });
    // Only persist as many images as there is room for (4 total per collection). A
    // full collection writes nothing at all — the DoS fix.
    const c = db.getCollection(req.params.id);
    const room = Math.max(0, 4 - (Array.isArray(c.pawn_images) ? c.pawn_images.length : 0));
    const written = []; // { path, created } for every file THIS request actually wrote
    for (const f of parts.slice(0, room)) {
      try {
        written.push(content.saveImageBytes(f.data));
      } catch {
        // Oversized/unsupported image — skip this file, keep the rest (fail-soft).
      }
    }
    const stored = db.addPawnImages(
      req.params.id,
      req.query.k,
      written.map((w) => w.path)
    );
    // Reclaim any file we wrote that DIDN'T get recorded (a duplicate the DB dropped,
    // or the whole batch on a lost owner token) — but only files THIS request created
    // AND that nothing else references, so a shared content-addressed file is safe.
    const kept = new Set(stored || []);
    for (const w of written) {
      if (!kept.has(w.path) && w.created && !content.isImageReferenced(w.path)) {
        content.deleteUpload(w.path);
      }
    }
    if (stored == null) return res.status(403).json({ error: 'forbidden' });
    res.json({ ok: true, pawn_images: stored });
  }
);

// Public order PREVIEW: render a REAL sample card + board for a theme with the
// honoree name (and an optional word-font pick), so the customer sees their card
// right after entering the name. Rate-limited per client IP like the coupon
// oracle (each call spawns Chrome). Also runs the name-language check and returns
// a `warning` when the name doesn't fit the theme's script, plus the shared
// word-font options so the client can render the picker.
app.post('/api/preview', async (req, res) => {
  const b = req.body || {};
  const theme = String(b.theme || '').trim();
  const name = String(b.name || '').trim();
  // Cheap, in-memory validation FIRST — reject bad requests before any work.
  const themeConfig = validate.getTheme(theme);
  if (!themeConfig) return res.status(400).json({ error: 'unknown theme' });
  if (!name) return res.status(400).json({ error: 'name required' });

  // Cheap, in-memory parsing of the remaining render inputs (no fs, no spawn).
  const rawWordFont = b.word_font ? String(b.word_font).trim() : '';
  const extraFields =
    b.extra_fields && typeof b.extra_fields === 'object' && !Array.isArray(b.extra_fields)
      ? b.extra_fields
      : {};
  // Chasers add-on toggle from the order flow — when on, preview the theme's
  // chasers board variant (server falls back to the normal board if none).
  const chasers = !!b.chasers;
  // Custom title (F7): the buyer's optional overriding title. Sanitized with the
  // SAME rule stored orders use, so the live preview is WYSIWYG for production.
  const customTitle = db.sanitizeCustomTitle(b.title);
  // Surfaced to the customer immediately (doesn't block rendering the preview).
  const warning = validate.checkNameLanguage(name, themeConfig);
  const themeWordFont = themeConfig.word_font || null;

  // 1) CACHE lookup FIRST, keyed by the raw inputs (identical requests map to the
  // same render). A hit returns instantly with no Chrome and WITHOUT consuming the
  // rate-limit budget. `options` (a tiny fs read) is needed only to build the meta.
  const cacheKey = previewCache.key({
    theme,
    name,
    wordFont: rawWordFont,
    extraFields,
    chasers,
    customTitle,
  });
  const cached = previewCache.get(cacheKey);
  if (cached) {
    const options = wordFontOptions();
    const wordFont = options.some((o) => o.file === rawWordFont) ? rawWordFont : null;
    return res.json({
      ...cached,
      warning,
      word_font: wordFont,
      word_font_options: options,
      theme_word_font: themeWordFont,
    });
  }

  // 2) RATE LIMIT on a MISS, BEFORE any expensive per-request work (the font-options
  // fs read + the Chrome render), on preview's OWN bucket — a flood is 429'd early
  // and a typer never eats into the coupon/pay budget.
  if (!previewRate.ok('preview:' + clientKey(req))) {
    return res.status(429).json({ error: 'too many attempts' });
  }

  // Only ever spawn with a word_font that is one of the offered options — never an
  // arbitrary client-supplied filename.
  const options = wordFontOptions();
  const wordFont = options.some((o) => o.file === rawWordFont) ? rawWordFont : null;
  try {
    // A SINGLE preview.py run renders card + board + the design's real card back
    // together (one Python process, no second Chrome). runPreview rejects on
    // failure (→ handled below); board/back are simply absent when the theme has
    // no such artwork, so a missing back never fails the request.
    const imgs = await runPreview({ theme, name, wordFont, extraFields, chasers, customTitle });
    previewCache.set(cacheKey, imgs);
    res.json({
      ...imgs,
      warning,
      word_font: wordFont,
      word_font_options: options,
      theme_word_font: themeWordFont,
    });
  } catch (e) {
    const detail = String((e && e.message) || e);
    const status = /not calibrated|unknown theme/i.test(detail) ? 400 : 500;
    res.status(status).json({ error: 'preview failed', detail: detail.slice(0, 800) });
  }
});

// Public read: anyone with the link can see the words. The owner (owner_token
// passed as ?k=) additionally gets the stored delivery address back, so a locked
// delivery order can be prefilled on reload — never exposed to the public view.
app.get('/api/collections/:id', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const owner = !!(req.query.k && req.query.k === c.owner_token);
  res.json(publicView(c, { owner }));
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
  res.json({ added: r.added, skipped: r.skipped, count: db.countWords(req.params.id) });
});

// Owner-only: close collection.
app.post('/api/collections/:id/close', (req, res) => {
  const token = req.body && req.body.owner_token;
  const result = db.closeCollection(req.params.id, token);
  if (!result) return res.status(403).json({ error: 'forbidden' });
  // Notify the owner the list is finished and ready to produce — but ONLY on the
  // real open->closed transition (a repeated close must not re-send) and only
  // when email is configured (skip the word-count work entirely otherwise).
  // Fire-and-forget: a failed email must never affect the response.
  if (result.changed && notify.isConfigured()) {
    const c = db.getCollection(req.params.id);
    if (c) {
      notify
        .sendOrderFinished({ ...c, count: db.countWords(c.id) }, paymentBaseUrl())
        .catch(() => {});
    }
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
  // Order created -> fire the one-time owner/buyer emails + WhatsApp group.
  onOrderCreated(req.params.id, paymentBaseUrl());
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

// Owner-only: edit a word's text (fix a typo). Same normalization + 80-char cap
// as the add path (never trust the client); rejects an empty result and a
// collision with another existing word. token in the body (not the URL) so it
// isn't logged, mirroring the delete route.
app.patch('/api/collections/:id/words/:wordId', (req, res) => {
  const b = req.body || {};
  const r = db.editWord(req.params.id, req.params.wordId, b.text, b.owner_token);
  if (r === null) return res.status(404).json({ error: 'not found' });
  if (r.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (r.error === 'not_found') return res.status(404).json({ error: 'word not found' });
  if (r.error === 'empty') return res.status(400).json({ error: 'text required' });
  if (r.error === 'duplicate') return res.status(409).json({ error: 'duplicate' });
  res.json({ ok: true, word: { id: r.id, text: r.text, added_by: r.added_by } });
});

// A short per-payment ParamX token: <=19 chars, digits + lowercase letters
// (PeleCard's ParamX limit). PeleCard echoes it back as AdditionalDetailsParamX.
function newPayToken() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 18);
}

// Fire the owner + buyer "order paid" emails for a collection that just
// transitioned to paid. Shared by BOTH paid transitions — the PeleCard callback
// and the free (100%-coupon) path — so they send identical, consistent
// notifications. `amountCharged` is what the customer ACTUALLY paid (0 for a
// fully-free order, the discounted amount for a partial coupon); the emails show
// that rather than the pre-coupon package price. Fire-and-forget: the payment
// must succeed even if a send fails. Called via onOrderPaid, which guards it with
// notify.isConfigured() so the word-count work is skipped when email is dormant.
// Resolve the template/product photo URL for a paid collection's chosen design,
// for the buyer confirmation email. Prefers the owner's uploaded photo
// (design-images 'store', else 'front' override), else the shipped static
// store.webp — matched to the design by the order's stable `theme` key (or the
// Hebrew design name as a fallback). Returns an absolute URL under `base`, or null
// when nothing resolves. Fail-soft: any error -> null (the email just omits the
// image). The design catalog is the ESM site/js/designs.js, dynamically imported
// (and Node-cached) exactly as /api/admin/designs does.
async function resolveProductImageUrl(collection, base) {
  if (!base || !collection) return null;
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')));
    const catalog = mod.DESIGNS || [];
    const theme = collection.theme || null;
    const designName = collection.design || null;
    const d = catalog.find(
      (x) => (theme && x.theme === theme) || (designName && x.name === designName)
    );
    if (!d) return null;
    // Owner override (a validated /content-uploads/<hash> path) wins over the
    // shipped static photo.
    const override = designImages.get(d.id, 'store') || designImages.get(d.id, 'front');
    if (override) return base + override;
    // Static fallback — only when the file actually exists on disk, so the email
    // never embeds a broken <img> (it would then just show the alt text).
    const rel = 'assets/designs/' + d.id + '/store.webp';
    if (!fs.existsSync(path.join(__dirname, '..', 'site', rel))) return null;
    return base + '/' + rel;
  } catch {
    return null;
  }
}

// Send the owner + buyer "order received" emails. Fired at ORDER CREATION, so
// there is no charged amount yet — the emails show the order's package price
// (order.total), and the free/coupon charge display is a payment concern that no
// longer appears here. `base` is the normalized public origin.
async function sendOrderNotifications(collectionId, base) {
  const c = db.getCollection(collectionId);
  if (!c) return;
  const enriched = { ...c, count: db.listWords(collectionId).length };
  // One-click admin orders panel link for the OWNER emails (goes to NOTIFY_TO
  // only). Includes the admin key by design — the owner chose convenience, and
  // the mail never reaches the buyer. The secret is built HERE and passed in;
  // server/notify.js never sees ADMIN_KEY.
  const adminLink =
    base && ADMIN_KEY ? base + '/admin.html?key=' + encodeURIComponent(ADMIN_KEY) : null;
  const ownerOptions = { adminLink };
  // Fire the OWNER emails IMMEDIATELY (synchronously) — they carry no product
  // image, so they must NOT wait on the async image resolution below.
  notify.sendOrderPaid(enriched, base, ownerOptions).catch(() => {});
  // A bespoke "custom" order (no template) needs hand-design — fire an EXTRA
  // Dugri-only alert so it stands out from the normal order emails.
  if (c.order && c.order.version === 'custom') {
    notify.sendCustomOrderAlert(enriched, base, ownerOptions).catch(() => {});
  }
  // The BUYER confirmation embeds the template product photo, which needs an async
  // catalog lookup — resolve it, then send. Skips gracefully if no buyer email.
  const productImageUrl = await resolveProductImageUrl(c, base);
  notify.sendBuyerConfirmation(enriched, base, { adminLink, productImageUrl }).catch(() => {});
}

// Everything that must happen when an order is first CREATED — the owner captures
// the order and starts collecting words immediately, BEFORE/without a completed
// card payment. Idempotent via db.markOrderNotified: only the first order creation
// per collection notifies, so re-setting the version or re-opening the pay modal
// never re-sends or re-opens a group. The two effects are INDEPENDENTLY gated
// (email on notify.isConfigured(), the WhatsApp group on whatsapp.isConfigured())
// and fully fire-and-forget, so neither can block or break the order/payment flow.
// Fire the one-time "new order" side effects for a collection: the owner + buyer
// emails and the WhatsApp word-collection group. Fires the moment a customer
// STARTS — a collection is created (honoree + contact + design) — so word
// collection begins immediately, before/without payment (most starts never reach
// the pay step). Idempotent per collection via db.markOrderNotified, so the later
// order/pay step is a no-op. Works with or without an order yet: order details
// (version/price) are simply omitted from the email until the buyer picks one.
// Both effects are independently gated (email on notify.isConfigured(), the group
// on whatsapp.isConfigured()) and fully fire-and-forget.
function fireStartNotifications(collectionId, base) {
  const c = db.getCollection(collectionId);
  if (!c) return;
  if (!db.markOrderNotified(collectionId)) return; // already notified — no-op
  if (notify.isConfigured()) sendOrderNotifications(collectionId, base).catch(() => {});
  if (whatsapp.isConfigured()) {
    openWhatsappGroup(c, base).catch((e) => {
      console.warn('[whatsapp] group open failed:', e && e.message ? e.message : e);
    });
  }
}

// Fired at the order-creation points (pay/init, POST /order, admin custom). Now a
// thin wrapper over fireStartNotifications — the collection was almost always
// already notified at creation, so this is usually a no-op; it stays as a safety
// net for an order placed on a collection created before this behavior (or via a
// path that skipped the start notification).
function onOrderCreated(collectionId, base) {
  fireStartNotifications(collectionId, base);
}

// Payment no longer triggers notifications — the owner wants the order captured
// and words collected at ORDER CREATION (see onOrderCreated), before/without a
// completed card payment. Kept as a no-op hook the paid transitions still call, so
// a payment receipt can be reintroduced here later without re-touching the payment
// paths.
function onOrderPaid() {}

// =========================================================================
// WhatsApp bot (Phase B) — inbound webhook, paid-order group creation, and the
// nudge scheduler. EVERYTHING below is gated on whatsapp.isConfigured(): with the
// WHAPI_* / WHATSAPP_ENABLED env unset the module is inert (no fetch, no state),
// so merging this changes nothing in production until the owner arms the bot.
// Every outgoing message text comes from the owner-editable trigger catalog in
// settings.js (via whatsapp.buildTriggerMessage) — a disabled trigger is silent.
// =========================================================================

// The buyer's in-group "finish the list" command. Editable via env; a distinct
// short phrase so ordinary group chatter never closes a list by accident. Matched
// case-insensitively against the trimmed message text.
const WA_CLOSE_COMMAND = (process.env.WHAPI_CLOSE_COMMAND || 'סיום').trim();
// The bot's OWN WhatsApp id (optional). Recorded as an initial member at group
// creation so the bot never greets itself as a joining friend.
const WHAPI_BOT_WA = process.env.WHAPI_BOT_WA || '';
// The owner's OWN WhatsApp number (optional). Used as the escalation channel that
// survives an email-dormant deployment: when an operational alert can't be emailed
// (Resend unconfigured), it's DM'd to this number instead. A phone or a wa id.
const WHAPI_OWNER_WA = process.env.WHAPI_OWNER_WA || '';

// Reduce a WhatsApp id / phone to its bare international digits for comparison
// ("972521234567@s.whatsapp.net" -> "972521234567"). Strips the "@…" chat-suffix,
// the ":<device>" multi-device JID suffix ("972…:12@s.whatsapp.net"), and every
// non-digit, so ids captured in different shapes still compare equal. Without the
// ":device" strip a multi-device sender's id would carry the device number as
// extra trailing digits and never match the buyer/initial-member ids.
function waIdDigits(x) {
  return String(x == null ? '' : x)
    .split('@')[0]
    .split(':')[0]
    .replace(/[^\d]/g, '');
}

// Convert an Israeli mobile number to a WhatsApp id (bare international digits,
// e.g. "052-123-4567" / "+972 52 123 4567" / "00972521234567" -> "972521234567").
// Returns '' when it can't produce a plausible IL mobile, so the caller simply
// skips the bot for that order. Normalizes robustly to the 972 international form:
//   • strip a leading "00" international dialing prefix (00972… -> 972…) so it is
//     NOT mistaken for a local "0" and double-prefixed into "972972…";
//   • an already-972-prefixed number is kept (dropping a redundant local 0 after
//     the code);
//   • a local "0XXXXXXXXX" becomes "972XXXXXXXXX";
//   • a bare national number gets the 972 country code.
// The result must be a plausible IL MOBILE — 972 + a 9-digit national part that
// starts with 5 — otherwise it's rejected (soft-fail) rather than returned as a
// malformed / doubled-code id.
function ilPhoneToWaId(phone) {
  let s = waIdDigits(phone);
  if (!s) return '';
  if (s.startsWith('00')) s = s.slice(2); // drop the 00 international prefix first
  if (s.startsWith('972')) s = '972' + s.slice(3).replace(/^0+/, '');
  else if (s.startsWith('0')) s = '972' + s.replace(/^0+/, '');
  else s = '972' + s;
  // Plausible IL mobile only: 972 + "5" + 8 more digits (12 total). Anything else
  // (landline, junk, a doubled code) soft-fails to '' so we never emit a bad id.
  if (!/^9725\d{8}$/.test(s)) return '';
  return s;
}

// The interpolation values shared by every group-scoped trigger: the honoree's
// name and the public "add words" (friends) collect link — NOT the owner link, so
// the token is never shared into a group. `base` is the normalized public origin.
function waGroupValues(collection, base) {
  const honoree = (collection && collection.honoree_name) || 'בעל/ת השמחה';
  const link = base && collection && collection.id ? base + '/collect.html?c=' + collection.id : '';
  return { honoree, link };
}

// Send ONE trigger's message to a chat, if that trigger is enabled. Text comes
// from the owner-editable catalog via whatsapp.buildTriggerMessage (a disabled or
// unknown trigger yields no text and sends nothing). Fail-soft: a Whapi send
// failure never throws. Returns { ok, messageId } — ok is true only when a message
// was actually sent; messageId (when present) lets the caller pin it.
async function sendWaTrigger(to, triggerId, values) {
  const msg = whatsapp.buildTriggerMessage(triggerId, values);
  if (!msg || !msg.enabled || !msg.text) return { ok: false, messageId: null };
  const r = await whatsapp.sendMessage(to, msg.text);
  return { ok: !!(r && r.ok), messageId: (r && r.messageId) || null };
}

// Did the buyer actually land in the freshly-created group? WhatsApp may silently
// refuse to add a number for privacy. Whapi's real POST /groups success response
// is typically { group_id, invite_code } with NO participants array, so absence of
// participant info must NOT be read as failure — doing so would DM/escalate on
// EVERY order. The rule: the buyer is ADDED whenever the group was created,
// UNLESS the response EXPLICITLY lists the buyer in a failed / not-added set. Only
// a POSITIVE failure signal returns false (→ invite DM + escalation); a response
// silent about participants means "assume added" (don't spam). The failed-field
// key variants (failed_participants / not_added / failed) cover Whapi's documented
// shapes.
function participantIds(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => (typeof p === 'string' ? p : (p && (p.id || p.wa_id)) || ''))
    .map(waIdDigits)
    .filter(Boolean);
}
function buyerLandedInGroup(created, buyerWa) {
  const data = (created && created.data) || {};
  const want = waIdDigits(buyerWa);
  if (!want) return true; // no buyer id to check — group exists, don't spam
  // A POSITIVE failure signal (buyer explicitly in a failed/not-added set) is the
  // ONLY thing that means "not added". Anything else = assume added.
  const failed = participantIds(data.failed_participants || data.not_added || data.failed);
  return !failed.includes(want);
}

// The owner's own WhatsApp id for escalations, derived from WHAPI_OWNER_WA (a
// phone or a raw wa id). '' when unset.
function ownerWaId() {
  if (!WHAPI_OWNER_WA) return '';
  return ilPhoneToWaId(WHAPI_OWNER_WA) || waIdDigits(WHAPI_OWNER_WA);
}

// Escalate an operational alert to the OWNER over WhatsApp — a DM to the owner's
// own number. This is the escalation channel that survives an email-dormant
// deployment: the owner has WhatsApp even when Resend is unconfigured, so a paid
// order whose buyer couldn't be added still reaches a human. Fail-soft: NEVER
// throws. When no owner WA number is configured we can't DM, so we emit a
// prominent server-side ERROR log instead, so the lost escalation is at least
// diagnosable rather than silent. Returns true only when the DM actually sent.
async function alertOwnerViaWhatsApp(subject, lines) {
  const text = [String(subject == null ? '' : subject)]
    .concat(Array.isArray(lines) ? lines : [lines])
    .map((l) => String(l == null ? '' : l))
    .join('\n');
  try {
    const to = ownerWaId();
    if (!to) {
      console.error(
        '[whatsapp] OWNER ESCALATION NOT DELIVERED — no WHAPI_OWNER_WA configured ' +
          'and email is unavailable. Set WHAPI_OWNER_WA to receive these. Alert: ' +
          text.replace(/\n/g, ' | ')
      );
      return false;
    }
    const r = await whatsapp.sendMessage(to, text);
    if (!r || !r.ok) {
      console.error(
        '[whatsapp] OWNER ESCALATION DM FAILED — intervene manually. Alert: ' +
          text.replace(/\n/g, ' | ')
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error('[whatsapp] alertOwnerViaWhatsApp threw:', e && e.message ? e.message : e);
    return false;
  }
}

// Paid-order hook: open a WhatsApp word-collection group for the buyer. Idempotent
// (never opens a second group for a collection — even under two concurrent paid
// events, thanks to the synchronous wa-state reservation below) and fully
// fail-soft. Steps:
//   1. reserve the collection synchronously (before any await) so a concurrent
//      second call backs off — closing the check-then-create TOCTOU;
//   2. derive the buyer's WhatsApp id from the collection's owner_phone;
//   3. createGroup(subject, [buyer]); on success link the group ↔ collection with
//      the buyer + bot recorded as initial members (so they're never greeted as
//      joining friends), and announce with the `group_opened` trigger;
//   4. privacy-block fallback — if the buyer wasn't added, DM them an invite link
//      (group_opened text, link = the group invite) and record it; if that DM also
//      fails, escalate to the owner — by email (notify.sendSystemAlert) AND, when
//      email is unavailable, by a WhatsApp DM to the owner's own number — so a
//      human is always reached even on an email-off deployment.
async function openWhatsappGroup(collection, base) {
  if (!collection || !collection.id) return;
  if (waState.groupForCollection(collection.id)) return; // already have a group — no-op
  // Reserve the intent to create BEFORE the first await. Two concurrent paid
  // events for one collection would otherwise both pass the check above and both
  // createGroup; the loser here backs off, so exactly one group is ever created.
  if (!waState.reserveCollection(collection.id)) return;
  try {
    const buyerWa = ilPhoneToWaId(collection.owner_phone);
    if (!buyerWa) return; // no usable buyer number
    const honoree = collection.honoree_name || '';
    const subject = 'דוגרי · מילים על ' + (honoree || 'בעל/ת השמחה');

    const created = await whatsapp.createGroup(subject, [buyerWa]);
    if (!created || !created.ok || !created.groupId) return;
    const groupId = created.groupId;

    const botId = WHAPI_BOT_WA ? waIdDigits(WHAPI_BOT_WA) : '';
    const initialMembers = botId ? [buyerWa, botId] : [buyerWa];
    waState.linkGroup(groupId, collection.id, buyerWa, initialMembers);

    // Announce the group is open (to the group), then PIN it so anyone who joins
    // the group later still sees the welcome + words link at the top (WhatsApp
    // doesn't reliably webhook member-joins, so we can't greet each joiner). The
    // pin is fail-soft — a pin failure never affects the group flow.
    const opened = await sendWaTrigger(groupId, 'group_opened', waGroupValues(collection, base));
    if (opened.ok && opened.messageId) {
      await whatsapp.pinMessage(opened.messageId).catch(() => {});
    }

    // Privacy-block fallback: the buyer couldn't be added by number.
    if (!buyerLandedInGroup(created, buyerWa)) {
      const invite = await whatsapp.getInviteLink(groupId);
      const inviteLink = invite && invite.ok ? invite.inviteLink : null;
      let dmSent = false;
      if (inviteLink) {
        dmSent = (await sendWaTrigger(buyerWa, 'group_opened', { honoree, link: inviteLink })).ok;
        if (dmSent) waState.setInviteDmSent(groupId);
      }
      if (!dmSent) {
        const alertSubject = 'קבוצת וואטסאפ — צריך צירוף ידני';
        const alertLines = [
          'נפתחה קבוצה לאיסוף מילים אבל לא הצלחנו לצרף את הלקוח/ה אוטומטית.',
          'שם בעל/ת השמחה: ' + (honoree || '—'),
          'טלפון הלקוח/ה: ' + (collection.owner_phone || '—'),
          'מזהה קבוצה: ' + groupId,
          inviteLink ? 'קישור הצטרפות: ' + inviteLink : 'לא הצלחנו להפיק קישור הצטרפות.',
        ];
        // Email escalation is a no-op (returns false) when Resend is dormant. The
        // owner still has WhatsApp, so fall back to a DM to the owner's own number
        // — otherwise an armed-bot + email-off deployment loses this "intervene
        // manually" alert entirely.
        const emailed = await notify.sendSystemAlert(alertSubject, alertLines);
        if (!emailed) await alertOwnerViaWhatsApp(alertSubject, alertLines);
      }
    }
  } finally {
    // Release the reservation whether we succeeded or bailed. On success the group
    // is now in by_collection (so a later call is a no-op via the top guard); on
    // failure the release lets a subsequent paid event retry.
    waState.releaseCollection(collection.id);
  }
}

// Handle ONE normalized webhook event (from whatsapp.parseWebhook). Fail-soft is
// the CALLER's job (each event is wrapped) — this focuses on the logic.
async function handleWaEvent(ev, base) {
  if (!ev) return;
  // De-dupe redelivered events. Whapi is at-least-once and can redeliver a whole
  // batch (a network blip, a slow 200), which would otherwise re-greet a joining
  // friend and re-ack the same words. Skip an event whose id we've already
  // processed for this group. We RECORD the id only AFTER handling it (per branch),
  // batched with that branch's own state write where possible (the hot word path
  // persists activity + the id in ONE write). Unmapped groups aren't in state, so
  // this is a no-op for them (they return early below anyway); events with no id
  // (older test payloads) are never deduped.
  if (ev.id && waState.wasEventProcessed(ev.groupId, ev.id)) return;
  if (ev.kind === 'participants_added') {
    const entry = waState.collectionForGroup(ev.groupId);
    if (!entry) return; // group the bot doesn't own — never greet into a foreign chat
    const collection = entry.collection_id ? db.getCollection(entry.collection_id) : null;
    if (!collection) return;
    // A friend who joins after the list is closed/expired must NOT be invited to
    // add words — consistent with the message path, which checks status first.
    if (db.effectiveStatus(collection) !== 'open') return;
    const gv = waGroupValues(collection, base);
    // Compare on bare digits: initial_members are stored as digits ("9725…") but
    // Whapi sends participant ids as JIDs ("9725…@s.whatsapp.net"). Without
    // normalizing BOTH sides the buyer + bot would be mis-greeted as new friends.
    const initial = new Set((entry.initial_members || []).map(waIdDigits));
    for (const m of ev.added || []) {
      if (initial.has(waIdDigits(m && m.id))) continue; // skip the buyer + bot
      await sendWaTrigger(ev.groupId, 'member_joined', {
        name: (m && m.name) || '',
        honoree: gv.honoree,
        link: gv.link,
      });
    }
    if (ev.id) waState.markEventProcessed(ev.groupId, ev.id);
    return;
  }
  if (ev.kind === 'message') {
    const entry = waState.collectionForGroup(ev.groupId);
    if (!entry) return; // unmapped group — ignore
    const cid = entry.collection_id;
    const collection = cid ? db.getCollection(cid) : null;
    if (!collection) return;
    const gv = waGroupValues(collection, base);
    const isBuyer = entry.owner_wa && ev.from && waIdDigits(entry.owner_wa) === waIdDigits(ev.from);
    const text = String(ev.text || '').trim();

    // Buyer's "finish the list" command: close the collection + announce.
    if (isBuyer && text.toLowerCase() === WA_CLOSE_COMMAND.toLowerCase()) {
      const closed = db.closeCollection(cid, collection.owner_token);
      waState.markClosed(ev.groupId);
      if (closed && closed.changed) {
        await sendWaTrigger(ev.groupId, 'list_closed', {
          honoree: gv.honoree,
          wordCount: db.countWords(cid),
        });
        // This IS the primary completion path: the list is done and ready to
        // produce. Fire the owner "ready to produce" email exactly like the web
        // /close route — otherwise no PDF is ever made and the customer waits
        // forever. Only on the real open->closed transition, gated on email being
        // configured, fire-and-forget so a send failure never escapes the webhook.
        if (notify.isConfigured()) {
          const fresh = db.getCollection(cid);
          if (fresh) {
            notify.sendOrderFinished({ ...fresh, count: db.countWords(cid) }, base).catch(() => {});
          }
        }
      }
      if (ev.id) waState.markEventProcessed(ev.groupId, ev.id);
      return;
    }

    // Collection already closed: post the "list closed" note ONCE (state-deduped
    // via the group's `closed` flag) and stop — no words are collected.
    if (db.effectiveStatus(collection) !== 'open') {
      if (!entry.closed) {
        waState.markClosed(ev.groupId);
        await sendWaTrigger(ev.groupId, 'list_closed', {
          honoree: gv.honoree,
          wordCount: db.countWords(cid),
        });
      }
      if (ev.id) waState.markEventProcessed(ev.groupId, ev.id);
      return;
    }

    // Normal traffic: harvest words from the message, stamp activity, and fire the
    // (default-disabled, so usually silent) `word_added` ack. The activity stamp
    // and the dedupe-id record are batched into a SINGLE persist.
    const words = whatsapp.splitWords(ev.text);
    if (words.length) {
      db.addWords(cid, words, ev.fromName);
      waState.touchActivityWithEvent(ev.groupId, ev.id);
      await sendWaTrigger(ev.groupId, 'word_added', {
        honoree: gv.honoree,
        count: db.countWords(cid),
        link: gv.link,
      });
    } else if (ev.id) {
      waState.markEventProcessed(ev.groupId, ev.id);
    }
    return;
  }
}

// One nudge-scan pass over every active group. Exposed (app.runWaNudgeScan) so a
// test can run a single pass with an injected `now` instead of waiting on the
// interval. No-ops (returns 0) when the bot is unconfigured. For each active
// group: if its collection is gone / no longer open, close the group and skip;
// otherwise ask whatsapp.groupsDueForNudge which time triggers are due now, send
// each (from the catalog), and record the send (daily_* → markNudged by slot,
// quiet_reminder → recordQuietReminder). Disabled triggers never appear in the
// due list, so they stay silent. Fail-soft per group; never throws.
async function runWaNudgeScan(now = Date.now()) {
  if (!whatsapp.isConfigured()) return 0;
  const base = paymentBaseUrl();
  let sent = 0;
  let groups = [];
  try {
    groups = waState.activeGroups();
  } catch {
    return 0;
  }
  // First pass: resolve each group's collection once. Retire (close) any group
  // whose collection is gone or no longer open; keep the rest — with their
  // collection — for a SINGLE batched due-check below.
  const open = [];
  const collectionByGroup = new Map();
  for (const g of groups) {
    try {
      const cid = g.collection_id;
      const collection = cid ? db.getCollection(cid) : null;
      if (!collection || db.effectiveStatus(collection) !== 'open') {
        waState.markClosed(g.groupId);
        continue;
      }
      open.push(g);
      collectionByGroup.set(g.groupId, collection);
    } catch (e) {
      console.warn('[whatsapp] nudge prep failed for group:', e && e.message ? e.message : e);
    }
  }
  if (!open.length) return 0;
  // ONE call for the whole list: groupsDueForNudge builds Intl.DateTimeFormat and
  // reads the trigger catalog once per call, so batching avoids doing that per
  // group.
  let due = [];
  try {
    due = whatsapp.groupsDueForNudge(open, { now });
  } catch (e) {
    console.warn('[whatsapp] groupsDueForNudge failed:', e && e.message ? e.message : e);
    return 0;
  }
  for (const d of due) {
    try {
      const collection = collectionByGroup.get(d.groupId);
      if (!collection) continue;
      const ok = (await sendWaTrigger(d.groupId, d.triggerId, waGroupValues(collection, base))).ok;
      if (!ok) continue; // send failed — don't record, so the next tick retries
      if (d.triggerId === 'quiet_reminder') waState.recordQuietReminder(d.groupId, now);
      else if (d.slotKey) waState.markNudged(d.groupId, d.slotKey);
      sent += 1;
    } catch (e) {
      console.warn('[whatsapp] nudge send failed for group:', e && e.message ? e.message : e);
    }
  }
  return sent;
}

// Owner-only: start a PeleCard card payment for this collection's order.
// Persists/refreshes the order first (same validation as /order), then asks
// PeleCard for an iframe URL. Returns { url } for the browser to load in an
// <iframe>. The ParamX token stored here lets the later callback find the order.
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

  // (Re)set the order for this payment. setOrder preserves the pending PeleCard
  // handshake on an unpaid order, so in-flight ParamX tokens from an earlier
  // still-open pay modal survive (any version, incl. delivery).
  const order = db.setOrder(req.params.id, b.owner_token, {
    version: b.version,
    address: b.address,
  });
  if (order && order.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (order && order.error) return res.status(400).json({ error: order.error });
  // Order created (checkout started) -> fire the one-time owner/buyer emails +
  // WhatsApp group NOW, before the card payment. Idempotent, so re-opening the pay
  // modal (or applying a coupon on a retry) never re-notifies.
  onOrderCreated(req.params.id, base);

  // Optional discount coupon. Re-validate SERVER-SIDE (never trust a client
  // price). The effective charge is what we bill AND what the callback verifies.
  let discountPct = 0;
  let couponCode = null;
  if (b.coupon) {
    // NOT rate-limited here: pay/init is owner_token-gated and performs a real
    // charge, so it must never be blocked by the preview endpoint's oracle budget
    // (an owner previewing a code repeatedly must still be able to pay).
    const v = db.validateCoupon(b.coupon);
    if (!v.valid) return res.status(400).json({ error: 'invalid coupon' });
    discountPct = v.coupon.discount_pct;
    couponCode = v.coupon.code;
  }
  // charged_total is ALWAYS a real number — the full total when no coupon.
  const charged = Math.round(order.total * (1 - discountPct / 100));

  // A base order total can never be 0 (version prices validate as >= 1 and the
  // charge falls back to a positive default), so charged<=0 is ONLY reachable via
  // a coupon that discounts to zero. Guard defensively: if the charge rounds to 0
  // with NO coupon, something is wrong — refuse rather than mark a paid-at-₪0
  // order. Only a real coupon may take the free/skip-PeleCard path.
  if (charged <= 0 && !couponCode) {
    return res.status(400).json({ error: 'invalid order total' });
  }

  // Free order (a coupon discounts it to <= 0): skip PeleCard entirely, mark it
  // paid now, count the coupon use, and tell the client it's paid. BUT NOT while a
  // real (non-free) card session is still in flight — otherwise the customer could
  // complete that charge and be billed for a "free" order.
  if (charged <= 0) {
    if (db.hasInFlightRealSession(order)) {
      return res.status(409).json({ error: 'יש תשלום פתוח — סגרו את חלון התשלום לפני החלת קופון' });
    }
    db.markPaid(req.params.id, {
      method: 'coupon',
      charged_total: 0,
      coupon: couponCode,
      discount_pct: couponCode ? discountPct : null,
    });
    if (couponCode) db.incrementCouponUses(couponCode);
    // A free (100%-coupon) order is now paid — fire the same paid-order side
    // effects as the PeleCard callback (owner/buyer emails when email is on, the
    // WhatsApp group when the bot is armed), showing the real charged amount (0).
    onOrderPaid(req.params.id, base, 0);
    return res.json({ free: true, paid: true, total: 0 });
  }

  const paramToken = newPayToken();
  try {
    const { url, transactionId } = await pelecard.init({
      amountNis: charged,
      paramToken,
      urls: {
        goodUrl: base + '/pay-done.html',
        errorUrl: base + '/pay-done.html?error=1',
        serverGoodUrl: base + '/api/payment/callback',
        serverErrorUrl: base + '/api/payment/callback?error=1',
      },
    });
    // Record THIS session's own charged amount + coupon so the callback for it
    // verifies against the right price (sessions with different coupons stay
    // independent).
    db.recordPaymentInit(req.params.id, {
      paramToken,
      transactionId,
      charged_total: charged,
      coupon: couponCode,
      discount_pct: couponCode ? discountPct : null,
    });
    res.json({ url, total: order.total, charged });
  } catch (e) {
    res.status(502).json({ error: 'payment init failed' });
  }
});

// PeleCard server-side callback (ServerSideGoodFeedbackURL). The body is
// UNTRUSTED — we take only the TransactionId from it, then re-fetch the
// transaction from PeleCard with our secret credentials (getTransaction) and
// decide off that. A forged callback cannot survive: an unknown/foreign
// TransactionId either fails the lookup or maps to a different order's token.
app.post('/api/payment/callback', async (req, res) => {
  const parsed = pelecard.parseCallback(req.body || {});
  // We need a TransactionId to re-fetch the transaction. Prefer the one in the
  // callback; if it's absent, fall back to the id we stored at init (located via
  // the echoed ParamX token).
  let transactionId = parsed.transactionId;
  if (!transactionId && parsed.paramX) {
    // Fall back to the id we stored for that session (located via the echoed
    // ParamX token), then the per-order last_transaction_id as a last resort.
    const match = db.getPaymentSessionByToken(parsed.paramX);
    transactionId =
      (match && match.session && match.session.transaction_id) ||
      (match &&
        match.collection.order.pelecard &&
        match.collection.order.pelecard.last_transaction_id) ||
      null;
  }
  if (!transactionId) return res.json({ ok: true });

  let tx;
  try {
    tx = await pelecard.getTransaction(transactionId);
  } catch (e) {
    // Transient error verifying with PeleCard: return non-200 so PeleCard
    // retries the callback once (markPaid is idempotent).
    return res.status(502).json({ error: 'verification failed' });
  }

  // Locate the specific pay SESSION by the AUTHORITATIVE token PeleCard returned.
  // Verify tx against THAT session's own charged_total (sessions opened with
  // different coupons must each verify against their own price) — never a shared
  // order-level amount. On success mark paid + credit THAT session's coupon.
  const match = db.getPaymentSessionByToken(tx.paramX);
  const c = match && match.collection;
  const session = match && match.session;
  if (
    c &&
    session &&
    !c.order.paid &&
    pelecard.verifyTransaction(tx, { amountNis: session.charged_total })
  ) {
    db.markPaid(c.id, {
      method: 'pelecard',
      transactionId: tx.transactionId,
      approvalNo: tx.approvalNo,
      token: session.token,
      charged_total: session.charged_total,
      coupon: session.coupon,
      discount_pct: session.discount_pct,
    });
    // Count the coupon use once, on the real unpaid->paid transition.
    if (session.coupon) db.incrementCouponUses(session.coupon);
    // Fire the paid-order side effects, showing the amount ACTUALLY charged for
    // THIS session (never the pre-coupon order.total). Email owner/buyer
    // notifications and the WhatsApp group-open are INDEPENDENTLY gated inside
    // onOrderPaid — each stays dormant until its own service is configured.
    onOrderPaid(c.id, paymentBaseUrl(), session.charged_total);
  }
  res.json({ ok: true });
});

// Admin: onboard a NEW private template. Multipart upload of the clean +
// filled {fronts,backs,board} SVGs, the title + word font files, and a few text
// fields (slug, display_he, title_text, name_form, language?, extra_fields?).
// Writes them into resources/canva/templates/<slug>/, best-effort runs
// generator/recipe_diff.py to produce generator/recipes/<slug>.json, and appends
// a visibility:"private", calibrated:false entry to generator/themes.json. The
// new template is NOT yet renderable — it needs a title-style calibration pass.
// Body is parsed with a tiny in-repo multipart parser (no multer/busboy dep).
app.post(
  '/api/admin/templates',
  express.raw({ type: () => true, limit: TEMPLATE_UPLOAD_LIMIT }),
  (req, res) => {
    if (!requireAdmin(req, res)) return;
    const boundary = templates.boundaryFromContentType(req.headers['content-type']);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'expected multipart/form-data upload' });
    }
    const { fields, files } = templates.parseMultipart(req.body, boundary);
    let result;
    try {
      result = templates.onboardTemplate({
        root: TEMPLATE_ROOT,
        pythonBin: PYTHON_BIN,
        fields,
        files,
      });
    } catch (e) {
      return res
        .status(500)
        .json({ error: 'onboarding failed', detail: String((e && e.message) || e) });
    }
    if (result.error) return res.status(result.httpStatus || 400).json({ error: result.error });
    res.status(201).json({ ok: true, ...result });
  }
);

// Admin: template STATUS view — READ-ONLY inventory of every registered template
// and which of its assets exist vs are MISSING (front/back/board clean+filled,
// the OPTIONAL chasers board, and both fonts). Powers the admin checklist so gaps
// — especially a missing chasers board — are visible at a glance.
app.get('/api/admin/templates', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let list;
  try {
    list = templates.listTemplateStatuses(TEMPLATE_ROOT);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  res.json({ templates: list });
});

// Admin: rename a template's DISPLAY LABEL only (display_he). The slug/key/dir —
// the identity stored orders reference — stay stable, so a rename never breaks an
// existing order. Body: { display_he }.
app.post('/api/admin/templates/:key/rename', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const displayName = (req.body && (req.body.display_he ?? req.body.name)) || '';
  let result;
  try {
    result = templates.renameTemplate({
      root: TEMPLATE_ROOT,
      key: req.params.key,
      displayName,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result.error) return res.status(result.httpStatus || 400).json({ error: result.error });
  res.json({ ok: true, ...result });
});

// Admin: replace a SINGLE asset of an existing template in place. Multipart
// upload of one file part; the role (whitelisted) comes from the URL so the write
// target is a fixed path inside the template dir — no traversal, and the other
// onboarded assets are untouched. SVG roles are SVG-validated, font roles by sfnt
// magic. On a CALIBRATED template, replacing an SVG role is rejected (409,
// calibrationWarning) unless the form carries force=1 — the UI re-submits with
// force after the admin confirms they verified the proof.
app.post(
  '/api/admin/templates/:key/assets/:role',
  express.raw({ type: () => true, limit: TEMPLATE_UPLOAD_LIMIT }),
  (req, res) => {
    if (!requireAdmin(req, res)) return;
    const boundary = templates.boundaryFromContentType(req.headers['content-type']);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'expected multipart/form-data upload' });
    }
    const { fields, files } = templates.parseMultipart(req.body, boundary);
    const file = files.file || files.asset || Object.values(files)[0];
    const force = fields && (fields.force === '1' || fields.force === 'true');
    let result;
    try {
      result = templates.replaceAsset({
        root: TEMPLATE_ROOT,
        key: req.params.key,
        role: req.params.role,
        file,
        force,
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (result.error) {
      const { httpStatus, error, ...rest } = result;
      return res.status(httpStatus || 400).json({ error, ...rest });
    }
    res.json({ ok: true, ...result });
  }
);

// Inline content editor. The owner edits any tagged text/photo on the live site
// in an admin-key-gated edit mode; the overrides persist under DATA_DIR (see
// server/content.js) and overlay the shipped defaults for EVERY visitor. The
// public GET is unauthenticated on purpose — every visitor must render the
// current copy — while all writes are behind requireAdmin.
app.get('/api/content', (req, res) => {
  res.json({ overrides: content.getPage(req.query.page) });
});

// Public: the current display name per orderable design id, so an admin "rename
// template" (which edits generator/themes.json display_he) reaches products.html
// and the product page WITHOUT a rebuild. Each design carries its generator theme
// (site/js/designs.js), so themes.json.display_he maps straight onto the design id
// — no separate slug↔id table. Unauthenticated on purpose (every visitor needs the
// current names) and exposes ONLY the { id: name } map, never any other theme
// field. themes.json is read ONCE per request; any error (missing/corrupt config,
// catalog import failure) resolves to {} so the pages fall back to their built-in
// names and never break. The buyer-facing fetchers add their own timeout.
app.get('/api/design-names', async (req, res) => {
  let names = {};
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')));
    // PUBLIC subset only — a private/access-gated design's name must never leak to
    // anonymous visitors. themes.json is read through an mtime cache so this hot
    // endpoint doesn't hit disk on every products.html / product.html load.
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
    names = templates.designDisplayNames(themes, mod.PUBLIC_DESIGNS || []);
  } catch {
    names = {};
  }
  res.json({ names });
});

// Serve an uploaded content image. The files live in DATA_DIR/content-uploads,
// which is OUTSIDE SITE_DIR, so express.static never reaches them — this route is
// the only way out. The name is validated to the exact shape saveImageBytes
// produces (hash + allowlisted ext), so there is no traversal or arbitrary read.
app.get('/content-uploads/:name', (req, res) => {
  const name = String(req.params.name || '');
  // Raster only (webp/jpg/png) — SVG is never stored (see content.extFromMagic).
  if (!/^[a-f0-9]{16}\.(webp|jpe?g|png)$/.test(name)) {
    return res.status(404).type('txt').send('Not found');
  }
  const file = path.join(content._uploadDir, name);
  if (!fs.existsSync(file)) return res.status(404).type('txt').send('Not found');
  // Content-addressed names never change contents, so cache hard + immutable.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // Defense in depth: never let a browser MIME-sniff an uploaded file into an
  // executable type, so a served image can't be interpreted as HTML/script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
});

// Admin: set a text override for page/key (text may be "" to blank the node).
app.post('/api/admin/content', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { page, key, text } = req.body || {};
  if (!content.pageOk(page) || !content.keyOk(key)) {
    return res.status(400).json({ error: 'bad page or key' });
  }
  content.setText(page, key, text);
  res.json({ ok: true });
});

// Admin: remove a page/key override entirely (revert to the shipped default).
app.delete('/api/admin/content', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { page, key } = req.body || {};
  if (!content.pageOk(page) || !content.keyOk(key)) {
    return res.status(400).json({ error: 'bad page or key' });
  }
  content.remove(page, key);
  res.json({ ok: true });
});

// Admin: replace a tagged photo. Multipart upload (fields page,key + a file
// part) parsed with the same in-repo parser the templates upload uses. The bytes
// are typed by their magic bytes (not the client name) and saved under a
// content-hash filename; the override then points every tagged node at it.
app.post(
  '/api/admin/content/image',
  // Authenticate (on ?key=, available before the body) BEFORE buffering up to
  // several MB, so an unauthenticated client can't force large allocations.
  (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    next();
  },
  express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
  (req, res) => {
    const boundary = templates.boundaryFromContentType(req.headers['content-type']);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'expected multipart/form-data upload' });
    }
    const { fields, files } = templates.parseMultipart(req.body, boundary);
    const page = fields.page;
    const key = fields.key;
    if (!content.pageOk(page) || !content.keyOk(key)) {
      return res.status(400).json({ error: 'bad page or key' });
    }
    const file = files.file || files.image || Object.values(files)[0];
    if (!file || !Buffer.isBuffer(file.data)) {
      return res.status(400).json({ error: 'no image file part' });
    }
    let img;
    try {
      img = content.saveImageBytes(file.data).path;
    } catch (e) {
      return res.status(400).json({ error: String((e && e.message) || e) });
    }
    content.setImg(page, key, img);
    res.json({ ok: true, img });
  }
);

// Admin: APPEND a photo to a page/key's photo ARRAY (a product carousel). Same
// multipart shape + magic-byte typing as the single-image route; the difference
// is the bytes are pushed onto the key's `imgs` array (not set as its `img`), and
// the response returns the whole array so the client re-renders the carousel.
app.post(
  '/api/admin/content/photos',
  (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    next();
  },
  express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
  (req, res) => {
    const boundary = templates.boundaryFromContentType(req.headers['content-type']);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'expected multipart/form-data upload' });
    }
    const { fields, files } = templates.parseMultipart(req.body, boundary);
    const page = fields.page;
    const key = fields.key;
    if (!content.pageOk(page) || !content.keyOk(key)) {
      return res.status(400).json({ error: 'bad page or key' });
    }
    const file = files.file || files.image || Object.values(files)[0];
    if (!file || !Buffer.isBuffer(file.data)) {
      return res.status(400).json({ error: 'no image file part' });
    }
    const before = content.getPhotos(page, key);
    let img, created;
    try {
      ({ path: img, created } = content.saveImageBytes(file.data));
    } catch (e) {
      return res.status(400).json({ error: String((e && e.message) || e) });
    }
    const imgs = content.addPhoto(page, key, img);
    if (imgs == null) {
      // Bad page/key AFTER the file was written — reclaim the orphan, but ONLY if THIS
      // request created it (content-addressed: created:false means the bytes already
      // existed on the volume before us — a pre-existing file we must never delete).
      if (created && !content.isImageReferenced(img)) content.deleteUpload(img);
      return res.status(400).json({ error: 'bad page or key' });
    }
    // The upload was DROPPED (array already at PHOTO_CAP, or a content-hash
    // duplicate) → the array didn't grow. Don't report a false success: delete the
    // just-written orphan — but only when THIS request created the file (created:true)
    // AND nothing else references this shared, content-addressed file.
    if (imgs.length <= before.length) {
      if (created && !content.isImageReferenced(img)) content.deleteUpload(img);
      const atCap = before.length >= content.PHOTO_CAP;
      const error = atCap ? `הגעת למקסימום ${content.PHOTO_CAP} תמונות` : 'התמונה כבר קיימת בגלריה';
      return res.status(409).json({ error, imgs });
    }
    res.json({ ok: true, img, imgs });
  }
);

// Admin: REPLACE a page/key's whole photo array (used for remove + reorder — the
// client sends the desired full order as JSON `imgs`). Each entry is re-validated
// server-side to an our-own /content-uploads path, so the array can never point
// off-origin. An empty array is valid (reverts that carousel to its defaults).
app.put('/api/admin/content/photos', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { page, key, imgs } = req.body || {};
  if (!content.pageOk(page) || !content.keyOk(key)) {
    return res.status(400).json({ error: 'bad page or key' });
  }
  if (!Array.isArray(imgs)) return res.status(400).json({ error: 'imgs must be an array' });
  const next = content.setPhotos(page, key, imgs);
  if (next == null) return res.status(400).json({ error: 'bad page or key' });
  res.json({ ok: true, imgs: next });
});

// --- Per-design GALLERY (server/design-images.js) ----------------------------
// The owner CURATES each design's gallery WITHOUT a deploy — same self-serve
// pattern as the content editor: REPLACE a base render (store|front|back|board),
// ADD named extra photos, toggle each picture's visibility per surface (products
// grid / product detail), and reorder. Storage is REUSED from content.js: a
// picture only ever holds a "/content-uploads/<hash>.<ext>" path THIS server
// produced (magic-byte typed, size-capped), so it can never point off-origin.
// Uploads are content-addressed and SHARED across the design-images store AND the
// content store, so before reclaiming a displaced file we confirm NEITHER store
// still references it.

// Reclaim a now-orphaned upload: delete it only when no design-image picture and
// no content override still points at it (content-addressed files are shared).
function reclaimDesignImage(imgPath) {
  if (!imgPath) return;
  if (designImages.isImageReferenced(imgPath)) return;
  if (content.isImageReferenced(imgPath)) return;
  content.deleteUpload(imgPath);
}

// Save the multipart file part as an our-own upload, or send a 400. Returns the
// "/content-uploads/<name>" path on success, or null after responding on failure.
function saveGalleryUpload(req, res) {
  const boundary = templates.boundaryFromContentType(req.headers['content-type']);
  if (!boundary || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'expected multipart/form-data upload' });
    return null;
  }
  const { fields, files } = templates.parseMultipart(req.body, boundary);
  const file = files.file || files.image || Object.values(files)[0];
  if (!file || !Buffer.isBuffer(file.data)) {
    res.status(400).json({ error: 'no image file part' });
    return null;
  }
  let img;
  try {
    img = content.saveImageBytes(file.data).path;
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
    return null;
  }
  return { img, fields };
}

// Public: the whole gallery-config map. Unauthenticated on purpose — every
// visitor's grid + product page needs it to render the owner's curated gallery
// (see site/js/design-images.js). Read-only; res.json copies.
app.get('/api/design-images', (req, res) => {
  res.json({ images: designImages.getAll() });
});

// Admin: REPLACE a base render (store|front|back|board) with an uploaded picture.
// Multipart (fields designId, slot + a file part). A displaced prior override is
// reclaimed. Auth runs on ?key= BEFORE buffering megabytes.
app.post(
  '/api/admin/design-images/base/image',
  (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    next();
  },
  express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
  (req, res) => {
    const saved = saveGalleryUpload(req, res);
    if (!saved) return;
    const designId = designImages.designOk(saved.fields.designId);
    const slot = designImages.slotOk(saved.fields.slot);
    if (!designId || !slot) {
      // Reclaim the just-written orphan (nothing references it yet).
      reclaimDesignImage(saved.img);
      return res.status(400).json({ error: 'bad designId or slot' });
    }
    const { prev } = designImages.setBaseImg(designId, slot, saved.img);
    if (prev) reclaimDesignImage(prev);
    res.json({ ok: true, img: saved.img, gallery: designImages.getForDesign(designId) });
  }
);

// Admin: ADD a named extra photo to a design's gallery. Multipart (fields
// designId, name? + a file part).
app.post(
  '/api/admin/design-images/photo',
  (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    next();
  },
  express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
  (req, res) => {
    const saved = saveGalleryUpload(req, res);
    if (!saved) return;
    const designId = designImages.designOk(saved.fields.designId);
    if (!designId) {
      reclaimDesignImage(saved.img);
      return res.status(400).json({ error: 'bad designId' });
    }
    const photo = designImages.addPhoto(designId, saved.img, saved.fields.name);
    res.json({ ok: true, photo, gallery: designImages.getForDesign(designId) });
  }
);

// Admin: revert a base slot to its shipped render. JSON { designId, slot }.
app.delete('/api/admin/design-images/base', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { designId, slot } = req.body || {};
  if (!designImages.designOk(designId) || !designImages.slotOk(slot)) {
    return res.status(400).json({ error: 'bad designId or slot' });
  }
  const { prev } = designImages.resetBaseImg(designId, slot);
  if (prev) reclaimDesignImage(prev);
  res.json({ ok: true, gallery: designImages.getForDesign(designId) });
});

// Admin: set a base slot's per-surface visibility. JSON { designId, slot,
// onProducts?, onProduct? }.
app.post('/api/admin/design-images/base/flags', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { designId, slot, onProducts, onProduct } = req.body || {};
  if (!designImages.designOk(designId) || !designImages.slotOk(slot)) {
    return res.status(400).json({ error: 'bad designId or slot' });
  }
  const flags = {};
  if (onProducts !== undefined) flags.onProducts = !!onProducts;
  if (onProduct !== undefined) flags.onProduct = !!onProduct;
  designImages.setBaseFlags(designId, slot, flags);
  res.json({ ok: true, gallery: designImages.getForDesign(designId) });
});

// Admin: patch an extra photo's name / visibility. JSON { designId, photoId,
// name?, onProducts?, onProduct? }.
app.post('/api/admin/design-images/photo/update', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { designId, photoId, name, onProducts, onProduct } = req.body || {};
  if (!designImages.designOk(designId)) {
    return res.status(400).json({ error: 'bad designId' });
  }
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (onProducts !== undefined) patch.onProducts = !!onProducts;
  if (onProduct !== undefined) patch.onProduct = !!onProduct;
  const photo = designImages.updatePhoto(designId, photoId, patch);
  if (!photo) return res.status(404).json({ error: 'photo not found' });
  res.json({ ok: true, photo, gallery: designImages.getForDesign(designId) });
});

// Admin: remove an extra photo. JSON { designId, photoId }. Reclaims its file.
app.delete('/api/admin/design-images/photo', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { designId, photoId } = req.body || {};
  if (!designImages.designOk(designId)) {
    return res.status(400).json({ error: 'bad designId' });
  }
  const removed = designImages.removePhoto(designId, photoId);
  if (removed == null) return res.status(404).json({ error: 'photo not found' });
  reclaimDesignImage(removed);
  res.json({ ok: true, gallery: designImages.getForDesign(designId) });
});

// Admin: set the gallery display order. JSON { designId, order: [key,...] }
// (keys = base slots + photo ids).
app.post('/api/admin/design-images/order', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { designId, order } = req.body || {};
  if (!designImages.designOk(designId)) {
    return res.status(400).json({ error: 'bad designId' });
  }
  const next = designImages.setOrder(designId, order);
  if (next == null) return res.status(400).json({ error: 'order must be an array' });
  res.json({ ok: true, gallery: designImages.getForDesign(designId) });
});

// Public social-proof "celebrations" counter for the homepage. Returns ONLY an
// aggregate number: a fixed base plus the count of paid orders — never any order
// detail. Unauthenticated on purpose (every visitor renders it). The base is a
// named constant (overridable via env) so it's easy to bump later.
// Base offset for the public celebrations counter. Guard against a non-numeric
// env value (Number("twenty") → NaN would make the count serialize to null).
const ORDERS_COUNT_BASE = (() => {
  const n = Number(process.env.ORDERS_COUNT_BASE);
  return Number.isFinite(n) ? n : 23;
})();
app.get('/api/stats/orders', (req, res) => {
  res.json({ count: ORDERS_COUNT_BASE + db.countPaidOrders() });
});

// Admin: the FULL overrides object (every page). The public GET /api/content
// returns only ONE page; this admin-gated route returns the whole store so the
// cross-service import below can mirror it. Gated by requireAdmin (unlike the
// public per-page GET) since it exposes every page's overrides in one shot.
app.get('/api/admin/content/all', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ overrides: content.getAll() });
});

// Admin: one-click import — mirror ALL content overrides from the STAGING service
// onto THIS one. Staging and prod have SEPARATE volumes, so edits made in staging's
// editor never reach prod otherwise. Config (PRODUCTION service only — see
// RAILWAY_SETUP.md): STAGING_URL = the staging base URL; STAGING_ADMIN_KEY = staging's
// admin key (the two services use DIFFERENT keys, so prod's own ADMIN_KEY can't
// authenticate against staging — falls back to ADMIN_KEY only when they happen to
// match). Refuses a self-import (STAGING_URL == this origin) and a missing STAGING_URL;
// backs up the current store before overwriting; fetches + re-saves every referenced
// image. Fail-soft: any error leaves the live store intact.
app.post('/api/admin/content/import-from-staging', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ownOrigins = [];
  if (process.env.PUBLIC_BASE_URL) ownOrigins.push(process.env.PUBLIC_BASE_URL);
  try {
    ownOrigins.push(req.protocol + '://' + req.get('host'));
  } catch {
    /* no Host header — PUBLIC_BASE_URL still guards the self-import check */
  }
  let result;
  try {
    result = await contentImport.importFromStaging({
      stagingUrl: process.env.STAGING_URL || '',
      ownOrigins,
      adminKey: process.env.STAGING_ADMIN_KEY || ADMIN_KEY || '',
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  res.json(result);
});

// Admin: owner-editable message templates + settings. The email subject/body
// templates, the editable label maps and the WhatsApp trigger catalog all live
// in server/settings.js (a DATA_DIR store overlaying the registry defaults). The
// GET returns defaults + overrides + effective values + the registry (tokens +
// kind per key) so the admin page can render an editor; POST stores one override,
// DELETE resets one key back to its default. All behind the admin key.
app.get('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(settings.all());
});
app.post('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { section, key, value } = req.body || {};
  if (!settings.hasKey(section, key)) {
    return res.status(400).json({ error: 'unknown section/key' });
  }
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  // Reject a value whose SHAPE doesn't match the registry default (null/array/
  // string for an object key, a non-string subject/body, etc.) BEFORE it can
  // reach the store — a bad override would break live email rendering. The store
  // is left untouched on a rejected write.
  const shapeError = settings.validateValue(section, key, value);
  if (shapeError) return res.status(400).json({ error: shapeError });
  res.json({ effective: settings.set(section, key, value) });
});
app.delete('/api/admin/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  // section/key come from the body, but fall back to the query string: many HTTP
  // clients/proxies drop a DELETE request body, which would otherwise make reset
  // silently 400 and leave a broken override un-clearable. NOTE: the `key` query
  // param is reserved for the admin secret (requireAdmin), so the settings key
  // uses `settingKey` to avoid a collision.
  const body = req.body || {};
  const section = body.section != null ? body.section : req.query.section;
  const key = body.key != null ? body.key : req.query.settingKey;
  if (!settings.hasKey(section, key)) {
    return res.status(400).json({ error: 'unknown section/key' });
  }
  res.json({ effective: settings.reset(section, key) });
});

// WhatsApp bot inbound webhook (Whapi Cloud). Point Whapi's webhook at
// /api/whatsapp/webhook?secret=<WHAPI_WEBHOOK_SECRET>. DORMANT until armed:
// verifies the shared secret (timing-safe) first — a missing/mismatched secret,
// or a bot with no secret configured, is rejected 403 with no work; when the bot
// isn't fully armed we accept but do nothing. Otherwise every parsed event is
// handled fail-soft (a bad event or a Whapi send failure never throws out of the
// route and never breaks the rest of the batch), and we ALWAYS answer 200 so
// Whapi doesn't retry-storm.
// Mirror (copy) an inbound WhatsApp webhook to ANOTHER environment's webhook, so a
// group created there can also collect words — e.g. production forwards a copy to
// staging. One Whapi channel delivers to ONE URL (production), but a group's
// collection mapping lives only in the service that CREATED it; forwarding a copy
// lets each environment act on its OWN groups (an unmapped group is already a
// no-op, so a copy of prod's real traffic is silently ignored by staging and never
// stored there). Fire-and-forget: never blocks or fails the webhook response. The
// `mirror=1` marker on the forwarded URL stops the copy from being re-forwarded (no
// ping-pong loops) — so set WHATSAPP_MIRROR_WEBHOOK_URL ONLY on the entry
// environment (production), pointing at staging's webhook (with staging's secret).
const WHATSAPP_MIRROR_WEBHOOK_URL = process.env.WHATSAPP_MIRROR_WEBHOOK_URL || '';
function mirrorWebhook(req) {
  try {
    if (!WHATSAPP_MIRROR_WEBHOOK_URL) return;
    const q = req.query || {};
    if (q.mirror === '1' || q.mirror === 'true') return; // this IS a mirror — don't re-forward
    const sep = WHATSAPP_MIRROR_WEBHOOK_URL.includes('?') ? '&' : '?';
    const url = WHATSAPP_MIRROR_WEBHOOK_URL + sep + 'mirror=1';
    const fetchImpl = typeof fetch !== 'undefined' ? fetch : null;
    if (!fetchImpl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  } catch {
    /* a mirror failure must never break the webhook */
  }
}

// Should we log a 0-event webhook's shape? Scoped so routine traffic (status
// receipts, our own from_me echoes, plain text) never spams — but a "member added"
// is captured whether Whapi delivers it as a GROUP event OR as a system `messages`
// action. True when the body has a group/participant key, OR carries an inbound
// (not from_me) NON-text message that parseWebhook dropped (a system/action event).
function isGroupWebhook(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (Object.keys(body).some((k) => /group|participant/i.test(k))) return true;
  if (Array.isArray(body.messages)) {
    return body.messages.some((m) => m && !m.from_me && m.type && m.type !== 'text');
  }
  return false;
}

// Structure-only fingerprint of a webhook body for diagnostics: top-level keys ->
// (for an array of objects) the keys of the first element, else the value's type.
// Emits field NAMES only — never message text, phone numbers or names — so an
// unhandled inbound reveals its shape without leaking any content.
function webhookShape(body) {
  if (!body || typeof body !== 'object') return typeof body;
  const out = {};
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (Array.isArray(v)) {
      out[k] =
        v[0] && typeof v[0] === 'object' ? '[{' + Object.keys(v[0]).join(',') + '}]' : 'array';
    } else if (v && typeof v === 'object') {
      out[k] = '{' + Object.keys(v).join(',') + '}';
    } else {
      out[k] = typeof v;
    }
  }
  return out;
}

app.post('/api/whatsapp/webhook', async (req, res) => {
  if (!whatsapp.verifyWebhookSecret(req.query && req.query.secret)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // Mirror a COPY of this inbound to another environment's webhook (prod ->
  // staging), so a group created there can also collect its words. Fire-and-
  // forget; never blocks the response. A no-op unless WHATSAPP_MIRROR_WEBHOOK_URL
  // is set and this request isn't itself a mirror.
  mirrorWebhook(req);
  if (!whatsapp.isConfigured()) return res.status(200).json({ ok: true });
  const base = paymentBaseUrl();
  try {
    const { events } = whatsapp.parseWebhook(req.body);
    // Diagnostic: if we recognized NO events but this looks like an unhandled
    // group/participant inbound (a join can arrive as a `groups`/PATCH event OR as
    // a system `messages` action, neither of which parseWebhook matches yet), log
    // the body's STRUCTURE — field names only, never content — so the real shape is
    // visible and can be parsed. Scoped (isGroupWebhook) so routine status receipts
    // and our own echoes don't spam the log.
    if (events.length === 0 && isGroupWebhook(req.body)) {
      console.warn(
        '[whatsapp] unhandled group webhook shape:',
        JSON.stringify(webhookShape(req.body))
      );
    }
    for (const ev of events) {
      try {
        await handleWaEvent(ev, base);
      } catch (e) {
        console.warn('[whatsapp] event failed:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[whatsapp] webhook failed:', e && e.message ? e.message : e);
  }
  res.status(200).json({ ok: true });
});

// Admin: WhatsApp arming status — a non-secret readout so the owner can confirm
// the bot is live after setting the Railway env, instead of reading logs. Returns
// only PRESENCE booleans (never the token/secret VALUES): { enabled, tokenPresent,
// webhookSecretPresent, baseUrl, configured, ready }. `configured` = can send/open
// groups; `ready` = configured AND a webhook secret is set = the full round-trip
// (send + receive). Admin-gated because the arming state, while not a secret, is
// operational and shouldn't be public.
app.get('/api/whatsapp/status', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(whatsapp.status());
});

// Public: the buyer-wizard feature flags. Unauthenticated on purpose — every
// visitor's wizard must know which of the gated features to show. Returns ONLY a
// flat projection of the features section's effective booleans (never other
// settings sections or secrets). The keys are derived from the registry's
// `features` section so a flag added there is projected automatically — while
// the projection is scoped to that ONE section, so nothing else can ever leak.
// Mirrors the public GET /api/content. All writes stay behind the admin key via
// /api/admin/settings.
app.get('/api/features', (req, res) => {
  // Deep-clones the whole settings tree — call it ONCE (this is an unauthenticated
  // hot path hit on every wizard load).
  const all = settings.all();
  const eff = (all.effective && all.effective.features) || {};
  const out = {};
  for (const k of Object.keys((all.registry && all.registry.features) || {})) {
    out[k] = !!eff[k];
  }
  res.json(out);
});

// Public, UNAUTHENTICATED: the effective pricing the storefront + checkout read
// (the owner edits it from admin-pricing.html, no deploy). A WHITELISTED
// projection of only the `pricing` settings section — the store display price and
// each checkout version's { enabled, price }. No other settings section leaks
// here. Mirrors GET /api/content (public overrides projection).
app.get('/api/pricing', (req, res) => {
  // db.effectivePricing() is the SINGLE source shared with the charge path (it
  // reads the same versionEnabled/versionPrice/storeValue helpers), so the price
  // a buyer is shown can never disagree with the price the server charges — and a
  // corrupt override falls back to the same built-in default the charge uses (not
  // a misleading 0). Only the whitelisted { store, versions } is exposed here.
  res.json(db.effectivePricing());
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
      if (filePath.endsWith('.html')) return res.setHeader('Cache-Control', 'no-cache');
      // Self-hosted fonts: woff2 filenames are content-hashed (see
      // scripts/fetch-fonts.mjs), so a regen with changed bytes yields a NEW url
      // — the immutable 1-year cache is safe and self-busting. fonts.css keeps a
      // stable name, so it only revalidates daily to pick up the new hashed refs.
      if (filePath.endsWith('.woff2'))
        return res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (filePath.endsWith('fonts.css'))
        return res.setHeader('Cache-Control', 'public, max-age=86400');
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

// --- Words-reminder scheduler ---------------------------------------------
// A collection that's been sitting for 3+ days with no words gets ONE nudge email
// asking the buyer to add their word list (production can't start until it
// arrives). One pass = find the due collections (db.collectionsDueForReminder),
// email each via notify.sendWordsReminder, then mark it reminded so it's never
// emailed again. Exposed as a callable so a test can run a single pass without
// waiting on the interval. Fully wrapped and no-ops when email is unconfigured;
// it never throws into the caller.
const REMINDER_SCAN_INTERVAL_MS = Number(process.env.REMINDER_SCAN_INTERVAL_MS || 60 * 60 * 1000);
// The WhatsApp nudge scan runs on the same hourly cadence (the daily triggers
// catch up the same day once past their hour; quiet reminders are spaced by
// idle_hours), and stays dormant unless the bot is armed.
const WA_NUDGE_SCAN_INTERVAL_MS = Number(process.env.WA_NUDGE_SCAN_INTERVAL_MS || 60 * 60 * 1000);

async function runReminderScan(now = Date.now()) {
  if (!notify.isConfigured()) return 0;
  const base = paymentBaseUrl();
  let sent = 0;
  try {
    const due = db.collectionsDueForReminder(now);
    for (const c of due) {
      try {
        // word_count is 0 for every due collection (the query requires it); pass
        // it so the reminder's body renders a correct count.
        await notify.sendWordsReminder({ ...c, word_count: 0 }, base);
        // Mark reminded regardless of the send result — one nudge per collection.
        // sendWordsReminder already swallows its own failures (returns false), so
        // a transient miss won't loop the same customer forever.
        db.markReminded(c.id);
        sent += 1;
      } catch (e) {
        console.warn('[reminder] send failed:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[reminder] scan failed:', e && e.message ? e.message : e);
  }
  return sent;
}

// --- Payment-reminder scheduler -------------------------------------------
// The current hour (0..23) in Israel time — for the payment reminder's daytime
// window gate, so a nudge never fires in the middle of the night.
function jerusalemHour(now) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(now));
  const h = Number(s);
  return h === 24 ? 0 : h;
}

// One pass of the payment reminder: a DM + email to the buyer when their order has
// sat unpaid past the owner-configured delay. The payment_reminder WhatsApp
// trigger is the MASTER switch (enabled) + schedule (timing.delay_hours + window)
// for BOTH channels. When enabled and inside the window, each due collection gets
// the email (if Resend is configured) and a WhatsApp DM to the buyer (if the bot
// is armed), then is marked reminded so it's never nudged twice. Exposed as a
// callable so a test can run one pass without the interval. Fully wrapped; never
// throws into the caller.
async function runPaymentReminderScan(now = Date.now()) {
  const emailOn = notify.isConfigured();
  const waOn = whatsapp.isConfigured();
  if (!emailOn && !waOn) return 0;
  let trig;
  try {
    trig = settings.get('wa', 'trigger.payment_reminder');
  } catch {
    return 0;
  }
  if (!trig || !trig.enabled) return 0; // master switch off
  const timing = trig.timing || {};
  // Milestones (hours after an unpaid order) at which to nudge — remind at each,
  // once, until paid. Fall back to a single 24h reminder for a malformed value.
  const delays = Array.isArray(timing.delays) && timing.delays.length ? timing.delays : [24];
  const window = Array.isArray(timing.window) && timing.window.length === 2 ? timing.window : null;
  if (window) {
    const h = jerusalemHour(now);
    if (!(h >= window[0] && h < window[1])) return 0; // outside the daytime window
  }
  const base = paymentBaseUrl();
  let sent = 0;
  try {
    const due = db.collectionsDueForPaymentReminder(now, delays);
    for (const c of due) {
      try {
        if (emailOn && c.owner_email) await notify.sendPaymentReminder(c, base);
        if (waOn && c.owner_phone) {
          const buyerWa = ilPhoneToWaId(c.owner_phone);
          if (buyerWa) {
            // The buyer's OWN pay link (their owner token) — safe in a 1:1 DM.
            const link =
              base && c.id && c.owner_token
                ? base + '/collect.html?c=' + c.id + '&k=' + c.owner_token
                : '';
            await sendWaTrigger(buyerWa, 'payment_reminder', {
              honoree: c.honoree_name || 'בעל/ת השמחה',
              link,
            });
          }
        }
        // Advance the stage counter regardless of send result — this milestone
        // fires once; the next scan sends the next milestone when it comes due.
        db.markPaymentReminderSent(c.id);
        sent += 1;
      } catch (e) {
        console.warn('[payment-reminder] send failed:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[payment-reminder] scan failed:', e && e.message ? e.message : e);
  }
  return sent;
}

// An over-sized upload is rejected by body-parser with a 413 (entity.too.large)
// BEFORE the route runs, so the route's own handler never sees it. Without this
// error middleware the client only gets a bare "413" with no body; translate it
// into a clear JSON message the admin UI can show. Registered last so it catches
// errors from every route. Must keep 4 args for Express to treat it as an error
// handler; _req is unused (argsIgnorePattern '^_').
app.use((err, _req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
    return res.status(413).json({
      error: 'הקובץ גדול מדי',
      detail:
        'the upload exceeds the size limit — export the SVGs without embedded images, or raise TEMPLATE_UPLOAD_LIMIT',
    });
  }
  return next(err);
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`dugri server listening on ${PORT}`));
  // Hourly reminder scan, only when email is configured. unref() so the timer
  // never keeps the process alive on its own, and the scan is fire-and-forget.
  if (notify.isConfigured()) {
    const timer = setInterval(() => {
      runReminderScan().catch(() => {});
    }, REMINDER_SCAN_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }
  // Hourly WhatsApp nudge scan — only when the bot is armed. unref() so it never
  // keeps the process alive on its own; fire-and-forget so a failing pass can't
  // crash the process. Gated inside require.main so tests never auto-start it.
  if (whatsapp.isConfigured()) {
    const waTimer = setInterval(() => {
      runWaNudgeScan().catch(() => {});
    }, WA_NUDGE_SCAN_INTERVAL_MS);
    if (waTimer.unref) waTimer.unref();
  }
  // Hourly payment-reminder scan — runs when EITHER channel is available (email or
  // the WhatsApp bot); the payment_reminder trigger's own `enabled` gates whether
  // anything is actually sent. unref()'d + fire-and-forget like the others.
  if (notify.isConfigured() || whatsapp.isConfigured()) {
    const payTimer = setInterval(() => {
      runPaymentReminderScan().catch(() => {});
    }, REMINDER_SCAN_INTERVAL_MS);
    if (payTimer.unref) payTimer.unref();
  }
}

module.exports = app;
// Exposed for tests + the scheduler: a single WhatsApp nudge pass, and the
// paid-order group-open hook. Attached to the app export (which stays the default
// export) so a test can drive them with injected inputs, hermetically.
module.exports.runWaNudgeScan = runWaNudgeScan;
module.exports.openWhatsappGroup = openWhatsappGroup;
module.exports.onOrderPaid = onOrderPaid;
module.exports.onOrderCreated = onOrderCreated;
module.exports.runReminderScan = runReminderScan;
module.exports.runPaymentReminderScan = runPaymentReminderScan;
module.exports.webhookShape = webhookShape;
module.exports.isGroupWebhook = isGroupWebhook;
// Pure WA id/phone normalizers + the createGroup-response reader — exposed for
// unit tests (no network, no state).
module.exports.ilPhoneToWaId = ilPhoneToWaId;
module.exports.waIdDigits = waIdDigits;
module.exports.buyerLandedInGroup = buyerLandedInGroup;
