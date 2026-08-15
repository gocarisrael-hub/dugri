// Dugri server: serves the static site/ and a tiny JSON API for the
// collaborative word-collection feature.
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const express = require('express');
const db = require('./db');
const pelecard = require('./pelecard');
const notify = require('./notify');
const validate = require('./validate');
const templates = require('./templates');
const redetectJob = require('./redetect-job');
const playbook = require('./playbook');
const content = require('./content');
const contentImport = require('./content-import');
const designImages = require('./design-images');
const imageThumbs = require('./image-thumbs');
const designCatalog = require('./design-catalog');
const photoFallback = require('./photo-fallback');
const settings = require('./settings');
const whatsapp = require('./whatsapp');
const waState = require('./wa-state');
const reminders = require('./reminders');
const faq = require('./faq');
const wordlists = require('./wordlists');
const unsubscribe = require('./unsubscribe');
const sms = require('./sms');
const pdfName = require('./pdf-name');
const wordBank = require('./word-bank');
// The print-shop pass over a finished deck (generator/press_marks.py).
const pressMarks = require('./press-marks');
const messagePreview = require('./message-preview');
const storeImport = require('./store-import');
const templateImport = require('./template-import');
const { makeRateLimiter, makePreviewCache } = require('./preview-cache');
const generatorProc = require('./generator-proc');

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
// RESOLVED for the same reason server/content.js resolves DATA_DIR: the deck and
// board downloads below res.sendFile these paths, and sendFile refuses a relative
// one. Nothing sets a relative GENERATED_DIR today, so this is hardening against
// the same trap, not a live bug — the live one was DATA_DIR (see content.js).
const GENERATED_DIR = path.resolve(process.env.GENERATED_DIR || path.join(__dirname, 'generated'));
const PYTHON_BIN = process.env.PYTHON || 'python3';
// Root of the SHIPPED template config (resources/canva/templates/<slug>/ +
// generator/themes.json) — the read-only base layer. Overridable via
// TEMPLATE_ROOT so tests can point it at a throwaway scaffold and never touch the
// real repo. NOTE: the admin template routes no longer WRITE here when a
// persistent volume is configured — every upload/rename/calibration goes to the
// owner store under DATA_DIR/templates and overlays this base (see
// server/template-store.js). In production this root is the Docker image, whose
// filesystem resets on each deploy.
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
// capped at ~4MB by the store (server/content.js IMAGE_CAP), plus envelope room —
// AND each photo now travels with its background-removed cutout, a PNG of up to
// ~1024px that runs 1-3MB. Four 4MB originals with their cutouts is over 20MB, and
// the body parser rejecting the batch would lose the photos entirely, so the
// ceiling doubles. Nothing here relaxes the per-image cap, which the store still
// enforces file by file.
const PAWN_UPLOAD_LIMIT = process.env.PAWN_UPLOAD_LIMIT || '40mb';
// Hard cap on a single generation run (Chrome renders one page at a time, so a
// large deck is slow); the child's whole process group is SIGKILLed past this
// and the request 504s.
const GENERATE_TIMEOUT_MS = Number(process.env.GENERATE_TIMEOUT_MS || 120000);

// EVERY generator spawn goes through this, never through `spawn` directly: the
// child is started as its own process-GROUP leader so killGenerator can take
// Chrome and its helpers down with it. See server/generator-proc.js for the
// outage this exists to prevent.
const spawnGenerator = (args, opts) =>
  generatorProc.spawnGenerator(PYTHON_BIN, args, { cwd: REPO_ROOT, ...opts });
const killGenerator = generatorProc.killGenerator;

// --- The board artifact ---------------------------------------------------
// One order now produces TWO deliverables: the card-deck PDF at <id>.pdf, and
// the game BOARD as a SEPARATE file beside it (it is no longer a page inside the
// deck). Contract with the generator (#233): order_to_pdf.py derives the board
// path from the deck path by replacing the ".pdf" suffix with ".board.pdf", i.e.
// GENERATED_DIR/<collection id>.board.pdf.
// We resolve it by probing OUR OWN GENERATED_DIR for that stem rather than by
// reading the path off the child's stdout (which the generator also prints) — a
// path handed to us by a subprocess must never decide which file a download
// route serves, and the download routes run long after that stdout is gone and
// have to hit the disk anyway. A missing board file is normal (orders generated
// before the split, or a theme whose board isn't wired yet): every board-aware
// path then degrades to the deck-only behaviour it had before, instead of
// failing the generation.
const BOARD_EXTS = ['.pdf', '.png', '.svg'];
// SVG is served as octet-stream (never image/svg+xml): an SVG can carry script,
// and this origin also serves the admin UI. With attachment + nosniff it is only
// ever downloaded, never rendered in the origin's context.
const BOARD_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png' };

// Absolute path of the board file produced for `id`, or null when there is none.
function boardFileFor(id) {
  for (const ext of BOARD_EXTS) {
    const f = path.join(GENERATED_DIR, id + '.board' + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Stream the board file for `id` as a download, or 404 when it was never
// produced. Callers must have authorized the request FIRST (admin key or the
// per-order capability token) — this helper does no access control.
function sendBoardFile(res, id) {
  const file = boardFileFor(id);
  if (!file) return res.status(404).json({ error: 'no board' });
  const ext = path.extname(file);
  res.setHeader('Content-Type', BOARD_TYPES[ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The name the CUSTOMER sees is ours to choose — it is not the generator's
  // on-disk name (<id>.board.pdf). It carries the order's TITLE (server/pdf-name.js).
  res.setHeader(
    'Content-Disposition',
    pdfName.contentDisposition(db.getCollection(id), '-board', ext)
  );
  res.sendFile(file);
}

// THE GENERATOR'S ARGV FOR ONE ORDER, BUILT IN ONE PLACE.
//
// Two files come out of this pipeline and a customer can end up holding either:
// the deck she downloads, and the press sheet the print shop actually prints. They
// are the same deck, so they have to be ASKED for the same way — and they were
// not. The press route passed the theme, the name, the words and the title, and
// nothing else, so the file that got PRINTED silently differed from the file the
// customer approved by six things at once:
//
//   * --photo   — the buyer's own pawn photos never reached the printed card, so
//                 the press sheet carried four generic pawns instead of her people;
//   * --field   — {AGE}/{YEARS} unsubstituted in the title;
//   * --gender  — {m:…|f:…} unresolved, so a girl's deck could print בן;
//   * --chasers — the drinking-game board she paid for, missing;
//   * --wordlist— a different seed pool, so DIFFERENT FILLER WORDS on the cards;
//   * --word-font — the face she picked, ignored.
//
// Adding six pushes to the press route would fix today and guarantee the next
// divergence, because nothing would stop the two lists drifting again. So the
// argv is built here, once, and each caller appends only what is genuinely its
// own — the output path it writes to, and (for the press run) the press flags.
function orderArgs({
  theme,
  name,
  wordsFile,
  outPath,
  wordFont,
  extraFields,
  chasers,
  customTitle,
  wordlist,
  cardOrder,
  personalCount,
  gender,
  photos,
}) {
  const args = [
    path.join(REPO_ROOT, 'generator', 'order_to_pdf.py'),
    theme,
    name || '',
    wordsFile,
    outPath,
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
  // Seed-pool override for THIS order: which pool tops the deck up, replacing the
  // theme's own. `=`-joined for the same reason as --title. The name is validated
  // against the real pools before it is stored, and the generator's own path
  // guard bounds it to the two wordlist directories.
  if (wordlist) args.push('--wordlist=' + wordlist);
  // How the words are laid onto cards for THIS order (pack.py ORDERS): her own
  // words first, Hebrew and Latin cards kept apart, or the default blend. Only
  // ever one of the validated values, and omitted for the default so an old
  // order's argv is byte-for-byte what it always was.
  if (db.CARD_ORDERS.includes(cardOrder)) args.push('--order=' + cardOrder);
  // Where her own words end in the list being printed. Only meaningful with the
  // 'personal-first' order, and only knowable HERE: a frozen bank reaches the
  // generator as one flat list of 412, so the generator's own measurement of the
  // boundary would be "all of it" and the deck would print blended.
  if (Number.isInteger(personalCount) && personalCount > 0) {
    args.push('--personal-count=' + personalCount);
  }
  // Honoree gender: resolves the title's {feminine|masculine} markers, so a
  // Hebrew birthday title prints בת for a girl and בן for a boy from one
  // template. Only ever the two validated values.
  if (gender === 'male' || gender === 'female') args.push('--gender', gender);
  // The customer's pawn photos for the deck's photo card (v2 templates). A v1
  // theme ignores them, so passing them is always safe.
  for (const photo of photos || []) args.push('--photo', photo);
  return args;
}

// Spawn the Python generator for one order and resolve { pages } on success.
// Writes the words to a temp file (cleaned up after), streams the theme +
// honoree + optional word-font/extra-fields as CLI args, captures stderr for a
// useful error, and enforces a timeout. Never leaks the child process.
// Map a collection's stored pawn-image paths ("/content-uploads/<hash>.<ext>",
// written by the pawn-photos wizard step) onto the files on disk, so the
// generator can draw them into the deck's photo card. Anything that isn't one of
// our own upload paths — or whose file is gone — is dropped rather than passed
// through: the generator tops the card up from the theme's fallback set, which
// is a better outcome than failing a paid order over a missing photo.
const PAWN_UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

// Absolute path on disk for one of our own /content-uploads paths, or null when
// the shape is wrong or the file is gone.
function uploadFileFor(p) {
  if (typeof p !== 'string' || !PAWN_UPLOAD_PATH_RE.test(p)) return null;
  const file = path.join(content._uploadDir, path.basename(p));
  return fs.existsSync(file) ? file : null;
}

// Which photo actually goes on the card: the background-removed CUTOUT when we
// have one, else the original. The photo card's white sticker outline is traced
// from the image's own alpha (docs/photo-card.md), so an original prints as a
// white-bordered rectangle — but printing that is still better than failing a
// paid order, and the miss is recorded so the owner can cut it by hand.
function pawnPhotoFiles(collection) {
  const paths = Array.isArray(collection && collection.pawn_images) ? collection.pawn_images : [];
  const cuts =
    collection && collection.pawn_cutouts && typeof collection.pawn_cutouts === 'object'
      ? collection.pawn_cutouts
      : {};
  const out = [];
  for (const p of paths) {
    const original = uploadFileFor(p);
    if (!original) continue;
    const cutPath = Object.prototype.hasOwnProperty.call(cuts, p) ? cuts[p] : null;
    out.push(uploadFileFor(cutPath) || original);
  }
  return out.slice(0, 4);
}

function runGenerator({
  theme,
  name,
  words,
  outPdf,
  wordFont,
  extraFields,
  chasers,
  customTitle,
  photos,
  gender,
  wordlist,
  cardOrder,
  personalCount,
}) {
  return new Promise((resolve, reject) => {
    let wordsFile;
    try {
      fs.mkdirSync(GENERATED_DIR, { recursive: true });
      wordsFile = path.join(os.tmpdir(), 'dugri-words-' + crypto.randomUUID() + '.txt');
      fs.writeFileSync(wordsFile, words.join('\n') + '\n', 'utf8');
    } catch (e) {
      return reject(e);
    }
    const args = orderArgs({
      theme,
      name,
      wordsFile,
      outPath: outPdf,
      wordFont,
      extraFields,
      chasers,
      customTitle,
      wordlist,
      cardOrder,
      personalCount,
      gender,
      photos,
    });
    const child = spawnGenerator(args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGenerator(child);
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
      if (timedOut) {
        // A bare "generation timed out" reads exactly like a crash in the admin
        // UI, which sends whoever is on call looking for a broken template when
        // the real answer is usually "it was still working". Say how long we
        // waited, what the normal cost is, and carry whatever the generator had
        // already reported — a timeout is the one failure whose stderr we used
        // to throw away entirely.
        const secs = Math.round(GENERATE_TIMEOUT_MS / 1000);
        const tail = (stderr || stdout || '').trim().slice(-400);
        return reject(
          new Error(
            `generation timed out after ${secs}s and was killed. A full deck is ` +
              'one Chrome pass and normally takes seconds, so this usually means ' +
              'the template has an asset that never finishes loading — or that ' +
              'GENERATE_TIMEOUT_MS is set too low for this machine.' +
              (tail ? ` Last output: ${tail}` : ' The generator printed nothing.')
          )
        );
      }
      if (code !== 0) {
        return reject(new Error((stderr || stdout || 'exit ' + code).trim().slice(0, 800)));
      }
      const m = /\((\d+) pages?\)/.exec(stdout);
      // A v2 (single-card) order also produces the game board as a SEPARATE
      // file and prints its path on its own line; v1 keeps the board inside the
      // deck and prints nothing, so board stays null there.
      const b = /^board (.+)$/m.exec(stdout);
      // The cards that will print noticeably smaller than the rest of this deck,
      // each with the entry that decided it (generator/word_demand.py). A deck
      // with nothing to report prints nothing, so absent means "even deck", not
      // "not checked" — an older generator would also print nothing, and reading
      // that as "no problems" is the same answer it always gave.
      const sc = /^smallcards (.+)$/m.exec(stdout);
      let smallCards = [];
      if (sc) {
        try {
          const parsed = JSON.parse(sc[1]);
          if (Array.isArray(parsed)) smallCards = parsed.slice(0, 12);
        } catch {
          /* a report we cannot read is not a reason to fail a produced deck */
        }
      }
      resolve({
        pages: m ? Number(m[1]) : null,
        board: b ? b[1].trim() : null,
        smallCards,
      });
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
function runPreview({
  theme,
  name,
  wordFont,
  extraFields,
  chasers,
  customTitle,
  calibration,
  withBoard = true,
  gender,
}) {
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
    // Owner calibration preview: render an UNCALIBRATED template from unsaved
    // knobs. The blob is written to a temp file inside outDir and passed as
    // --calibration; preview.py merges it into the theme cfg in-memory (no
    // themes.json write) and skips its calibrated:false guard.
    if (calibration && typeof calibration === 'object') {
      try {
        const calFile = path.join(outDir, 'calibration.json');
        fs.writeFileSync(calFile, JSON.stringify(calibration), 'utf8');
        args.push('--calibration', calFile);
      } catch (e) {
        cleanup();
        return reject(e);
      }
    }
    if (wordFont) args.push('--word-font', wordFont);
    for (const [k, v] of Object.entries(extraFields || {})) {
      args.push('--field', `${k}=${v}`);
    }
    // Chasers add-on: preview the theme's chasers board variant when it ships one
    // (else the normal board — additive), matching what production will generate.
    if (chasers) args.push('--chasers');
    // Skip the board RENDER (not just its delivery) when the caller will not
    // show it — see the withBoard note on the /api/preview route.
    if (!withBoard) args.push('--no-board');
    // Custom title (F7): preview the EXACT overriding title (WYSIWYG), matching
    // what production will render.
    // --title=<value> (single token) so a title that starts with '-' (e.g. "-40",
    // "-רווקות") is never parsed by argparse as an option and crash the generator.
    if (customTitle) args.push('--title=' + customTitle);
    // Honoree gender: resolves the title's {feminine|masculine} markers. Passed
    // for the SAME reason the custom title is — the preview is the buyer's (and
    // the owner's) look at what will be printed, so it has to resolve the title
    // exactly the way production will, or a girl approves a card that prints בן.
    if (gender === 'male' || gender === 'female') args.push('--gender', gender);
    const child = spawnGenerator(args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGenerator(child);
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
        // Anything the render had to say about itself — a surface that came back
        // with no personalized name on it, or a back that could not be rendered.
        // Carried through with the images (and INTO the preview cache, so a
        // cache hit says the same thing a fresh render did): the preview is the
        // approval step before a deck is printed, so what it leaves out is
        // exactly what the owner would otherwise discover on the printed cards.
        if (Array.isArray(produced.notes) && produced.notes.length) {
          out.notes = produced.notes;
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
          // Copies + the arithmetic behind the total. Orders placed before copies
          // existed carry no `quantity`; they are all single-copy, so default to 1
          // rather than handing the checkout an undefined to render.
          quantity: order.quantity || 1,
          unit_price: Number.isInteger(order.unit_price) ? order.unit_price : order.total,
          delivery_fee: order.delivery_fee || 0,
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
    // Free word quota. The buyer is meant to discover the cap by REACHING it, so
    // while the collection is still open the limit is withheld — shipping it here
    // would put it in devtools' Network tab (and in any scraper) long before the
    // lock lands, and the page has no use for it before then.
    //
    // Once LOCKED it is sent. Not a leak worth guarding: at the lock `count` IS
    // the limit, so anyone reading the payload already has the number. Omitting it
    // there buys nothing and costs something real — a tab opened before this
    // shipped runs the old renderer, which prints `Math.min(count, null)` and
    // draws the lock as "0/null". The page still never DISPLAYS the number.
    ...(() => {
      const fl = db.freeLimitState(c, words.length);
      return fl.locked
        ? { free_limit_locked: true, free_word_limit: fl.limit }
        : { free_limit_locked: false };
    })(),
    // The buyer's WhatsApp group join link, when a group has been opened for this
    // collection. OWNER-ONLY: anyone holding the public collect link could
    // otherwise walk into the buyer's private group. In the default invite_link
    // mode the bot never adds or DMs anyone, so this (plus the invite email) is
    // how the buyer gets in. null when no group / no link yet.
    ...(owner ? { wa_invite_link: waState.inviteLinkForCollection(c.id) } : {}),
    count: words.length,
    words: words.map((w) => ({
      id: w.id,
      text: w.text,
      added_by: w.added_by,
      created_at: w.created_at,
    })),
  };
}

// The emoji refusal for the two free-text fields that become the PRINTED title:
// the buyer's optional custom title, and the honoree name the default title is
// built from. The wizard checks both in the field (site/js/emoji.js) — this is
// the authority behind it, because a client-side check is only a courtesy and a
// re-post would otherwise put a blank box on 104 paid cards. Returns true when
// it has already sent the 400, so callers read `if (refuseEmojiTitle(…)) return;`.
//
// It is NOT a font-coverage check — that is render_page.assert_title_drawable's
// job and it asks a different question. This one only ever objects to emoji, so
// a name with a geresh, a niqqud mark or an en dash sails through.
function refuseEmojiTitle(res, { title, name } = {}) {
  const t = title == null ? '' : String(title);
  const n = name == null ? '' : String(name);
  const problem = validate.titleEmojiMessage(t) || validate.nameEmojiMessage(n);
  if (!problem) return false;
  res.status(400).json({
    error: 'emoji',
    field: validate.hasEmoji(t) ? 'custom_title' : 'honoree_name',
    message: problem,
  });
  return true;
}

// Create a collection -> returns the secret owner_token (only time it's sent).
app.post('/api/collections', (req, res) => {
  const b = req.body || {};
  // THE TITLE is the order's only free-text input now ("no name no gender only
  // free text title"): it is what prints on the cards and the board. The name is
  // the order's LABEL — the admin table, the emails, the collection heading —
  // and when the client doesn't send one we take the title's first line, so a
  // title-only caller (and every wizard order) still has something to be called.
  const title = String(b.custom_title == null ? '' : b.custom_title).trim();
  const name = (b.honoree_name || '').trim() || title.split('\n')[0].trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'honoree_name required' });
  // Refuse an emoji BEFORE the collection exists. Once it is stored the buyer has
  // moved on to paying, and the next person to look at the title is the printer.
  if (refuseEmojiTitle(res, { title: b.custom_title, name })) return;
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
    // Who is ORDERING (not the honoree above — she is buying this for somebody
    // else) and what the event actually is, both in her own words. Optional short
    // free text; db.createCollection flattens each to one line, caps and treats
    // empty/whitespace as absent.
    buyer_name: b.buyer_name,
    event_type: b.event_type,
    // Anything she wants to tell us about this order — a date, a surprise to keep,
    // a delivery note. Stored as typed (sanitized) and shown in admin; never
    // printed on the cards.
    comment: b.comment,
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
  // `unsubscribed` rides along per row: a buyer who has stopped her mail gets no
  // receipt, no "ready" and no reminder, and the owner needs to see WHY rather
  // than discover that email is "broken" for one customer.
  res.json({
    collections: db
      .listAllCollections()
      .map((c) => ({ ...c, unsubscribed: unsubscribe.isUnsubscribed(c.owner_email) })),
  });
});

// NOTE: there is deliberately NO admin "mark this order paid" route. An order
// becomes paid only through a real money event — a verified PeleCard callback or
// a 100%-coupon order — so `paid` always means the customer actually paid, and a
// payment receipt can never be sent for a payment that did not happen.

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

// Admin: EDIT an order's stored choices after the fact. The customer settles the
// details with the owner on WhatsApp AFTER checking out ("make it their 40th",
// "switch me to pickup", "here's my address"), and the owner corrects the order
// here rather than asking the customer to re-run the wizard.
//
// Body: any subset of the collection fields (honoree_name, email, phone, design,
// color, theme, extra_fields, word_font, gender, chasers, custom_title,
// buyer_name, event_type, comment, owner_note) plus an
// optional `order: { version, address }` for the fulfilment choice. Absent keys
// are left untouched.
//
// `owner_note` is the OWNER's own note, and the orders table PATCHes it on its
// own from an inline box on the row. That works because absent keys really are
// untouched: a body of {owner_note} edits the note and nothing else, so jotting
// a line mid-phone-call can never disturb a field the owner did not open.
//
// The ORDER edit is applied FIRST and its failure aborts the whole request, so a
// rejected fulfilment change (bad version / missing delivery address) can never
// leave the field edits half-applied.
app.patch('/api/admin/collections/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  if (!db.getCollection(req.params.id)) return res.status(404).json({ error: 'not found' });
  // A seed-pool override must name a pool that REALLY EXISTS. Rejected here
  // rather than at generate time: a typo that only surfaces when the owner
  // presses "produce" — silently falling back to generic filler — is a deck of
  // the wrong words she has no reason to look for. '' clears the override.
  if (Object.prototype.hasOwnProperty.call(b, 'wordlist')) {
    const wanted = String(b.wordlist == null ? '' : b.wordlist).trim();
    if (wanted && !wordlists.list().some((w) => w.name === wanted)) {
      return res.status(400).json({ error: 'unknown wordlist' });
    }
  }
  // Same door, same reason: a card order the generator does not know would be
  // dropped to the default blend, and a deck that quietly ignores the option the
  // owner picked is one she has no reason to look at twice. '' / null is the
  // default and always allowed.
  if (Object.prototype.hasOwnProperty.call(b, 'card_order')) {
    const wanted = String(b.card_order == null ? '' : b.card_order).trim();
    if (wanted && !db.CARD_ORDERS.includes(wanted)) {
      return res.status(400).json({ error: 'unknown card order' });
    }
  }
  // Same emoji rule as the public create route. The admin edit screen is a
  // second door onto the same printed title, and a rule enforced on one door and
  // not the other is not a rule. PATCH semantics: only the keys actually PRESENT
  // are checked, so an edit that never mentions the title can't be refused for it.
  if (
    refuseEmojiTitle(res, {
      title: Object.prototype.hasOwnProperty.call(b, 'custom_title') ? b.custom_title : '',
      name: Object.prototype.hasOwnProperty.call(b, 'honoree_name') ? b.honoree_name : '',
    })
  ) {
    return;
  }
  if (b.order && typeof b.order === 'object') {
    const r = db.adminUpdateOrder(req.params.id, b.order);
    if (r && r.error) {
      return res.status(r.error === 'not found' ? 404 : 400).json({ error: r.error });
    }
  }
  const c = db.adminUpdateCollection(req.params.id, b);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, collection: { ...c, status: db.effectiveStatus(c) } });
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

// Admin: the MERGED design catalog + per-design asset inventory. ONE list, no
// built-in/owner-template distinction — an uploaded template is a design like any
// other, so it appears wherever a built-in design does. BOTH admin design screens
// read this endpoint: "עיצובים" (admin-designs.html) for the inventory, and
// "גלריית מוצר" (admin-images.html) for the design list + each slot's shipped
// render. One server-side merge, so the two screens can never drift apart again —
// they did, and that is how an in-store template ended up sellable but invisible
// in both of them. The merge itself lives in server/design-catalog.js (which also
// documents the two art layouts and the per-kind asset checklist).
app.get('/api/admin/designs', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let designs;
  try {
    designs = await designCatalog.mergedDesigns({
      siteDir: path.join(__dirname, '..', 'site'),
      templateRoot: TEMPLATE_ROOT,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  // `expected` stays the BUILT-IN file list it always was (the shape a built-in
  // design is measured against). Per-design expectations now travel on each
  // design's own `assets` / `source`, which is what a mixed list needs.
  res.json({ designs, expected: designCatalog.EXPECTED_DESIGN_ASSETS });
});

// Admin: generate the full print-ready PDF for a collection. The theme (a
// generator/themes.json key) defaults to the one the collection already resolved
// to when the buyer picked their design, so the admin's one-click "produce"
// button needn't ask for it; an explicit body theme still overrides.
// Body: { theme?, word_font?, extra_fields? } — EVERY field is an optional
// override of what the order already stores. The empty body the admin button
// posts must produce exactly what the buyer bought, so nothing here is read from
// the body alone.
// Gathers the collection's words + honoree name, spawns the Python generator,
// stores the PDF
// under GENERATED_DIR/<id>.pdf, records order.production, and (when email is
// configured) mails a download link to the client + Dugri.
// Map a generator failure to an HTTP status. Two cases are NOT server faults and
// must not read as 500s:
//   * a mis-set-up order/theme — the caller has to fix something (400);
//   * the render-slot cap in generator/chrome.py — Chrome costs ~120 processes
//     against a 1000-process ceiling, so runs are capped and a run that could
//     not get a slot never started. Nothing is broken and a retry will work, so
//     it is a 503 with Retry-After, not a 500. Reporting it as a 500 would send
//     the next person hunting a crash that did not happen.
function generatorStatus(detail) {
  if (/render slots were busy/i.test(detail)) return 503;
  if (/not calibrated|unknown theme/i.test(detail)) return 400;
  return 500;
}

app.post('/api/admin/collections/:id/generate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  // One-click production: fall back to the collection's STORED resolved theme
  // (db sets `theme` from the design the buyer chose) so the admin button can
  // post an empty body. An explicit body theme still wins, so re-generating onto
  // a different template stays possible. Neither present is still a 400 — every
  // downstream check (unknown theme, then the validate.js pre-production checks)
  // runs on the resolved key exactly as before.
  const theme = String(b.theme || c.theme || '').trim();
  if (!theme) return res.status(400).json({ error: 'theme required' });
  // The APPROVED BANK when this order has one, the buyer's own words otherwise.
  // A frozen bank is already a full deck, and topup keeps every word it is given
  // and only fills a shortfall — so handing it over prints the approved list
  // exactly, with no change to the generator at all. (server/word-bank.js)
  const words = wordBank.wordsForProduction(
    c,
    db.listWords(c.id).map((w) => w.text)
  );
  if (!words.length) return res.status(400).json({ error: 'no words to generate' });

  // Reject an unknown theme up front. An unknown key makes getTheme() null, which
  // makes validateOrderForProduction skip every theme-specific check (name
  // language, required extra fields) and still spawn the generator — so a bad
  // theme must fail fast here, before any validation is trusted or Chrome runs.
  const themeConfig = validate.getTheme(theme);
  if (!themeConfig) return res.status(400).json({ error: 'unknown theme' });

  // The render inputs the BUYER chose. Both live on the stored order; the body
  // may only OVERRIDE them, never erase them (validate.effectiveExtraFields
  // documents the precedence). Reading them from the body alone — which is what
  // this route used to do, defaulting to {} / null — silently dropped them from
  // every production run, because the admin "produce" button posts nothing but
  // `{theme}`: טוקיו printed "HADAR'S" over a bare "S" with the age gone, and
  // every deck rendered in its theme's default word font rather than the one the
  // buyer picked in the preview.
  const extraFields = validate.effectiveExtraFields(c, b.extra_fields);
  const wordFont = String(b.word_font || c.word_font || '').trim() || null;

  // Validate the order BEFORE spending time/money on generation. On any problem
  // we do NOT run the generator: we record an 'error' production status (shown in
  // admin), email the client + Dugri what to fix, and 400 with the problem list.
  //
  // Validated against the EXACT dict the generator is about to be handed — not
  // the stored order it is derived from — so "validated" and "rendered" cannot
  // drift apart again. That is what makes a genuinely missing required field a
  // refusal (production.state='error' + a fix-it email) instead of a card that
  // quietly prints without it.
  const problems = validate.validateOrderForProduction(
    { ...c, extra_fields: extraFields },
    themeConfig,
    words
  );
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

  // Use the stored (validated) id — never the raw param — for the output path.
  const outPdf = path.join(GENERATED_DIR, c.id + '.pdf');

  try {
    const { pages, smallCards } = await runGenerator({
      theme,
      name: c.honoree_name || '',
      words,
      outPdf,
      wordFont,
      extraFields,
      chasers: !!c.chasers,
      customTitle: c.custom_title || null,
      photos: pawnPhotoFiles(c),
      // From the STORED collection, never the request body. The wizard asks the
      // buyer for the honoree's gender once and it is validated to
      // 'male'/'female'/null at the door (db.createCollection), so the order
      // itself is the only place that knows it — an admin clicking "produce"
      // posts an empty body and must still get בת on a girl's cards.
      gender: c.gender || null,
      // The owner's per-order seed pool, chosen in the order edit dialog. Null
      // means "use the theme's own", which is what every order did before this
      // existed. Read from the STORED collection, like everything else here.
      wordlist: c.wordlist || null,
      cardOrder: c.card_order || null,
      // Where HER words end in the list above — see personalCountForProduction.
      personalCount: wordBank.personalCountForProduction(c),
    });
    // The board is a second, separate artifact — recorded on production so the
    // admin UI knows whether to offer it, and left null for a generator run that
    // produced none (a v1 theme, whose board is still the deck's last page).
    // ONE source of truth: what the generator actually left on disk. The child
    // also prints the board path on stdout (#233), but the download routes have
    // to probe the disk anyway — they run in a later request — and two sources
    // can disagree, so the record is derived the same way the routes resolve it.
    const boardFile = boardFileFor(c.id);
    // THE PRINT SHOP'S COPY, built from the deck that was just produced —
    // "1 button called create pdf and what it does is creating the pdf (as now
    // this button do) and then run this script". One button, and nothing to wait
    // for: the marks pass is 0.44s on a real 208-page order, so the shop's file
    // is on disk before this request answers.
    //
    // NO COLOUR CONVERSION — "remove the cymk entirely". It was minutes of
    // Ghostscript for a decision the shop makes better than we can, and it is the
    // reason the old press build needed a button, a progress poll and a way to
    // say "still building".
    //
    // The press file is an EXTRA, deliberately: a failure here leaves the order
    // produced and the customer's deck correct, and is recorded rather than
    // thrown. The one thing it must not do is leave a STALE press file from an
    // earlier run beside a freshly produced deck — that is a file the shop would
    // print without anyone noticing it belongs to an older version — so the old
    // one goes before the new one is built.
    const pressFiles = pressPaths(c.id);
    pressUnlink(pressFiles.err, pressFiles.pdf, pressFiles.partial);
    const marks = await pressMarks.addMarks(outPdf, pressFiles.pdf);
    if (!marks.ok) {
      try {
        fs.writeFileSync(pressFiles.err, String(marks.detail || 'press_marks failed'), 'utf8');
      } catch {
        /* the produce itself still succeeded */
      }
    }
    const production = db.setProduction(c.id, {
      state: 'generated',
      pdf_file: path.basename(outPdf),
      board_file: boardFile ? path.basename(boardFile) : null,
      generated_at: new Date().toISOString(),
      theme,
      pages,
      // Whether the shop's copy is on disk. There is only ONE kind of press file
      // now, so this is a fact rather than a mode: 'ready' or 'failed'.
      press: marks.ok ? 'ready' : 'failed',
      // Cards that will print noticeably smaller than the rest, and the entry
      // responsible for each. The owner asked for this after finding decks with
      // "1 card that the font size of the words is super tiny because of 1
      // fucked up word": the packer already puts such entries together so they
      // cost one card instead of four, and what is left is a word only she can
      // shorten. A NOTE, never a block — the deck is correct, it is one card she
      // may want to rewrite.
      small_cards: smallCards && smallCards.length ? smallCards : null,
    });
    const base = paymentBaseUrl();
    // Two links, and they are NOT interchangeable:
    //  - adminLink carries the master ADMIN_KEY and is for Dugri's own use only.
    //  - customerLink carries this collection's per-order pdf_token capability
    //    (set by db.setProduction) so the CUSTOMER can download WITHOUT ever
    //    seeing the admin secret. Anything handed to a customer must be this one.
    // Each has a board twin on the same footing — the SAME capability token
    // covers both artifacts of one order, so no second secret is minted.
    const adminLink = base
      ? base + '/api/admin/collections/' + c.id + '/pdf?key=' + encodeURIComponent(ADMIN_KEY)
      : null;
    const customerLink =
      base && production && production.pdf_token
        ? base + '/api/collections/' + c.id + '/pdf?t=' + encodeURIComponent(production.pdf_token)
        : null;
    const adminBoardLink =
      base && boardFile
        ? base + '/api/admin/collections/' + c.id + '/board?key=' + encodeURIComponent(ADMIN_KEY)
        : null;
    const customerBoardLink =
      base && boardFile && production && production.pdf_token
        ? base + '/api/collections/' + c.id + '/board?t=' + encodeURIComponent(production.pdf_token)
        : null;
    // NO email fires here any more. The old "your file is ready — download it"
    // mail (pdf_ready) was written for the digital-only phase; the product now
    // ships as a printed game, so there is nothing for the customer to download,
    // and the customer-facing mail moved to the moment they CLOSE the word list
    // (notify.sendProductionStarted, from the two close paths).
    //
    // Both link PAIRS still come back here, to an already-authenticated admin UI:
    // the admin pair for Dugri's own download, and the CUSTOMER (capability) pair
    // so the owner can hand a customer their file by hand when one does need it —
    // over WhatsApp, say. Dropping the customer pair would have stranded the
    // capability route with no way to reach it.
    res.json({
      ok: true,
      production,
      link: adminLink,
      boardLink: adminBoardLink,
      customerLink,
      customerBoardLink,
    });
  } catch (e) {
    const detail = String((e && e.message) || e);
    // A clear, actionable status for the common "theme not calibrated" case,
    // and a retryable 503 when the box was simply at its render cap.
    const status = generatorStatus(detail);
    if (status === 503) res.setHeader('Retry-After', '30');
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
  res.setHeader('Content-Disposition', pdfName.contentDisposition(c));
  res.sendFile(file);
});

// Admin: download the order's BOARD file — the second artifact, produced beside
// the deck. Same gate and same id-handling as the PDF route above; 404 when the
// collection or the board file is absent.
app.get('/api/admin/collections/:id/board', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  sendBoardFile(res, c.id);
});

// --- The PRESS copy -------------------------------------------------------
// The deck is what the customer's game is printed from; a commercial printer
// needs the same artwork on a bigger sheet, carrying bleed, crop marks and a
// TrimBox that states where to cut.
//
// It is not a build any more, and there is no button for it. Producing an order
// runs generator/press_marks.py over the deck it just made (server/press-marks
// .js) and writes <id>.press.pdf beside it, in 0.44s on a real 208-page order.
// This route only hands that file over.
//
// WHAT WAS HERE BEFORE, and why it is gone: a second full render onto a press
// sheet, then Ghostscript for CMYK — minutes of work, so it needed a POST, a
// progress poll, a "still building" state, partial paths, a verifier for the
// half-written files a killed run leaves behind, and a switch for the colour
// pass. The owner replaced the artwork half with her own post-pass over the
// finished PDF ("the create pdf for printing shop is not so good… i want when i
// press the create pdf button this is what will be created") and removed the
// colour half outright ("remove the cymk entirely") — a separation the shop
// makes better than we can. All of that machinery went with them.
//
// The generator still HAS a press mode (order_to_pdf --press, generator/press.py
// and the geometry in deck_html.py). Nothing reaches it now; deleting it touches
// the render path itself, so it is its own change rather than a passenger on
// this one.
function pressPaths(id) {
  const base = path.join(GENERATED_DIR, id + '.press');
  return {
    pdf: base + '.pdf',
    // The marks pass writes here and the file is moved into place, so a download
    // arriving mid-write gets the previous file or none — never a torn one.
    partial: base + '.partial.pdf',
    // Why the last attempt produced nothing, for the admin to show. The order
    // itself is produced and the customer's deck is correct either way.
    err: base + '.err',
  };
}

// Remove press files, ignoring what was not there. Used before a rebuild: a
// stale press copy beside a freshly produced deck is a file the shop would print
// without anyone noticing it belongs to an older version.
function pressUnlink(...files) {
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* absent is the state we wanted */
    }
  }
}

// Hand over the print shop's copy. It is written when the order is PRODUCED, so
// there is no build to poll and no state to report: the file is there, or the
// last produce could not make it, or this order was never produced.
app.get('/api/admin/collections/:id/press', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const paths = pressPaths(c.id);
  if (fs.existsSync(paths.pdf)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Named apart from the customer's deck, because both land in the same orders
    // folder and are indistinguishable on screen.
    res.setHeader('Content-Disposition', pdfName.contentDisposition(c, '-press.pdf', ''));
    return res.sendFile(paths.pdf);
  }
  if (fs.existsSync(paths.err)) {
    let detail = '';
    try {
      detail = fs.readFileSync(paths.err, 'utf8');
    } catch {
      /* unreadable is still a failure */
    }
    // The TAIL, not the head. A Python traceback puts the actual error on its
    // LAST line, and the head is 800 characters of frames that say nothing.
    return res.status(409).json({ status: 'failed', detail: detail.slice(-800) });
  }
  res.status(404).json({ error: 'no press pdf' });
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
  res.setHeader('Content-Disposition', pdfName.contentDisposition(c));
  res.sendFile(file);
});

// PUBLIC: download the order's BOARD file via the SAME per-collection capability
// token as the deck (one order, one secret, two artifacts) — this is the second
// link in the customer's "file ready" email. 403 on a missing/wrong token, 404
// when the collection or the board file is absent.
app.get('/api/collections/:id/board', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const production = (c.order && c.order.production) || c.production || null;
  const token = production && production.pdf_token;
  if (!pdfTokenOk(req.query.t, token)) return res.status(403).json({ error: 'forbidden' });
  sendBoardFile(res, c.id);
});

// Admin: mark an order SENT TO THE PRINT SHOP. A toggle: body {undo:true} takes
// it back. The first of the two hand-pressed production steps, and the gate the
// second one sits behind.
//
// It notifies NOBODY — not the print shop, not the customer. The owner mails
// Galor the file the way she always has; this records that she did, so the list
// can show what is out at the printer and so /ready has something to check.
//
// Un-sending is refused while the order is marked ready for the customer (409):
// "ready" means "back from print", so pulling the print stamp out from under it
// would leave a state the pipeline cannot reach. Un-mark ready first.
app.post('/api/admin/collections/:id/to-print', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sent = !(req.body && req.body.undo);
  const r = db.setOrderSentToPrint(req.params.id, sent);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.error === 'ready') {
    return res.status(409).json({
      error: 'ready',
      message: 'ההזמנה כבר סומנה כמוכנה ללקוח/ה — יש לבטל את הסימון "מוכן" קודם.',
    });
  }
  res.json({
    ok: true,
    sent_to_print: !!r.order.sent_to_print_at,
    sent_to_print_at: r.order.sent_to_print_at || null,
    // Both tallies, recomputed from the orders: marking one order sent moves it
    // out of "waiting" and into "at Galor", so the dashboard has to repaint both
    // numbers off the same read or they can disagree for a beat.
    sent_to_print_count: db.countSentToPrintOrders(),
    ready_count: db.countReadyOrders(),
  });
});

// Admin: mark an order READY — printed, and either waiting to be collected or
// about to go out. A toggle: body {ready:false} takes it back.
//
// GATED ON /to-print above: an order can only be ready once it has been sent to
// the print shop, because "ready" means "back from Galor". Refused with 409
// otherwise. The store enforces it (db.setOrderReady) rather than the admin page
// alone, so a stale tab cannot email a customer about a game that never went to
// print.
//
// Flipping INTO ready emails the customer. The owner asked for that mail to be
// re-sent if she undoes and presses again (she would only do that after fixing
// something, and the customer should hear the corrected version), so there is
// deliberately NO once-only guard here — `changed` only suppresses a double-tap
// that didn't actually change anything.
//
// The email itself is a separate concern (notify.sendOrderReady + its
// owner-editable template). It is called defensively so this route works, and the
// tally stays correct, whether or not that template has shipped yet — a missing
// mail must never cost the owner the ability to mark an order done.
// Queue the "your game is ready" SMS for the owner's phone to send. Silent no-op
// when the feature is off, the buyer left no mobile, or the text is empty — an
// SMS is optional in a way the email is not, so nothing here is ever an error the
// owner has to clear.
function queueReadySms(collection) {
  try {
    if (!settings.get('sms', 'enabled')) return null;
    const tpl = String(settings.get('sms', 'order_ready') || '');
    if (!tpl.trim()) return null;
    const base = paymentBaseUrl();
    const link =
      base && collection && collection.id && collection.owner_token
        ? base + '/collect.html?c=' + collection.id + '&k=' + collection.owner_token
        : '';
    const text = settings.interpolate(tpl, {
      honoree: (collection && collection.honoree_name) || 'בעל/ת השמחה',
      link,
    });
    return sms.enqueue({
      to: collection && collection.owner_phone,
      text,
      event: 'order_ready',
      collection_id: collection && collection.id,
    });
  } catch (e) {
    console.warn('[sms] queue failed:', e && e.message ? e.message : e);
    return null;
  }
}

app.post('/api/admin/collections/:id/ready', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ready = !(req.body && req.body.undo);
  const r = db.setOrderReady(req.params.id, ready);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.error === 'not_sent_to_print') {
    return res.status(409).json({
      error: 'not_sent_to_print',
      message: 'צריך קודם לסמן שההזמנה נשלחה לדפוס.',
    });
  }
  if (ready && r.changed) {
    const fresh = db.getCollection(req.params.id);
    if (typeof notify.sendOrderReady === 'function') {
      notify.sendOrderReady(fresh, paymentBaseUrl()).catch(() => {});
    }
    // …and the SMS, queued for the phone to collect. Same moment, same order,
    // different medium — and enqueue is a local write, so a gateway that is
    // asleep cannot slow this response down or fail the press.
    queueReadySms(fresh);
  }
  res.json({
    ok: true,
    ready: !!r.order.ready_at,
    ready_at: r.order.ready_at || null,
    // Both tallies, recomputed from the orders so the buttons and the numbers
    // can never drift apart — this flip moves the order out of "at Galor" as
    // well as into "printed".
    sent_to_print_count: db.countSentToPrintOrders(),
    ready_count: db.countReadyOrders(),
  });
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
  // Reopening means the word list can move again, so the bank frozen at the last
  // close no longer describes this order. The owner's rule: "discarded and
  // re-frozen on the next close" — which then stores version + 1.
  db.clearWordBank(req.params.id);
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

// A design id -> its generator theme key. A CUSTOM design is its own theme (the
// themes.json key IS the design id); a BUILT-IN one is mapped by THEME_BY_DESIGN
// in site/js/designs.js. That module is ESM, so it is imported once and cached —
// a miss just means "unknown", never a thrown route.
let _themeByDesign = null;
async function loadThemeByDesign() {
  if (_themeByDesign) return _themeByDesign;
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')));
    _themeByDesign = mod.THEME_BY_DESIGN || {};
  } catch {
    _themeByDesign = {};
  }
  return _themeByDesign;
}

/**
 * Is this DESIGN offered in the shop? Unknown ids answer true: the flag exists to
 * let the owner withdraw something deliberately, so it must never be the reason a
 * design nobody registered stops working.
 *
 * Synchronous on purpose — the callers are request paths that cannot await — so
 * it uses the cached map and falls back to treating the design id as its own
 * theme key, which is exactly right for a custom design.
 */
function designIsInStore(designId) {
  const id = String(designId || '');
  if (!id) return true;
  try {
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT)) || {};
    const key = (_themeByDesign && _themeByDesign[id]) || id;
    const entry = themes[key];
    return entry ? templates.inStore(entry) : true;
  } catch {
    return true;
  }
}
// Warm the map at boot so the synchronous check above can see built-in designs.
loadThemeByDesign();

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
  // A design taken OFF the shop floor is off it for everyone. An access code
  // chooses how an on-sale private design is reached; it is not a way past
  // "this is not for sale yet", or withdrawing a design would still leave it
  // orderable by every code already handed out. Reads as an invalid code
  // rather than "valid but unavailable", so a withdrawn design leaks nothing.
  if (!designIsInStore(r.design_id)) return res.json({ valid: false });
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
  (req, res) => handlePawnUpload(req, res, req.params.id, req.query.k)
);

// A cutout part is named after the original it belongs to: "cut:pawn0" carries the
// cutout for the "pawn0" original. Pairing by NAME rather than by position keeps
// the two lists from sliding against each other when one photo is skipped.
const CUTOUT_PREFIX = 'cut:';

// The body of a pawn-images upload, shared by the OWNER route above (authenticated
// by the collection's owner token) and the ADMIN one below (authenticated by the
// admin key, then acting with the collection's own owner token). Everything after
// authentication is identical, so the cap/orphan-reclaim rules can't drift apart.
function handlePawnUpload(req, res, id, ownerToken) {
  const boundary = templates.boundaryFromContentType(req.headers['content-type']);
  if (!boundary || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: 'expected multipart/form-data upload' });
  }
  const { fields, files } = templates.parseMultipart(req.body, boundary);
  const parts = Object.entries(files).filter(
    ([name, f]) => f && Buffer.isBuffer(f.data) && !name.startsWith(CUTOUT_PREFIX)
  );
  // Reject an over-large batch UP FRONT so a single request can never write dozens
  // of files before the cap check (the buyer UI only ever sends up to 4).
  if (parts.length > 4) return res.status(400).json({ error: 'too many images (max 4)' });
  // Only persist as many images as there is room for (4 total per collection). A
  // full collection writes nothing at all — the DoS fix.
  const c = db.getCollection(id);
  const room = Math.max(0, 4 - (Array.isArray(c.pawn_images) ? c.pawn_images.length : 0));
  const written = []; // { name, path, created } for every file THIS request wrote
  for (const [name, f] of parts.slice(0, room)) {
    try {
      written.push({ name, ...content.saveImageBytes(f.data) });
    } catch {
      // Oversized/unsupported image — skip this file, keep the rest (fail-soft).
    }
  }
  const stored = db.addPawnImages(
    id,
    ownerToken,
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
  storePawnCutouts({ id, ownerToken, written, kept, files, fields });
  const fresh = db.getCollection(id);
  res.json({
    ok: true,
    pawn_images: stored,
    pawn_cutouts: (fresh && fresh.pawn_cutouts) || {},
  });
}

// --- background removal for the pawn photos ---------------------------------
// The photo card draws each pawn as a die-cut sticker whose white outline is
// generated from the image's OWN alpha (docs/photo-card.md): the halo is a <use>
// of the slot through a filter that dilates SourceAlpha. A photo straight off a
// phone is opaque, so it has no silhouette to trace and prints as a white-bordered
// RECTANGLE. Every pawn photo therefore has to become a transparent RGBA cutout.
//
// The cut itself happens in the BUYER'S BROWSER (site/js/pawn-cutout.js, MediaPipe
// + a self-hosted Apache-2.0 model), so it costs nothing per order, adds nothing to
// this container, and the buyer SEES the sticker and can retry a bad one before
// paying. The server's whole job is to keep the two files straight: pawn_images
// holds the untouched ORIGINALS, pawn_cutouts maps each original's path to its
// cutout — or to null when the browser tried and could not.
//
// Nothing here can fail an order. A missing, malformed or non-PNG cutout is simply
// a miss: the original photo is used and the owner sees the flag in the orders table.
function storePawnCutouts({ id, ownerToken, written, kept, files, fields }) {
  // Which originals the browser tried to cut and failed on, by part name. Sent as
  // a plain field because there is no file to attach for a failure.
  const failed = new Set(
    String((fields && fields.cutfail) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  for (const w of written) {
    if (!kept.has(w.path)) continue; // the original itself wasn't recorded
    const part = files[CUTOUT_PREFIX + w.name];
    if (!part || !Buffer.isBuffer(part.data)) {
      // No cutout came with this photo. Only record a MISS when the client said it
      // tried — an older client that knows nothing about cutouts must leave the map
      // untouched (key absent = never attempted), exactly as before this existed.
      if (failed.has(w.name)) db.setPawnCutout(id, ownerToken, w.path, null);
      continue;
    }
    // PNG only. A JPEG cannot carry alpha, so accepting one would record "cut ✓"
    // for an image that still prints as a white rectangle — a silent failure, which
    // is the one outcome this whole feature exists to prevent.
    let saved = null;
    try {
      if (content.extFromMagic(part.data) === '.png') saved = content.saveImageBytes(part.data);
    } catch {
      saved = null; // oversized/unreadable — record the miss
    }
    const recorded = db.setPawnCutout(id, ownerToken, w.path, saved ? saved.path : null);
    if (saved && recorded == null && saved.created && !content.isImageReferenced(saved.path)) {
      content.deleteUpload(saved.path); // couldn't record it — don't orphan the file
    }
  }
}

// Admin: ADD pawn photos to an order from the orders table — the owner receives a
// photo on WhatsApp after checkout and attaches it herself. Same multipart shape,
// 4-per-collection cap and orphan reclaim as the owner route; authenticated by the
// admin key (checked BEFORE express.raw buffers the body) and then performed with
// the collection's own owner token, which the admin is trusted to act for.
app.post(
  '/api/admin/collections/:id/pawns',
  (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!db.getCollection(req.params.id)) return res.status(404).json({ error: 'not found' });
    next();
  },
  express.raw({ type: () => true, limit: PAWN_UPLOAD_LIMIT }),
  (req, res) =>
    handlePawnUpload(req, res, req.params.id, db.getCollection(req.params.id).owner_token)
);

// Admin: REPLACE the pawn-photo list (remove / reorder). Body: { pawn_images: [] }
// of our own /content-uploads paths; the store re-validates, de-dupes and caps at 4.
app.put('/api/admin/collections/:id/pawns', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const imgs = db.adminSetPawnImages(req.params.id, (req.body || {}).pawn_images);
  if (imgs == null) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, pawn_images: imgs });
});

// The vendored background-removal runtime (site/vendor/mediapipe — MediaPipe Tasks
// Vision + the selfie_multiclass model, both Apache-2.0). Served from OUR origin,
// never a CDN, so the buyer's browser can cut a photo with the outside world
// unreachable.
//
// This route exists for ONE reason: the wasm is stored brotli-precompressed
// (2.4MB on disk against 11.8MB raw) and express.static has no idea what a .br
// sibling is. Everything else in the directory falls through to express.static
// untouched. The model is NOT precompressed — tflite float32 weights only give up
// ~9% and the second copy would cost more in the repo than it saves on the wire.
const VENDOR_DIR = path.join(SITE_DIR, 'vendor');
const VENDOR_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
};
const vendorInflated = new Map();

app.get('/vendor/:dir/:file', (req, res, next) => {
  const { dir, file } = req.params;
  // Plain names only — no traversal, no dotfiles, no nested paths.
  if (!/^[A-Za-z0-9._-]+$/.test(dir) || !/^[A-Za-z0-9._-]+$/.test(file)) return next();
  if (dir.includes('..') || file.includes('..')) return next();
  const type = VENDOR_TYPES[path.extname(file)];
  if (!type) return next(); // let express.static serve LICENSE/README as it likes
  const raw = path.join(VENDOR_DIR, dir, file);
  const br = raw + '.br';
  if (!fs.existsSync(br)) return next(); // no precompressed sibling — static's job
  // Content-addressed by hand: these files change only when we deliberately
  // re-vendor them, and a stale wasm is the difference between a cut and a miss.
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Vary', 'Accept-Encoding');
  if (/\bbr\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.setHeader('Content-Encoding', 'br');
    return res.sendFile(br);
  }
  // A client that can't take brotli (rare enough that it isn't worth a second copy
  // on disk) gets it inflated once and cached in memory.
  try {
    if (!vendorInflated.has(br)) {
      vendorInflated.set(br, require('zlib').brotliDecompressSync(fs.readFileSync(br)));
    }
    return res.send(vendorInflated.get(br));
  } catch {
    return res.status(500).end();
  }
});

// Public order PREVIEW: render a REAL sample card + board for a theme with the
// honoree name (and an optional word-font pick), so the customer sees their card
// right after entering the name. Rate-limited per client IP like the coupon
// oracle (each call spawns Chrome). Also runs the name-language check and returns
// a `warning` when the name doesn't fit the theme's script, plus the shared
// word-font options so the client can render the picker.

// A fingerprint of everything the RENDER reads for a template, so a preview
// cache entry can never outlive the artwork it was rendered from.
//
// The cache key is built from the request (name, calibration knobs, ...), which
// silently assumes the template itself is static. It isn't: the owner replaces
// fonts and card SVGs from the admin panel. Upload a new font, preview the same
// name, and the identical key returned the PNG from BEFORE the upload — the
// change appeared to do nothing until the 5-minute TTL expired.
//
// mtimes rather than hashes: a few stat() calls per request, no file reads, and
// any write to a watched path changes one of them. Both themes.json layers are
// watched (the recorded font filename lives there), plus the template dir and
// its immediate asset subdirs — writing fonts/X.ttf bumps fonts/, not the theme
// dir, so the subdirs have to be stat'd individually. Anything unreadable
// contributes a constant, so a missing dir simply doesn't participate.
// Upper bound on files stat'd per preview request. A card template is ~30
// files; the cap only guards against something pathological.
const TEMPLATE_FINGERPRINT_MAX_FILES = 400;

function templateFingerprint(theme) {
  const parts = [];
  const stamp = (p) => {
    try {
      const st = fs.statSync(p);
      parts.push(st.mtimeMs + ':' + st.size);
    } catch {
      parts.push('-');
    }
  };
  stamp(path.join(TEMPLATE_ROOT, 'generator', 'themes.json'));
  const dataDir = process.env.DATA_DIR;
  if (dataDir) stamp(path.join(dataDir, 'templates', 'themes.json'));
  let dir = null;
  try {
    dir = templates.resolveTemplateDirBySlug(TEMPLATE_ROOT, theme);
  } catch {
    /* unknown template — the render will fail on its own terms */
  }
  if (dir) {
    // FILES, recursively — not just the directories. Replacing an asset
    // OVERWRITES a file in place, and an in-place write changes no directory
    // mtime at all (a directory's mtime only moves when an entry is added,
    // removed or renamed). Stat'ing the theme dir and its immediate subdirs
    // therefore saw nothing when a font was replaced, and the cache went on
    // serving the pre-upload card — which is the exact bug this fingerprint
    // exists to prevent. Fonts also sit two levels down
    // (fonts/Cafe Regular/Cafe Regular.ttf), so even a NEW file would not have
    // bumped fonts/.
    //
    // Capped so an unusually large template can never make a preview request
    // walk an unbounded tree; the entries are sorted first so the cap is
    // deterministic rather than filesystem-order dependent.
    let entries = [];
    try {
      entries = fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath || e.path || dir, e.name))
        .sort();
    } catch {
      /* unreadable dir — the stamps below simply don't participate */
    }
    for (const f of entries.slice(0, TEMPLATE_FINGERPRINT_MAX_FILES)) stamp(f);
    parts.push('n=' + entries.length);
  }
  return parts.join(':');
}

app.post('/api/preview', async (req, res) => {
  const b = req.body || {};
  const theme = String(b.theme || '').trim();
  const name = String(b.name || '').trim();
  // Cheap, in-memory validation FIRST — reject bad requests before any work.
  const themeConfig = validate.getTheme(theme);
  if (!themeConfig) return res.status(400).json({ error: 'unknown theme' });
  if (!name) return res.status(400).json({ error: 'name required' });
  // No emoji in what we are about to draw. The preview is sold to the buyer as
  // WYSIWYG, so rendering a 🎉 as the blank box the font actually produces would
  // technically be honest and completely useless — she would see a broken card
  // and not know why. Refusing here says why, and it also saves a Chrome page
  // render on an order that could never be produced. Same rule, same words as
  // the create route, so the message never changes between the two.
  if (refuseEmojiTitle(res, { title: b.title, name })) return;

  // Cheap, in-memory parsing of the remaining render inputs (no fs, no spawn).
  const rawWordFont = b.word_font ? String(b.word_font).trim() : '';
  const extraFields =
    b.extra_fields && typeof b.extra_fields === 'object' && !Array.isArray(b.extra_fields)
      ? b.extra_fields
      : {};
  // Chasers add-on toggle from the order flow — when on, preview the theme's
  // chasers board variant (server falls back to the normal board if none).
  const chasers = !!b.chasers;
  // The buyer's name preview shows the card and its back only, so it asks for
  // the board to be SKIPPED. That is a render the server then never performs:
  // the board is a full landscape artboard and by far the heaviest thing in
  // this response (~715KB of base64 against the card's ~84KB, plus its own
  // Chrome page), so dropping it client-side would keep the whole cost and lose
  // only the benefit. Opt-OUT rather than opt-in, so every existing caller —
  // the owner's calibration screen included, where the board is still wanted —
  // keeps the board without being changed.
  const withBoard = b.board !== false;
  // Custom title (F7): the buyer's optional overriding title. Sanitized with the
  // SAME rule stored orders use, so the live preview is WYSIWYG for production.
  const customTitle = db.sanitizeCustomTitle(b.title);
  // Honoree gender, resolving the title's {feminine|masculine} markers. Unlike
  // the generate route there is no stored collection to read here — the wizard
  // previews BEFORE the order exists — so it comes from the body, narrowed to
  // the same two values db.createCollection accepts. Anything else is null,
  // which takes the feminine form rather than defaulting to the masculine one.
  const gender = b.gender === 'male' || b.gender === 'female' ? b.gender : null;

  // Owner CALIBRATION preview: when the admin form sends unsaved look-knobs
  // (`calibration`), render the theme with those overrides so the owner sees the
  // exact result BEFORE saving/flipping calibrated:true. This path is ADMIN-ONLY
  // (it can render an otherwise-unrenderable uncalibrated template with arbitrary
  // knobs) and is validated with the SAME rules the save route enforces.
  let calibration = null;
  if (b.calibration != null) {
    if (!requireAdmin(req, res)) return;
    // Validated against the THEME'S OWN front list: a deck that renders one
    // front has one title position to give, and the eight-front rule would
    // reject its calibration preview outright.
    const v = templates.validateCalibration(
      b.calibration,
      templates.entryFrontNumbers(themeConfig)
    );
    if (v.error) return res.status(400).json({ error: v.error });
    calibration = v.value;
  }
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
    // A gendered title renders DIFFERENT text per gender, so the same name must
    // not be served the other gender's cached card.
    gender,
    // Distinct knob sets must not collide, and a calibration preview must never
    // be served a plain (uncalibrated) cache entry or vice-versa.
    calibration,
    // A board-less render must never be served to a caller that asked for the
    // board (it would silently lose a panel), nor the reverse.
    withBoard,
    // ...and neither may an entry outlive the artwork it was rendered from.
    assets: templateFingerprint(theme),
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
    const imgs = await runPreview({
      theme,
      name,
      wordFont,
      extraFields,
      chasers,
      customTitle,
      calibration,
      withBoard,
      gender,
    });
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
    const status = generatorStatus(detail);
    if (status === 503) res.setHeader('Retry-After', '5');
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

// OWNER-ONLY order summary, for the payment confirmation page: "here is what you
// just bought". Everything on it is either already on the buyer's own receipt
// email or is their own input, but it includes what they were ACTUALLY charged
// (post-coupon) — which the shared collect link must never leak to the friends the
// owner invites — so it is gated on the owner token rather than on link knowledge.
app.get('/api/collections/:id/summary', async (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!req.query.k || req.query.k !== c.owner_token) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const order = c.order || null;
  const labels = settings.get('email', 'version_labels') || {};
  const descriptions = settings.get('email', 'product_info') || {};
  // Never fails the summary: a missing catalog entry just means no photo.
  let productImage = null;
  try {
    productImage = await resolveProductImagePath(c);
  } catch {
    productImage = null;
  }
  res.json({
    order_no: db.orderRef(c),
    honoree_name: c.honoree_name,
    design: c.design || null,
    color: c.color || null,
    product_image: productImage,
    order: order
      ? {
          version: order.version,
          version_label: labels[order.version] || order.version,
          description: descriptions[order.version] || null,
          // The package price, and — when the order is paid — what was actually
          // charged after any coupon. `charged` is null for an unpaid order and
          // 0 for a fully-free 100%-coupon one, so the page can tell them apart.
          total: order.total != null ? order.total : null,
          // The breakdown behind the total, so the confirmation page can show
          // "199 × 5 + 39 שילוח" rather than a bare 1034 the buyer must trust.
          quantity: order.quantity || 1,
          unit_price: Number.isInteger(order.unit_price) ? order.unit_price : order.total,
          delivery_fee: order.delivery_fee || 0,
          charged: order.paid && order.charged_total != null ? order.charged_total : null,
          coupon: order.paid ? order.coupon || null : null,
          paid: !!order.paid,
          paid_at: order.paid_at || null,
        }
      : null,
    // Everything POST /api/preview needs to re-render the buyer's own card, so
    // the confirmation page can show the real thing rather than a stock photo.
    // Mirrors the fields the wizard sent when the order was placed.
    preview: c.theme
      ? {
          theme: c.theme,
          name: c.honoree_name,
          extra_fields: c.extra_fields || {},
          word_font: c.word_font || null,
          title: c.custom_title || null,
          chasers: !!c.chasers,
          // The stored honoree gender, so the confirmation page's re-render
          // resolves a gendered title (בת/בן) the same way the wizard's preview
          // and the printed deck do.
          gender: c.gender || null,
        }
      : null,
  });
});

// Add words (rejected when closed/expired).
app.post('/api/collections/:id/words', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const words = Array.isArray(req.body && req.body.words) ? req.body.words : [];
  if (!words.length) return res.status(400).json({ error: 'words required' });
  if (words.length > 500) return res.status(400).json({ error: 'too many words at once' });
  // The free-quota gate is enforced HERE, server-side — collect.html also hides
  // the add box at the limit, but a client-side lock is bypassable and the whole
  // point of the quota is that it can't be walked around.
  const before = db.freeLimit(req.params.id);
  if (before && before.locked) {
    // Locked, so the limit goes out with it (same reasoning as the public view:
    // at the lock `count` already IS the limit). The page still never shows it.
    return res.status(402).json({
      error: 'free_limit_reached',
      count: db.countWords(req.params.id),
      free_word_limit: before.limit,
    });
  }
  const r = db.addWords(req.params.id, words, req.body && req.body.added_by);
  if (r && r.closed) return res.status(409).json({ error: 'collection closed' });
  const count = db.countWords(req.params.id);
  const after = db.freeLimit(req.params.id);
  // Just filled the quota (this request is what tipped it over): one email to the
  // buyer explaining the lock, with the pay CTA. markFreeLimitNotified is the
  // once-only guard, so a later add attempt can never re-send it.
  if (after && after.locked && db.markFreeLimitNotified(req.params.id)) {
    notify
      .sendFreeLimitReached(db.getCollection(req.params.id), paymentBaseUrl(), after.limit)
      .catch(() => {});
  }
  res.json({
    added: r.added,
    skipped: r.skipped,
    // How many words the quota refused (0 when no quota applies). The page uses
    // this to say "5 of your 50 words were added" instead of failing silently.
    blocked: r.blocked || 0,
    // How many entries were over the length cap and therefore NOT stored. The
    // page normally filters these out before submitting (so the customer is told
    // while typing), but a paste from an old tab or a non-browser client still
    // lands here — the count plus `max_word_len` lets any caller say exactly what
    // was refused and why.
    too_long: r.tooLong || 0,
    max_word_len: validate.MAX_WORD_LEN,
    // How many entries were refused for carrying an emoji. Like `too_long` this
    // is normally 0 — collect.html filters them out before submitting, so the
    // customer is told while the word is still in front of her — but a paste
    // from a stale tab, or any non-browser caller, still lands here and gets a
    // number it can explain instead of a word that silently never appeared.
    emoji: r.emoji || 0,
    // Same again for pointed Hebrew ("שָׁלוֹם"): the card faces are drawn for
    // unpointed text, so the marks would print as boxes. Normally 0 for the same
    // reason as `emoji` — the page catches it while the word is still on screen.
    niqqud: r.niqqud || 0,
    count,
    // Locked state, plus the limit ONLY once locked (see the public view for why
    // withholding it past that point buys nothing).
    free_limit_locked: !!(after && after.locked),
    ...(after && after.locked ? { free_word_limit: after.limit } : {}),
  });
});

// Owner-only: close collection.
app.post('/api/collections/:id/close', (req, res) => {
  const token = req.body && req.body.owner_token;
  const result = db.closeCollection(req.params.id, token);
  if (!result) return res.status(403).json({ error: 'forbidden' });
  // FREEZE THE WORD BANK. Closing IS the approval — the point past which the
  // buyer's list stops moving and production begins — so it is where the 412
  // that will be printed stops being recomputed on demand and becomes a stored
  // production input. See server/word-bank.js for the whole argument.
  //
  // Best effort, deliberately: the close has already succeeded and the buyer is
  // about to be told her order is in production. An order that could not be
  // frozen prints exactly the way every order printed before this existed.
  if (result.changed) {
    const c = db.getCollection(req.params.id);
    const theme = c && String(c.theme || '').trim();
    if (c && theme) {
      const bank = wordBank.freeze({
        personalWords: db.listWords(c.id).map((w) => w.text),
        theme,
        pool: c.wordlist || null,
        python: PYTHON_BIN,
      });
      if (bank) db.setWordBank(c.id, bank);
    }
  }
  // Closing is the handover: the buyer is done, we start producing. BOTH sides
  // are told, from the same transition — the owner that a list is ready to
  // produce, and the BUYER that we have their words and have started. Only on
  // the real open->closed transition (a repeated close must not re-send) and
  // only when email is configured (skip the word-count work entirely otherwise).
  // Fire-and-forget: a failed email must never affect the response.
  if (result.changed && notify.isConfigured()) {
    const c = db.getCollection(req.params.id);
    if (c) {
      const enriched = { ...c, count: db.countWords(c.id) };
      const base = paymentBaseUrl();
      notify.sendOrderFinished(enriched, base).catch(() => {});
      notify.sendProductionStarted(enriched, base).catch(() => {});
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
    // Copies of the same deck. setOrder sanitises it and recomputes the total —
    // the client's number never reaches the charge unmultiplied by our own price.
    quantity: b.quantity,
  });
  if (r && r.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (r && r.error) return res.status(400).json({ error: r.error });
  // Order created -> fire the one-time owner/buyer emails + WhatsApp group.
  onOrderCreated(req.params.id, paymentBaseUrl());
  res.json({
    version: r.version,
    total: r.total,
    quantity: r.quantity,
    unit_price: r.unit_price,
    delivery_fee: r.delivery_fee,
  });
});

// Owner-only: delete a word (moderation).
app.delete('/api/collections/:id/words/:wordId', (req, res) => {
  const token = req.body && req.body.owner_token;
  if (!db.deleteWord(req.params.id, req.params.wordId, token)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ ok: true });
});

// Owner-only: edit a word's text (fix a typo). Same normalization, entry-length
// cap and emoji refusal as the add path (never trust the client); rejects an
// empty result, an over-length result, an emoji and a collision with another
// existing word. token in the
// body (not the URL) so it isn't logged, mirroring the delete route.
app.patch('/api/collections/:id/words/:wordId', (req, res) => {
  const b = req.body || {};
  const r = db.editWord(req.params.id, req.params.wordId, b.text, b.owner_token);
  if (r === null) return res.status(404).json({ error: 'not found' });
  if (r.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (r.error === 'not_found') return res.status(404).json({ error: 'word not found' });
  if (r.error === 'empty') return res.status(400).json({ error: 'text required' });
  if (r.error === 'too_long') {
    return res.status(400).json({
      error: 'too_long',
      message: validate.wordLengthMessageForLen(r.len),
      len: r.len,
      max_word_len: validate.MAX_WORD_LEN,
    });
  }
  // An edit that ADDS an emoji is refused and the stored word is left alone. The
  // message names the emoji, because "invalid input" would leave the owner
  // hunting for which character in her own typing the server objected to.
  if (r.error === 'emoji') {
    return res.status(400).json({
      error: 'emoji',
      message: validate.wordEmojiMessage(b.text),
      found: r.found || [],
    });
  }
  // An edit that ADDS niqqud is refused and the stored word is left alone. The
  // message carries the unpointed form rather than pointing at the marks, which
  // are invisible on their own — there is nothing to circle, only something to
  // retype.
  if (r.error === 'niqqud') {
    return res.status(400).json({
      error: 'niqqud',
      message: validate.wordNiqqudMessage(b.text),
      clean: r.clean || '',
    });
  }
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
// The SITE-RELATIVE path ("/assets/designs/<id>/store.webp" or an owner-uploaded
// "/content-uploads/<hash>.webp") of the product photo for a collection's chosen
// design, or null when nothing resolves. Split out from resolveProductImageUrl so
// the browser (payment confirmation page) can use a relative path while the email
// builders — which need a fully-qualified src — prepend the public origin.
async function resolveProductImagePath(collection) {
  if (!collection) return null;
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
    if (override) return override;
    // Static fallback — only when the file actually exists on disk, so the email
    // never embeds a broken <img> (it would then just show the alt text).
    const rel = 'assets/designs/' + d.id + '/store.webp';
    if (!fs.existsSync(path.join(__dirname, '..', 'site', rel))) return null;
    return '/' + rel;
  } catch {
    return null;
  }
}

// The same photo as an ABSOLUTE url for the email builders (an <img> in an inbox
// can't resolve a site-relative src). Null without a public origin to build on.
async function resolveProductImageUrl(collection, base) {
  if (!base) return null;
  const rel = await resolveProductImagePath(collection);
  return rel ? base + rel : null;
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

// Send the owner + buyer PAYMENT receipts for a collection that just went paid.
// The counterpart to sendOrderNotifications (which fires at order CREATION): this
// one is about the money actually landing, so it shows `amountCharged` — what was
// charged AFTER any coupon — rather than the package's list price. The buyer's
// copy carries the product photo and the add-words CTA, so it needs the same async
// catalog lookup the confirmation does; the owner's copy is fired first and does
// not wait on it. `base` is the normalized public origin.
async function sendPaidNotifications(collectionId, base, amountCharged) {
  const c = db.getCollection(collectionId);
  if (!c) return;
  const enriched = { ...c, count: db.listWords(collectionId).length };
  // One-click admin orders panel link — OWNER copy only. Built here (never inside
  // server/notify.js) so the mail module never sees ADMIN_KEY, and never passed to
  // the buyer's copy.
  const adminLink =
    base && ADMIN_KEY ? base + '/admin.html?key=' + encodeURIComponent(ADMIN_KEY) : null;
  // Both callers pass a real charge, but a non-finite value is tolerated: it's
  // omitted so the emails fall back to the order's own total rather than
  // rendering a broken amount.
  const charged = Number.isFinite(amountCharged) ? { amountCharged } : {};
  notify.sendPaymentReceipt(enriched, base, { adminLink, ...charged }).catch(() => {});
  const productImageUrl = await resolveProductImageUrl(c, base);
  notify.sendBuyerReceipt(enriched, base, { productImageUrl, ...charged }).catch(() => {});
}

// Everything that must happen when a payment actually COMPLETES. Called from BOTH
// unpaid->paid transitions — the verified PeleCard callback and the free
// (100%-coupon) path — each of which guards the transition, so this never fires
// twice for one order. There is no third caller by design: nothing marks an order
// paid by hand, so a receipt always follows real money. Order creation has its own
// notifications (onOrderCreated); this is purely the receipt pair. Gated on
// notify.isConfigured() so the word-count/image work is skipped when email is
// dormant, and fire-and-forget: a failed send must never fail the payment.
function onOrderPaid(collectionId, base, amountCharged) {
  if (!notify.isConfigured()) return;
  sendPaidNotifications(collectionId, base, amountCharged).catch(() => {});
}

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
    // exempt: the owner's own number is not a stranger reachout, and this is
    // exactly the message that must still get out when the breaker has tripped —
    // gating it would silence the alert that explains the gate.
    const r = await whatsapp.sendMessage(to, text, { exempt: true });
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
//   4. fetch + persist the group's join link. In the default invite_link mode
//      that link IS the delivery: it appears as a WhatsApp button on the buyer's
//      own order page, which they tap to join. NOTHING is sent to the buyer here
//      — no DM, no email — so the bot contacts nobody and there is no reachout to
//      be restricted for. In auto_add mode the link is the privacy-block fallback.
//   5. escalate to the owner — by email (notify.sendSystemAlert), falling back to
//      a WhatsApp DM to the owner's own number — only when the buyer has been left
//      with no way in at all.
async function openWhatsappGroup(collection, base) {
  if (!collection || !collection.id) return;
  if (waState.groupForCollection(collection.id)) return; // already have a group — no-op
  // Reserve the intent to create BEFORE the first await. Two concurrent paid
  // events for one collection would otherwise both pass the check above and both
  // createGroup; the loser here backs off, so exactly one group is ever created.
  if (!waState.reserveCollection(collection.id)) return;
  try {
    const mode = whatsapp.groupMode();
    const buyerWa = ilPhoneToWaId(collection.owner_phone);
    // auto_add needs a usable buyer number to add. invite_link does NOT — the
    // buyer taps the join link on their own order page, so a collection with an
    // unusable phone still gets its group.
    if (mode === 'auto_add' && !buyerWa) return;
    const honoree = collection.honoree_name || '';
    const subject = 'דוגרי · מילים על ' + (honoree || 'בעל/ת השמחה');

    // The whole point of invite_link mode: an EMPTY group contacts nobody, so
    // WhatsApp has no reachout to restrict. Only auto_add puts a number in the
    // create call, and whatsapp.createGroup gates exactly that on the breaker.
    const participants = mode === 'auto_add' && buyerWa ? [buyerWa] : [];
    const created = await whatsapp.createGroup(subject, participants);
    if (created && created.blocked) {
      // The reachout breaker (or the daily cap) held this back. That is the guard
      // working as designed, but it is NOT silent: orders keep arriving while no
      // groups open, so the owner has to hear about it.
      console.error(
        '[whatsapp] group creation BLOCKED by the reachout guard for collection ' +
          collection.id +
          ' (' +
          created.reason +
          '). Switch wa.group_mode to invite_link, or clear the breaker in admin ' +
          'once the number is confirmed healthy.'
      );
      const alertSubject = 'וואטסאפ — פתיחת קבוצות נחסמה';
      const alertLines = [
        created.reason === 'tripped'
          ? 'זוהתה הגבלה של וואטסאפ על המספר, ולכן הפסקנו לפתוח קבוצות חדשות כדי לא להחמיר.'
          : 'הגענו למכסה היומית של פתיחת קבוצות, ולכן ההזמנה הזו לא קיבלה קבוצה.',
        'מספר הזמנה: ' + collection.id,
        'אפשר לעבור למצב "קישור הצטרפות" בעמוד הניהול — הוא לא פונה לאף אחד ולכן לא נחסם.',
      ];
      if (!(await notify.sendSystemAlert(alertSubject, alertLines))) {
        await alertOwnerViaWhatsApp(alertSubject, alertLines);
      }
      return;
    }
    if (!created || !created.ok || !created.groupId) {
      // A `skipped` result is the intentional dormant path (bot off by design) —
      // stay silent. But a REAL failure (dropped Whapi channel, HTTP error, or a
      // 200 with no group id) otherwise fails here silently and the owner just sees
      // "orders but no groups", so log WHY: reason + collection id only — never the
      // buyer's phone or the honoree name.
      if (created && !created.skipped) {
        const why = created.error || 'http ' + (created.status || '?') + ' / no groupId';
        // Append Whapi's own error text. "whapi http 429" alone doesn't say WHY,
        // and the difference is everything: a 429 whose details read
        // "account_reachout_restricted" means WhatsApp has restricted the bot
        // NUMBER from contacting people (appeal in WhatsApp Business — no env or
        // code change helps), while a plain rate limit just means wait. Whapi
        // nests it as { error: { code, message, details } }, and `details` is the
        // machine-readable part worth logging; `message` is the generic
        // "too many requests". Only these fields, never the whole payload — a
        // group response can echo participant phone numbers.
        const d = created.data || {};
        const err = d && typeof d.error === 'object' && d.error ? d.error : null;
        const detail = err ? err.details || err.message || '' : d.message || d.error || '';
        const detailText = detail
          ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
          : '';
        console.warn(
          '[whatsapp] createGroup failed for collection ' + collection.id + ': ' + why + detailText
        );
      }
      return;
    }
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

    // Always fetch and PERSIST the join link, in both modes. In invite_link mode
    // it is the only way the buyer reaches the group; in auto_add it is the
    // privacy-block fallback. Storing it means a later Whapi outage can't blank a
    // link we already hold.
    const invite = await whatsapp.getInviteLink(groupId);
    const inviteLink = invite && invite.ok ? invite.inviteLink : null;
    if (inviteLink) waState.setInviteLink(groupId, inviteLink);

    if (mode === 'invite_link') {
      // The safe path, and the reason this mode is the default: nothing is sent
      // to the buyer at all. The stored link surfaces as a WhatsApp button on
      // their own order page (publicView.wa_invite_link) and they tap it to join.
      // The bot has now contacted precisely nobody, so there is no reachout for
      // WhatsApp to restrict. The only failure worth a human is having no link.
      if (!inviteLink) {
        const alertSubject = 'קבוצת וואטסאפ — לא הופק קישור הצטרפות';
        const alertLines = [
          'נפתחה קבוצה לאיסוף מילים אבל לא הצלחנו להפיק קישור הצטרפות, ולכן הלקוח/ה לא קיבל/ה דרך להיכנס.',
          'שם בעל/ת השמחה: ' + (honoree || '—'),
          'מזהה קבוצה: ' + groupId,
        ];
        if (!(await notify.sendSystemAlert(alertSubject, alertLines))) {
          await alertOwnerViaWhatsApp(alertSubject, alertLines);
        }
      }
      return;
    }

    // Privacy-block fallback (auto_add only): the buyer couldn't be added by
    // number. The invite DM below is itself a reachout, so it goes through the
    // same breaker + cap inside whatsapp.sendMessage.
    if (!buyerLandedInGroup(created, buyerWa)) {
      let dmSent = false;
      if (inviteLink) {
        dmSent = (await sendWaTrigger(buyerWa, 'group_opened', { honoree, link: inviteLink })).ok;
        if (dmSent) waState.setInviteDmSent(groupId);
      }
      // The buyer still has the join button on their own order page, so this is
      // not "no way in" — but nobody told them, so it needs a human.
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
        // produce. Fire the SAME pair the web /close route does — the owner's
        // "ready to produce" (otherwise no PDF is ever made and the customer waits
        // forever) and the buyer's "we've got your words, we've started". Only on
        // the real open->closed transition, gated on email being configured,
        // fire-and-forget so a send failure never escapes the webhook.
        if (notify.isConfigured()) {
          const fresh = db.getCollection(cid);
          if (fresh) {
            const enriched = { ...fresh, count: db.countWords(cid) };
            notify.sendOrderFinished(enriched, base).catch(() => {});
            notify.sendProductionStarted(enriched, base).catch(() => {});
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
      // Words arriving from the group count against the free quota exactly like
      // words typed on the page (db.addWords enforces it), so filling it here
      // must fire the same one-time "pay to keep adding" email to the buyer.
      const fl = db.freeLimit(cid);
      if (fl && fl.locked && db.markFreeLimitNotified(cid)) {
        notify
          .sendFreeLimitReached(db.getCollection(cid), paymentBaseUrl(), fl.limit)
          .catch(() => {});
      }
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

// One reminder-scan pass over every OPEN collection, driving the owner-managed
// reminder list (server/reminders.js). Reminders are anchored to the COLLECTION,
// so this delivers over BOTH channels: email (to the buyer) and WhatsApp (to the
// collection's group, when one exists) — email works even with the bot disarmed.
// Exposed (app.runReminderListScan) so a test can run one pass with an injected
// `now`. Runs whenever email OR the bot is available; each reminder's own channels
// + the engine's window / every_days / max_total / idle gates decide what actually
// sends. Each due reminder is RECORDED BEFORE the send result (mark-on-attempt),
// so a failed-looking send can never re-fire it — the fix for the hourly spam
// loop. Fail-soft per collection; never throws.
// How many more AUTOMATED reminder emails this buyer may receive for this order.
// One budget across all three schedulers (the words nudge, the payment milestones
// and the owner's reminder list), because a buyer does not experience them as
// three systems — she experiences an inbox. Owner-settable; see
// settings.reminders.max_emails for why per-reminder caps are not enough.
// A missing/broken setting falls back to the shipped default rather than to
// "unlimited": a ceiling that fails open is not a ceiling.
//
// Takes an ID and re-reads the collection, deliberately: every scan iterates over
// listAllCollections(), which hands out COPIES, so a budget computed from the loop
// variable would still show the count as it was when the pass started. With five
// reminders due in one pass that is five emails against a ceiling of three — which
// is exactly what the first version of this did.
function reminderEmailBudget(id) {
  let cap = 8;
  try {
    const v = settings.get('reminders', 'max_emails');
    if (Number.isInteger(v) && v >= 0) cap = v;
  } catch {
    /* keep the default */
  }
  return Math.max(0, cap - db.reminderEmailsSent(db.getCollection(id)));
}

async function runReminderListScan(now = Date.now()) {
  const emailOn = notify.isConfigured();
  const waOn = whatsapp.isConfigured();
  if (!emailOn && !waOn) return 0;
  let list = [];
  try {
    list = settings.get('reminders', 'list');
  } catch {
    return 0;
  }
  if (!Array.isArray(list) || !list.some((r) => r && r.enabled)) return 0;
  const base = paymentBaseUrl();
  let sent = 0;
  let collections = [];
  try {
    collections = db.listAllCollections();
  } catch {
    return 0;
  }
  for (const c of collections) {
    try {
      // Words in, at the printer, ready, or cancelled — nothing left to ask for.
      // (This replaces a plain `status !== 'open'` check, which kept chasing an
      // order that was already produced whenever the owner reopened the list.)
      if (reminders.wordRemindersStopped(c)) continue;
      const due = reminders.remindersDue({
        reminders: list,
        nowMs: now,
        sentState: db.reminderState(c.id),
        lastActivityMs: db.lastActivityMs(c.id),
      });
      if (!due.length) continue;
      const groupId = waState.groupForCollection(c.id); // null when no group
      const values = waGroupValues(c, base);
      for (const d of due) {
        // Record on attempt — an ambient reminder fires at most once per its
        // window; never retry on a failed-looking send (that spammed the group).
        db.markReminderSent(c.id, d.id, now);
        let delivered = false;
        // Could WhatsApp carry this reminder AT ALL? Distinct from "did the send
        // succeed" — see the fallback below, which turns on this distinction.
        const waPossible = !!(d.channels.whatsapp && groupId && waOn);
        if (waPossible) {
          const text = settings.interpolate(d.text, values);
          const r = await whatsapp.sendMessage(groupId, text);
          if (r && r.ok) delivered = true;
        }
        // Email runs when the reminder asks for it, OR as a FALLBACK when it asked
        // for WhatsApp only and WhatsApp could not be attempted at all — the bot is
        // off/disconnected, or this collection has no group. Without the fallback a
        // WhatsApp-only reminder (the shipped default for `morning`, see
        // reminders.js DEFAULT_REMINDERS) is marked sent by the record-on-attempt
        // above, delivers nothing, and never retries: the customer silently stops
        // being chased while the admin state claims the reminder went out. Learned
        // when the bot's WhatsApp number was banned and every group went dark.
        //
        // The condition is deliberately `!waPossible`, NOT "the send failed". A
        // restricted account can DELIVER and still return not-ok (see the
        // records-on-attempt regression in reminder-scan.test.js), so falling back
        // on a failed send would double-message the customer. Only the case where
        // nothing was even attempted is unambiguous.
        //
        // Gated on owner_email so a phone-only buyer doesn't count as "delivered".
        // The reminder text is reused as-is — it is channel-neutral.
        // …and never past the ceiling. WhatsApp above is unaffected: it is a group
        // the buyer chose to be in, guarded separately (server/wa-guard.js), and
        // capping it here would silently stop the channel this reminder was
        // actually written for.
        const wantsEmail = d.channels.email || (d.channels.whatsapp && !waPossible);
        if (wantsEmail && emailOn && c.owner_email) {
          if (reminderEmailBudget(c.id) > 0) {
            db.markReminderEmailSent(c.id);
            if (await notify.sendReminderEmail(c, d.text, base)) delivered = true;
          } else {
            console.warn('[reminders] email ceiling reached for collection ' + c.id);
          }
        }
        if (delivered) sent += 1;
        else {
          console.warn(
            '[reminders] ' + d.id + ' not delivered for collection ' + c.id + ' (already recorded)'
          );
        }
      }
    } catch (e) {
      console.warn('[reminders] scan failed for a collection:', e && e.message ? e.message : e);
    }
  }
  return sent;
}

// Owner-only: the buyer CLOSED the payment window. Marks every in-flight pay
// session abandoned so it stops counting as "a payment is open".
//
// Without this the checkout deadlocks: pay/init records a real session, the
// buyer closes the modal (which the server never hears about), and for the next
// 20 minutes the free/coupon path answers 409 "close the payment window before
// applying a coupon" — a window that is already closed, with no way to clear it.
// That is the "pay button does nothing" report.
//
// Deliberately forgiving: any outcome that isn't outright forbidden answers 200,
// because this is a fire-and-forget beacon sent while a modal closes. A buyer
// must never be blocked by the failure of a cleanup call they cannot see.
app.post('/api/collections/:id/pay/cancel', (req, res) => {
  const token = req.body && req.body.owner_token;
  const n = db.abandonPaySessions(req.params.id, token);
  if (n === null) return res.status(403).json({ error: 'forbidden' });
  res.json({ cancelled: n });
});

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
    quantity: b.quantity,
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
    // A free (100%-coupon) order is now paid — fire the same payment receipts as
    // the PeleCard callback, showing the real charged amount (0, which the emails
    // render as "free — 100% coupon" rather than a bare price).
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
    // Fire the owner + buyer payment receipts, showing the amount ACTUALLY
    // charged for THIS session (never the pre-coupon order.total). Gated on
    // email being configured inside onOrderPaid, and fire-and-forget — a failed
    // send must never turn a successful charge into a failed callback.
    onOrderPaid(c.id, paymentBaseUrl(), session.charged_total);
  }
  res.json({ ok: true });
});

// Admin: onboard a NEW private template. Multipart upload of the card SVGs, the
// title + word font files, and a few text fields (slug, display_he, title_text,
// name_form, language?, extra_fields?). Accepts BOTH asset layouts and detects
// which one the upload is (see server/templates.js):
//   sheet (legacy) clean+filled {fronts,backs,board}.svg
//   cards  (new)   clean+filled 1.svg-9.svg (1 = back, 2-9 = the eight fronts),
//                  the board uploaded separately since it is its own output file
// Writes them into resources/canva/templates/<slug>/, best-effort runs
// generator/recipe_diff.py to produce generator/recipes/<slug>.json (sheet only —
// there is no sheet to measure on a single-card template), and appends a
// visibility:"private", calibrated:false entry to generator/themes.json. The
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
    const { fields, files, fileLists } = templates.parseMultipart(req.body, boundary);
    let result;
    try {
      result = templates.onboardTemplate({
        root: TEMPLATE_ROOT,
        pythonBin: PYTHON_BIN,
        fields,
        files,
        // Repeated parts sharing one name — how a single multi-file picker
        // delivers the nine numbered card SVGs (and the shared assets/) at once.
        fileLists,
      });
    } catch (e) {
      return res
        .status(500)
        .json({ error: 'onboarding failed', detail: String((e && e.message) || e) });
    }
    // `titleless` marks the ONE rejection the owner can override: a title with no
    // {NAME}. It is legitimate (a deck whose artwork carries no name at all) but
    // must never be reached by accident, so the form re-posts with
    // allow_titleless:true after an explicit confirmation.
    if (result.error) {
      return res
        .status(result.httpStatus || 400)
        .json({ error: result.error, ...(result.titleless ? { titleless: true } : {}) });
    }
    res.status(201).json({ ok: true, ...result });
  }
);

// Admin: CREATE an EMPTY template shell from METADATA only (no files). Register the
// themes.json entry + the empty dir, so a heavy template can be added by uploading
// each asset SEPARATELY afterwards (via the per-asset replace route) instead of one
// giant multipart POST that would exceed the body-size limit. JSON body carries the
// same metadata fields the full upload form does (slug, display_he, title_text,
// name_form, language, extra_fields, visibility).
app.post('/api/admin/templates/create', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = templates.createTemplateShell({ root: TEMPLATE_ROOT, fields: req.body || {} });
  } catch (e) {
    return res.status(500).json({ error: 'create failed', detail: String((e && e.message) || e) });
  }
  if (result.error) {
    return res
      .status(result.httpStatus || 400)
      .json({ error: result.error, ...(result.titleless ? { titleless: true } : {}) });
  }
  res.status(201).json({ ok: true, ...result });
});

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

// Admin: edit an existing template's SETTINGS (display_he, language, name_form,
// extra_fields, visibility, title_text/title_lines) — the storefront/config knobs,
// never the identity (slug/dir/recipe) or assets. JSON body carries only the
// fields to change; each is validated. e.g. flip an uploaded template
// public/private, fix its language, or repair a title that lost its {NAME}.
app.post('/api/admin/templates/:key/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = templates.updateTemplateSettings({
      root: TEMPLATE_ROOT,
      key: req.params.key,
      patch: req.body || {},
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  // See the upload route: `titleless` is the one rejection the owner may confirm
  // past (allow_titleless:true), not a validation the client can simply ignore.
  if (result.error) {
    return res
      .status(result.httpStatus || 400)
      .json({ error: result.error, ...(result.titleless ? { titleless: true } : {}) });
  }
  res.json({ ok: true, ...result });
});

// Admin: DELETE a template — remove its themes.json entry + on-disk files. GUARDED:
// a theme a live orderable design maps to (its key is a THEME_BY_DESIGN value in
// site/js/designs.js) is refused (409) so deleting can't break the storefront or an
// in-flight order. The in-use set is derived from the catalog; if the catalog can't
// be read we FAIL CLOSED (refuse) rather than risk deleting an in-use theme.
app.delete('/api/admin/templates/:key', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let inUse;
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')));
    inUse = new Set(Object.values(mod.THEME_BY_DESIGN || {}));
  } catch (e) {
    return res.status(500).json({
      error:
        'could not verify the template is safe to delete (catalog unavailable): ' +
        String((e && e.message) || e),
    });
  }
  let result;
  try {
    result = templates.deleteTemplate({
      root: TEMPLATE_ROOT,
      key: req.params.key,
      inUseThemes: inUse,
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
//
// Replacing a NUMBERED CARD SVG then re-runs slot detection, and the outcome
// comes back as `redetect: {ok, detail}`. The old recipe measured artwork that is
// no longer there — and since card_slots carries no colour, leaving it alone
// would paint the new art's words in the OLD art's ink. Detection writes the
// RECIPE only, so the owner's hand-tuned card_slots still win; a failure changes
// nothing on disk and is reported rather than swallowed.
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
        pythonBin: PYTHON_BIN, // shrink embedded rasters on a per-file SVG upload too
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

// Admin: REMOVE an optional asset — today the two second fonts, and only those.
// The undo for a font uploaded to the wrong role or the wrong template, which
// until now could only be repaired by hand-editing themes.json on the volume.
// templates.clearAsset refuses every other role, so this cannot strip a template
// of a font it needs to render.
app.delete('/api/admin/templates/:key/assets/:role', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = templates.clearAsset({
      root: TEMPLATE_ROOT,
      key: req.params.key,
      role: req.params.role,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result.error) {
    const { httpStatus, error, ...rest } = result;
    return res.status(httpStatus || 400).json({ error, ...rest });
  }
  res.json({ ok: true, ...result });
});

// --- Seed word pools ("wordlists") — admin CRUD --------------------------
// The pools generator/topup.py fills a short deck from. Until now they were
// files in the repo only a developer could change; these routes put them behind
// the admin key so the owner can edit them on the live site. Every WRITE lands
// in DATA_DIR/wordlists (the persistent volume) — never in content/wordlists,
// which is baked into the ephemeral image — so editing a shipped list is a
// copy-on-write that survives redeploys. See server/wordlists.js for the full
// design. The page shell is site/admin-wordlists.html.

// Admin: every pool (shipped + owner-created) with its word count, source and
// the themes using it, plus the READ-ONLY theme -> pool linkage from themes.json.
app.get('/api/admin/wordlists', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ wordlists: wordlists.list(), themes: wordlists.themeLinks() });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Admin: one pool's full contents (the editor's load).
app.get('/api/admin/wordlists/:name', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let rec;
  try {
    rec = wordlists.read(req.params.name);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (!rec) return res.status(404).json({ error: 'הרשימה לא נמצאה.' });
  res.json(rec);
});

// Admin: create a NEW pool on the volume. Body: { name, text? | words? }.
app.post('/api/admin/wordlists', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  let result;
  try {
    result = wordlists.create({ name: body.name, words: body.words, text: body.text });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result && result.error) return res.status(result.httpStatus || 400).json(result);
  res.status(201).json({ ok: true, ...result });
});

// Admin: save a pool. Body is EITHER { text | words } (replace the whole list —
// the pasted blob) or { append } (add one word / a few). A shipped pool is
// copy-on-written into DATA_DIR here; the image's original is never touched.
app.put('/api/admin/wordlists/:name', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  let result;
  try {
    result = wordlists.update(req.params.name, {
      words: body.words,
      text: body.text,
      append: body.append,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result && result.error) return res.status(result.httpStatus || 400).json(result);
  res.json({ ok: true, ...result });
});

// Admin: undo the edits to a SHIPPED pool — drop the volume override so the
// version that ships with the system is live again.
app.post('/api/admin/wordlists/:name/revert', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = wordlists.revert(req.params.name);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result && result.error) return res.status(result.httpStatus || 400).json(result);
  res.json({ ok: true, ...result });
});

// Admin: delete a pool. Refused (409) when a theme still points at it (the
// message names them) and refused for a SHIPPED pool, which lives in the image
// and would simply reappear on the next deploy.
// Admin: RENAME a pool. The rename itself is wordlists.rename (write under the new
// name, drop the old one); the DESIGNS that pointed at the old name are repointed
// here, through the templates module, because that is the one path allowed to write
// a theme entry — see the note at the top of server/wordlists.js.
//
// The repoint is best-effort per design and reported: a design whose entry could
// not be written is named in the response rather than silently left pointing at a
// pool that no longer exists. The rename itself has already happened by then, so
// failing the whole request would leave the owner with a rename she cannot see.
app.post('/api/admin/wordlists/:name/rename', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = wordlists.rename(req.params.name, (req.body || {}).name);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result && result.error) return res.status(result.httpStatus || 400).json(result);
  const failed = [];
  for (const key of result.repoint || []) {
    try {
      const r = templates.updateTemplateSettings({
        root: TEMPLATE_ROOT,
        key,
        patch: { wordlist: result.name },
      });
      if (r && r.error) failed.push(key);
    } catch {
      failed.push(key);
    }
  }
  res.json({
    ok: true,
    ...result,
    repointed: (result.repoint || []).length - failed.length,
    failed,
  });
});

app.delete('/api/admin/wordlists/:name', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = wordlists.remove(req.params.name);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result && result.error) return res.status(result.httpStatus || 400).json(result);
  res.json({ ok: true, ...result });
});

// Admin: REVERT a shipped template to its shipped state — drop the owner-store
// override (entry + copied assets + recipe) that a rename/calibration/asset swap
// created, so the pristine version that ships with the release takes over again.
// The counterpart to the DELETE route's refusal on a shipped template: a shipped
// template can't be deleted (it would just come back on the next deploy), but the
// edits layered on top of it can be thrown away.
// Re-run detection + auto-calibration for a template already in the catalog.
// Deliberately a BUTTON, not something that fires on every asset replace: a full
// pass is 18 Chrome start-ups (each card's clean/filled pair rendered
// separately), and it used to run once per uploaded file.
//
// It is also a JOB now rather than the answer to this request. Measured in the
// staging container, one press on מרקאנה is ~61 seconds of work (7-9s detection,
// 53-59s calibration) and it used to run through spawnSync — which froze the
// whole server for the duration. A plain page request fired nine seconds into
// one came back HTTP 408 after 121s, and Railway's edge answers an unanswered
// request with 502 "Application failed to respond": that is the
// `הזיהוי נכשל: 502` the owner was getting for work that had actually
// succeeded. See server/redetect-job.js for the measurements and the fix.
//
// So: POST starts it and returns 202 immediately, GET reports where it has got
// to. Nothing about a slow template is hidden — the panel says which stage is
// running and which card is being measured, and a run that dies with the
// process is reported as interrupted, never as permanently "in progress".
app.post('/api/admin/templates/:key/redetect', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let job;
  try {
    redetectJob.sweepStale();
    job = redetectJob.start({
      root: TEMPLATE_ROOT,
      key: req.params.key,
      pythonBin: PYTHON_BIN,
      templates,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (job.error) return res.status(job.httpStatus || 400).json({ error: job.error });
  res.status(202).json({ ok: true, job });
});

// Where the re-detection for this template has got to. 404 when there is no run
// to report — which, for a job the panel was polling, means the server restarted
// underneath it. The page says so in those words rather than spinning forever:
// the work is gone, and the owner needs to know to press again.
app.get('/api/admin/templates/:key/redetect', (req, res) => {
  if (!requireAdmin(req, res)) return;
  redetectJob.sweepStale();
  const job = redetectJob.get(req.params.key);
  if (!job) return res.status(404).json({ error: 'no re-detection has been started' });
  res.json({ ok: true, job });
});

app.post('/api/admin/templates/:key/revert', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = templates.revertTemplate({ root: TEMPLATE_ROOT, key: req.params.key });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result.error) return res.status(result.httpStatus || 400).json({ error: result.error });
  res.json({ ok: true, ...result });
});

// Inline content editor. The owner edits any tagged text/photo on the live site
// in an admin-key-gated edit mode; the overrides persist under DATA_DIR (see
// server/content.js) and overlay the shipped defaults for EVERY visitor. The
// public GET is unauthenticated on purpose — every visitor must render the
// current copy — while all writes are behind requireAdmin.
// --- "stop emailing me" -------------------------------------------------------
// PUBLIC and unauthenticated, gated by a signature instead: the whole point is a
// person with an email and no account being able to stop the mail in one tap. The
// token is an HMAC of their own address (server/unsubscribe.js), so a query
// string cannot be edited to silence somebody else.
//
// Suppression is TOTAL — receipts and "your order is ready" included. See the
// gate in notify.send() for why that is the strict reading.

// The state of one address, for the landing page to render (and to say "you are
// already unsubscribed" rather than pretending the tap did something).
app.get('/api/unsubscribe/status', (req, res) => {
  const email = String(req.query.e || '');
  if (!unsubscribe.verify(email, req.query.t)) return res.status(403).json({ error: 'bad token' });
  res.json({ email: unsubscribe.norm(email), unsubscribed: unsubscribe.isUnsubscribed(email) });
});

// STOP. Answers both the page's button and the one-click POST that Gmail/Outlook
// send from their own unsubscribe control (RFC 8058) — same route, so the two can
// never drift apart.
app.post('/api/unsubscribe', (req, res) => {
  const body = req.body || {};
  const email = String(body.email || req.query.e || '');
  const token = body.token || req.query.t;
  if (!unsubscribe.verify(email, token)) return res.status(403).json({ error: 'bad token' });
  unsubscribe.unsubscribe(email, 'link');
  res.json({ ok: true, email: unsubscribe.norm(email), unsubscribed: true });
});

// …and back. One tap in a mail client is easy to do by accident, and without this
// the only way back is a phone call.
app.post('/api/resubscribe', (req, res) => {
  const body = req.body || {};
  const email = String(body.email || req.query.e || '');
  const token = body.token || req.query.t;
  if (!unsubscribe.verify(email, token)) return res.status(403).json({ error: 'bad token' });
  unsubscribe.resubscribe(email);
  res.json({ ok: true, email: unsubscribe.norm(email), unsubscribed: false });
});

// Admin: who has stopped their mail. The orders table annotates its rows from
// this too (see /api/admin/collections), because an owner who cannot see it just
// finds out that "the emails stopped working".
app.get('/api/admin/unsubscribed', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ addresses: unsubscribe.list() });
});

// Admin: stop (or resume) mail to an address BY HAND. People ask on WhatsApp, in
// a reply, or on the phone — and the owner should be able to honour that without
// asking them to go and find the link in an email they may have deleted. Also the
// way back for someone who pressed it by accident and cannot find the mail again.
app.post('/api/admin/unsubscribed', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const email = unsubscribe.norm(body.email);
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'bad email' });
  if (body.unsubscribed === false) unsubscribe.resubscribe(email);
  else unsubscribe.unsubscribe(email, 'admin');
  res.json({ ok: true, email, unsubscribed: unsubscribe.isUnsubscribed(email) });
});

// --- the SMS gateway on the owner's phone -------------------------------------
// The phone POLLS: it is behind a home router with no address of its own, so the
// server cannot call it. Everything here is gated by SMS_GATEWAY_KEY — a shared
// secret in the app's config, separate from ADMIN_KEY so a phone left in a drawer
// never carries the key to the whole admin.
//
// Dormant until that env var is set: with no key, these routes answer 404 rather
// than 403, so an unconfigured deployment does not advertise a feature it has not
// got.
function requireSmsGateway(req, res) {
  const key = process.env.SMS_GATEWAY_KEY || '';
  if (!key) {
    res.status(404).json({ error: 'sms gateway not configured' });
    return false;
  }
  const given = String(req.get('x-sms-key') || req.query.key || '');
  // Length check first so timingSafeEqual cannot throw on a mismatched length.
  const ok =
    given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// What to send now. Leased, so a second poll does not hand out the same message
// twice; see server/sms.js for why a lease rather than a delete.
app.get('/api/sms/outbox', (req, res) => {
  if (!requireSmsGateway(req, res)) return;
  sms.markPolled();
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  res.json({ messages: sms.claim({ limit }) });
});

// The phone's report on one message. `ok:false` carries the SIM's reason, which
// is what makes a failure legible on the admin screen instead of a silence.
app.post('/api/sms/outbox/:id/ack', (req, res) => {
  if (!requireSmsGateway(req, res)) return;
  sms.markPolled();
  const body = req.body || {};
  const m = sms.ack(req.params.id, { ok: body.ok !== false, error: body.error });
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, state: m.state });
});

// Admin: the queue, and when the phone last asked for work. That second number is
// the one that matters — pending messages plus a poll from two days ago is a
// phone that is off, not a server that is broken.
app.get('/api/admin/sms', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    enabled: !!settings.get('sms', 'enabled'),
    gateway_configured: !!process.env.SMS_GATEWAY_KEY,
    last_poll_at: sms.lastPollAt(),
    counts: sms.counts(),
    messages: sms.list({ limit: 30 }),
  });
});

app.get('/api/content', (req, res) => {
  res.json({ overrides: content.getPage(req.query.page) });
});

// Public: the LIVE, owner-editable per-design metadata the storefront and the
// buyer wizard must not bake into their bundle —
//   `names`  { <designId>: displayName }   an admin "rename template"
//   `fields` { <designId>: { extra_fields, language, name_form } }
//
// Both exist for the same reason: they are edited in the ADMIN, which writes the
// owner themes.json on the volume (DATA_DIR), while site/js/designs.js holds only
// build-time DEFAULTS. `fields` was added after סנטוריני was changed from a couple
// deck to a one-person deck in the admin and the wizard went on asking the buyer
// for two partner names + years-married — nothing the owner could do reached it,
// because the client mirror is compiled into the browser bundle.
//
// Each design carries its generator theme (site/js/designs.js), so a themes.json
// entry maps straight onto the design id — no separate slug↔id table.
// Unauthenticated on purpose (every visitor needs the current values) and exposes
// ONLY these whitelisted keys, never any other theme field. themes.json is read
// ONCE per request; any error (missing/corrupt config, catalog import failure)
// resolves to {} / {} so the pages fall back to their built-in defaults and never
// break. The buyer-facing fetchers add their own timeout.
app.get('/api/design-names', async (req, res) => {
  let names = {};
  let fields = {};
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')));
    // PUBLIC subset only — a private/access-gated design's name must never leak to
    // anonymous visitors. themes.json is read through an mtime cache so this hot
    // endpoint doesn't hit disk on every products.html / product.html load.
    const publicDesigns = mod.PUBLIC_DESIGNS || [];
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
    names = templates.designDisplayNames(themes, publicDesigns);
    fields = templates.designThemeFields(themes, publicDesigns);
  } catch {
    names = {};
    fields = {};
  }
  res.json({ names, fields });
});

// --- Custom designs: uploaded templates that become storefront products -------
// A "custom design" is DERIVED (no separate store): a PUBLIC generator theme
// (themes.json) that is NOT one of the built-in catalog designs' themes. So an
// admin-uploaded template automatically becomes an orderable product, and deleting
// the template removes it — no catalog rebuild. Its pictures are the template's own
// FILLED SVGs (the sample-personalized art — a realistic product photo, unlike the
// blank clean art), served by GET /api/template-image below. Uncalibrated templates
// still appear (the owner controls visibility + the admin gates PDF generation).

// The product picture slots a custom design can expose.
const CUSTOM_SLOTS = ['front', 'back', 'board'];
// Does the template have a filled SVG for this picture slot? The FILE behind a
// slot depends on the template's asset layout — filled/fronts.svg on a legacy
// sheet, filled/2.svg on a single-card template (whose filled/1.svg is the back)
// — so the mapping lives in templates.filledImageRel and is resolved through the
// persistent overlay (server/template-store.js), so an OWNER-uploaded template —
// whose assets live under DATA_DIR and not in the image — shows its pictures.
function customSvgExists(slug, slot) {
  if (!templates.isSafeSlug(slug)) return false;
  const file = templates.templateImagePath(TEMPLATE_ROOT, slug, slot);
  return !!file && fs.existsSync(file);
}

// Public: the list of custom designs (uploaded templates that aren't built-in),
// each shaped like a catalog design the storefront can render — id (=slug), name
// (display_he), theme (=slug), custom:true, and img URLs for whichever of
// front/back/board SVGs the template actually has on disk. Fail-safe: any error →
// empty list so the storefront just shows the built-in catalog.
app.get('/api/custom-designs', async (req, res) => {
  let out = [];
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')));
    const builtIn = new Set(Object.values(mod.THEME_BY_DESIGN || {}));
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
    for (const key of Object.keys(themes || {})) {
      const t = themes[key] || {};
      if (builtIn.has(key)) continue; // a built-in design's theme, not a custom product
      // Taken off the shop floor entirely — not in the grid, and NOT unlockable
      // with an access code either. That is the difference from `visibility`
      // below, which only chooses HOW an on-sale design is reached. The owner can
      // still generate an order for it from the admin.
      if (!templates.inStore(t)) continue;
      if ((t.visibility || 'public') !== 'public') continue; // owner hid it
      if (!templates.isSafeSlug(key)) continue;
      const img = {};
      for (const slot of CUSTOM_SLOTS) {
        if (customSvgExists(key, slot)) {
          img[slot] = '/api/template-image/' + encodeURIComponent(key) + '/' + slot;
        }
      }
      // Skip a shell with no card art yet — nothing to show as a product.
      if (!img.front && !img.back && !img.board) continue;
      out.push({
        id: key,
        // The ONE display-name rule (templates.displayNameForDesign) — a custom
        // design IS its own theme, so this is its live `display_he`, resolved the
        // same way /api/design-names and the admin catalog resolve every other
        // design's name.
        name: templates.displayNameForDesign(themes, { id: key, theme: key }),
        theme: key,
        custom: true,
        public: true,
        calibrated: !!t.calibrated,
        hasBoard: !!img.board,
        // The wizard resolves a BUILT-IN design's fields from a static map in
        // site/js/designs.js, which by definition cannot contain a custom
        // template. Without these it asked for none of them: a template
        // declaring AGE / YEARS / NAME1+NAME2 took the order anyway and printed
        // the title with unfilled placeholders, and an ENGLISH template got the
        // Hebrew name rule from the fallback.
        extra_fields: Array.isArray(t.extra_fields) ? t.extra_fields : [],
        language: typeof t.language === 'string' && t.language ? t.language : 'hebrew',
        name_form: typeof t.name_form === 'string' && t.name_form ? t.name_form : null,
        img,
      });
    }
  } catch {
    out = [];
  }
  res.json({ designs: out });
});

// Public: serve a custom design's picture — the template's FILLED SVG for the
// slot (the sample-personalized art, so the storefront shows a realistic
// example). slot is front|back|board, mapped to a file by the template's asset
// layout (fronts/backs.svg on a sheet, 2.svg/1.svg on a single-card template).
// The slug is validated to the safe-slug shape and the path is confined to the
// templates dir, so there is no traversal. Cached (the art changes only on a
// re-upload, which changes the file). SVG only.
// A template's de-duplicated background lives in its own assets/ dir and each
// card SVG points at it RELATIVELY ("../assets/<sha>.png"). Served straight from
// an /api/... URL that relative path resolves to nothing, so the card arrived
// WITHOUT its artwork — the storefront has been showing de-duplicated templates
// as bare cards. Serving the asset itself, and rewriting the reference to point
// here, fixes that and lets the admin checklist show a thumbnail per file
// without inlining a 5MB background into every one of them (the browser fetches
// it once and caches it across all of them).
app.get('/api/template-asset/:slug/:name', (req, res) => {
  const slug = String(req.params.slug || '');
  const name = path.basename(String(req.params.name || ''));
  if (!templates.isSafeSlug(slug) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return res.status(404).type('txt').send('Not found');
  }
  let dir = null;
  try {
    dir = templates.resolveTemplateDirBySlug(TEMPLATE_ROOT, slug);
  } catch {
    return res.status(404).type('txt').send('Not found');
  }
  if (!dir) return res.status(404).type('txt').send('Not found');
  const file = path.resolve(dir, 'assets', name);
  // Confined to the template's own assets dir — basename() above plus this
  // prefix check, so neither half has to be perfect alone.
  const root = path.resolve(dir, 'assets') + path.sep;
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    return res.status(404).type('txt').send('Not found');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// Read a card SVG with its "../assets/" references rewritten to absolute
// /api/template-asset/ URLs, so the markup renders correctly wherever it is
// served from. Returns null when the file is missing.
function templateSvgWithAssets(slug, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return text.replace(
    /((?:xlink:)?href=")\.\.\/assets\/([^"]+)(")/gi,
    (_m, pre, name, post) =>
      pre +
      '/api/template-asset/' +
      encodeURIComponent(slug) +
      '/' +
      encodeURIComponent(name) +
      post
  );
}

// Strip anything executable from an SVG before it is injected into the admin
// page's DOM.
//
// The thumbnails cannot use <img>: that context blocks external references, and
// a de-duplicated card's whole background IS an external reference, so every
// card rendered as an identical blank rectangle. Injecting the markup inline
// makes the background load — and also means any <script> inside it would run,
// in the admin's own session. These are owner-uploaded Canva exports, so this is
// closer to self-harm than an attack, but server/content.js already refuses SVG
// uploads outright over exactly this risk; agreeing with that position costs two
// regexes.
function sanitizeSvgForDom(svg) {
  return String(svg)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/(?:xlink:)?href\s*=\s*"javascript:[^"]*"/gi, '');
}

// One card SVG by ROLE, for the admin checklist's thumbnails. Admin-gated: the
// public storefront route below exposes only the three display slots.
app.get('/api/admin/templates/:key/asset-svg/:role', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = String(req.params.key || '');
  const role = String(req.params.role || '');
  if (!templates.isSafeThemeKey(key)) return res.status(404).type('txt').send('Not found');
  let entry = null;
  let dir = null;
  try {
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
    entry = themes && themes[key];
    dir = templates.resolveTemplateDirBySlug(TEMPLATE_ROOT, key);
  } catch {
    /* fall through to 404 */
  }
  if (!entry || !dir) return res.status(404).type('txt').send('Not found');
  // assetRolesFor is the single source of truth for role -> file, so a thumbnail
  // can only ever name a file the checklist itself lists.
  const spec = (templates.assetRolesFor(entry) || []).find((a) => a.role === role);
  if (!spec || !spec.rel) return res.status(404).type('txt').send('Not found');
  const file = path.resolve(dir, spec.rel);
  if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) {
    return res.status(404).type('txt').send('Not found');
  }
  const svg = templateSvgWithAssets(key, file);
  if (svg == null) return res.status(404).type('txt').send('Not found');
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.send(sanitizeSvgForDom(svg));
});

app.get('/api/template-image/:slug/:slot', (req, res) => {
  const slug = String(req.params.slug || '');
  const slot = String(req.params.slot || '');
  if (!templates.isSafeSlug(slug) || !CUSTOM_SLOTS.includes(slot)) {
    return res.status(404).type('txt').send('Not found');
  }
  // Resolved through the persistent overlay and confined to the resolved template
  // dir (templateImagePath returns null on any escape), so an owner-uploaded
  // template's art is served from DATA_DIR while there is still no traversal.
  const file = templates.templateImagePath(TEMPLATE_ROOT, slug, slot);
  if (!file || !fs.existsSync(file)) return res.status(404).type('txt').send('Not found');
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=300');
  // NOT sendFile: a de-duplicated card points at "../assets/<sha>.png", which
  // resolves to nothing from this URL, so the storefront was showing those
  // templates as bare cards with no artwork.
  const svg = templateSvgWithAssets(slug, file);
  if (svg == null) return res.status(404).type('txt').send('Not found');
  res.send(sanitizeSvgForDom(svg));
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
// pattern as the content editor: REPLACE a base render (store|front|back|photo|board),
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
  // ...and the photo-card fallback pawns, which reuse the same content-addressed
  // uploads: the SAME bytes uploaded as both a gallery picture and a pawn are ONE
  // file, so displacing the picture must not delete what the pawn still points at.
  if (photoFallback.isImageReferenced(imgPath)) return;
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
// (see site/js/design-images.js). Read-only.
//
// `srcsets` rides along: for every upload the config references, the ready-made
// srcset string for its derivative ladder (server/image-thumbs.js). It is built
// HERE rather than on the client so exactly ONE place decides what `w` descriptor
// each rung gets — the client only ever copies a string it was handed, and can
// never assert a width the resizer would not produce (INVARIANT 1). An upload
// whose dimensions cannot be read is simply absent, and the client keeps a plain
// `src` rather than an unbacked descriptor.
app.get('/api/design-images', (req, res) => {
  const images = designImages.getAll();
  const srcsets = {};
  for (const p of designImages.collectImagePaths(images)) {
    const name = p.split('/').pop();
    const set = imageThumbs.srcsetFor(name);
    if (set) srcsets[name] = set;
  }
  res.json({ images, srcsets, rev: imageThumbs.REV });
});

// Public: ONE rung of an upload's derivative ladder (see server/image-thumbs.js).
// The owner's gallery uploads are camera files — up to 4032 px and 3.4 MB — and
// every surface paints them into a 100–400 CSS px box. This is what those
// surfaces load instead.
//
// The REVISION is in the PATH, not just in the on-disk filename. The response is
// `immutable` for a year, so if the produced bytes ever change (a new encoder,
// quality, colour handling or geometry rule) while the URL stayed the same, every
// browser that has visited would keep the old picture until the cache expired.
// Bumping imageThumbs.REV therefore changes the public URL too, which is a clean
// cutover, and sweepStale() reclaims the previous generation from the volume.
//
// A request carrying a PAST revision is still served (never a broken image on a
// page whose HTML was cached across a bump) — but with a short max-age, since
// those bytes are by definition not the current answer for that URL.
//
// 404 is a NORMAL answer (no Python/Pillow, an undecodable upload): every caller
// keeps its own fallback, so a missing derivative costs one picture, never the
// page. It deliberately does NOT fall back to serving the original — that is the
// multi-MB page this route exists to avoid.
app.get('/design-img/:rev/:w/:name', (req, res) => {
  const current = req.params.rev === imageThumbs.REV;
  imageThumbs
    .get(req.params.name, Number(req.params.w))
    .then((der) => {
      if (!der) return res.status(404).type('txt').send('Not found');
      res.setHeader(
        'Cache-Control',
        current ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
      );
      // Defense in depth, as on /content-uploads: never let a browser sniff a
      // served image into an executable type.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type(der.type);
      res.sendFile(der.file);
    })
    .catch(() => res.status(404).type('txt').send('Not found'));
});

// Public: the wizard design picker's small derivative. Predates the ladder and
// keeps its own URL because buyer sessions have this path cached; it now serves
// the 400 rung of the same pipeline.
app.get('/design-thumb/:name', (req, res) => {
  imageThumbs
    .get(req.params.name, 400)
    .then((thumb) => {
      if (!thumb) return res.status(404).type('txt').send('Not found');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type(thumb.type);
      res.sendFile(thumb.file);
    })
    .catch(() => res.status(404).type('txt').send('Not found'));
});

// Admin: REPLACE a base render (store|front|back|photo|board) with an uploaded picture.
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

// --- Photo-card FALLBACK PAWNS (server/photo-fallback.js) --------------------
// The photo card's four slots are filled with generic Dugri pawns when an order
// supplies no customer photos. The shipped set lives in the repo, so replacing
// one meant a PR; these routes let the owner do it per slot from the admin, with
// no deploy. An un-overridden slot keeps using the shipped artwork, which is why
// "reset" DELETES the override rather than storing a copy of the default.
//
// The GENERATOR reads the resulting store directly — see
// docs/photo-fallback-overrides.md.

// Where the shipped pawns live. Read-only, and only ever joined with a validated
// slot digit, so this can never be steered at another file.
const SHIPPED_PAWN_DIR = path.join(
  __dirname,
  '..',
  'resources',
  'canva',
  'templates',
  '_shared',
  'photo-fallback'
);

// Reclaim a now-orphaned upload. Uploads are content-addressed and SHARED across
// ALL THREE stores, so a displaced pawn may still be in use as a gallery picture
// or a content image — check every one before deleting the bytes.
function reclaimPawn(imgPath) {
  if (!imgPath) return;
  if (photoFallback.isImageReferenced(imgPath)) return;
  if (designImages.isImageReferenced(imgPath)) return;
  if (content.isImageReferenced(imgPath)) return;
  content.deleteUpload(imgPath);
}

// Admin: the four slots, each reporting whether it is overridden and what to
// show as its thumbnail. `img` is what the generator will actually use.
app.get('/api/admin/photo-fallback', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const overrides = photoFallback.getAll();
  const slots = photoFallback.SLOTS.map((slot) => {
    const img = overrides[slot] || null;
    return {
      slot,
      img,
      overridden: !!img,
      // The shipped pawn is not under site/, so it cannot be linked directly —
      // it is served by the route below.
      shipped: '/api/admin/photo-fallback/default/' + slot,
      shippedExists: fs.existsSync(path.join(SHIPPED_PAWN_DIR, slot + '.svg')),
    };
  });
  res.json({ slots });
});

// Admin: the SHIPPED pawn for a slot, so the panel can show what a slot falls
// back to. Streams a repo file (our own committed artwork, not user input) and
// is admin-gated like the rest of this panel.
app.get('/api/admin/photo-fallback/default/:slot', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const slot = photoFallback.slotOk(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'bad slot' });
  const file = path.join(SHIPPED_PAWN_DIR, slot + '.svg');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no shipped pawn for that slot' });
  res.type('image/svg+xml');
  res.setHeader('Cache-Control', 'no-store');
  res.send(fs.readFileSync(file));
});

// Admin: REPLACE one slot's pawn. Multipart (field `slot` + a file part).
app.post(
  '/api/admin/photo-fallback',
  (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    next();
  },
  express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
  (req, res) => {
    const saved = saveGalleryUpload(req, res);
    if (!saved) return;
    const slot = photoFallback.slotOk(saved.fields.slot);
    if (!slot) {
      // Reclaim the just-written orphan — nothing references it yet.
      reclaimPawn(saved.img);
      return res.status(400).json({ error: 'bad slot' });
    }
    const { prev } = photoFallback.setSlot(slot, saved.img);
    if (prev) reclaimPawn(prev);
    res.json({ ok: true, slot, img: saved.img });
  }
);

// Admin: revert one slot to its shipped pawn. JSON { slot }.
app.delete('/api/admin/photo-fallback', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const slot = photoFallback.slotOk((req.body || {}).slot);
  if (!slot) return res.status(400).json({ error: 'bad slot' });
  const { prev } = photoFallback.resetSlot(slot);
  if (prev) reclaimPawn(prev);
  res.json({ ok: true, slot });
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

// Admin: what another service may mirror FROM this one — the owner-authored
// stores (settings/prices/emails, playbook, design gallery, word lists). This is
// the endpoint production calls against staging. Admin-gated and deliberately
// narrow: owner configuration only, never orders, customers, collected words,
// owner tokens, or any secret.
app.get('/api/admin/stores/export', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    stores: storeImport.exportAll({ settings, playbook, designImages, wordlists }),
  });
});

// Admin: mirror those stores from STAGING onto this service — the destructive
// twin of the export above, and the counterpart to content/import-from-staging
// (which moves the content overrides). MIRROR semantics: anything present here
// but absent on staging is DELETED. So the import refuses an empty payload, backs
// up every store, and fetches every gallery image BEFORE replacing anything.
// Same config as the content import: STAGING_URL + STAGING_ADMIN_KEY.
app.post('/api/admin/stores/import-from-staging', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  // Self-import guard, same as the content import: under mirror semantics a
  // STAGING_URL misconfigured to point here is destructive, not a no-op.
  const stagingUrl = process.env.STAGING_URL || '';
  const ownOrigins = [];
  if (process.env.PUBLIC_BASE_URL) ownOrigins.push(process.env.PUBLIC_BASE_URL);
  try {
    ownOrigins.push(req.protocol + '://' + req.get('host'));
  } catch {
    /* no Host header — PUBLIC_BASE_URL still guards the check */
  }
  if (contentImport.isSelfOrigin(stagingUrl, ownOrigins)) {
    return res
      .status(400)
      .json({ error: 'STAGING_URL points at this same service — refusing self-import' });
  }
  let result;
  try {
    result = await storeImport.importFromStaging({
      stagingUrl,
      adminKey: process.env.STAGING_ADMIN_KEY || ADMIN_KEY || '',
      deps: { settings, playbook, designImages, wordlists },
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (!result.ok) return res.status(result.status || 400).json(result);
  res.json(result);
});

// Admin: the manifest of THIS service's owner template store — the designs the
// owner onboarded through the admin UI, which live on the volume
// (DATA_DIR/templates) and therefore do NOT travel with a deploy. Metadata only:
// theme entries, recipes, and a {key, rel, bytes, sha256} row per file. The bytes
// come from the per-file route below, so a store with tens of MB of artwork is
// never marshalled into one JSON response. Admin-gated; the shipped templates
// baked into the image are deliberately excluded (the target already has them).
app.get('/api/admin/templates/export', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let manifest;
  try {
    manifest = templateImport.exportManifest();
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  res.json(manifest);
});

// Admin: raw bytes of ONE file named by that manifest. The template key comes in
// as `template` (not `key`, which is reserved for the admin secret) and the path
// is resolved strictly inside the owner dir — an unsafe key or path 404s without
// touching the filesystem. Owner layer only: the image's shipped assets are not
// reachable through here.
app.get('/api/admin/templates/export/file', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const file = templateImport.ownerFilePath(req.query.template, req.query.path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.status(404).json({ error: 'not found' });
  }
  res.type('application/octet-stream').sendFile(file);
});

// Admin: mirror staging's owner templates onto this service — the third of the
// staging→prod imports, alongside content (texts + photos) and stores
// (settings/playbook/gallery/word lists). Neither of those carries a template:
// a design is a DIRECTORY of SVGs and fonts on the volume, so an owner who
// onboarded and calibrated a design on staging had no way to get it to
// production short of re-uploading it by hand.
//
// ADDITIVE, unlike the stores mirror: a template that exists only here is left
// alone, never deleted. Removing one stays an explicit act (DELETE
// /api/admin/templates/:key). Same config as the other two imports: STAGING_URL
// + STAGING_ADMIN_KEY, and the same self-import refusal.
app.post('/api/admin/templates/import-from-staging', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stagingUrl = process.env.STAGING_URL || '';
  const ownOrigins = [];
  if (process.env.PUBLIC_BASE_URL) ownOrigins.push(process.env.PUBLIC_BASE_URL);
  try {
    ownOrigins.push(req.protocol + '://' + req.get('host'));
  } catch {
    /* no Host header — PUBLIC_BASE_URL still guards the check */
  }
  if (contentImport.isSelfOrigin(stagingUrl, ownOrigins)) {
    return res
      .status(400)
      .json({ error: 'STAGING_URL points at this same service — refusing self-import' });
  }
  let result;
  try {
    result = await templateImport.importFromStaging({
      stagingUrl,
      adminKey: process.env.STAGING_ADMIN_KEY || ADMIN_KEY || '',
      // OUR shipped designs, so a staging entry carrying only metadata (a renamed
      // shipped template — no artwork by design) is accepted rather than aborting
      // the whole import.
      templateRoot: TEMPLATE_ROOT,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (!result.ok) return res.status(result.status || 400).json(result);
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

// Admin: CLEAR the reachout circuit breaker (server/wa-guard.js). The breaker is
// sticky by design — it survives restarts and never auto-resets, because the
// last ban escalated precisely by retrying into an account restriction. Only a
// human who has checked the number's standing in WhatsApp Business should
// re-open the tap, which is what this route is. Also resets the day's reachout
// count so a clear is a genuine reset rather than a resume into a spent budget.
app.post('/api/admin/whatsapp/guard/clear', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const before = whatsapp.guard.snapshot();
  const after = whatsapp.guard.clear();
  if (before.tripped) {
    console.warn(
      '[wa-guard] breaker cleared by admin — reachout re-enabled. Previous reason: ' + before.reason
    );
  }
  res.json({ ok: true, guard: after });
});

// Live channel connection probe. Unlike /status (a pure env snapshot), this makes
// a real Whapi call to check whether the linked phone is still paired — so the
// admin banner can surface a dropped device ("QR"/disconnected) that otherwise
// silently breaks group creation. Admin-gated, async, returns only the connection
// tri-state + raw status text (never the token/secret). Fail-soft: never throws.
app.get('/api/whatsapp/health', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(await whatsapp.health());
  } catch (e) {
    res.json({ ok: false, connection: 'error', error: (e && e.message) || String(e) });
  }
});

// Admin: the catalog of previewable messages (email + WhatsApp triggers).
app.get('/api/admin/message-preview', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ kinds: messagePreview.listKinds({ settings }) });
});

// Admin: render ONE message exactly as it would be sent. Renders against a
// SAMPLE order by default so the preview works on a fresh install and never puts
// a real customer's details into a screenshot; pass ?collection=<id> to render a
// real order instead, which is what you want when checking that a specific
// order's address / design / amount interpolates correctly.
//
// The hero product photo is resolved through the SAME resolveProductImageUrl the
// real send path uses, so "does the photo actually appear" is a question the
// preview can answer honestly.
//
// `draft`, when present, renders an UNSAVED edit instead of the stored template —
// see the POST route below. The body is shared by both routes so a drafted
// preview and a stored one can't diverge in how they resolve the order, the
// product photo or the base URL. It answers the request itself, including its own
// 404s, so each route just awaits it.
async function respondWithMessagePreview(req, res, draft) {
  const base = paymentBaseUrl();
  let collection = null;
  if (req.query && req.query.collection) {
    collection = db.getCollection(String(req.query.collection));
    if (!collection) return res.status(404).json({ error: 'collection not found' });
    collection = { ...collection, count: db.countWords(collection.id) };
  }
  const target = collection || messagePreview.SAMPLE_COLLECTION;
  let productImageUrl = null;
  try {
    productImageUrl = await resolveProductImageUrl(target, base);
  } catch {
    productImageUrl = null;
  }
  const out = messagePreview.render(String(req.params.channel), String(req.params.id), {
    notify,
    whatsapp,
    settings,
    baseUrl: base,
    collection,
    productImageUrl,
    draft,
  });
  if (!out) return res.status(404).json({ error: 'unknown message id' });
  res.json({ ...out, sample: !collection, draft: !!draft });
}

app.get('/api/admin/message-preview/:channel/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await respondWithMessagePreview(req, res, null);
});

// Admin: render ONE message from an UNSAVED draft — the preview page's editor
// POSTs the text as it is typed so the owner sees the real, rendered result
// before committing it. Nothing is stored: the draft is overlaid on a throwaway
// copy of the settings store for this one render, and saving still goes through
// POST /api/admin/settings like every other edit.
//
// The draft is shape-validated with the SAME settings.validateValue a save uses,
// so the preview can't accept (and appear to bless) a value that a save would
// then reject.
app.post('/api/admin/message-preview/:channel/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const draft = (req.body && req.body.draft) || null;
  if (draft) {
    const { section, key, value } = draft;
    if (!settings.hasKey(section, key)) {
      return res.status(400).json({ error: 'unknown section/key' });
    }
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    const shapeError = settings.validateValue(section, key, value);
    if (shapeError) return res.status(400).json({ error: shapeError });
  }
  await respondWithMessagePreview(req, res, draft);
});

// Admin: which collections have a WhatsApp group. Pure local state (no Whapi
// call), so it stays fast enough for the admin table's 15s refresh and still
// answers while the channel is down. Keyed by collection id for a direct lookup
// per row. Closed groups are INCLUDED (see wa-state.allGroups) — the owner may
// still want to post in the group of a finished order. Returns ids only: no
// buyer phone, no member list.
app.get('/api/admin/whatsapp/groups', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const groups = {};
  for (const g of waState.allGroups()) {
    if (!g || !g.collection_id) continue;
    groups[g.collection_id] = { groupId: g.groupId, closed: !!g.closed };
  }
  res.json({ groups });
});

// Admin: open a word-collection group for a collection that has none — the
// manual equivalent of the automatic order-created hook, for orders that were
// placed while the bot was dormant or disconnected. Deliberately reuses
// openWhatsappGroup so a manually opened group is IDENTICAL to an automatic one
// (same subject, same buyer add, same pinned group_opened announcement, same
// wa-state link) rather than a second, subtly different code path.
//
// openWhatsappGroup is fail-soft and returns nothing, so success is decided by
// re-reading wa-state after it runs. On failure we probe the channel health to
// tell the owner WHICH failure it is — a disconnected channel (re-scan the QR)
// reads completely differently from a bad buyer phone, and without this the
// button would just say "failed" for the one problem that actually recurs.
app.post('/api/admin/whatsapp/groups/:cid/open', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const collection = db.getCollection(req.params.cid);
  if (!collection) return res.status(404).json({ error: 'collection not found' });
  if (waState.groupForCollection(collection.id)) {
    return res.status(409).json({ error: 'already has a group' });
  }
  if (!whatsapp.isConfigured()) {
    return res.status(400).json({ error: 'not configured', reason: 'bot_off' });
  }
  // A tripped breaker means WhatsApp has restricted this number from contacting
  // people. Refusing the click here (rather than letting it fall through to a
  // generic "could not create group") is the whole point of the guard: a manual
  // retry into a live restriction is exactly how the previous ban was escalated.
  const guardState = whatsapp.guard.snapshot();
  if (guardState.tripped && whatsapp.groupMode() === 'auto_add') {
    return res.status(409).json({
      error: 'reachout blocked',
      reason: 'guard_tripped',
      detail: guardState.reason,
      guard: guardState,
    });
  }
  // In auto_add mode the buyer's number is what the group is built around, so a
  // collection with no usable IL mobile can never get one and the owner should be
  // told that, not "try again". invite_link mode adds nobody, so it needs no
  // phone at all — the link reaches the buyer by email / their order page.
  if (whatsapp.groupMode() === 'auto_add' && !ilPhoneToWaId(collection.owner_phone)) {
    return res.status(400).json({ error: 'no usable buyer phone', reason: 'bad_phone' });
  }
  try {
    await openWhatsappGroup(collection, paymentBaseUrl());
  } catch (e) {
    console.warn('[whatsapp] admin open failed:', e && e.message ? e.message : e);
  }
  // groupForCollection returns the groupId STRING (by_collection maps
  // collection id -> groupId), not an entry object.
  const groupId = waState.groupForCollection(collection.id);
  if (groupId) return res.json({ ok: true, groupId });
  let connection = 'unknown';
  try {
    const h = await whatsapp.health();
    connection = (h && h.connection) || 'unknown';
  } catch {
    connection = 'error';
  }
  res.status(502).json({ error: 'could not create group', reason: 'whapi_failed', connection });
});

// Admin: a clickable link to an existing group. WhatsApp has no "open group by
// id" URL, so the only way in is the group's invite link — which also works
// when the owner's personal number isn't a member yet (the group is created by
// the BOT number, so usually it isn't): the link offers to join, then opens it.
// Live Whapi call, hence separate from the listing above rather than folded into
// it — one call per click instead of one per row per refresh.
app.get('/api/admin/whatsapp/groups/:cid/invite', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const groupId = waState.groupForCollection(req.params.cid);
  if (!groupId) return res.status(404).json({ error: 'no group for this collection' });
  try {
    const r = await whatsapp.getInviteLink(groupId);
    if (!r || !r.ok || !r.inviteLink) {
      return res.status(502).json({ error: 'could not fetch invite link' });
    }
    res.json({ ok: true, groupId, inviteLink: r.inviteLink });
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || String(e) });
  }
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

// Public, UNAUTHENTICATED: the home-page FAQ the owner edits in admin-faq.html.
// A WHITELISTED projection of only the `faq` settings section — the ENABLED
// questions, in order, reduced to { id, q, a, link_text, link_url }. A disabled
// question is the owner hiding it from visitors, so it must not travel here even
// though the admin page still shows it. faq.publicFaq falls back to the shipped
// defaults if the stored value is somehow malformed, so this endpoint answers
// with real content or nothing surprising — never a 500 the home page has to
// handle. Writes stay behind the admin key via /api/admin/settings.
app.get('/api/faq', (req, res) => {
  res.json({ items: faq.publicFaq(settings.get('faq', 'list')) });
});

// Unknown API routes -> JSON 404 (must come before static/catch-all).
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Content-hashed ES modules (server/asset-hashing.js): a new build yields NEW
// module urls, so a CDN edge can never pair a stale script with fresh HTML — the
// 9 Aug store outage, where a day-old design-images.js (no `SIZES` export) met an
// index.html that imported it and the whole page module died on its import line.
// Built once, at boot, from site/js.
const assetHashing = require('./asset-hashing');
const moduleAssets = assetHashing.build(SITE_DIR);

// The hash IS the version, so a hashed url is immutable for a year. These never
// exist on disk under the hashed name — the request is mapped back to the real
// file. An unknown hash falls through (a stale HTML would 404 here, but HTML is
// no-cache and carries a current import map, so the browser only ever asks for
// hashes this build actually minted).
app.get(/^\/js\/.+\.[0-9a-f]{8}\.m?js$/, (req, res, next) => {
  const file = moduleAssets.resolveHashed(req.path);
  if (!file) return next();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type('js');
  res.sendFile(file);
});

// Serve HTML ourselves (before express.static) so the import map can be injected
// into every page. resolveHtmlFile returns the file for "/", "*.html" and an
// extension-less route that maps to a page (the same set express.static's
// extensions:['html'] resolved), and null for anything with a real asset
// extension — those fall through to the hashed route / static below.
function resolveHtmlFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/') p = '/index.html';
  else if (p.endsWith('/')) p += 'index.html';
  const ext = path.extname(p);
  let candidate;
  if (ext === '.html') candidate = path.join(SITE_DIR, p);
  else if (!ext) candidate = path.join(SITE_DIR, p + '.html');
  else return null;
  const resolved = path.resolve(candidate);
  if (
    resolved !== path.resolve(SITE_DIR) &&
    !resolved.startsWith(path.resolve(SITE_DIR) + path.sep)
  )
    return null;
  return fs.existsSync(resolved) ? resolved : null;
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = resolveHtmlFile(req.path);
  if (!file) return next();
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    return next();
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html');
  res.send(moduleAssets.inject(html));
});

// Static site (so /collect resolves to collect.html, etc.). HTML is served
// with no-cache so visitors always get the latest page (and the iPhone/Instagram
// browsers stop showing a stale copy); other assets keep their default validators.
app.use(
  express.static(SITE_DIR, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) return res.setHeader('Cache-Control', 'no-cache');
      // A bare module url (no hash in its own name) must always revalidate, so an
      // edge can never pin yesterday's script against today's HTML — the 9 Aug
      // outage. The hashed copies are served immutable by the route above; this
      // catches any direct hit on an unhashed /js/*.js.
      if (/\.m?js$/.test(filePath)) return res.setHeader('Cache-Control', 'no-cache');
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
  // Inject the import map here too, so the SPA fallback carries hashed module urls
  // just like a directly-served page.
  const html = fs.readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8');
  res.type('html');
  res.send(moduleAssets.inject(html));
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
        // The shared ceiling. Skipped WITHOUT marking, so raising the cap later
        // still lets the one nudge this collection is owed go out.
        if (reminderEmailBudget(c.id) <= 0) {
          console.warn('[reminder] email ceiling reached for collection ' + c.id);
          continue;
        }
        db.markReminderEmailSent(c.id);
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
        // The email half, under the shared ceiling. The WhatsApp DM below is not
        // counted against it — it is a different medium with its own guard — but
        // when neither channel can go, the milestone is left UNSPENT rather than
        // marked, so nothing is silently skipped.
        const emailAllowed = emailOn && c.owner_email && reminderEmailBudget(c.id) > 0;
        const waAllowed = waOn && c.owner_phone && whatsapp.groupMode() === 'auto_add';
        if (!emailAllowed && !waAllowed) {
          console.warn('[payment-reminder] nothing to send for collection ' + c.id);
          continue;
        }
        if (emailAllowed) {
          db.markReminderEmailSent(c.id);
          await notify.sendPaymentReminder(c, base);
        }
        // The WhatsApp half is a COLD DM to a buyer who never messaged the bot —
        // a reachout, and one of the actions that got the previous number banned.
        // It is therefore skipped entirely in invite_link mode (the safe default),
        // and in auto_add mode it still passes through the breaker + daily cap
        // inside whatsapp.sendMessage. The email above goes either way, so the
        // buyer is still reminded.
        if (waAllowed) {
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
  // Gallery derivatives (server/image-thumbs.js), once at boot:
  //   • sweepStale() reclaims the PREVIOUS revision's cached files. The revision
  //     is part of both the filename and the public URL, so bumping it would
  //     otherwise leave the old generation on the volume forever.
  //   • warm the source-dimension cache, so the first shopper's /api/design-images
  //     doesn't pay 74 header reads inline. Deferred + fire-and-forget: it is an
  //     optimisation, and a failure here must never affect boot.
  setTimeout(() => {
    try {
      imageThumbs.sweepStale();
      for (const p of designImages.collectImagePaths()) imageThumbs.dims(p.split('/').pop());
    } catch {
      /* the cache warms lazily instead */
    }
  }, 0).unref();
  // Hourly reminder scan, only when email is configured. unref() so the timer
  // never keeps the process alive on its own, and the scan is fire-and-forget.
  if (notify.isConfigured()) {
    const timer = setInterval(() => {
      runReminderScan().catch(() => {});
    }, REMINDER_SCAN_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }
  // Hourly owner-reminder-list scan (email + WhatsApp). Runs when EITHER channel
  // is available (email works without the bot); the per-reminder channels + the
  // engine gate what actually sends. unref() so it never keeps the process alive;
  // fire-and-forget so a failing pass can't crash it. Inside require.main so tests
  // never auto-start it.
  if (notify.isConfigured() || whatsapp.isConfigured()) {
    const remTimer = setInterval(() => {
      runReminderListScan().catch(() => {});
    }, WA_NUDGE_SCAN_INTERVAL_MS);
    if (remTimer.unref) remTimer.unref();
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
module.exports.runReminderListScan = runReminderListScan;
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
// Which pawn files the generator is handed for a collection (the cutout when we
// have one, the original otherwise) — exposed so the choice can be asserted
// directly instead of through a full generation run.
module.exports.pawnPhotoFiles = pawnPhotoFiles;
module.exports.orderArgs = orderArgs;
