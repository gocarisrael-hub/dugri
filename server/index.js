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
const tranzila = require('./tranzila');
const { createSweeper, positiveNumber } = require('./tranzila-sweep');
const { paymentClientIp } = require('./payment-client-ip');
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
const promo = require('./promo');
const wordlists = require('./wordlists');
const wordlistOptions = require('./wordlist-options');
const unsubscribe = require('./unsubscribe');
const sms = require('./sms');
// The courier that carries a delivery order's parcel.
const hfd = require('./hfd');
const pdfName = require('./pdf-name');
const wordBank = require('./word-bank');
// The print-shop pass over a finished deck (generator/press_marks.py).
const pressMarks = require('./press-marks');
const messagePreview = require('./message-preview');
const storeImport = require('./store-import');
const templateImport = require('./template-import');
const { makeRateLimiter, makePreviewCache } = require('./preview-cache');
const generatorProc = require('./generator-proc');
const proof = require('./proof');
const deckJobs = require('./deck-jobs');
// First-party ad attribution: which campaign produced which paid order.
const attribution = require('./attribution');
// The server's own copy of a sale, sent to Meta so a blocked browser cannot
// swallow it. Dormant with no META_CAPI_TOKEN.
const metaCapi = require('./meta-capi');
// What Meta knows that we cannot: what the ads COST.
const metaInsights = require('./meta-insights');
// Agent D's routes (server/routes/platform.js). Each block is registered below at
// the spot it used to occupy, so the route order is unchanged.
const platformRoutes = require('./routes/platform');
// Agent B's routes (server/routes/catalog.js), registered the same way.
const catalogRoutes = require('./routes/catalog');

const app = express();
// Behind Railway's proxy: trust X-Forwarded-For so req.ip is the real client
// address (used to rate-limit coupon validation per client, not per proxy).
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
// PeleCard posts its server-side callback as a urlencoded form; accept both.
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// NOTHING MAY CACHE A JSON ANSWER FROM THIS SERVER.
//
// The pages were built to be un-stale: the HTML ships `no-cache`, the modules
// are content-hashed and immutable, and Cloudflare reports DYNAMIC on every
// document. But every /api answer went out with NO cache directive at all —
// only a weak ETag. A response with no freshness information is not "don't
// cache me", it is "you decide", and the caches that decide are the ones we
// never see: in-app browsers (Instagram is where most of this shop's traffic
// comes from), carrier proxies, a webview restored from disk. That is how a
// shopper reloads the page, gets today's HTML, and still reads yesterday's
// price out of /api/pricing — the reload she was told would fix it does not
// touch a heuristically-fresh entry.
//
// These payloads are STATE, not assets: a price, a sale that has ended, which
// designs exist, what the owner rewrote a minute ago. There is no version of
// "slightly old" that is right for any of them, and they are all a few hundred
// bytes, so there is nothing to save by allowing it.
//
// Hooked on res.json rather than mounted as a blanket header, because /api also
// hands back FILES — template images, a produced PDF — and those genuinely
// should be cached. An endpoint that has already chosen its own Cache-Control
// keeps it.
app.use('/api', (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (!res.get('Cache-Control')) res.set('Cache-Control', 'no-store');
    return json(body);
  };
  next();
});

// Absolute base URL for the PeleCard return/callback URLs. We require an
// explicit PUBLIC_BASE_URL and never derive it from request headers: a spoofed
// Host header would otherwise redirect the payment callback to an attacker, so
// a real charge would never reach us. Returns null when unconfigured.
function paymentBaseUrl() {
  return process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : null;
}

// WHICH CARD PROVIDER OPENS NEW PAYMENTS. PeleCard, unless PAYMENT_PROVIDER is
// `tranzila` — set per Railway environment, so staging can take Tranzila while
// production stays on PeleCard until the owner switches it.
//
// Asking for Tranzila without its credentials turns card payment OFF rather than
// quietly falling back to PeleCard: a staging test that silently ran on the old
// provider would "pass" and prove nothing.
//
// Only NEW payments follow this. Both callbacks stay live whichever is chosen,
// so a window opened on one provider still settles after the switch.
function cardProvider() {
  const want = String(process.env.PAYMENT_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (want === 'tranzila') return tranzila.isConfigured() ? tranzila : null;
  return pelecard.isConfigured() ? pelecard : null;
}

// Every return/callback address a provider may need for one payment. Each
// provider reads its own: PeleCard the callback pair, Tranzila the notify URL,
// which carries this payment's token so the notify can be matched to it.
function paymentUrls(base, paramToken) {
  return {
    goodUrl: base + '/pay-done.html',
    errorUrl: base + '/pay-done.html?error=1',
    serverGoodUrl: base + '/api/payment/callback',
    serverErrorUrl: base + '/api/payment/callback?error=1',
    notifyUrl: base + '/api/payment/tranzila/notify?t=' + encodeURIComponent(paramToken),
  };
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
// Max multipart body for a pawn-images upload: PAWN_BATCH_MAX customer photos,
// each capped at ~4MB by the store (server/content.js IMAGE_CAP), plus envelope
// room — AND each photo travels with its background-removed cutout, a PNG of up
// to ~1024px that runs 1-3MB. Four 4MB originals with their cutouts is over 20MB,
// and the body parser rejecting the batch would lose the photos entirely, so the
// ceiling doubles. Nothing here relaxes the per-image cap, which the store still
// enforces file by file.
const PAWN_UPLOAD_LIMIT = process.env.PAWN_UPLOAD_LIMIT || '40mb';
// HOW MANY PHOTOS ONE REQUEST MAY CARRY — which is NOT how many a collection may
// hold. A deck is laid out for 4 to 16 players (db.playersFor) and holds one photo
// per player, but this body is buffered WHOLE in memory before anything looks at
// it, and POST /api/collections is public — anyone can mint a valid owner token
// and post. So the TOTAL follows the player count and the BATCH stays pinned to
// what PAWN_UPLOAD_LIMIT was sized for; a sixteen-player deck is filled by four
// requests, not by a 160MB one. Both clients (the wizard's uploadPawns, the
// collection page's addPawns) chunk to this number.
const PAWN_BATCH_MAX = 4;
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
// customer approved by five things at once:
//
//   * --photo   — the buyer's own pawn photos never reached the printed card, so
//                 the press sheet carried four generic pawns instead of her people;
//   * --field   — {AGE}/{YEARS} unsubstituted in the title;
//   * --gender  — {m:…|f:…} unresolved, so a girl's deck could print בן;
//   * --wordlist— a different seed pool, so DIFFERENT FILLER WORDS on the cards;
//   * --word-font — the face she picked, ignored.
//
// Adding five pushes to the press route would fix today and guarantee the next
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
  customTitle,
  wordlist,
  cardOrder,
  personalCount,
  gender,
  photos,
  photoFrames,
  photoCutouts,
  pawnCards,
  noTopup,
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
  // Custom title (F7): override the theme-derived title on the cards + board.
  // --title=<value> (single token) so a title that starts with '-' (e.g. "-40",
  // "-רווקות") is never parsed by argparse as an option and crash the generator.
  if (customTitle) args.push('--title=' + customTitle);
  // Seed-pool override for THIS order: which pool tops the deck up, replacing the
  // theme's own. `=`-joined for the same reason as --title. The name is validated
  // against the real pools before it is stored, and the generator's own path
  // guard bounds it to the two wordlist directories.
  if (wordlist) args.push('--wordlist=' + wordlist);
  // ...and the order that asked for NO filler at all. The deck is still the full
  // 104 cards; the ones her words do not reach print empty and numbered, for her
  // to write on. It is exclusive with the pool above by nature — there is nothing
  // to fill from when nothing is being filled — so it is passed alone, and her
  // stored pool pick is simply not asked for.
  if (noTopup) args.push('--no-topup');
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
  // How many PAWN cards this deck carries — one per four players. It comes
  // BEFORE the photos because it is what decides how many of them the deck has
  // room for. Omitted at the default so an order placed before the choice
  // existed produces byte-for-byte the argv it always did; the generator's own
  // default is the same one card.
  if (Number.isInteger(pawnCards) && pawnCards > 1) {
    args.push('--pawn-cards', String(pawnCards));
  }
  // The customer's pawn photos for those cards (v2 templates). A v1 theme
  // ignores them, so passing them is always safe. See pushPhotoArgs for how each
  // one's frame and cutout marker ride along with it.
  pushPhotoArgs(args, photos, photoFrames, photoCutouts);
  return args;
}

// THE PHOTO ARGUMENTS, EMITTED ONCE. Every flag here is POSITIONAL against its
// own `--photo` and the generator pairs them by walking the argv in order, so
// they have to be written together — the deck and the pawn-card preview each
// having their own copy of this loop is how a frame ended up on the wrong face
// (#595). A photo carries at most three things: the file, the frame the buyer
// set (omitted when she left it alone), and whether the file is her ORIGINAL
// rather than a cutout (omitted for a cutout, the normal case). Both omissions
// keep an older order's argv byte-for-byte what it always was.
function pushPhotoArgs(args, photos, photoFrames, photoCutouts) {
  const frames = photoFrames || [];
  const cuts = photoCutouts || [];
  (photos || []).forEach((photo, i) => {
    args.push('--photo', photo);
    if (frames[i]) args.push('--photo-frame=' + frames[i]);
    // `cuts[i] === false` and not `!cuts[i]`: an ABSENT entry means "a cutout,
    // as it always was", which is what every caller that predates this passes.
    if (cuts[i] === false) args.push('--photo-original');
  });
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
//
// …unless the BUYER asked for her background (pawn_view[path].bg), which is a
// choice and not a miss: some photos are the place as much as the person, and
// she has seen exactly what it looks like on her collection page. The original
// then goes to the printer deliberately, and build.square_photo rounds it into
// the slot's disc — a photo never prints as a rectangle whatever we send.
function pawnPhotoEntries(collection) {
  const paths = Array.isArray(collection && collection.pawn_images) ? collection.pawn_images : [];
  const cuts =
    collection && collection.pawn_cutouts && typeof collection.pawn_cutouts === 'object'
      ? collection.pawn_cutouts
      : {};
  const views =
    collection && collection.pawn_view && typeof collection.pawn_view === 'object'
      ? collection.pawn_view
      : {};
  const out = [];
  for (const p of paths) {
    const original = uploadFileFor(p);
    if (!original) continue;
    const view = views[p] || null;
    const cutPath = Object.prototype.hasOwnProperty.call(cuts, p) ? cuts[p] : null;
    const cutFile = view && view.bg ? null : uploadFileFor(cutPath);
    const file = cutFile || original;
    // WHICH of the two we picked, said out loud. The generator frames a cutout
    // on its silhouette and an original on the plain square — the same fork her
    // collection page takes when it draws the pawn (site/collect.html
    // `measureFrame`) — so it has to know which file this is. It used to sniff
    // the file's alpha instead, and an ORIGINAL that carries alpha (an already
    // transparent PNG, kept by a buyer who ticked "keep my background") was
    // framed one way on the page and another way by the printer.
    out.push({ file, view, cut: !!cutFile });
  }
  // As many as the deck has slots — four per pawn card. Photos past that are
  // KEPT on the collection and simply not printed, which is why this slices
  // rather than the store trimming: a buyer who uploaded sixteen and then moved
  // the slider back to four prints the first four and still has the other twelve
  // if she changes her mind. Both writers (handlePawnUpload, db.addPawnImages)
  // cap at the CURRENT count, so a list longer than this one is always the
  // residue of a count that has since come down.
  return out.slice(0, db.playersFor(collection));
}

// The two halves of that answer, as PARALLEL arrays — the generator takes one
// `--photo` and one optional `--photo-frame` per slot, and they only line up
// because both are derived from the same entry list (a photo whose file vanished
// drops out of BOTH or the frames slide onto the wrong faces).
function pawnPhotoFiles(collection) {
  return pawnPhotoEntries(collection).map((e) => e.file);
}
function pawnPhotoFrames(collection) {
  return pawnPhotoEntries(collection).map((e) => photoFrameArg(e.view));
}
// …and whether each of those files is the CUTOUT. Same list, same order, same
// reason they are derived together: a flag that slid onto the next photo would
// frame the wrong face.
function pawnPhotoCutouts(collection) {
  return pawnPhotoEntries(collection).map((e) => e.cut);
}

// The generator's `--photo-frame` value for one photo, or null when the buyer
// never moved it and the automatic framing should stand. Kept as a separate
// helper so "the default view is the same as no view" is stated once.
function photoFrameArg(view) {
  if (!view) return null;
  const zoom = Number(view.zoom);
  const dx = Number(view.dx);
  const dy = Number(view.dy);
  const z = Number.isFinite(zoom) ? zoom : 1;
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  if (z === 1 && x === 0 && y === 0) return null;
  return `${z},${x},${y}`;
}

function runGenerator({
  theme,
  name,
  words,
  outPdf,
  wordFont,
  extraFields,
  customTitle,
  photos,
  photoFrames,
  photoCutouts,
  pawnCards,
  gender,
  wordlist,
  cardOrder,
  personalCount,
  noTopup,
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
      customTitle,
      wordlist,
      cardOrder,
      personalCount,
      gender,
      photos,
      photoFrames,
      photoCutouts,
      pawnCards,
      noTopup,
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
const PICKUP_STICKERS_SCRIPT = path.join(REPO_ROOT, 'generator', 'pickup_stickers.py');
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
// THE PAWN CARD GETS ITS OWN, and does not share the one above.
//
// It used to. The two are both previews and bounding them once was the tidier
// story — until the pawn card started carrying the ORDER TITLE, which put the
// title in its key and made the cached card PER ORDER instead of per (design,
// disc count). Before that, every buyer on a design shared at most five entries
// between them; now each order claims its own five, and five orders being edited
// at once would evict a 40-slot cache that the public name-preview is also
// filling. Everything a buyer dragging her pawns does — every change to how many
// discs she covers — would go back to being a fresh Chrome render, on a path that
// is already unhappy at two concurrent ones.
//
// So: its own bound, sized for what it now holds (five disc counts x a dozen
// orders in flight), and no cross-eviction in either direction — a flood of pawn
// cards cannot cost the storefront its previews, and a rush of previews cannot
// cost a buyer the card she is dragging photos onto. Each entry here is ONE card
// PNG, where a preview entry is three (card + board + back), so this is a smaller
// footprint per slot than the number suggests.
const pawnCardCache = makePreviewCache({
  max: Number(process.env.PAWN_CARD_CACHE_MAX || 60),
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

// Spawn ONE preview.py run for the buyer's PHOTO CARD and resolve it as a PNG
// data URL. The pawn card is a card like any other — it prints on the front
// card's paper, cut to the deck's frame — so the only honest way to show her
// what her photos will look like is to render the real thing; the generator
// composes it through the same helper the deck does. Nothing else is rendered:
// no front, no back, no board.
// THE PAWN CARD PREVIEW'S ARGV, built the way orderArgs builds the deck's.
//
// Pure and exported for the same reason orderArgs is: this is the second place
// that emits `--photo` / `--photo-frame`, the two lists have to stay paired
// (#595 — a frame that lands on the wrong face prints the wrong face), and the
// only way to assert a spawn's arguments without spawning is to build them
// somewhere a test can call.
//
// The card this renders IS the card the deck prints, so everything the deck's
// photo card depends on is passed here too — the photos, their frames, and now
// the ORDER TITLE, which the pawn card carries under the pawns like every other
// card carries it.
function pawnCardArgs({
  theme,
  outDir,
  photos,
  photoFrames,
  photoCutouts,
  empty = false,
  drawn = 0,
  name = '',
  extraFields,
  customTitle,
  gender,
}) {
  // The name is no longer a placeholder: the pawn card sets a title now, so the
  // title arguments are resolved here exactly as the deck resolves them. A
  // caller that passes none gets the card as it printed before the title
  // existed, which is what an un-named collection should show.
  const args = [PREVIEW_SCRIPT, theme, name || '', outDir, '--pawn-card'];
  for (const [k, v] of Object.entries(extraFields || {})) {
    args.push('--field', `${k}=${v}`);
  }
  // `=`-joined for the same reason orderArgs joins it: a title starting with
  // '-' must never be read by argparse as an option.
  if (customTitle) args.push('--title=' + customTitle);
  if (gender === 'male' || gender === 'female') args.push('--gender', gender);
  // EMPTY: the card as the design ships it, WITHOUT her photos, plus where the
  // discs are. The browser lays her photos onto it — which is what lets the
  // card move under her finger instead of a second behind it.
  //
  // `drawn` is how many discs it will cover, and the render fills the REST with
  // the shipped Dugri pawns, exactly as the printed card tops itself up. Leaving
  // them bare showed her an empty circle where a pawn prints, under a caption
  // promising this is exactly what will be printed. It is one more cache
  // dimension, and a small one: 0..4 per theme, and a card that changes only
  // when the number of photos does.
  if (empty) args.push('--no-photos', '--drawn', String(drawn));
  // Photos, frames and cutout markers, emitted by the SAME helper the deck run
  // uses — this preview only earns its place by being the same picture the
  // printer makes, and a preview that framed differently would be the one thing
  // worse than no preview: believed.
  pushPhotoArgs(args, photos, photoFrames, photoCutouts);
  return args;
}

function runPawnCard({
  theme,
  photos,
  photoFrames,
  photoCutouts,
  empty = false,
  drawn = 0,
  name = '',
  extraFields,
  customTitle,
  gender,
}) {
  return new Promise((resolve, reject) => {
    let outDir;
    try {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawns-'));
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
    const args = pawnCardArgs({
      theme,
      outDir,
      photos,
      photoFrames,
      photoCutouts,
      empty,
      drawn,
      name,
      extraFields,
      customTitle,
      gender,
    });
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
        return reject(new Error('pawn card render timed out'));
      }
      if (code !== 0) {
        cleanup();
        return reject(new Error((stderr || stdout || 'exit ' + code).trim().slice(0, 800)));
      }
      // A run that SUCCEEDED can still have degraded: build.square_photo falls
      // back to the untouched original when it cannot frame a photo, which prints
      // it as a rectangle, and it says so on stderr. Dropping stderr on exit 0
      // meant the only trace of that was the card itself — and a card is only
      // wrong once someone looks at it closely.
      if (stderr.trim()) console.warn('pawn card render warned:', stderr.trim().slice(0, 800));
      try {
        const produced = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        const file = produced.pawns;
        if (!file || !fs.existsSync(file)) {
          cleanup();
          return reject(new Error('pawn card render produced no image'));
        }
        const url = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
        const slots = Array.isArray(produced.slots) ? produced.slots : null;
        cleanup();
        resolve(slots ? { card: url, slots } : { card: url });
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
    // Whether online card payment is available (the chosen provider has its
    // credentials). Lets collect.html show the credit-card button only when it
    // will work.
    card_enabled: !!cardProvider(),
    // HOW THIS DECK IS SPLIT — how many players it is laid out for, how many
    // pawn cards that is, and what is left for words. PUBLIC, not owner-only:
    // the word counter is the same counter for every contributor, and a friend
    // adding words has to be told the same ceiling the owner is.
    //
    // The arithmetic is served rather than repeated in the browser because the
    // server is what enforces it (db.deckWordsFor) — a copy in the page is a
    // copy that can promise room the deck does not have.
    players: db.playersFor(c),
    pawn_cards: db.pawnCardsFor(c),
    deck_words: db.deckWordsFor(c),
    // The buyer's own pawn photos, so she can see what she sent and change it
    // from her collection page — the wizard step that took them is behind her by
    // then, and she had no way back to it.
    //
    // OWNER ONLY, and this one is not a nicety: they are photographs of her
    // people, while the collection LINK is meant to be forwarded to everyone at
    // the party. A contributor gets no hint that they exist.
    ...(owner
      ? {
          pawn_images: Array.isArray(c.pawn_images) ? [...c.pawn_images] : [],
          // …and, per photo, the CUTOUT we hold for it (or null when a cut was
          // tried and missed) plus how she placed it in its circle. The photo tab
          // draws the pawn the printer will draw, and it cannot do that from the
          // original alone: the frame is measured off the cutout's alpha, and the
          // placement is hers.
          pawn_cutouts:
            c.pawn_cutouts && typeof c.pawn_cutouts === 'object' ? { ...c.pawn_cutouts } : {},
          pawn_view: c.pawn_view && typeof c.pawn_view === 'object' ? { ...c.pawn_view } : {},
          // …and the title she chose, so the same sheet can show and change it.
          // null means she never set one and the theme's own title is printed.
          custom_title: c.custom_title || null,
          // Which entry of the owner's buyer-facing pool menu this order is on,
          // by OPTION ID — never the pool's file name, which is a production
          // detail she is not choosing and has no use for. null = no pick, so the
          // deck fills the way her design says.
          // Which row of the pool menu this order is on — including the row
          // that says "don't fill it at all", which stores no pool.
          wordlist_option: optionIdForCollection(c),
          // ...and that same answer as the bare fact production reads: the rest
          // of the deck is printed EMPTY rather than filled with our words.
          no_topup: !!c.no_topup,
          // Can she still add door-to-door delivery to an order she has already
          // paid for, and what would it cost? Computed by the store (one place,
          // so the offer on screen and the charge behind it cannot disagree) and
          // owner-only, like the order it is about.
          shipping_upgrade: db.shippingUpgrade(c.id),
        }
      : {}),
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
    // Words the free quota refused and we are holding for release on payment.
    // Sent to EVERY viewer of the collect link, exactly like the word list, and
    // deliberately as the words themselves rather than a number: the page shows
    // them so the buyer can SEE what has not been added instead of being asked to
    // believe a reassuring sentence. The old lock copy promised "all the words you
    // collected are saved" while silently dropping the overflow, which is how a
    // 150-word paste became 15 words and a paid order. Proof, not a promise.
    //
    // NOT added to `count`, and never mixed into `words` — the counter, the CSV
    // and the generator must keep seeing only what has actually been bought.
    held_words: db.listHeldWords(c.id).map((w) => ({
      id: w.id,
      text: w.text,
      added_by: w.added_by,
      created_at: w.created_at,
    })),
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

// The wizard's report of HOW THIS BUYER ARRIVED: two raw strings, capped here and
// parsed on our server into the touch to freeze on the order. Null for anything
// that is not a plain object — a string, an array — and null too when the parse
// found no evidence at all, because the arrival is first-write-wins and beats the
// landing at purchase time, so an empty report must not be allowed to outrank the
// real touch the paying browser still carries (see attribution.arrivalTouch).
function arrivalFromBody(arrival) {
  if (!arrival || typeof arrival !== 'object' || Array.isArray(arrival)) return null;
  return attribution.arrivalTouch({
    landing: String(arrival.landing || '').slice(0, 2000),
    referrer: String(arrival.referrer || '').slice(0, 500),
  });
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
    // How this buyer arrived, kept on the order (Agent A — attribution). The sale
    // is then credited to it even when she pays later from another device. RAW
    // STRINGS in, parsed on our server: a caller can put utm_source in the landing
    // it reports and see it read back — exactly as it can through /api/track, so
    // this is no new opening — but it cannot hand over a ready-made { source: … }
    // and skip the parse, and the URL itself is never stored (it can carry the
    // order's owner token). Null when the parse found nothing; passed in here
    // rather than written after, so the one saveDb createCollection already does
    // carries it — saveDb serialises the whole store.
    arrival: arrivalFromBody(b.arrival),
    // How many players her deck is laid out for — one pawn card per four, and
    // each pawn card costs a word card. Chosen on the wizard's pawns step, so it
    // arrives with the order and her word ceiling is right from the first word.
    // db.createCollection coerces it (4-16, stepped by four; anything else is
    // the standard deck).
    players: b.players,
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
// A SECOND key, for someone who works on the orders but is not the owner.
// Unset (the default) means there is no staff key and nothing below changes:
// one key, full access, exactly as before.
//
// It is refused when it equals the owner's key — a copy-paste that would
// silently hand the owner's key out as the worker's, granting everything while
// looking like a restriction. Better to have no staff key than a fake one.
const STAFF_KEY =
  process.env.STAFF_KEY && process.env.STAFF_KEY !== ADMIN_KEY ? process.env.STAFF_KEY : null;

// Constant-time compare against a known key. Length is compared first because
// timingSafeEqual throws on a length mismatch — and the length of a secret is
// not the secret.
function keyMatches(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function adminKeyOk(provided) {
  return keyMatches(provided, ADMIN_KEY);
}
// 'owner' | 'staff' | null. The owner's key is checked first, so a STAFF_KEY
// that somehow equals it could never downgrade the owner.
function adminRole(provided) {
  if (adminKeyOk(provided)) return 'owner';
  if (keyMatches(provided, STAFF_KEY)) return 'staff';
  return null;
}

// WHAT THE STAFF KEY MAY TOUCH — an allowlist, deliberately, not a blocklist.
// A blocklist is wrong by default: the next money route somebody adds would be
// open to the worker until someone remembered to add it here. With an allowlist
// the same mistake fails closed, which is the direction a mistake should fail.
//
// These are exactly the endpoints the two pages she is meant to use actually
// call — ניהול הזמנות (admin.html) and עורך הטיפוגרפיה (admin-bench.html),
// read off those two files rather than guessed.
const STAFF_ALLOWED = [
  /^\/api\/admin\/collections(\/|$)/,
  /^\/api\/admin\/designs(\/|$)/,
  /^\/api\/admin\/hfd\/status$/,
  /^\/api\/admin\/pickup-stickers$/,
  /^\/api\/admin\/stickers$/,
  /^\/api\/admin\/templates(\/|$)/,
  /^\/api\/admin\/whatsapp\/groups(\/|$)/,
  /^\/api\/admin\/wordlists(\/|$)/,
  /^\/api\/admin\/whoami$/,
];

// …minus the money that lives INSIDE an allowed prefix. Creating a bespoke
// order mints a 599 ₪ charge and a payment link, which is the owner's business
// however much it looks like an order operation.
const STAFF_DENIED = [/^\/api\/admin\/collections\/[^/]+\/custom$/];

// Match against a NORMALISED path, because Express does not route on the exact
// bytes: with the default settings `/CUSTOM` and `/custom/` both reach the
// handler registered as `/custom`. A case-sensitive, `$`-anchored deny pattern
// therefore missed them while the allow prefix still matched, and the staff key
// could mint a 599 ₪ bespoke order by capitalising a letter. Verified against a
// real collection before the fix: `/custom` 403, `/CUSTOM` 200 with an order in
// the response.
//
// Lowercasing is safe here — every pattern is an all-lowercase literal — and the
// trailing slash goes for the same reason Express ignores it. Order matters: the
// deny list is consulted on the same normalised string as the allow list, so a
// carve-out cannot be stepped around by a spelling the router accepts.
function normalizeAdminPath(pathname) {
  const lowered = String(pathname || '').toLowerCase();
  const trimmed = lowered.replace(/\/+$/, '');
  return trimmed || '/';
}

function staffMayReach(pathname) {
  const p = normalizeAdminPath(pathname);
  if (STAFF_DENIED.some((re) => re.test(p))) return false;
  return STAFF_ALLOWED.some((re) => re.test(p));
}

// Shared admin guard: sends the 503/403 response and returns false when the
// request is not an authorized admin; returns true to proceed.
//
// Every admin route already funnels through here, so the staff scope is enforced
// in ONE place. A new route is therefore closed to staff the moment it exists,
// without anyone having to remember this file.
function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ error: 'admin disabled: set ADMIN_KEY' });
    return false;
  }
  const role = adminRole(req.query.key);
  if (!role) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  if (role === 'staff' && !staffMayReach(req.path)) {
    // Named apart from a wrong key on purpose: the worker's key IS valid, and a
    // page that says "wrong key" would send her hunting for a better one.
    res.status(403).json({ error: 'forbidden', reason: 'staff' });
    return false;
  }
  req.adminRole = role;
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

// WHO AM I — the role behind the key in the URL, so an admin page can lay itself
// out for the person holding it rather than offering links that will 403. This is
// presentation only: the scope itself is enforced in requireAdmin, on every
// request, and hiding a link has never stopped anyone typing a URL.
app.get('/api/admin/whoami', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ role: req.adminRole, staff_enabled: !!STAFF_KEY });
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

// Admin: EDIT an order's stored choices after the fact. The customer settles the
// details with the owner on WhatsApp AFTER checking out ("make it their 40th",
// "switch me to pickup", "here's my address"), and the owner corrects the order
// here rather than asking the customer to re-run the wizard.
//
// Body: any subset of the collection fields (honoree_name, email, phone, design,
// color, theme, extra_fields, word_font, gender, custom_title, buyer_name,
// event_type, comment, owner_note) plus an optional
// `order: { version, address }` for the fulfilment choice. Absent keys are left
// untouched.
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

// Agent D: the playbook routes, in server/routes/platform.js.
platformRoutes.registerPlaybook(app, { requireAdmin, playbook });

// Agent B: the admin design catalog, in server/routes/catalog.js.
catalogRoutes.registerAdminDesigns(app, {
  requireAdmin,
  path,
  __dirname,
  TEMPLATE_ROOT,
  designCatalog,
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

// PRODUCE ONE DECK — the machinery behind every produce button there is.
//
// Lifted out of the admin route unchanged so the BUYER's סיום can run exactly
// the same production the owner's "צור PDF" runs: same theme resolution, same
// word bank, same pre-production validation, same generator spawn, same press
// pass, same db.setProduction — which is the call that mints `pdf_token`, and so
// the only thing that can make a proof link exist. Two code paths producing two
// slightly different decks is the drift this project has already paid for; there
// is one path.
//
// Answers in three ways, and they are not interchangeable:
//   * { refuse: { status, body } } — the caller has to fix something (no theme,
//     no words, an unknown theme, a failed pre-production check). Nothing was
//     rendered and nothing was spent.
//   * throws — the generator itself failed. generatorStatus() maps the message.
//   * { production, boardFile } — the deck is on disk and recorded.
//
// opts.notifyOnError: whether a validation refusal also MAILS the customer what
// to fix. True for the owner pressing produce (she is acting on the order and
// the mail is the handover); false for the buyer's automatic run, where the mail
// would arrive seconds after her own "we're producing" mail and contradict it.
async function produceDeck(c, b, opts = {}) {
  const refuse = (status, body) => ({ refuse: { status, body } });
  // One-click production: fall back to the collection's STORED resolved theme
  // (db sets `theme` from the design the buyer chose) so the admin button can
  // post an empty body. An explicit body theme still wins, so re-generating onto
  // a different template stays possible. Neither present is still a 400 — every
  // downstream check (unknown theme, then the validate.js pre-production checks)
  // runs on the resolved key exactly as before.
  const theme = String(b.theme || c.theme || '').trim();
  if (!theme) return refuse(400, { error: 'theme required' });
  // The APPROVED BANK when this order has one, the buyer's own words otherwise.
  // A frozen bank is already a full deck, and topup keeps every word it is given
  // and only fills a shortfall — so handing it over prints the approved list
  // exactly, with no change to the generator at all. (server/word-bank.js)
  const words = wordBank.wordsForProduction(
    c,
    db.listWords(c.id).map((w) => w.text)
  );
  if (!words.length) return refuse(400, { error: 'no words to generate' });

  // Reject an unknown theme up front. An unknown key makes getTheme() null, which
  // makes validateOrderForProduction skip every theme-specific check (name
  // language, required extra fields) and still spawn the generator — so a bad
  // theme must fail fast here, before any validation is trusted or Chrome runs.
  const themeConfig = validate.getTheme(theme);
  if (!themeConfig) return refuse(400, { error: 'unknown theme' });

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
    if (opts.notifyOnError !== false && notify.isConfigured()) {
      notify.sendProductionError({ ...c, count: words.length }, base, problems).catch(() => {});
    }
    return refuse(400, { error: 'validation failed', problems, production });
  }

  // Use the stored (validated) id — never the raw param — for the output path.
  const outPdf = path.join(GENERATED_DIR, c.id + '.pdf');

  const { pages, smallCards } = await runGenerator({
    theme,
    name: c.honoree_name || '',
    words,
    outPdf,
    wordFont,
    extraFields,
    customTitle: c.custom_title || null,
    photos: pawnPhotoFiles(c),
    // …each with the frame the buyer set for it on her collection page, in the
    // same order (both come off pawnPhotoEntries).
    photoFrames: pawnPhotoFrames(c),
    // …and which of those files are cutouts, because that is what the automatic
    // framing keys off — on the page she approved it on, and now here.
    photoCutouts: pawnPhotoCutouts(c),
    // How many PAWN cards this deck prints — one per four players. The deck is
    // always 104 cards, so this is also what decides how many word cards are
    // left and how far the top-up fills.
    pawnCards: db.pawnCardsFor(c),
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
    // ...unless she asked us not to fill the deck at all. Her words print, the
    // rest of the deck prints empty and numbered, and the pool above is simply
    // never read (db.setNoTopupForOwner).
    noTopup: !!c.no_topup,
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
  return { production, boardFile };
}

app.post('/api/admin/collections/:id/generate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  try {
    const out = await produceDeck(c, req.body || {}, { notifyOnError: true });
    if (out.refuse) return res.status(out.refuse.status).json(out.refuse.body);
    // PRESSING צור PDF IS ITSELF THE DELIBERATE ACT. The owner building a deck
    // by hand is her saying it should go, so it is released in the same breath
    // and this button behaves exactly as it did before #542. Only the BUYER's
    // סיום now leaves a finished deck waiting in "נסגרו — להפקה" for her.
    const { boardFile } = out;
    const production = db.setProductionReleased(c.id, true) || out.production;
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
    // The PROOF link, on the same capability token: the page where the customer
    // reads her own deck before it goes to the shop. Handed back with the other
    // customer link rather than mailed — production is hand-pressed, and the
    // owner decides when an order is worth a proof.
    const customerProofLink =
      base && deckProofOn() && production && production.pdf_token
        ? base + '/proof.html?c=' + c.id + '&t=' + encodeURIComponent(production.pdf_token)
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
      customerProofLink,
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

// Admin: UNDO a production run — "בטל הפקה".
//
// An order lands in "הופקו — לשליחה לדפוס" because a PDF exists, and until now
// nothing could take it back out: the stage is computed from the production
// record, and only the generate route ever wrote one. Reopening the word list
// does not do it either (that stage checks whether a file was built, not whether
// the list is open), so an order produced too early, or produced from the wrong
// words, was stuck in the print queue.
//
// This clears the record AND removes the files it refers to. Both, deliberately:
// the /pdf routes serve whatever is on disk without consulting the record, so a
// cleared record beside a surviving file is a deck the shop could still be sent
// — the exact stale-copy failure pressUnlink already exists to prevent.
//
// REFUSED once the order has been stamped as sent to the printer or ready. By
// then the deck is out of our hands and un-producing it would only make the
// dashboard disagree with the world; the stamps come off first, newest first,
// exactly as the two stamp toggles already require of each other. 409, so a
// stale tab cannot get past it either.
app.delete('/api/admin/collections/:id/production', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const order = c.order || null;
  if (order && (order.sent_to_print_at || order.ready_at)) {
    return res.status(409).json({
      error: 'stamped',
      detail: order.ready_at
        ? 'ההזמנה סומנה כמוכנה — בטלו קודם את "מוכן" ואת "בדפוס"'
        : 'ההזמנה סומנה כנשלחה לדפוס — בטלו קודם את "בדפוס"',
    });
  }
  const prev = db.clearProduction(c.id);
  if (prev === false) return res.status(404).json({ error: 'not found' });
  if (prev === null) return res.status(409).json({ error: 'not produced' });
  // The deck, the board and both press artifacts. Best-effort by design: a file
  // that was already gone is the state we wanted, and a failed unlink must not
  // leave the record un-cleared — the record is what the dashboard reads.
  const press = pressPaths(c.id);
  const board = boardFileFor(c.id);
  // The proof reads the deck, so it goes when the deck does.
  proof.remove(GENERATED_DIR, c.id);
  pressUnlink(
    path.join(GENERATED_DIR, c.id + '.pdf'),
    ...(board ? [board] : []),
    press.pdf,
    press.partial,
    press.err
  );
  res.json({ ok: true, cleared: prev });
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

// Admin: open the customer's PROOF page for this order. A redirect, not a copy
// of the page: the owner clicks and lands on the very screen the customer gets,
// token and all, so "what does she see?" is never a question answered from
// memory. The admin key gets you the redirect; the token in it is what the
// buyer's link carries.
app.get('/api/admin/collections/:id/proof', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const production = (c.order && c.order.production) || c.production || null;
  const token = production && production.pdf_token;
  // No token means the order was never produced — there is no deck to proof.
  if (!token) return res.status(409).json({ error: 'not produced' });
  // The admin key rides along to the page. The proof endpoints accept it in
  // place of the flag, so the owner can still read a deck she has hidden from
  // buyers; the key is already in this request's own URL, so forwarding it
  // exposes nothing that was not exposed a redirect ago.
  res.redirect(
    '/proof.html?c=' +
      encodeURIComponent(c.id) +
      '&t=' +
      encodeURIComponent(token) +
      '&key=' +
      encodeURIComponent(String(req.query.key || ''))
  );
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

// --- The PROOF ------------------------------------------------------------
// Is the buyer's proof switched ON? An owner flag (admin → פיצ׳רים), read at
// request time so flipping it takes effect on the next click, with no restart
// and no redeploy. Compared against `false` rather than to `true` so anything
// unreadable keeps the SHIPPED behaviour: a corrupt override may not silently
// take a live feature away from every buyer.
function deckProofOn() {
  return settings.get('features', 'deck_proof') !== false;
}

// The gate the two public proof routes share. The owner's own admin key passes
// even when the flag is off — she hid the proof from BUYERS, and hiding it from
// herself would take away the last look at a deck before it goes to the shop.
function proofGate(req, res) {
  if (deckProofOn()) return true;
  if (adminKeyOk(req.query.key)) return true;
  // 403 with a reason of its own: proof.js tells "switched off" apart from "bad
  // token" by this body, and the two owe the buyer completely different lines.
  res.status(403).json({ error: 'off' });
  return false;
}

// PUBLIC, on the same per-collection capability token as the deck and the board:
// one order, one secret, now three artifacts. The buyer gets to READ her deck
// before it is printed — every card, front and back, as pages out of the produced
// PDF rather than a second drawing of it. server/proof.js has the reasoning.
app.get('/api/collections/:id/proof', async (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const production = (c.order && c.order.production) || c.production || null;
  const token = production && production.pdf_token;
  if (!pdfTokenOk(req.query.t, token)) return res.status(403).json({ error: 'forbidden' });
  if (!proofGate(req, res)) return;
  try {
    const manifest = await proof.ensure({
      generatedDir: GENERATED_DIR,
      id: c.id,
      python: PYTHON_BIN,
      repoRoot: REPO_ROOT,
    });
    // No cache: the deck can be re-produced under a buyer who left the tab open,
    // and the manifest is how she'd find out.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ pages: manifest.pages, width: manifest.width, name: c.honoree_name || '' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // "no pdf" is not an error the buyer caused: her order simply isn't produced
    // yet, and the page says so rather than showing her a failure.
    if (msg === 'no pdf') return res.status(404).json({ error: 'no pdf' });
    console.error('proof build failed', c.id, msg);
    res.status(500).json({ error: 'proof failed' });
  }
});

// One page of the proof. The page number is validated against the manifest and
// then rebuilt from digits, so nothing off the URL reaches the filesystem.
app.get('/api/collections/:id/proof/:n', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const production = (c.order && c.order.production) || c.production || null;
  const token = production && production.pdf_token;
  if (!pdfTokenOk(req.query.t, token)) return res.status(403).json({ error: 'forbidden' });
  if (!proofGate(req, res)) return;
  const manifest = proof.readFresh(GENERATED_DIR, c.id);
  if (!manifest) return res.status(404).json({ error: 'no proof' });
  const file = proof.pageFile(GENERATED_DIR, c.id, req.params.n, manifest);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no page' });
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Immutable for an hour: a page only changes when the deck is re-produced, and
  // that rebuilds the whole proof directory under a fresh manifest.
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
});

// --- PRODUCTION ON סיום ----------------------------------------------------
//
// She presses סיום and the deck is rendered THEN, so the next thing she sees is
// her own cards instead of a thank-you note. Two routes, both gated on the
// collection's owner_token — the same secret the close itself is posted with, so
// finishing an order never needs the admin key:
//
//   POST /produce  starts a render (or joins the one already going) and answers
//                  immediately: 202 while it runs, 503 when the box is full.
//   GET  /produce  is what the waiting screen polls. Cheap by construction — a
//                  store read and a Map lookup, no filesystem walk beyond one
//                  existsSync, no work scheduled.
//
// IT DOES NOT BLOCK FOR THE RENDER. A deck is 20-50s of headless Chrome and
// GENERATE_TIMEOUT_MS allows two minutes; holding a request open that long is a
// connection a phone browser will drop on a lock-screen, and a dropped
// connection would leave the buyer with no way to learn how it ended. Kick off,
// then poll.
//
// WHAT PROTECTS THE BOX is server/deck-jobs.js: one render per collection ever
// (so a double-tap or a reload joins rather than starts), two concurrent renders
// across all buyers, four more allowed to wait, and an honest "busy" past that.
// The owner's admin produce is deliberately NOT routed through the queue — it is
// one person acting on one order and must never be told to wait behind buyers.

function deckOnDisk(id) {
  try {
    return fs.existsSync(path.join(GENERATED_DIR, id + '.pdf'));
  } catch {
    return false;
  }
}

// Where an order stands, in the words the waiting screen needs.
//
// 'ready' comes off the ORDER, never off the job: a produced deck stays produced
// across a restart, and a buyer who reopens the tab an hour later must still be
// sent to her cards. The job only explains the states before that.
function produceState(c) {
  const production = (c.order && c.order.production) || c.production || null;
  const token = production && production.pdf_token;
  if (production && production.state === 'generated' && token && deckOnDisk(c.id)) {
    // 'ready' is a fact about the DECK, so it stands whether or not she may look
    // at it — only the link is withheld when the proof is switched off. That is
    // exactly what collect.html reads: ready with no proof_url ends the wait on
    // the calm "המשחק בהפקה" note instead of navigating to a page that would
    // refuse her.
    const ready = { state: 'ready', pages: production.pages || null };
    if (deckProofOn()) {
      ready.proof_url =
        '/proof.html?c=' + encodeURIComponent(c.id) + '&t=' + encodeURIComponent(token);
    }
    return ready;
  }
  const job = deckJobs.get(c.id);
  if (job && (job.state === 'running' || job.state === 'queued')) return { state: job.state };
  if (job && job.state === 'error') return { state: 'error' };
  return { state: 'idle' };
}

// How many cards she is waiting for, so the screen can say a number instead of
// "please wait". From the SAME list production will print — the frozen bank when
// there is one — at the deck's four words per card, PLUS the pawn cards, which
// are printed cards too and which she is watching Chrome render like any other.
// Counting only the words said 103 for the standard 104-card deck, and would
// have gone on saying 103 for the 16-player one. An estimate, and treated as
// one: null when it cannot be worked out, and the screen drops the number.
function cardEstimate(c) {
  try {
    const words = wordBank.wordsForProduction(
      c,
      db.listWords(c.id).map((w) => w.text)
    );
    return words.length ? Math.ceil(words.length / 4) + db.pawnCardsFor(c) : null;
  } catch {
    return null;
  }
}

app.post('/api/collections/:id/produce', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const token = req.body && req.body.owner_token;
  if (!c.owner_token || c.owner_token !== token)
    return res.status(403).json({ error: 'forbidden' });
  res.setHeader('Cache-Control', 'no-store');

  // Already produced: a second tap, or a reload after it finished. Hand back the
  // proof rather than rendering the same deck again.
  const already = produceState(c);
  if (already.state === 'ready') return res.json(already);

  // CLOSED FIRST, always. The close route is what freezes the word bank, and the
  // deck has to be rendered from the frozen list rather than one still being
  // typed into. It is also the rate limit that matters: closing is a one-way
  // transition, so no buyer can ask for render after render.
  if (c.status !== 'closed') return res.status(409).json({ error: 'open' });

  // AND PAID. The proof shows every card in the deck, which is the product — an
  // unpaid order that produced one would be giving it away. The pre-payment
  // "מספיק! סיימנו לאסוף" therefore closes exactly as it always did and renders
  // nothing; it is the post-payment "סיום - התחילו להפיק" that produces. This is
  // one condition, and the owner can drop it if she'd rather every close render.
  if (!(c.order && c.order.paid)) return res.status(409).json({ error: 'unpaid' });

  const job = deckJobs.start(c.id, async () => {
    // Re-read: the job may have sat in the queue for a minute, and the words,
    // the title and the frozen bank are all read at render time.
    const fresh = db.getCollection(c.id);
    if (!fresh) throw new Error('collection vanished');
    const out = await produceDeck(fresh, {}, { notifyOnError: false });
    if (out.refuse) throw new Error((out.refuse.body && out.refuse.body.error) || 'refused');
    // …and rasterise the proof while she is still on the waiting screen. Best
    // effort, and never a reason to fail the job: the deck is produced either
    // way, and proof.html builds it on arrival if this did not. What it buys is
    // that her page JOINS this build (proof.js is single-flight per collection)
    // instead of starting its own seven seconds after we told her it was ready.
    // Skipped outright when the buyer's proof is switched off. Rasterising a
    // whole deck is the most expensive thing this job does, and with the proof
    // hidden there is nobody on the other end of the pages.
    if (deckProofOn()) {
      await proof
        .ensure({
          generatedDir: GENERATED_DIR,
          id: fresh.id,
          python: PYTHON_BIN,
          repoRoot: REPO_ROOT,
        })
        .catch(() => {});
    }
  });
  if (job.state === 'busy') {
    // Nothing was started and nothing was queued — say so, out loud, rather than
    // leaving a spinner to time out. THE ORDER IS STILL CLOSED: the close
    // happened in its own request and is not undone by this, so the owner
    // produces it by hand and nothing is lost but the instant proof.
    res.setHeader('Retry-After', '120');
    return res.status(503).json({ state: 'busy' });
  }
  res
    .status(202)
    .json({ state: job.state === 'queued' ? 'queued' : 'running', cards: cardEstimate(c) });
});

app.get('/api/collections/:id/produce', (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!c.owner_token || c.owner_token !== req.query.k)
    return res.status(403).json({ error: 'forbidden' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(produceState(c));
});

// Admin: RELEASE a finished deck into "הופקו — לשליחה לדפוס". A toggle: body
// {undo:true} puts it back in the production queue.
//
// This exists because producing and releasing stopped being the same event. The
// pile was read off the production record alone, which was true while only the
// owner's צור PDF wrote one — pressing it WAS the decision. Since #542 a buyer
// finishing her word list produces the deck herself, and orders began arriving
// in the print pile with nobody having looked at them.
//
// It stamps and nothing else. The deck the buyer already built is the deck that
// ships: no regeneration, no second file, no new pdf_token — the existing
// record is carried through untouched but for the stamp. That matters because
// the whole point is an order whose PDF is already correct.
//
// Now the FIRST of three hand-pressed steps: released -> sent to print -> ready.
app.post('/api/admin/collections/:id/release', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const on = !(req.body && req.body.undo);
  // Nothing to release until a deck exists. Answering 409 rather than stamping
  // an empty record keeps the pile's promise: everything in it has a file.
  const r = db.setProductionReleased(c.id, on);
  if (r === false) return res.status(404).json({ error: 'not found' });
  if (r === null) return res.status(409).json({ error: 'not produced' });
  res.json({ ok: true, production: r });
});

// Admin: mark an order SENT TO THE PRINT SHOP. A toggle: body {undo:true} takes
// it back. The SECOND of the three hand-pressed production steps, and the gate
// the third one sits behind.
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

// --- self-collection stickers -------------------------------------------------
// Every printed game the customer collects herself gets a label on its box, and
// the owner has been typing that sheet by hand every night: open a document,
// type eleven names, print. This is that sheet, from the orders.

// The design's Hebrew name — what goes on the label, because "which of these two
// boxes is the Paris one" is a question about a picture and not about a theme
// key. Falls back to the key rather than to nothing: a label with no design is
// worse than a label with an odd-looking one.
function designNameFor(theme) {
  const key = String(theme || '');
  if (!key) return '';
  try {
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT)) || {};
    const entry = themes[key];
    return (entry && String(entry.display_he || '').trim()) || key;
  } catch {
    return key;
  }
}

// The orders a sticker is printed for TONIGHT: exactly the owner's
// "הופקו — לשליחה לדפוס" pile, narrowed to self-collection.
//
// ONE STAGE, NOT A RANGE. The sheet is printed with the batch that is about to
// leave for Galor, so it is the same set as that chip and no wider. Each clause
// earns its place —
//   • pickup             — a delivery order is posted, and its label is the
//                          courier's (server/hfd.js), not this one;
//   • paid               — an unpaid order is not being made;
//   • produced           — there is no box to label until the deck is built;
//   • NOT sent to print  — once the batch has gone, its stickers went with it;
//                          reprinting them the next night is a duplicate sheet
//                          for boxes that already carry one;
//   • not ready          — marked ready means labelled and handed over;
//   • not cancelled.
//
// This USED to also take orders resting in בדפוס (stamped, not yet ready), on
// the reasoning that the stamp and the ready mark are pressed together so
// nothing ever rests there. Orders do rest there — eight of them the day this
// changed — and every one had already had its sticker printed. Zero on a night
// with nothing newly produced is the correct answer, not a sign the sheet is
// broken.
//
// Oldest first, so the sheet comes out in the order the orders table shows and a
// sticker can be found in it.
function orderProduced(c) {
  const p = (c.order && c.order.production) || c.production || null;
  // RELEASED, not merely generated. This sheet says of itself that it is
  // "exactly the owner's הופקו — לשליחה לדפוס pile" and ONE STAGE, NOT A RANGE;
  // once a buyer's סיום could build a deck without the order entering that pile
  // (see db.setProductionReleased), reading `generated` here would have printed
  // stickers for boxes that are not in tonight's batch.
  return !!(p && p.state === 'generated' && p.released_at);
}
// EVERY box in tonight's pile, in the order the orders table shows them, each
// with the label it needs. Two kinds, because we sell two ways of getting the
// box to the customer:
//
//   pickup   — she collects it. The label is OURS: the one below, printed here.
//   delivery — HFD carries it. The label is THEIRS: a barcode the driver scans,
//              which we cannot draw and have to fetch per shipment.
//
// A digital order has no box and no label at all.
//
// A delivery order with no HFD shipment booked (or one that was cancelled) has
// nothing to fetch — `shipment_number` is null and the caller leaves it out of
// the PDF and says which ones it left out. Booking is a real van and a real
// charge, so it stays a button the owner presses, never a side effect of asking
// for the stickers.
function stickerBatch() {
  return db
    .listAllCollections()
    .filter((c) => {
      const o = c.order;
      if (!o || c.cancelled) return false;
      if (!o.paid) return false;
      // A PDF-only order is a file in an inbox; there is nothing to stick a
      // label on.
      if (o.version !== 'pickup' && o.version !== 'delivery') return false;
      if (o.ready_at || o.sent_to_print_at) return false;
      return orderProduced(c);
    })
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .map((c) => {
      const rec = (c.order && c.order.hfd) || null;
      const live = rec && rec.shipment_number && !rec.cancelled_at;
      return {
        id: c.id,
        kind: c.order.version === 'delivery' ? 'delivery' : 'pickup',
        // The courier's shipment, when there is one to fetch a label for.
        shipment_number: live ? String(rec.shipment_number) : null,
        // What OUR label says. Built for every entry, not just the pickups: it
        // is also how a skipped delivery order is named back to the owner.
        label: {
          order_no: db.orderRef(c),
          // What the deck is CALLED — her own title when she wrote one, else the
          // honoree's name, which is the same thing the cards print.
          title: (c.custom_title || c.honoree_name || '').trim(),
          // The person COLLECTING, who is the buyer and not the honoree. Blank
          // when the order never captured one: an empty line is honest, and the
          // phone underneath still identifies them.
          buyer_name: (c.buyer_name || '').trim(),
          design: designNameFor(c.theme),
          phone: (c.owner_phone || '').trim(),
        },
      };
    });
}

// The self-collection half of that pile — the labels this server draws itself.
// Derived from stickerBatch rather than re-filtered, so the two cannot drift
// into disagreeing about what tonight's pile is.
function pickupStickerOrders() {
  return stickerBatch()
    .filter((e) => e.kind === 'pickup')
    .map((e) => e.label);
}

// Spawn ONE pickup_stickers.py run over `entries` — our labels and the courier's
// already-downloaded PDFs, in the order they should print — and resolve the
// finished PDF's path. `outDir` belongs to the CALLER, which fetched the courier
// labels into it and removes it afterwards.
//
// One Chrome print for all of ours, the same path the deck uses, so it goes
// through spawnGenerator and inherits its concurrency slot and its kill.
function runStickerBatch(entries, outDir) {
  return new Promise((resolve, reject) => {
    const jsonPath = path.join(outDir, 'stickers.json');
    const outPdf = path.join(outDir, 'pickup-stickers.pdf');
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(entries), 'utf8');
    } catch (e) {
      return reject(e);
    }
    const child = spawnGenerator([PICKUP_STICKERS_SCRIPT, jsonPath, outPdf]);
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
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('sticker render timed out'));
      if (code !== 0 || !fs.existsSync(outPdf)) {
        return reject(new Error((stderr || stdout || 'exit ' + code).trim().slice(0, 800)));
      }
      resolve(outPdf);
    });
  });
}

// How many courier labels are pulled from HFD at once. A batch is ten or twenty
// parcels and each label is one small request; four at a time empties the queue
// in about as long as one round trip without opening twenty sockets to a
// courier that has no idea we are batching.
const HFD_LABEL_CONCURRENCY = 4;

// Download the courier's label for every delivery entry that has a shipment,
// into `outDir`. Resolves { files, failed } — a Map from entry id to the file on
// disk, and the ones HFD would not give us, each with the reason.
//
// A label that does not come down is NOT fatal: the rest of the pile still
// prints, and the owner is told which parcels to fetch by hand. Losing twenty
// labels because HFD hiccuped on one is the failure worth avoiding here.
async function fetchCourierLabels(entries, outDir) {
  const wanted = entries.filter((e) => e.kind === 'delivery' && e.shipment_number);
  const files = new Map();
  const failed = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= wanted.length) return;
      const e = wanted[i];
      let r;
      try {
        r = await hfd.fetchLabel(e.shipment_number);
      } catch (err) {
        r = { ok: false, error: (err && err.message) || String(err) };
      }
      if (!r.ok) {
        console.error('hfd label failed for', e.shipment_number, '-', r.error);
        failed.push({
          order_no: e.label.order_no,
          shipment_number: e.shipment_number,
          message: r.error,
        });
        continue;
      }
      const file = path.join(outDir, 'hfd-' + e.shipment_number + '.pdf');
      try {
        fs.writeFileSync(file, r.pdf);
        files.set(e.id, file);
      } catch (err) {
        failed.push({
          order_no: e.label.order_no,
          shipment_number: e.shipment_number,
          message: (err && err.message) || String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HFD_LABEL_CONCURRENCY, wanted.length) }, worker));
  return { files, failed };
}

// The batch as the generator wants it: our labels as their own fields, the
// courier's as the file already fetched to disk, both in the order they should
// print. A delivery whose label did not come down drops out here — the caller
// counts what is missing and the page names it.
function stickerEntries(printable, files) {
  return printable
    .map((e) => {
      if (e.kind === 'pickup') return e.label;
      const file = files.get(e.id);
      return file ? { pdf: file } : null;
    })
    .filter(Boolean);
}

// Admin: tonight's stickers, as ONE PDF to print.
//
// The pile is mixed — boxes the customer collects and boxes HFD carries — and it
// used to take two places to get its labels: this button for the self-collection
// ones and HFD's own website for the rest. So this is the whole pile in one
// download, in the order the orders table shows it: our own label (105x74 mm,
// one to a page, straight onto the label stock) for a collection, and HFD's own
// sticker, fetched per shipment, for a delivery.
//
// A delivery order with no shipment booked is LEFT OUT and named in the response
// header rather than booked on the spot: a shipment is a real van and a real
// charge, and pressing "print my stickers" is not consent to order one.
//
// A GET so the button can be a plain link and the browser's own download does
// the work — there is nothing to post, and the batch is derived entirely from
// orders that already exist.
async function sendStickerBatch(req, res) {
  if (!requireAdmin(req, res)) return;
  const batch = stickerBatch();
  // What we can actually print: every collection label, and every delivery that
  // has a shipment to fetch a label for.
  const printable = batch.filter((e) => e.kind === 'pickup' || e.shipment_number);
  const unbooked = batch.filter((e) => e.kind === 'delivery' && !e.shipment_number);
  if (!printable.length) {
    // Not an error page: "there are none tonight" is a normal night, and it
    // should read as one rather than as something that failed. An evening whose
    // only orders are deliveries waiting to be booked says THAT instead.
    return res.status(409).json({
      error: 'none',
      message: unbooked.length
        ? 'כל ההזמנות שממתינות לדפוס הן משלוחים שעוד לא נפתח להם משלוח ב-HFD.'
        : 'אין כרגע הזמנות שהופקו וממתינות לשליחה לדפוס.',
      unbooked: unbooked.map((e) => e.label.order_no),
    });
  }

  let outDir;
  try {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-stickers-'));
  } catch (e) {
    console.error('stickers: no temp dir:', (e && e.message) || e);
    return res.status(500).json({ error: 'render failed' });
  }
  const cleanup = () => {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };

  let out;
  let failed = [];
  try {
    const labels = await fetchCourierLabels(printable, outDir);
    failed = labels.failed;
    const entries = stickerEntries(printable, labels.files);
    if (!entries.length) {
      cleanup();
      return res.status(502).json({
        error: 'no labels',
        message: 'HFD לא החזירה אף מדבקה: ' + ((failed[0] && failed[0].message) || 'שגיאה'),
      });
    }
    out = await runStickerBatch(entries, outDir);
  } catch (e) {
    cleanup();
    console.error('stickers failed:', (e && e.message) || e);
    return res.status(502).json({ error: 'render failed' });
  }

  const name = 'מדבקות ' + new Date().toISOString().slice(0, 10) + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  // Counts, not names: a header is latin-1 and an order title is not. The page
  // shows the owner WHICH orders are missing a shipment; these are here so a
  // download that came out short can be explained from the response alone.
  res.setHeader('X-Stickers-Unbooked', String(unbooked.length));
  res.setHeader('X-Stickers-Failed', String(failed.length));
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="stickers.pdf"; filename*=UTF-8\'\'' + encodeURIComponent(name)
  );
  res.sendFile(out, (err) => {
    cleanup();
    if (err) console.error('stickers send failed:', (err && err.message) || err);
  });
}

app.get('/api/admin/stickers', sendStickerBatch);
// The name it shipped under, kept working: it is in the staff allowlist, in the
// owner's browser history, and on a button that may be open in a tab right now.
app.get('/api/admin/pickup-stickers', sendStickerBatch);

// --- physical stock -----------------------------------------------------------
// Boards, boxes, thank-you notes, stickers. See the block above db.stockSnapshot
// for what counts as using one and why the counts may go negative.

// Every design that exists RIGHT NOW, as { theme, name }. Read from themes.json
// (the volume's copy in production, so a template the owner uploaded is in here
// too) and deliberately NOT filtered to public designs: a private template's
// boards are on the same shelf as everyone else's.
function stockDesigns() {
  try {
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT)) || {};
    return Object.entries(themes)
      .filter(([, v]) => v && typeof v === 'object')
      .map(([theme, v]) => ({ theme, name: (v.display_he || '').trim() || theme }));
  } catch {
    // No theme list is not an error here — the stored counts are still the truth,
    // and stockSnapshot answers with them (as orphans) rather than nothing.
    return [];
  }
}

app.get('/api/admin/stock', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(db.stockSnapshot(stockDesigns()));
});

// Admin: correct a count, restock a shelf, or change how many of a supply an
// order uses. One route for both kinds of row, because they are one screen.
app.put('/api/admin/stock', express.json({ limit: '8kb' }), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const designs = stockDesigns();
  if (b.kind === 'board') {
    const stored = db.setBoardStock(b.theme, b.count, designs);
    if (stored == null) return res.status(404).json({ error: 'unknown design' });
  } else if (b.kind === 'supply') {
    const stored = db.setSupplyStock(b.key, { count: b.count, per_order: b.per_order });
    if (stored == null) return res.status(404).json({ error: 'unknown supply' });
  } else {
    return res.status(400).json({ error: 'expected kind board|supply' });
  }
  // The whole shelf back, so the page redraws from the store rather than from
  // what it hoped the store did.
  res.json(db.stockSnapshot(designs));
});

// EVERYTHING THAT HAPPENS WHEN AN ORDER BECOMES READY, in one place.
//
// Extracted because there are now two ways to press it — one row, or the whole
// בדפוס pile at once — and a customer's experience must not depend on which
// button the owner used. Anything added here (a third medium, a stock rule)
// reaches both by construction; two copies would have drifted the first time
// one of them was edited.
//
// Returns what was actually done, so the batch can report itself honestly
// instead of claiming a number it did not achieve — which is why the mail is
// AWAITED here rather than fired and forgotten.
async function applyOrderReady(id, ready, changed) {
  const done = { stock: false, emailed: false, sms: null };
  // The shelf. Marking an order ready is the moment the deck is packed, so this
  // is where a board, a box and a note physically leave — and un-marking a row
  // pressed by mistake puts back exactly what that press took (db.applyOrderStock
  // reverses its own record, never a recomputation). Only on a REAL transition,
  // and never allowed to fail the press: this is the step that emails the
  // customer, and a bookkeeping error must not stand in the way of it.
  if (changed) {
    try {
      db.applyOrderStock(id, ready, stockDesigns());
      done.stock = true;
    } catch (e) {
      console.warn('[stock] could not update:', (e && e.message) || e);
    }
  }
  // PRESSING מוכן ON AN ALREADY-READY ORDER IS THE RECOVERY PRESS. When the SMS
  // for this order failed — the phone took it three times and never reported, or
  // the 12-hour window closed on it — the customer was never told, and the owner
  // has exactly one button that says "tell her". It has to work without her
  // first un-marking the order and marking it again, which is a trick nobody
  // would guess and which briefly un-does the shelf as a side effect.
  //
  // What keeps this from being a double-text is that sms.enqueue ALREADY knows
  // the answer: its dedupe holds while the message is pending, taken or sent,
  // and lets a replacement through only for the two states that mean she never
  // heard from us. So an accidental double-tap on a healthy order is still a
  // silent no-op, exactly as before — the queue decides, not the button.
  //
  // The SMS only. The mail has no per-message state to ask, so re-sending it
  // here would mail a customer again on every stray tap; that mail still goes on
  // the real transition below, and on an undo-then-redo as it always has.
  if (ready && !changed) {
    done.sms = queueReadySms(db.getCollection(id));
    return done;
  }
  if (ready && changed) {
    const fresh = db.getCollection(id);
    // The SMS first: enqueue is a local write, so a mail server that is slow or
    // unreachable cannot hold up the text the customer is owed.
    done.sms = queueReadySms(fresh);
    // …then the mail, AWAITED, so `emailed` is what HAPPENED and not what was
    // attempted. Resend rate-limits, times out and refuses unsubscribed
    // addresses; a batch that fires eleven of these at once and assumes they
    // all landed would tell the owner eleven customers were told while some of
    // them heard nothing — the exact failure this button exists to prevent.
    // sendOrderReady already swallows its own errors and answers false; the
    // try/catch is for the caller that replaced it with something that throws.
    if (typeof notify.sendOrderReady === 'function') {
      try {
        done.emailed = Boolean(await notify.sendOrderReady(fresh, paymentBaseUrl()));
      } catch (e) {
        console.warn('[notify] order-ready mail failed:', (e && e.message) || e);
      }
    }
  }
  return done;
}

// Will an order-ready MAIL actually go out? Both halves of the answer: the
// owner's per-message switch (settings.emailEnabled) and whether email is
// configured at all. The confirmation dialog promises mail on the strength of
// this, so it must be the same question notify.sendOrderReady asks itself.
function orderReadyEmailArmed() {
  try {
    return Boolean(notify.isConfigured() && settings.emailEnabled('order_ready'));
  } catch {
    return false;
  }
}

// Will a TEXT actually go out? The master switch AND a template with something
// in it — queueReadySms returns null on either, so a dialog that checked only
// the switch would promise a text that an emptied template silently drops.
function orderReadySmsArmed() {
  try {
    return Boolean(
      settings.get('sms', 'enabled') && String(settings.get('sms', 'order_ready') || '').trim()
    );
  } catch {
    return false;
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
  // Not awaited, deliberately: the stock move and the SMS are synchronous, and
  // one row's answer must not wait on a mail server. The batch below DOES wait,
  // because there the send result IS the report.
  applyOrderReady(req.params.id, ready, r.changed).catch((e) => {
    console.warn('[orders] ready follow-up failed:', (e && e.message) || e);
  });
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

// --- the whole בדפוס pile, in one press ---------------------------------------
//
// The batch the owner actually works in: a run comes back from Galor and every
// box in it becomes ready within the same minute. Pressing eleven rows one at a
// time is eleven chances to miss one — and a missed row is a customer who never
// hears that her game is waiting.
//
// WHAT IT TAKES: exactly what the בדפוס chip shows — paid, not cancelled, sent
// to print, not yet ready. Both kinds, deliberately: a delivery order becomes
// ready at the same moment as a pickup one, and leaving it behind would only
// mean pressing it by hand afterwards. Each one goes through the SAME step a
// single row does (applyOrderReady), so the email, the SMS and the stock all
// behave exactly as they do today.
//
// WHAT IT DOES NOT DO: book a courier. That is a real van and a real charge, and
// it stays a button pressed per order — the same rule the sticker sheet follows.
function batchReadyCandidates() {
  return db
    .listAllCollections()
    .filter((c) => {
      const o = c.order;
      if (!o || c.cancelled) return false;
      if (!o.paid) return false;
      return !!o.sent_to_print_at && !o.ready_at;
    })
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

// One candidate, described for the confirmation dialog. The owner is about to
// text real people; she is shown who, and — just as importantly — who will get
// nothing because we hold no mobile for them.
function batchReadyRow(c) {
  const version = String((c.order && c.order.version) || '');
  return {
    id: c.id,
    order_no: db.orderRef(c),
    honoree: c.honoree_name || '',
    // The order's REAL version, not "delivery or else pickup". A pdf and a
    // custom order travel this same pipeline — db.applyOrderStock says so in
    // as many words — and calling a digital sale self-pickup tells the owner
    // she is sending two people to גלאור when one of them is waiting on a file.
    kind: ['delivery', 'pickup', 'pdf', 'custom'].includes(version) ? version : 'other',
    // The number as the GATEWAY will read it, not merely "something was typed
    // in the phone field". sms.enqueue puts every number through ilMobile(),
    // which soft-fails anything that is not an Israeli mobile — so a landline
    // counted as "will get a text" would be left off the call-by-hand list,
    // which is the one list this dialog exists to produce.
    has_phone: Boolean(sms.ilMobile(c && c.owner_phone)),
  };
}

// The preview. Read-only and separate from the press on purpose: a button that
// blasts messages on its first click is a button that gets clicked by accident.
app.get('/api/admin/orders/ready-batch', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = batchReadyCandidates().map(batchReadyRow);
  const kinds = { pickup: 0, delivery: 0, pdf: 0, custom: 0, other: 0 };
  for (const r of rows) kinds[r.kind] += 1;
  res.json({
    orders: rows,
    count: rows.length,
    pickup: kinds.pickup,
    delivery: kinds.delivery,
    // Every kind in the pile, so the dialog can say "2 self-pickup · 1 digital"
    // rather than filing the file under the boxes.
    kinds,
    // Named rather than counted: "3 without a phone" sends her hunting; three
    // order numbers tell her which three to call.
    no_phone: rows.filter((r) => !r.has_phone).map((r) => r.order_no),
    // What will ACTUALLY be sent. The dialog is the last thing she reads before
    // an action that cannot be taken back, so both answers come from the same
    // gates the senders themselves use — a switched-off template must not be
    // described as "everyone gets a mail".
    sms_enabled: orderReadySmsArmed(),
    email_enabled: orderReadyEmailArmed(),
  });
});

app.post('/api/admin/orders/ready-batch', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const done = [];
  const failed = [];
  const emailArmed = orderReadyEmailArmed();
  // ONE AT A TIME, and each send awaited — the pattern every other bulk sender
  // here follows (the reminder scans). Eleven mails fired at once is eleven
  // chances to trip Resend's rate limit, and a swallowed rejection would leave
  // the owner reading "11 marked ready" while a customer sits waiting.
  for (const c of batchReadyCandidates()) {
    const row = batchReadyRow(c);
    // Each order is marked through the store's own gate, so the batch cannot do
    // anything a single press could not — and one order that refuses (a race
    // with another tab, a row cancelled a second ago) never stops the rest.
    let r = null;
    try {
      r = db.setOrderReady(c.id, true);
    } catch (e) {
      r = { error: String((e && e.message) || e) };
    }
    if (!r || r.error || !r.changed) {
      failed.push({ ...row, error: (r && r.error) || 'unchanged' });
      continue;
    }
    const applied = await applyOrderReady(c.id, true, true);
    done.push({ ...row, sms_queued: Boolean(applied.sms), emailed: Boolean(applied.emailed) });
  }
  res.json({
    ok: true,
    marked: done.length,
    sms_queued: done.filter((d) => d.sms_queued).length,
    emailed: done.filter((d) => d.emailed).length,
    // The orders that were marked ready and whose mail did NOT go — the ones
    // she has to tell by hand. Empty when mail is switched off entirely: then
    // nothing was attempted, and naming every row would be noise, not news.
    not_emailed: emailArmed ? done.filter((d) => !d.emailed).map((d) => d.order_no) : [],
    email_enabled: emailArmed,
    sms_enabled: orderReadySmsArmed(),
    orders: done,
    failed,
    sent_to_print_count: db.countSentToPrintOrders(),
    ready_count: db.countReadyOrders(),
  });
});

// --- HFD shipments -----------------------------------------------------------
// Booking a delivery order's parcel with the courier from our own admin instead
// of retyping the address into HFD's site. See server/hfd.js for the API; every
// route here is a no-op while the credentials are unset.

// The three refusals that are OUR data being wrong, not HFD saying no. They are
// 400s with a fix the owner can act on, and nothing is sent to the courier.
const HFD_LOCAL_ERRORS = {
  'no order': 'אין הזמנה על הרשומה הזו.',
  'not a delivery order': 'זו לא הזמנת משלוח — אין מה לשלוח לשליח.',
  'address required': 'להזמנה חסרה כתובת מלאה (רחוב, עיר).',
};

// The design's CURRENT public name, for the sticker — the same string
// /api/design-names serves and the storefront shows (themes.json `display_he`),
// resolved from the order's generator theme. NOT `c.design`, which is the name
// stamped on the order when it was placed: a template rename leaves every older
// order carrying a label the shop no longer uses. Falls back to the stamped name
// if themes.json can't be read at all.
function hfdDesignName(c) {
  try {
    const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
    const theme = (c.order && c.order.theme) || c.theme || null;
    return templates.displayNameForDesign(themes, { theme, name: c.design, id: theme });
  } catch {
    return (c && c.design) || '';
  }
}

// Admin: is the courier integration armed? The admin page asks once at load and
// hides the whole control when it isn't, rather than offering a button that can
// only fail.
app.get('/api/admin/hfd/status', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(hfd.status());
});

// Admin: book this delivery order's parcel. Deliberately manual — a shipment is
// a van and a charge, so it happens when the owner presses, never on a state
// change.
app.post('/api/admin/collections/:id/hfd', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (!hfd.isConfigured()) {
    return res.status(503).json({
      error: 'hfd not configured',
      message: 'HFD לא מוגדרת — חסרים HFD_TOKEN / HFD_CLIENT_NUMBER.',
    });
  }
  // A second press must not book a second van. The already-booked shipment is
  // returned with the refusal so the page can just show it.
  const existing = c.order && c.order.hfd;
  if (existing && existing.shipment_number && !existing.cancelled_at) {
    return res.status(409).json({
      error: 'already booked',
      message: 'כבר נוצר משלוח להזמנה הזו (' + existing.shipment_number + ').',
      hfd: existing,
    });
  }

  const r = await hfd.createShipment(c, { designName: hfdDesignName(c) });
  if (!r.ok) {
    if (HFD_LOCAL_ERRORS[r.error]) {
      return res.status(400).json({ error: r.error, message: HFD_LOCAL_ERRORS[r.error] });
    }
    // HFD refused. Remember why: the owner comes back to this row later, and
    // "it didn't work" with no reason is what sends her to the phone.
    console.error('hfd create refused for', c.id, '-', r.error);
    const record = db.setHfdShipment(c.id, {
      error: r.error,
      error_at: new Date().toISOString(),
    });
    return res.status(502).json({ error: 'hfd refused', message: r.error, hfd: record });
  }

  const record = db.setHfdShipment(c.id, {
    shipment_number: r.shipmentNumber,
    rand_number: r.randNumber,
    tracking_url: hfd.trackingUrl(r.randNumber),
    sent_at: new Date().toISOString(),
    cancelled_at: null,
    error: null,
    error_at: null,
  });
  res.json({ ok: true, hfd: record });
});

// Admin: the parcel's sticker, proxied so the token never reaches the browser.
// Inline, because the owner prints it straight from the tab.
app.get('/api/admin/collections/:id/hfd/label', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const number = c.order && c.order.hfd && c.order.hfd.shipment_number;
  if (!number) return res.status(404).json({ error: 'no shipment' });
  const r = await hfd.fetchLabel(number);
  if (!r.ok) return res.status(502).json({ error: 'hfd label failed', message: r.error });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="hfd-' + number + '.pdf"');
  res.send(r.pdf);
});

// Admin: cancel the booked parcel. The number is KEPT (marked cancelled) — an
// order's shipping history is evidence, and a cleared field cannot say that a
// van was once ordered and stood down.
app.delete('/api/admin/collections/:id/hfd', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const c = db.getCollection(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const record = c.order && c.order.hfd;
  if (!record || !record.shipment_number) return res.status(404).json({ error: 'no shipment' });
  if (record.cancelled_at) return res.json({ ok: true, hfd: record });
  const r = await hfd.cancelShipment(record.shipment_number);
  if (!r.ok) {
    // LOGGED, not only returned. A refusal the owner reports as "it says it
    // failed" is unanswerable without HFD's own words for it, and this is the
    // only place they exist.
    console.error('hfd cancel refused for', record.shipment_number, '-', r.error);
    return res.status(502).json({ error: 'hfd refused', message: r.error, hfd: record });
  }
  const next = db.setHfdShipment(c.id, { cancelled_at: new Date().toISOString() });
  res.json({ ok: true, hfd: next });
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
// Optionally a PARTNER coupon — a blogger's code that earns her money — by
// carrying partner_name + commission_type + commission_value.
app.post('/api/admin/coupons', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const coupon = db.createCoupon({
    code: b.code,
    discount_pct: b.discount_pct,
    valid_until: b.valid_until,
    max_uses: b.max_uses,
    partner_name: b.partner_name,
    commission_type: b.commission_type,
    commission_value: b.commission_value,
  });
  if (coupon && coupon.error) return res.status(400).json({ error: coupon.error });
  res.status(201).json({ coupon });
});

// Admin: change or lift a coupon's redemption cap. Body: { max_uses } — a whole
// number of uses, or null/'' for no limit. 404 unknown id, 400 a bad cap.
app.post('/api/admin/coupons/:id/max-uses', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const coupon = db.setCouponMaxUses(req.params.id, (req.body || {}).max_uses);
  if (!coupon) return res.status(404).json({ error: 'not found' });
  if (coupon.error) return res.status(400).json({ error: coupon.error });
  res.json({ coupon });
});

// Admin: edit a coupon's PARTNER terms (name + what she earns). The code and the
// discount are not editable — both are already printed in the blogger's post.
app.post('/api/admin/coupons/:id/partner', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const coupon = db.updateCouponPartner(req.params.id, {
    partner_name: b.partner_name,
    commission_type: b.commission_type,
    commission_value: b.commission_value,
  });
  if (!coupon) return res.status(404).json({ error: 'not found' });
  if (coupon.error) return res.status(400).json({ error: coupon.error });
  res.json({ coupon });
});

// Admin: one partner's full report — the same numbers her own page shows, so
// the two can never disagree about what is owed.
app.get('/api/admin/coupons/:id/report', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const report = db.partnerReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'not found' });
  res.json(report);
});

// Admin: record money actually handed to the blogger.
app.post('/api/admin/coupons/:id/payouts', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const payout = db.addCouponPayout(req.params.id, {
    amount: b.amount,
    date: b.date,
    note: b.note,
  });
  if (!payout) return res.status(404).json({ error: 'not found' });
  if (payout.error) return res.status(400).json({ error: payout.error });
  res.status(201).json({ payout });
});

// Admin: undo a payout entry — for correcting a mistake, not for hiding one.
app.delete('/api/admin/coupons/:id/payouts/:payoutId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!db.deleteCouponPayout(req.params.id, req.params.payoutId)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ ok: true });
});

// Admin: issue a NEW report link, retiring the old one. For a link that leaked
// or a partnership that ended; there is no way back to the previous token.
app.post('/api/admin/coupons/:id/rotate-token', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const coupon = db.rotateCouponToken(req.params.id);
  if (!coupon) return res.status(404).json({ error: 'not found' });
  res.json({ coupon });
});

// THE BLOGGER'S OWN REPORT. No admin key and no login — the long random token in
// the URL is the credential, which is the whole reason there is nothing here
// worth stealing beyond her own numbers.
//
// It carries NO CUSTOMER DATA. Not a name, not an email, not a phone, not what
// anyone ordered — those belong to the shop's buyers, who never agreed to be
// listed on a partner's dashboard. An order number, a date and a sum are enough
// for her to check every figure against what she is paid.
app.get('/api/partner/:token', (req, res) => {
  const coupon = db.getCouponByToken(req.params.token);
  // Same answer for a malformed token, an unknown one and a coupon that is no
  // longer a partner's: a 404 that distinguishes them is a way to hunt for real
  // tokens.
  if (!coupon) return res.status(404).json({ error: 'not found' });
  const report = db.partnerReport(coupon.id);
  if (!report) return res.status(404).json({ error: 'not found' });
  res.json(report);
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

// Agent B: design access codes + the in-store check, in server/routes/catalog.js.
catalogRoutes.registerDesignCodes(app, {
  requireAdmin,
  couponRateOk,
  clientKey,
  path,
  __dirname,
  pathToFileURL,
  TEMPLATE_ROOT,
  db,
  templates,
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

// OWNER-SCOPED pawn-images upload: attach optional customer photos ("פיונים") to
// a collection — one per player, so up to db.playersFor(c), which is 4 for the
// standard deck and 16 for the largest. Owner-token gated via ?k= (a query param,
// so we can authenticate BEFORE express.raw buffers the body — an unauthenticated client
// can't force a large allocation). Multipart, same magic-byte typing + 4MB/image
// cap as the content-photo route (content.saveImageBytes). Pictures are a
// nice-to-have: a single bad/oversized image part is SKIPPED, not fatal, so a
// partial batch still succeeds — but it is REPORTED (`skipped: [{name, filename,
// reason}]`) rather than dropped in silence, so the page can tell the buyer which
// photo did not make it instead of just showing her fewer than she picked.
//
// The per-collection cap — db.playersFor(c) photos, one per player — is enforced at
// WRITE time (POST /api/collections is public, so anyone gets a valid
// {id, owner_token} and could hammer this route): we compute how much ROOM is left
// for this collection and only ever write that many files, so disk writes are
// bounded by that cap and repeated over-cap posts write nothing. A SECOND, smaller
// cap bounds one request (PAWN_BATCH_MAX), because the body is buffered whole.
//
// Any file we DID write but that ends up unrecorded (a content-hash
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

// The buyer REMOVES one of her own pawn photos, from her collection page. Body:
// { pawn_images: [...] } — the photos she is KEEPING, in order.
//
// It is a subset-only setter (db.setPawnImagesForOwner): every path must already
// be attached to this collection, so the route can detach and reorder but never
// attach. Adding stays with POST above, which writes the file it records — that
// asymmetry is the point, because it means possessing a collection link is not
// enough to graft an arbitrary /content-uploads path onto an order.
//
// The detached FILE is deliberately left on disk: it is content-addressed and may
// be shared with another collection (the same photo, uploaded twice, is one file),
// so deleting it here could blank someone else's card. Same posture as the admin
// setter next to it.
app.put('/api/collections/:id/pawns', express.json({ limit: '16kb' }), (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
  const body = req.body || {};
  if (!Array.isArray(body.pawn_images)) {
    return res.status(400).json({ error: 'expected { pawn_images: [] }' });
  }
  const imgs = db.setPawnImagesForOwner(req.params.id, req.query.k, body.pawn_images);
  // null here means a path that is not this collection's — the same answer as a
  // bad token, on purpose: both are "that is not yours to edit".
  if (imgs == null) return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true, pawn_images: imgs });
});

// HOW ONE PHOTO SITS IN ITS CIRCLE, as the buyer placed it — and whether it keeps
// its BACKGROUND. Body: { path, zoom, dx, dy, bg }.
//
// The automatic framing answers "where is the person?", which stops being the
// right question the moment there are two of them in the shot, or the buyer
// simply wants a face bigger. She can see the pawn on this page now, so she may
// as well be able to move it; the same numbers reach build.apply_photo_view and
// the printer cuts what she lined up.
//
// Owner-token gated (these are photographs of her people) and refused once the
// collection is CLOSED, like the title: the deck is in production by then and a
// silently-accepted change would print nothing.
app.put('/api/collections/:id/pawn-view', express.json({ limit: '8kb' }), (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
  if (db.effectiveStatus(c) !== 'open') {
    return res.status(409).json({ error: 'closed', message: 'האיסוף נסגר והמשחק בהפקה' });
  }
  const body = req.body || {};
  if (typeof body.path !== 'string' || !body.path) {
    return res.status(400).json({ error: 'expected { path }' });
  }
  // The store clamps zoom/dx/dy and coerces bg, and refuses a path this
  // collection does not hold — a null answer is "not yours", the same as a bad
  // token, on purpose.
  const views = db.setPawnView(req.params.id, req.query.k, body.path, body);
  if (views == null) return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true, pawn_view: views });
});

// HOW MANY PLAYERS this deck is laid out for. Body: { players }.
//
// The deck is always 104 cards, so four more players is one more pawn card and
// one word card fewer. RAISING the count therefore lowers the ceiling on her
// word list, and that is the one way this can fail: her list may already be
// longer than the smaller deck holds. It fails with the numbers rather than by
// trimming — the words are her guests', and the page turns the refusal into
// "delete N words to move to 12 players".
//
// Owner-token gated and refused once the collection is CLOSED, like the title
// and the pawn views: the deck is in production by then and a silently-accepted
// change would print nothing.
app.put('/api/collections/:id/players', express.json({ limit: '4kb' }), (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
  if (db.effectiveStatus(c) !== 'open') {
    return res.status(409).json({ error: 'closed', message: 'האיסוף נסגר והמשחק בהפקה' });
  }
  const out = db.setPlayers(req.params.id, req.query.k, (req.body || {}).players);
  if (out == null) return res.status(403).json({ error: 'forbidden' });
  // 409, not 400: nothing about the request is malformed — the collection is in
  // a state that refuses it, and the body says exactly what would clear that.
  if (out.error === 'words') return res.status(409).json(out);
  res.json({ ok: true, ...out });
});

// THE CUTOUT FOR A PHOTO WE ALREADY HOLD. Multipart: a `path` field naming the
// original and a `cut` file carrying the transparent PNG the browser produced.
//
// The upload route attaches a cutout to a photo as it ARRIVES, which covers the
// wizard and nothing else: a photo added later from the collection page, or one
// whose cut missed on the phone that sent it, had no second chance and printed
// with its background. This is that second chance — the same MediaPipe cut, run
// on whatever device she is holding now, for a photo already on the order.
//
// Owner-token gated in front of express.raw for the same reason the upload route
// is: authenticate before buffering a body, never after.
app.post(
  '/api/collections/:id/pawn-cut',
  (req, res, next) => {
    const c = db.getCollection(req.params.id);
    if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
    next();
  },
  express.raw({ type: () => true, limit: PAWN_UPLOAD_LIMIT }),
  (req, res) => {
    const id = req.params.id;
    const ownerToken = req.query.k;
    const boundary = templates.boundaryFromContentType(req.headers['content-type']);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'expected multipart/form-data upload' });
    }
    const { fields, files } = templates.parseMultipart(req.body, boundary);
    const orig = String((fields && fields.path) || '');
    const part = files && files.cut;
    if (!orig || !part || !Buffer.isBuffer(part.data)) {
      return res.status(400).json({ error: 'expected a `path` field and a `cut` file' });
    }
    // PNG only, exactly as storePawnCutouts insists: a JPEG cannot carry alpha,
    // so recording one as "cut ✓" would ship a photo that still prints as a
    // rectangle — the one silent failure this whole feature exists to prevent.
    let saved = null;
    try {
      if (content.extFromMagic(part.data) === '.png') saved = content.saveImageBytes(part.data);
    } catch {
      saved = null;
    }
    if (!saved) return res.status(400).json({ error: 'expected a PNG cutout' });
    const cuts = db.setPawnCutout(id, ownerToken, orig, saved.path);
    if (cuts == null) {
      // Not this collection's photo. Don't orphan the file we just wrote — unless
      // something else already references it (content-addressed uploads are shared).
      if (saved.created && !content.isImageReferenced(saved.path)) content.deleteUpload(saved.path);
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json({ ok: true, pawn_cutouts: cuts });
  }
);

// HER PHOTO CARD, RENDERED — the card her four photos actually become.
//
// The collection page used to show the photos as a strip of thumbnails, which
// answers "which files did I send?" when what she is deciding is "what will my
// guests hold?". The pawn card ships inside her deck: it prints on the front
// card's paper, cut to the deck's frame, with the photos in its four slots and
// the shipped Dugri pawns filling any she left empty. So this renders the real
// thing, through the generator path the deck itself uses.
//
// OWNER ONLY (owner_token), because the photos are.
//
// Cached on (theme + the exact photo files + the frames she set + the title), so
// returning to the tab is free and yet a photo added, removed or MOVED — or the
// honoree renamed — is a different key and re-renders at once: no staleness to
// reason about. In its OWN bounded cache rather than the preview LRU, because the
// title made these entries per-order and they would otherwise evict the public
// name-preview (see pawnCardCache).
app.get('/api/collections/:id/pawn-card', async (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
  const theme = c.theme || '';
  if (!validate.getTheme(theme)) return res.status(400).json({ error: 'unknown theme' });
  // LIVE: the card WITHOUT her photos, and where its discs are. The page then
  // draws them in itself, so dragging one is a CSS change rather than a browser
  // run on the server — the editor moved at the speed of a render before this,
  // which is to say it was always showing the adjustment before last.
  //
  // `n` is how many discs the page will cover; the render fills the rest with the
  // shipped Dugri pawns, which is what the printed card does. So this picture
  // depends on the theme and that COUNT — not on which photos, and not on how she
  // framed them, either of which would put the render back in the drag loop.
  const live = req.query.live === '1';
  const drawn = live ? Math.max(0, Math.min(4, Number(req.query.n) || 0)) : 0;
  const photos = live ? [] : pawnPhotoFiles(c);
  const photoFrames = live ? [] : pawnPhotoFrames(c);
  const photoCutouts = live ? [] : pawnPhotoCutouts(c);
  // THE ORDER TITLE, which this card carries now — read from the STORED
  // collection exactly as the produce route reads it, so the card she looks at
  // and the card the printer cuts resolve the same {AGE}/{feminine} title.
  const title = {
    name: c.honoree_name || '',
    extraFields: validate.effectiveExtraFields(c),
    customTitle: c.custom_title || null,
    gender: c.gender || null,
  };
  // …and it is part of BOTH keys. The live base card is no longer independent of
  // the order: renaming the honoree changes the picture the page draws her pawns
  // onto, and a key that ignored the title would keep serving the old name.
  const titleKey = [
    title.name,
    JSON.stringify(title.extraFields || {}),
    title.customTitle || '',
    title.gender || '',
  ].join('\u0000');
  const cacheKey = live
    ? 'pawn-base:' + theme + ':' + drawn + ':' + titleKey
    : 'pawn-card:' +
      theme +
      ':' +
      photos.join('|') +
      ':' +
      photoFrames.map((f) => f || '').join('|') +
      ':' +
      photoCutouts.map((isCut) => (isCut ? 'c' : 'o')).join('') +
      ':' +
      titleKey;
  const cached = pawnCardCache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const out = await runPawnCard({
      theme,
      photos,
      photoFrames,
      photoCutouts,
      empty: live,
      drawn,
      ...title,
    });
    pawnCardCache.set(cacheKey, out);
    res.json(out);
  } catch (e) {
    // A render that fails must not read as "you have no photos": the page keeps
    // the strip either way, and says the picture is what is missing.
    console.error('pawn card render failed:', (e && e.message) || e);
    res.status(502).json({ error: 'pawn card render failed' });
  }
});

// Which row of the buyer-facing menu THIS ORDER is on, or null for none.
//
// Two kinds of row, and the order records each of them its own way: an ordinary
// row stores the POOL (that is what the generator needs) and is matched back to
// its id here, while the decline stores `no_topup` and names no pool at all.
// Resolved on read rather than stored twice, so renaming a pool in one place
// cannot leave the two disagreeing.
//
// The decline is checked FIRST: an order can carry a pool she picked before she
// changed her mind (we keep it, so the row she used to be on is still there when
// she comes back), and what is TICKED is what we are actually going to print.
function optionIdForCollection(c) {
  if (c && c.no_topup) return wordlistOptions.BLANK_ID;
  const pool = c && c.wordlist;
  if (!pool) return null;
  const list = settings.get('wordlists', 'buyer_options') || [];
  const found = list.find((o) => o && o.enabled && o.pool === pool);
  return found ? found.id : null;
}

// The buyer-facing pool menu, public. Labels only — the pool file names behind
// them are production detail (see server/wordlist-options.js). Empty until the
// owner builds the menu, which is exactly when the chooser should not appear.
//
// The last row is "don't fill it at all" when the owner has given it a label
// (`blank_label`). It rides along with the menu rather than standing on its own:
// a radio group cannot be un-picked, so a decline with no pool row beside it
// would be a choice with no way back out of it.
app.get('/api/wordlist-options', (req, res) => {
  res.json({
    options: wordlistOptions.publicOptions(
      settings.get('wordlists', 'buyer_options'),
      settings.get('wordlists', 'blank_label')
    ),
  });
});

// THE WORDS THEMSELVES, public — what wordlists.html shows.
//
// A buyer picking between "רווקות" and "משפחתי" is picking what ~300 of the 412
// words on her cards will be about, from a label alone. This is the label made
// good on: every word in every list she can actually choose.
//
// It is the SAME boundary as the menu above, deliberately reusing publicOptions
// rather than reading the settings itself: a list reaches this route only by
// being an enabled buyer option, so a half-built pool, or one the owner switched
// off, can never be read here. And like the menu it answers labels only — the
// pool file name behind each list stays a production detail.
//
// A pool that has gone missing from the volume is skipped rather than 500ing the
// page: one broken entry must not cost the buyer the other five lists.
app.get('/api/wordlist-preview', (req, res) => {
  const stored = settings.get('wordlists', 'buyer_options');
  const menu = wordlistOptions.publicOptions(stored);
  const lists = [];
  for (const opt of menu) {
    const pool = wordlistOptions.poolForOption(stored, opt.id);
    if (!pool) continue;
    let rec;
    try {
      rec = wordlists.read(pool);
    } catch {
      rec = null; // unreadable on disk — skip it, the rest of the menu still shows
    }
    if (!rec || !Array.isArray(rec.words)) continue;
    lists.push({ id: opt.id, label: opt.label, count: rec.words.length, words: rec.words });
  }
  // Same rule as every other JSON API here: an in-app browser caching this would
  // show a list the owner has since edited (see the price-caching bug).
  res.set('Cache-Control', 'no-store');
  res.json({ lists });
});

// The buyer picks which pool fills the rest of her deck. Body: { option_id } —
// null/'' clears the pick and lets her design decide, as before.
//
// ...or picks the row that says DON'T fill it: her words print and the rest of
// the deck comes out blank and numbered for her to write on. It is the same
// question and so the same route — one radio group cannot be answered through two
// doors without the two eventually disagreeing about which answer is live.
//
// Allowed until she CLOSES the collection, the same rule as her title and photos:
// closing freezes the 412-word bank and starts production, and this choice is one
// of the inputs that bank is frozen FROM.
app.put('/api/collections/:id/wordlist', express.json({ limit: '4kb' }), (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
  if (db.effectiveStatus(c) !== 'open') {
    return res.status(409).json({ error: 'closed', message: 'האיסוף נסגר והמשחק בהפקה' });
  }
  const raw = (req.body || {}).option_id;
  const optionId = raw == null ? '' : String(raw).trim();
  // THE DECLINE, and it is checked against the MENU THAT IS OFFERED — not merely
  // against the id. An owner who has cleared the label, or who has no menu for it
  // to ride along with, is not offering this row, and a row nobody is offering
  // must not be reachable by naming it: the buyer would get a half-empty deck the
  // owner never agreed to sell. Turning it OFF is always allowed, whatever the
  // menu says now, or clearing the label would trap every order that took it.
  const offered = wordlistOptions
    .publicOptions(
      settings.get('wordlists', 'buyer_options'),
      settings.get('wordlists', 'blank_label')
    )
    .some((o) => o.id === wordlistOptions.BLANK_ID);
  if (optionId === wordlistOptions.BLANK_ID) {
    if (!offered) return res.status(409).json({ error: 'not offered' });
    const set = db.setNoTopupForOwner(req.params.id, req.query.k, true);
    if (set === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    return res.json({
      ok: true,
      option_id: optionIdForCollection(db.getCollection(req.params.id)),
    });
  }
  // Any other answer is an answer to the same question, so it un-declines: she
  // has just told us which of our words to use.
  if (db.setNoTopupForOwner(req.params.id, req.query.k, false) === 'forbidden') {
    return res.status(403).json({ error: 'forbidden' });
  }
  let pool = null;
  if (optionId) {
    // Resolved through the OWNER'S MENU, never taken from the client: the body
    // names a menu entry, and the pool it maps to is ours. A disabled option
    // resolves to nothing, so switching one off stops it being choosable rather
    // than merely hiding it.
    pool = wordlistOptions.poolForOption(settings.get('wordlists', 'buyer_options'), optionId);
    if (!pool) return res.status(400).json({ error: 'unknown option' });
    // …and the pool it names must still be a real pool. The menu is settings, the
    // pools are files on the volume, and a deleted pool would otherwise reach
    // topup.py as a name it cannot resolve — at print time, on a paid order.
    if (!wordlists.list().some((w) => w.name === pool)) {
      return res.status(409).json({ error: 'pool missing', message: 'הרשימה הזו כבר לא קיימת' });
    }
  }
  const stored = db.setWordlistForOwner(req.params.id, req.query.k, pool);
  if (stored === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true, option_id: optionIdForCollection(db.getCollection(req.params.id)) });
});

// The buyer RETITLES her own deck from the collection page. Body: { custom_title }
// (a blank one restores the theme's own title).
//
// Allowed until she CLOSES the collection — closing is what starts production, so
// up to that moment nothing has been printed and the title is still hers to move,
// paid or not. After it, the deck is being made and the title it is made with is
// fixed. Enforced here and not only in the page, because a UI-only rule is not a
// rule.
app.put('/api/collections/:id/title', express.json({ limit: '8kb' }), (req, res) => {
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== req.query.k) return res.status(403).json({ error: 'forbidden' });
  if (db.effectiveStatus(c) !== 'open') {
    return res.status(409).json({ error: 'closed', message: 'האיסוף נסגר והמשחק בהפקה' });
  }
  const title = (req.body || {}).custom_title;
  // The SAME emoji refusal the order flow applies, with the same Hebrew message:
  // an emoji cannot be drawn onto the printed card, and the buyer should hear
  // about it in the one place she can still fix it.
  if (refuseEmojiTitle(res, { title })) return;
  const stored = db.setCustomTitleForOwner(req.params.id, req.query.k, title);
  if (stored === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true, custom_title: stored });
});

// A cutout part is named after the original it belongs to: "cut:pawn0" carries the
// cutout for the "pawn0" original. Pairing by NAME rather than by position keeps
// the two lists from sliding against each other when one photo is skipped.
const CUTOUT_PREFIX = 'cut:';

// The body of a pawn-images upload, shared by the OWNER route above (authenticated
// by the collection's owner token) and the ADMIN one below (authenticated by the
// admin key, then acting with the collection's own owner token). Everything after
// authentication is identical, so the cap/orphan-reclaim rules can't drift apart.
// The uploaded filename, reduced to something safe to hand back: a basename only
// (never a path) and bounded, because it is client-supplied text that a page then
// shows. The page renders it as textContent, so this is belt and braces.
function shortName(f) {
  const raw = String((f && f.filename) || '')
    .split(/[\\/]/)
    .pop()
    .trim();
  return raw ? raw.slice(0, 80) : null;
}

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
  // of files before the cap check. This is the BODY-SIZE cap, not the deck's: both
  // clients chunk to PAWN_BATCH_MAX and fill a bigger deck with several requests,
  // because PAWN_UPLOAD_LIMIT is sized for exactly this many photos-plus-cutouts.
  if (parts.length > PAWN_BATCH_MAX) {
    return res
      .status(400)
      .json({ error: 'too many images (max ' + PAWN_BATCH_MAX + ' per upload)' });
  }
  // Only persist as many images as there is room for. ROOM IS THE PLAYER COUNT,
  // not a fixed four: a deck laid out for sixteen players holds sixteen photos,
  // one per pawn (db.playersFor / db.addPawnImages, which caps the write the same
  // way). Hard-coding 4 here silently threw away every photo past the fourth on a
  // deck that had room for it. A full collection writes nothing at all — the DoS fix.
  const c = db.getCollection(id);
  const room = Math.max(
    0,
    db.playersFor(c) - (Array.isArray(c.pawn_images) ? c.pawn_images.length : 0)
  );
  const written = []; // { name, path, created } for every file THIS request wrote
  // ...and every part we could NOT store, with the reason. Fail-soft is right —
  // one bad photo must not lose the good ones — but SILENT fail-soft is not: this
  // answered 200 with a shorter list than the buyer picked, and her page had no
  // way to tell "you sent three, we kept two" from "you sent two". Reported back
  // so the page can say which photo did not make it and why.
  const skipped = [];
  for (const [name, f] of parts.slice(0, room)) {
    try {
      written.push({ name, ...content.saveImageBytes(f.data) });
    } catch (e) {
      skipped.push({
        name,
        filename: shortName(f),
        reason: /too large/i.test(String((e && e.message) || '')) ? 'too_large' : 'unsupported',
      });
    }
  }
  // A part we never even looked at because the collection was already full — she
  // sent more photos than her deck has pawns, or a second tab / the shared link
  // filled it first. Either way it is hers to know about rather than a photo that
  // quietly evaporated, which is what `skipped` carries back.
  for (const [name, f] of parts.slice(room)) {
    skipped.push({ name, filename: shortName(f), reason: 'no_room' });
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
    skipped,
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
// oracle (each call spawns Chrome). It also returns the shared word-font options
// so the client can render the picker.
//
// It no longer returns a name-language `warning`. See the comment where the
// check used to run, below.

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
  // NO NAME-LANGUAGE WARNING — for ANY theme, on ANY request. This route used to
  // answer with 'שם החוגג/ת צריך להיות באנגלית (בהתאם לעיצוב): "…"' whenever the
  // `name` was in the wrong script for the theme's name_form, and the wizard
  // printed it under the rendered card.
  //
  // It was a true statement once. The honoree's NAME was printed on the card,
  // composed into the theme's title template ("{NAME}'S BACHELORETTE"), so a
  // Hebrew name on a Latin-scripted design was something the buyer had to fix
  // before paying. That stopped being true when the buyer started typing the
  // whole title herself: the `name` this route still takes is only the order's
  // LABEL — the title's first line, used by the admin table, the collection page
  // and the emails — and nothing prints it. Every buyer types a Hebrew title, so
  // every one of the six Latin-scripted templates warned every buyer about text
  // that does not appear on her card.
  //
  // Deliberately deleted rather than made conditional (on a title, on the
  // theme's name_form, on a per-template flag). Anything conditional is a
  // per-template answer, and per-template answers drift: themes.json exists in
  // TWO layers — this repo's copy and the owner's own templates on the DATA_DIR
  // volume — so a template that only exists on the volume would have kept
  // warning long after the repo looked fixed. With no call there is no flag to
  // get wrong and no layer to forget.
  //
  // `checkNameLanguage` itself stays in validate.js. It still gates PRODUCTION
  // for an order that predates the typed title (validateOrderForProduction),
  // where the name really is composed into the printed title — there the note
  // explains a refusal about text the card does show.
  const themeWordFont = themeConfig.word_font || null;

  // 1) CACHE lookup FIRST, keyed by the raw inputs (identical requests map to the
  // same render). A hit returns instantly with no Chrome and WITHOUT consuming the
  // rate-limit budget. `options` (a tiny fs read) is needed only to build the meta.
  const cacheKey = previewCache.key({
    theme,
    name,
    wordFont: rawWordFont,
    extraFields,
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
      customTitle,
      calibration,
      withBoard,
      gender,
    });
    previewCache.set(cacheKey, imgs);
    res.json({
      ...imgs,
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
  //
  // A full collection is no longer turned away with a 402. It used to be, and
  // that 402 was where a locked buyer's words died: the request was refused
  // whole, so a paste sent from a tab opened before the lock landed left nothing
  // behind. db.addWords now parks anything the quota refuses (capped) instead of
  // dropping it, and it enforces the quota itself — over-quota words never reach
  // the word list from here either way. So the request goes through and the
  // response says exactly what happened to every word in it.
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
    // The split of `blocked`: `held` was parked for release on payment, `dropped`
    // hit the held-bucket cap and really is gone. The page must be able to tell
    // these apart — claiming we kept a word we didn't is the exact failure this
    // whole change exists to fix, so it is never inferred, always reported.
    held: r.held || 0,
    dropped: r.dropped || 0,
    // Everything the collection is holding after this request, not just what this
    // request added to it, so a reload and a fresh add agree on the number.
    held_count: db.countHeldWords(req.params.id),
    // How many entries were over the length cap and therefore NOT stored. The
    // page normally filters these out before submitting (so the customer is told
    // while typing), but a paste from an old tab or a non-browser client still
    // lands here — the count plus `max_word_len` lets any caller say exactly what
    // was refused and why.
    too_long: r.tooLong || 0,
    max_word_len: validate.MAX_WORD_LEN,
    // How many entries were refused because the deck is already full, and the
    // size of that deck. Reported apart from `blocked` (the payment quota)
    // because the two mean opposite things to the buyer: one clears when she
    // pays, the other never does.
    full: r.full || 0,
    deck_words: db.deckWordsFor(c),
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
        // A no-fill order freezes HER WORDS and nothing else — that IS the bank
        // for this order, and freezing a topped-up one would store 412 words
        // production is then told not to print.
        noTopup: !!c.no_topup,
        // THE DECK THIS ORDER ACTUALLY HAS. Not a constant: the buyer's player
        // count decides how many of the 104 cards are pawn cards, and every pawn
        // card costs four words. Without this the freeze ran topup.py at its own
        // module default (412, the standard deck) for every order, so a
        // 16-player deck — which holds 400, and whose buyer was capped at 400 —
        // froze 412 and printed 107 cards / 214 pages. The number the buyer was
        // held to while collecting (db.deckWordsFor, the same call the collect
        // page's counter reads) is the number production is sized to.
        deckWords: db.deckWordsFor(c),
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

// A PAID order just became a DELIVERY order, because the buyer bought shipping
// after the fact. The owner now has a parcel to send that she did not have this
// morning, and an address she has never seen.
//
// Deliberately a SYSTEM ALERT and not a new customer-facing email template. The
// buyer needs no letter: she paid on screen, saw it succeed, and the collection
// page tells her the game is being shipped. The person who has to DO something is
// the owner — and an alert reaches her through the operational channel that is
// already there, rather than adding a template, a settings key and an on/off
// toggle to a mail catalog that is not this change's to grow.
//
// Fire-and-forget, like every other notification on the payment path: a failed
// send must never turn a successful charge into a failed callback.
function onShippingAdded(collectionId, base, amountCharged) {
  const c = db.getCollection(collectionId);
  if (!c || !c.order) return;
  const addr = notify.formatAddress(c.order.address);
  const lines = [
    'הזמנה: ' + db.orderRef(c),
    'בעל/ת השמחה: ' + (c.honoree_name || '—'),
    'הלקוח/ה הוסיפ/ה משלוח עד הבית אחרי התשלום, ושילמ/ה ' +
      (Number.isFinite(amountCharged) ? amountCharged : c.order.delivery_fee) +
      ' ₪ נוספים.',
    addr ? 'כתובת למשלוח: ' + addr : 'כתובת למשלוח: —',
    base && ADMIN_KEY
      ? 'לוח ההזמנות: ' + base + '/admin.html?key=' + encodeURIComponent(ADMIN_KEY)
      : '',
  ].filter(Boolean);
  notify.sendSystemAlert('נוסף משלוח להזמנה קיימת', lines).catch(() => {});
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
// name and the collect link. That link is the MANAGING one now — the owner token
// and all — because the product has stopped keeping two: the buyer pastes the
// same URL into the group herself the moment she shares it, so a bot posting a
// token-free variant only meant the group held two links with different powers
// and no way to tell them apart. What it costs (anyone in the group can delete a
// word or close the collection) is the owner's decision; see friendsUrl() in
// site/collect.html. `base` is the normalized public origin.
function waGroupValues(collection, base) {
  const honoree = (collection && collection.honoree_name) || 'בעל/ת השמחה';
  const link =
    base && collection && collection.id && collection.owner_token
      ? base + '/collect.html?c=' + collection.id + '&k=' + collection.owner_token
      : '';
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
//
// EVERY TRANZILA CALL MINTS A PAY SESSION, and a session's token is what the
// Tranzila notify, its retries and its limits are keyed by — so an unbounded
// pay/init is an unbounded supply of real tokens. Limited per client (before
// anything else) and per collection (after the owner check, so a stranger cannot
// spend a buyer's budget), for Tranzila only: PeleCard's flow is unchanged. The
// client is paymentClientIp (server/payment-client-ip.js), the address our own
// proxy saw, never an X-Forwarded-For entry the client wrote. Shared with
// shipping/init, which mints sessions the same way.
const payInitIpRate = makeRateLimiter({
  limit: positiveNumber(process.env.PAY_INIT_RATE_LIMIT_IP, 60),
  windowMs: 10 * 60 * 1000,
  maxKeys: 10000,
});
// The per-client key, and — only while TRANZILA_LOG_CLIENT_IP=1, for the one-off
// go-live check that our proxy hop count is right — the headers it came from.
// Off by default: these are buyers' addresses.
function payInitClientKey(req) {
  const key = paymentClientIp(req);
  if (process.env.TRANZILA_LOG_CLIENT_IP === '1') {
    console.log(
      '[tranzila] client key ' +
        key +
        ' x-forwarded-for=' +
        JSON.stringify(req.headers['x-forwarded-for'] || '') +
        ' cf-connecting-ip=' +
        JSON.stringify(req.headers['cf-connecting-ip'] || '')
    );
  }
  return key;
}
const payInitCollectionRate = makeRateLimiter({
  limit: positiveNumber(process.env.PAY_INIT_RATE_LIMIT_COLLECTION, 20),
  windowMs: 10 * 60 * 1000,
  maxKeys: 10000,
});
app.post('/api/collections/:id/pay/init', async (req, res) => {
  const provider = cardProvider();
  if (!provider) {
    return res.status(503).json({ error: 'card payment not configured' });
  }
  const base = paymentBaseUrl();
  if (!base) return res.status(503).json({ error: 'payment base url not configured' });
  const limited = provider.NAME === tranzila.NAME;
  if (limited && !payInitIpRate.ok(payInitClientKey(req))) {
    return res.status(429).json({ error: 'too many attempts' });
  }

  const b = req.body || {};
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== b.owner_token) return res.status(403).json({ error: 'forbidden' });
  if (limited && !payInitCollectionRate.ok(c.id)) {
    return res.status(429).json({ error: 'too many attempts' });
  }
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
    // The reason travels with the refusal: between the preview and this click
    // someone else can have spent the code's last use, and "the coupon ran out"
    // is a very different thing to read than "we could not open the payment".
    if (!v.valid) return res.status(400).json({ error: 'invalid coupon', reason: v.reason });
    discountPct = v.coupon.discount_pct;
    couponCode = v.coupon.code;
  }
  // charged_total is ALWAYS a real number — the full total when no coupon.
  //
  // A COUPON BUYS A GAME, NOT POSTAGE. The percentage comes off the game money
  // only — unit price × copies — and the delivery fee is added back whole. It
  // used to come off `order.total`, which already includes the fee, so a 50%
  // code halved the courier's charge too and a 100% code shipped a parcel for
  // nothing. commissionFor (server/db.js) has always stated this rule and
  // computes its percent on the same base; the discount now agrees with it.
  //
  // A consequence worth naming: a 100% code on a DELIVERY order is no longer a
  // free order. The game is free, the shipping is not, so it goes through the
  // card for the fee alone — the free path below only sees a real zero.
  // The checkout screen (site/collect.html renderTotal) mirrors this exactly;
  // a change to either belongs in both.
  const fee =
    Number.isInteger(order.delivery_fee) && order.delivery_fee > 0 ? order.delivery_fee : 0;
  const gameMoney = Math.max(0, order.total - fee);
  const charged = Math.round(gameMoney * (1 - discountPct / 100)) + fee;

  // A base order total can never be 0 (version prices validate as >= 1 and the
  // charge falls back to a positive default), so charged<=0 is ONLY reachable via
  // a coupon that discounts to zero. Guard defensively: if the charge rounds to 0
  // with NO coupon, something is wrong — refuse rather than mark a paid-at-₪0
  // order. Only a real coupon may take the free/skip-PeleCard path.
  if (charged <= 0 && !couponCode) {
    return res.status(400).json({ error: 'invalid order total' });
  }

  // The buyer's own request, captured HERE because it is the last one they make
  // before the money moves: their IP, their browser, Meta's first-party cookies
  // and the ad they landed on. The sale is reported to Meta from the PeleCard
  // callback, which is a request from PeleCard's server — none of this exists
  // there. Null when the Conversions API is not armed.
  const adCtx = metaAdContext(req, b);

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
      // No PeleCard handshake on this path, so the buyer's details and the Meta
      // claim ride in on markPaid's own write — one write, not three.
      metaCtx: adCtx,
      metaClaim: Boolean(adCtx),
    });
    if (couponCode) db.incrementCouponUses(couponCode);
    // A free order is a conversion too, and this is the request the buyer made
    // themselves — so Meta is told here and now, with their own browser's
    // details, rather than waiting for a confirmation page that may never load.
    // Guarded: this handler is `async`, and Express 4 does not route a rejected
    // one to error middleware — an unanswered request and a dead process is not
    // a price a measurement side-effect may charge.
    try {
      if (adCtx) sendPurchaseToMeta(req.params.id, adCtx, { preclaimed: true });
    } catch (e) {
      console.error('[meta-capi] ' + req.params.id + ': ' + ((e && e.message) || e));
    }
    // A free (100%-coupon) order is now paid — fire the same payment receipts as
    // the PeleCard callback, showing the real charged amount (0, which the emails
    // render as "free — 100% coupon" rather than a bare price).
    onOrderPaid(req.params.id, base, 0);
    return res.json({ free: true, paid: true, total: 0 });
  }

  // A Tranzila token carries this environment (tranzila.newSessionToken), so a
  // sweep on the shared terminal can tell its own charges from the other's.
  const paramToken = provider.NAME === tranzila.NAME ? tranzila.newSessionToken() : newPayToken();
  try {
    const { url, transactionId } = await provider.init({
      amountNis: charged,
      paramToken,
      urls: paymentUrls(base, paramToken),
      buyer: { email: c.owner_email, phone: c.owner_phone },
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
      metaCtx: adCtx,
      provider: provider.NAME,
      priceKey: db.orderPriceKey(order),
      // Not in the key — kept so a settle can tell the owner the fee moved under
      // it, rather than refusing a charge the buyer made correctly.
      feeAtInit: Number(order.delivery_fee) || 0,
    });
    res.json({ url, total: order.total, charged });
  } catch (e) {
    res.status(502).json({ error: 'payment init failed' });
  }
});

// Owner-only: buy DELIVERY for an order that is already paid.
//
// She picked pickup, the party moved, and now she wants it sent. The paid order
// is immutable to public callers on purpose (setOrder refuses outright — it is
// the only thing between a paid order and a client re-posting a cheaper
// version), so this is its own small purchase: the shipping fee, charged once,
// on its own PeleCard session. db.markShippingPaid then converges the order onto
// version 'delivery' with the address, which is what makes every reader
// downstream — the orders table, the emails, the press run — need to know
// nothing about upgrades.
//
// NO COUPONS here, deliberately: a discount code buys a game, not postage.
//
// Refused once the collection is CLOSED (db.shippingUpgrade), which is the
// owner's rule and the honest one — by then the deck is at the printer and where
// it goes has already been decided.
app.post('/api/collections/:id/shipping/init', async (req, res) => {
  const provider = cardProvider();
  if (!provider) {
    return res.status(503).json({ error: 'card payment not configured' });
  }
  const base = paymentBaseUrl();
  if (!base) return res.status(503).json({ error: 'payment base url not configured' });
  const limited = provider.NAME === tranzila.NAME;
  if (limited && !payInitIpRate.ok(payInitClientKey(req))) {
    return res.status(429).json({ error: 'too many attempts' });
  }

  const b = req.body || {};
  const c = db.getCollection(req.params.id);
  if (!c || c.owner_token !== b.owner_token) return res.status(403).json({ error: 'forbidden' });
  if (limited && !payInitCollectionRate.ok(c.id)) {
    return res.status(429).json({ error: 'too many attempts' });
  }

  // Stage it (address sanitized, fee re-read from settings, availability
  // re-checked — the collection can close between rendering the offer and
  // pressing the button).
  const shipping = db.startShippingUpgrade(req.params.id, b.owner_token, { address: b.address });
  if (shipping.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (shipping.error === 'already paid') return res.status(409).json({ error: 'already paid' });
  if (shipping.error === 'closed') {
    return res.status(409).json({ error: 'closed', message: 'האיסוף נסגר והמשחק בהפקה' });
  }
  if (shipping.error) return res.status(400).json({ error: shipping.error });

  const charged = shipping.fee;
  // The fee is validated as a positive integer before the upgrade is ever
  // offered, so this is unreachable — and it is here because a 0-charge PeleCard
  // init is the one failure mode that would look like a free upgrade.
  if (!(charged > 0)) return res.status(400).json({ error: 'invalid order total' });

  // A Tranzila token carries this environment (tranzila.newSessionToken), so a
  // sweep on the shared terminal can tell its own charges from the other's.
  const paramToken = provider.NAME === tranzila.NAME ? tranzila.newSessionToken() : newPayToken();
  try {
    const { url, transactionId } = await provider.init({
      amountNis: charged,
      paramToken,
      urls: paymentUrls(base, paramToken),
      buyer: { email: c.owner_email, phone: c.owner_phone },
    });
    db.recordShippingInit(req.params.id, {
      paramToken,
      transactionId,
      charged_total: charged,
      provider: provider.NAME,
      priceKey: db.shippingPriceKey(shipping),
      feeAtInit: Number(shipping.fee) || 0,
    });
    res.json({ url, charged });
  } catch {
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
    const match = db.findPaySession(parsed.paramX);
    const holder =
      match &&
      (match.kind === 'shipping'
        ? match.collection.order.shipping.pelecard
        : match.collection.order.pelecard);
    transactionId =
      (match && match.session && match.session.transaction_id) ||
      (holder && holder.last_transaction_id) ||
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
  //
  // Two kinds of purchase arrive here now: the ORDER, and a SHIPPING upgrade
  // bought on top of an already-paid one. PeleCard has one callback URL and one
  // token space, so the token is what tells them apart — and it must, because the
  // "is it already paid?" guard is a different flag for each and the shipping
  // charge is a different (smaller) amount than the order's.
  const match = db.findPaySession(tx.paramX);
  if (
    match &&
    match.session &&
    (match.session.provider || 'pelecard') === pelecard.NAME &&
    pelecard.verifyTransaction(tx, { amountNis: match.session.charged_total })
  ) {
    settleVerifiedPayment(match, {
      method: pelecard.NAME,
      transactionId: tx.transactionId,
      approvalNo: tx.approvalNo,
    });
  }
  res.json({ ok: true });
});

// A VERIFIED charge lands. Shared by both providers' callbacks, so what a paid
// order means — receipts, the coupon count, Meta's copy of the sale, a shipping
// upgrade converging the order — cannot differ by who cleared the card.
//
// `match` is db.findPaySession's { collection, session, kind }; the caller has
// already proven the charge belongs to that session and is for its amount.
// Idempotent on each purchase's own paid flag, because a provider may call twice.
function settleVerifiedPayment(match, { method, transactionId, approvalNo }) {
  const c = match.collection;
  const session = match.session;
  if (match.kind === 'shipping') {
    if (c.order.shipping.paid) return false;
    db.markShippingPaid(c.id, {
      method,
      transactionId,
      approvalNo,
      token: session.token,
      charged_total: session.charged_total,
    });
    // The order is a DELIVERY order from this moment (db.markShippingPaid), so
    // the owner is told the same way she is told about any other change of
    // fulfilment — she has a parcel to send that she did not have this morning.
    onShippingAdded(c.id, paymentBaseUrl(), session.charged_total);
    return true;
  }
  if (c.order.paid) return false;
  // metaClaim: the Meta report is claimed inside THIS write. The alternative
  // was a second synchronous whole-store write on the hot path of a charge
  // that has just cleared, for a measurement side-effect.
  const metaArmed = metaCapiArmed();
  db.markPaid(c.id, {
    method,
    transactionId,
    approvalNo,
    token: session.token,
    charged_total: session.charged_total,
    coupon: session.coupon,
    discount_pct: session.discount_pct,
    metaClaim: metaArmed,
  });
  // Count the coupon use once, on the real unpaid->paid transition.
  if (session.coupon) db.incrementCouponUses(session.coupon);
  // Fire the owner + buyer payment receipts, showing the amount ACTUALLY
  // charged for THIS session (never the pre-coupon order.total). Gated on
  // email being configured inside onOrderPaid, and fire-and-forget — a failed
  // send must never turn a successful charge into a failed callback.
  onOrderPaid(c.id, paymentBaseUrl(), session.charged_total);
  // Meta's copy of the sale, sent from HERE — the moment the money actually
  // landed, in a request made by the provider's server. Nothing about the
  // buyer's browser can suppress it: a closed tab, a blocked pixel and an in-app
  // browser that drops third-party scripts all still produce this call. The
  // buyer's own details ride along from the pay/init handshake (meta_ctx).
  // Guarded: an `async` handler in Express 4 does not route a rejection to
  // error middleware, and a payment callback must answer the provider whatever
  // an ad platform is doing.
  try {
    if (metaArmed) sendPurchaseToMeta(c.id, null, { preclaimed: true });
  } catch (e) {
    console.error('[meta-capi] ' + c.id + ': ' + ((e && e.message) || e));
  }
  return true;
}

// TRANZILA: SETTLED FROM THE TERMINAL'S OWN ROWS (server/tranzila-sweep.js).
//
// Tranzila's notify (notify_url_address, built in paymentUrls) is UNSIGNED and
// nothing documents it being retried, so it decides nothing. For a real, unpaid
// Tranzila session it only asks for a sweep, and answers 200. The sweep reads the
// terminal's transaction rows from the Reports API with our secret key — the only
// thing that proves a charge — and matches each to its pay session by the token
// the row carries. A row pays for a session only when approved, a DEBIT in
// standard mode on a regular plan, in shekels, for that session's exact amount,
// carrying that session's token, and not already spent on another purchase.
//
// Invented indexes and tokens are not rows. A flood of notifies therefore costs
// at most one sweep per TRANZILA_SWEEP_MIN_SPACING_MS, writes nothing per
// session, and can neither settle nor alert anything.
const tzLimit = (name, fallback) => positiveNumber(process.env[name], fallback);

// A real Tranzila session for this token, or null.
function tranzilaMatch(token) {
  const m = token ? db.findPaySession(token) : null;
  return m && m.session && m.session.provider === tranzila.NAME ? m : null;
}
function tranzilaPurchasePaid(match) {
  return match.kind === 'shipping'
    ? !!match.collection.order.shipping.paid
    : !!match.collection.order.paid;
}

// Decide one row of the terminal's report. Settles what verifies; returns an
// `alert` for an approved row a person has to look at:
//   • it carries one of our sessions' tokens but did not settle — a hold, a
//     wrong amount, a foreign currency, or a second charge on a purchase that is
//     already paid;
//   • it is an approved DEBIT carrying no session token at all — the token field
//     missing or misnamed on the terminal, or a charge made outside the site.
// Staging and production share the terminal: a row whose session token was
// minted in the OTHER environment is neither settled nor reported here. A row
// with no session token at all (an old or manual charge in My Tranzila, or a
// misconfigured token field) is reported by production only.
// Money going back to the buyer. A refund of a paid order carries its token too,
// and is nothing to report.
const TRANZILA_REFUND_TYPES = new Set(['CREDIT', 'CANCEL', 'REFUTE', 'REVERSAL']);
// The types a row can be and still be money the buyer meant to pay us: a real
// charge, or an attempt that took none (a hold or a card check — what a buyer who
// edits the iframe URL produces, and the one thing an unsettled row must still
// report). A type outside this set is money going the other way under a name this
// list does not know, so it is NOT reported as a suspected second charge: the
// real strings are confirmed in the staging test (server/TRANZILA.md). A row with
// no type at all stays reportable — an unreadable charge on our own token is
// exactly what the owner should see.
const TRANZILA_CHARGE_ATTEMPT_TYPES = new Set(['DEBIT', 'FORCE', 'VERIFY', 'J5', 'J2']);

function decideTranzilaRow(tx) {
  if (tx.responseCode !== tranzila.SUCCESS_CODE) return { outcome: 'ignored' };
  if (db.isTransactionUsed(tranzila.NAME, tx.index)) return { outcome: 'used' };
  if (TRANZILA_REFUND_TYPES.has(tx.txnType)) return { outcome: 'ignored' };
  const env = tranzila.envTag();
  const tokens = tranzila.sessionTokenValues(tx.raw);
  const mine = tokens.filter((t) => tranzila.tokenEnv(t) === env);
  if (tokens.length && !mine.length) return { outcome: 'other_env' };
  const matches = mine.map(tranzilaMatch).filter(Boolean);
  // Verified charges whose order has changed since their pay window opened.
  const repriced = [];
  for (const m of matches) {
    if (tranzilaPurchasePaid(m)) continue;
    const ok = tranzila.verifyTransaction(tx, {
      amountNis: m.session.charged_total,
      token: m.session.token,
    });
    if (!ok) continue;
    // The purchase must still be priced as it was when this window opened: the
    // buyer may have closed a cheaper window and changed the order since.
    const current =
      m.kind === 'shipping'
        ? db.shippingPriceKey(m.collection.order.shipping)
        : db.orderPriceKey(m.collection.order);
    if (!m.session.price_key || m.session.price_key !== current) {
      repriced.push(m);
      continue;
    }
    // The fee the purchase carries NOW, against what this window quoted. It is
    // not part of the key on purpose, so it never refuses the charge — but if it
    // moved, the order is about to be marked paid with a `total` that no longer
    // equals what the card was charged, and nobody would know. Settle, and tell
    // her. Unbounded by design: a 39 -> 390 typo settles exactly like a 39 -> 59
    // rise, and the size of the gap is precisely what she needs to see.
    const quoted = m.session.fee_at_init;
    const feeNow =
      m.kind === 'shipping'
        ? Number(m.collection.order.shipping.fee)
        : Number(m.collection.order.delivery_fee) || 0;
    const feeMoved = quoted != null && Number(quoted) !== feeNow;
    const totalNow =
      m.kind === 'shipping'
        ? Number(m.collection.order.shipping.fee)
        : Number(m.collection.order.total);

    settleVerifiedPayment(m, {
      method: tranzila.NAME,
      transactionId: tx.index,
      approvalNo: tx.approvalNo,
    });
    if (!feeMoved) return { outcome: 'settled' };
    console.error(
      '[tranzila] index ' + tx.index + ' settled after the delivery fee moved since its pay window'
    );
    return {
      outcome: 'settled',
      alert: {
        amount: tx.amountAgorot,
        type: tx.txnType,
        mode: tx.tranmode,
        date: tx.raw && tx.raw.transaction_date ? String(tx.raw.transaction_date) : null,
        kind: 'fee_changed',
        orders: [m.collection.order_no || m.collection.id],
        expected: [Math.round(Number(m.session.charged_total) * 100)],
        now: [Math.round(totalNow * 100)],
      },
    };
  }
  const base = {
    amount: tx.amountAgorot,
    type: tx.txnType,
    mode: tx.tranmode,
    date: tx.raw && tx.raw.transaction_date ? String(tx.raw.transaction_date) : null,
  };
  if (repriced.length) {
    console.error('[tranzila] index ' + tx.index + ' paid for an order that has changed since');
    return {
      outcome: 'rejected',
      alert: {
        ...base,
        kind: 'order_changed',
        orders: repriced.map((m) => m.collection.order_no || m.collection.id),
        // What that pay window was priced at — the charge had to equal it to
        // verify — and what the purchase costs NOW. The gap between the two is
        // the refusal, and both belong in the message so the owner can act on it
        // without opening the store.
        expected: repriced.map((m) => Math.round(Number(m.session.charged_total) * 100)),
        now: repriced.map((m) =>
          Math.round(
            Number(
              m.kind === 'shipping' ? m.collection.order.shipping.fee : m.collection.order.total
            ) * 100
          )
        ),
      },
    };
  }
  if (
    matches.length &&
    tx.txnType &&
    !TRANZILA_CHARGE_ATTEMPT_TYPES.has(tx.txnType) &&
    // ONLY when every purchase this row could belong to is ALREADY PAID. An
    // unknown type on an UNPAID purchase is the dangerous shape: verifyTransaction
    // settles 'DEBIT' alone, and the exact string a normal iframe charge reports
    // is unconfirmed until the staging test. If it turns out to be anything else,
    // the row fails verification and would be swallowed here — the buyer charged,
    // the order unpaid, nobody told, on EVERY payment. It falls through to the
    // 'unverified' alert instead, which is the fail-closed promise TRANZILA.md
    // makes. A real refund carries a paid order's token, so it is still ignored.
    matches.every(tranzilaPurchasePaid)
  ) {
    // Our token, approved, but a type this build does not know as a charge: most
    // likely money going back (a refund under another name). Not a second charge.
    return { outcome: 'ignored' };
  }
  if (matches.length) {
    // Enough to diagnose from the Railway log, and nothing about the card.
    console.error(
      '[tranzila] index ' +
        tx.index +
        ' carries a session token but did not settle: type=' +
        tx.txnType +
        ' mode=' +
        tx.tranmode +
        ' currency=' +
        tx.currency +
        ' amount=' +
        tx.amountAgorot
    );
    return {
      outcome: 'rejected',
      alert: {
        ...base,
        kind: 'unverified',
        orders: matches.map((m) => m.collection.order_no || m.collection.id),
        expected: matches.map((m) => Math.round(Number(m.session.charged_total) * 100)),
      },
    };
  }
  // Money that may have moved with nothing here to match it against, so it is
  // reported whatever its type — NOT only a `DEBIT`. verifyTransaction settles
  // DEBIT alone, but the string a normal iframe charge reports is unconfirmed
  // until the staging test, so a row typed anything else, or typed nothing, is
  // exactly the one nobody can account for. Every refund type already returned at
  // the top of this function, so there is no money-going-back test to repeat
  // here; production is the only condition left. Keep that early return if these
  // branches are ever edited — it is what makes this safe.
  //
  // This environment's token and no session for it: the collection was deleted,
  // or the session evicted, while its charge was on its way. Money was taken.
  if (mine.length) {
    if (env === 'p') {
      return { outcome: 'rejected', alert: { ...base, kind: 'orphan' } };
    }
    return { outcome: 'ignored' };
  }
  if (env === 'p') {
    return { outcome: 'rejected', alert: { ...base, kind: 'unmatched' } };
  }
  return { outcome: 'ignored' };
}

// One line per row for the owner. Order numbers, indexes and amounts only: no
// tokens, no card details, no keys.
function describeTranzilaAlert(item) {
  if (item.kind === 'sweep_failing') {
    return (
      'בדיקת העסקאות מול טרנזילה נכשלת מאז ' +
      new Date(Number(item.since)).toISOString() +
      ' (' +
      (item.error || 'שגיאה') +
      ') — תשלומים לא יסומנו כשולמים עד שזה יחזור לעבוד.'
    );
  }
  if (item.kind === 'sweep_recovered') {
    return (
      'בדיקת העסקאות מול טרנזילה חזרה לעבוד (נכשלה מאז ' +
      new Date(Number(item.since)).toISOString() +
      '); העסקאות מהזמן הזה נבדקות עכשיו.'
    );
  }
  const head =
    'עסקה ' +
    item.index +
    (item.date ? ' (' + item.date + ')' : '') +
    ' · ' +
    (item.amount != null ? item.amount + ' אגורות' : 'סכום לא ידוע') +
    ' · ' +
    (item.type || '-') +
    '/' +
    (item.mode || '-');
  if (item.kind === 'unmatched') {
    return head + ' — אושרה ולא שייכת לאף הזמנה (האם שדה dugri_token מוגדר במסוף?)';
  }
  if (item.kind === 'orphan') {
    return head + ' — אושרה עבור הזמנה שכבר לא קיימת במערכת (נמחקה?)';
  }
  // Money DID move and the order IS paid — this one is a notice, not a refusal.
  if (item.kind === 'fee_changed') {
    return (
      head +
      ' — שולמה וסומנה כשולמה עבור הזמנה ' +
      (item.orders || []).join(', ') +
      ', אבל דמי המשלוח השתנו מאז שנפתח חלון התשלום: נגבה ' +
      (item.expected || []).join('/') +
      ' אגורות וההזמנה עכשיו ' +
      (item.now || []).join('/') +
      ' אגורות. להשלים או לזכות את ההפרש לפי הצורך.'
    );
  }
  if (item.kind === 'order_changed') {
    return (
      head +
      ' — שולמה עבור הזמנה ' +
      (item.orders || []).join(', ') +
      ' שהשתנתה מאז שנפתח חלון התשלום (חלון התשלום: ' +
      (item.expected || []).join('/') +
      ' אגורות · ההזמנה עכשיו: ' +
      (item.now || []).join('/') +
      ' אגורות), ולכן לא סומנה כשולמה'
    );
  }
  return (
    head +
    ' — לא אומתה עבור הזמנה ' +
    (item.orders || []).join(', ') +
    ' (צפוי ' +
    (item.expected || []).join('/') +
    ' אגורות)'
  );
}

// OWNER ALERTS. Everything queued goes in one batch, split into messages of
// TRANZILA_ALERT_CHUNK lines so each fits WhatsApp. Answers with the items whose
// message really went out; the sweep marks only those reported, so a message
// that failed is sent again alone and one that arrived is never repeated. A batch
// takes one of the TRANZILA_ALERT_RATE_LIMIT hourly slots, and only once
// something reached the owner — failed attempts cost nothing. With no channel
// configured at all there is nobody to tell: logged loudly, and counted as
// delivered so the queue does not grow for ever.
const tranzilaAlertSends = [];
function tranzilaAlertCapFull(at) {
  while (tranzilaAlertSends.length && at - tranzilaAlertSends[0] >= 60 * 60 * 1000) {
    tranzilaAlertSends.shift();
  }
  return tranzilaAlertSends.length >= tzLimit('TRANZILA_ALERT_RATE_LIMIT', 5);
}
async function deliverTranzilaAlerts(items) {
  const at = Date.now();
  if (tranzilaAlertCapFull(at)) return [];
  const size = Math.floor(tzLimit('TRANZILA_ALERT_CHUNK', 15));
  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  const delivered = [];
  for (let i = 0; i < parts.length; i++) {
    const subject =
      'טרנזילה: ' +
      items.length +
      ' פריטים לבדיקה' +
      (parts.length > 1 ? ' (' + (i + 1) + '/' + parts.length + ')' : '');
    const body = parts[i]
      .map(describeTranzilaAlert)
      .concat(['לבדוק ב-My Tranzila אם נגבה כסף, ולזכות או לסמן ידנית לפי הצורך.']);
    let ok = await notify.sendSystemAlert(subject, body).catch(() => false);
    if (!ok) ok = await alertOwnerViaWhatsApp(subject, body);
    if (!ok && !notify.isConfigured() && !ownerWaId()) {
      console.error('[tranzila] OWNER ALERT, no channel configured: ' + body.join(' | '));
      ok = true;
    }
    if (ok) delivered.push(...parts[i]);
  }
  if (delivered.length) tranzilaAlertSends.push(at);
  return delivered;
}

const tranzilaSweeper = createSweeper({
  state: {
    get: () => db.tranzilaSweepState(),
    save: () => db.saveTranzilaSweepState(),
  },
  listRows: (range) => tranzila.listTransactions(range),
  decide: decideTranzilaRow,
  deliver: deliverTranzilaAlerts,
  hasRecentUnpaid: (at) => db.hasRecentUnpaidProviderSession(tranzila.NAME, at - 30 * 60 * 1000),
  minSpacingMs: tzLimit('TRANZILA_SWEEP_MIN_SPACING_MS', 10 * 1000),
  overlapMs: tzLimit('TRANZILA_SWEEP_OVERLAP_MS', 60 * 60 * 1000),
  failAlertAfterMs: tzLimit('TRANZILA_SWEEP_FAIL_ALERT_MS', 15 * 60 * 1000),
});

app.post('/api/payment/tranzila/notify', (req, res) => {
  const parsed = tranzila.parseNotify(req.body || {}, req.query || {});
  // A declined card is reported here too; a plain failure code asks for nothing.
  // Safe although the field is untrusted: a forged "declined" cannot stop the
  // periodic sweep from finding a real charge.
  const failed = parsed.response && parsed.response !== tranzila.SUCCESS_CODE;
  if (tranzila.isConfigured() && parsed.token && !failed) {
    const match = tranzilaMatch(parsed.token);
    // Only a window whose charge could still be on its way asks for a sweep: the
    // purchase unpaid, the session opened within the TTL. Being "resolved" is not
    // part of it — the browser's close beacon resolves the session while the
    // order is still unpaid on this provider, and a buyer who paid and closed the
    // window is exactly who needs the fast settle. A stale token still ages out
    // after 20 minutes, so it cannot drive sweeps for ever.
    if (match && !tranzilaPurchasePaid(match) && db.isPaySessionRecent(match.session)) {
      tranzilaSweeper.request();
    }
  }
  res.json({ ok: true });
});

// Tranzila returns the pay window to its success/fail page by POST, where
// PeleCard used GET. express.static answers GET only, so without this the buyer
// would be looking at a 404 inside the window they just paid in. Bounce it to the
// same address as a GET; the page reads nothing but its own ?error flag.
app.post('/pay-done.html', (req, res) => res.redirect(303, req.originalUrl));

// APPLE PAY DOMAIN VERIFICATION. Apple checks this exact, extension-less address
// on the domain the buyer pays on before Tranzila's page may show Apple Pay. The
// file is Tranzila's (the same for every Tranzila merchant, published at
// api.tranzila.com/assets/apple_pay/merchant_authentication_file.zip) and public.
// It needs its own route: express.static skips dot-directories, and the SPA
// fallback below would answer an extension-less path with the homepage.
const APPLE_PAY_DOMAIN_FILE = path.join(
  __dirname,
  'apple-pay',
  'apple-developer-merchantid-domain-association'
);
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.type('text/plain');
  res.sendFile(APPLE_PAY_DOMAIN_FILE);
});

// Agent B: template onboarding and settings, in server/routes/catalog.js.
catalogRoutes.registerTemplateOnboarding(app, {
  requireAdmin,
  express,
  path,
  __dirname,
  pathToFileURL,
  TEMPLATE_ROOT,
  TEMPLATE_UPLOAD_LIMIT,
  PYTHON_BIN,
  templates,
});

// Admin: REMOVE an optional asset — today the two second fonts, and only those.
// The undo for a font uploaded to the wrong role or the wrong template, which
// until now could only be repaired by hand-editing themes.json on the volume.
// templates.clearAsset refuses every other role, so this cannot strip a template
// of a font it needs to render.
const TYPEFIT_TIMEOUT_MS = Number(process.env.TYPEFIT_TIMEOUT_MS || 15000);

// Admin: WHAT THE PRESS WILL ACTUALLY SET for a template, some words and a set of
// unsaved knobs — answered by the generator itself (generator/typefit.py).
//
// The calibration screen carries its own copy of the fit so it can answer while a
// box is being dragged, and a second implementation of anything drifts. This one
// has: it read 21.05 where the press printed 12.94, clamped a pinned size the
// press honours, and fed the settled pitch back into the spacing so a wall of
// cards decayed. Each was invisible until the two answers sat side by side — so
// now they always do, on the page, rather than in a customer's deck.
app.post('/api/admin/templates/:key/typefit', express.json({ limit: '64kb' }), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const payload = JSON.stringify({
    theme: req.params.key,
    words: Array.isArray(body.words) ? body.words.slice(0, 8).map(String) : [],
    title_lines: Array.isArray(body.title_lines) ? body.title_lines.slice(0, 6).map(String) : null,
    // Unsaved knobs answer for themselves: the owner is asking about numbers she
    // has not committed to, which is the only moment the answer is useful.
    overrides: body.overrides && typeof body.overrides === 'object' ? body.overrides : {},
  });
  // Through spawnGenerator like every other generator run — it is what makes the
  // child its own process group, so a wedged one can be taken down whole.
  const child = spawnGenerator([path.join(REPO_ROOT, 'generator', 'typefit.py')], {
    cwd: path.join(REPO_ROOT, 'generator'),
  });
  // It answers in well under a second; a run that does not is wedged, and the
  // screen asks again on the next keystroke rather than holding a socket open.
  const timer = setTimeout(() => killGenerator(child), TYPEFIT_TIMEOUT_MS);
  let out = '';
  let err = '';
  const done = (code) => {
    clearTimeout(timer);
    if (res.headersSent) return;
    if (code !== 0) {
      return res.status(502).json({ error: 'typefit failed', detail: err.trim().slice(-400) });
    }
    try {
      res.json(JSON.parse(out));
    } catch {
      res.status(502).json({ error: 'typefit answered nothing readable' });
    }
  };
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => {
    err += String(e.message);
    done(-1);
  });
  child.on('close', done);
  child.stdin.end(payload);
});

// Admin: the EFFECTIVE entry for one template — shipped defaults with the owner's
// overrides merged, i.e. what the generator reads. The calibration screen needs the
// whole entry; /export answers the owner layer only and the status list is a fixed
// projection that omits most of the type knobs.
app.get('/api/admin/templates/:key/entry', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let result;
  try {
    result = templates.templateEntry({ root: TEMPLATE_ROOT, key: req.params.key });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  if (result.error) return res.status(result.httpStatus || 400).json({ error: result.error });
  res.setHeader('Cache-Control', 'no-cache');
  res.json(result);
});

// Agent B: read or remove a template asset, in server/routes/catalog.js.
catalogRoutes.registerTemplateAssets(app, { requireAdmin, TEMPLATE_ROOT, templates });

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

// Agent B: revert a shipped template, in server/routes/catalog.js.
catalogRoutes.registerTemplateRevert(app, { requireAdmin, TEMPLATE_ROOT, templates });

// Agent D: unsubscribe, the SMS gateway and GET /api/content, in
// server/routes/platform.js.
platformRoutes.registerUnsubscribeSmsContent(app, {
  requireAdmin,
  paymentBaseUrl,
  crypto,
  settings,
  unsubscribe,
  sms,
  content,
});

// Agent B: design names, custom designs, template art, in server/routes/catalog.js.
catalogRoutes.registerStorefrontTemplates(app, {
  requireAdmin,
  fs,
  path,
  __dirname,
  pathToFileURL,
  TEMPLATE_ROOT,
  templates,
});

// Agent D: content uploads + content-editor writes, in server/routes/platform.js.
platformRoutes.registerContentUploads(app, {
  requireAdmin,
  express,
  fs,
  path,
  content,
  templates,
  CONTENT_IMAGE_UPLOAD_LIMIT,
});

// Agent B: promo photo upload + design gallery, in server/routes/catalog.js.
const { saveGalleryUpload } = catalogRoutes.registerPromoImageGallery(app, {
  requireAdmin,
  express,
  CONTENT_IMAGE_UPLOAD_LIMIT,
  templates,
  content,
  designImages,
  imageThumbs,
  photoFallback,
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

// Agent D: the content, store and template export/import routes, in
// server/routes/platform.js.
platformRoutes.registerStagingImports(app, {
  requireAdmin,
  ADMIN_KEY,
  TEMPLATE_ROOT,
  fs,
  settings,
  playbook,
  content,
  contentImport,
  storeImport,
  templateImport,
  designImages,
  wordlists,
});

// Agent D: ad attribution + Meta CAPI, settings, WhatsApp, message previews and
// feature flags, in server/routes/platform.js.
const { metaCapiArmed, metaAdContext, sendPurchaseToMeta, isGroupWebhook, webhookShape } =
  platformRoutes.registerAdsSettingsWhatsapp(app, {
    requireAdmin,
    paymentBaseUrl,
    clientKey,
    makeRateLimiter,
    db,
    settings,
    attribution,
    metaCapi,
    metaInsights,
    notify,
    whatsapp,
    waState,
    messagePreview,
    handleWaEvent,
    openWhatsappGroup,
    ilPhoneToWaId,
    resolveProductImageUrl,
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

// Public, UNAUTHENTICATED: the localities where delivery takes longer, and how
// long. Its own endpoint rather than a field on /api/pricing, because the two
// have completely different audiences: every storefront page fetches pricing for
// its numbers, while this list — thousands of names on a real courier's
// exceptions list — is printed by exactly one surface, the checkout's delivery
// note. Riding along on pricing would put the whole list on the home page, the
// shop and every product page, none of which will ever show a word of it.
// A WHITELISTED projection like /api/faq: the parsed { towns, eta_days }, never
// the raw multi-line settings string.
app.get('/api/delivery-exceptions', (req, res) => {
  res.json(db.deliveryExceptions());
});

// Agent D: the public FAQ read, in server/routes/platform.js.
platformRoutes.registerFaq(app, { settings, faq });

// Agent B: the public promo block, in server/routes/catalog.js.
catalogRoutes.registerPromo(app, { settings, promo });

// Unknown API routes -> JSON 404 (must come before static/catch-all).
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Content-hashed scripts and stylesheets (server/asset-hashing.js): a new build
// yields NEW urls, so a CDN edge can never pair a stale asset with fresh HTML —
// the 9 Aug store outage, where a day-old design-images.js (no `SIZES` export) met
// an index.html that imported it and the whole page module died on its import
// line, and the 2 Sep staleness, where Cloudflare rewrote our `no-cache` on the
// unhashed tags into max-age=86400 and the edge went on serving a 26-day-old
// tokens.css. The import map covers `import` specifiers; rewriteTags covers the
// <script src> / <link href> tags themselves. Built once, at boot, from site/js,
// site/css and site/assets/fonts.
const assetHashing = require('./asset-hashing');
const moduleAssets = assetHashing.build(SITE_DIR);
const metaPixel = require('./meta-pixel');

// The hash IS the version, so a hashed url is immutable for a year. These never
// exist on disk under the hashed name — the request is mapped back to the real
// file. An unknown hash falls through (a stale HTML would 404 here, but HTML is
// no-cache and carries a current import map, so the browser only ever asks for
// hashes this build actually minted).
app.get(/^\/(?:js|css|assets\/fonts)\/.+\.[0-9a-f]{8}\.(?:m?js|css)$/, (req, res, next) => {
  const file = moduleAssets.resolveHashed(req.path);
  if (!file) return next();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(req.path.endsWith('.css') ? 'css' : 'js');
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
  // Two injections, both cheap string work on an already-in-memory page: the
  // module import map, and the owner's Meta pixel when she has set one. The
  // pixel reads its id per request rather than at boot so pasting a new one in
  // the admin takes effect on the next page load, with no restart.
  res.send(
    metaPixel.inject(
      moduleAssets.rewriteTags(moduleAssets.inject(html)),
      settings.get('analytics', 'meta_pixel_id')
    )
  );
});

// Static site (so /collect resolves to collect.html, etc.). HTML is served
// with no-cache so visitors always get the latest page (and the iPhone/Instagram
// browsers stop showing a stale copy); other assets keep their default validators.
app.use(
  express.static(SITE_DIR, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) return res.setHeader('Cache-Control', 'no-cache');
      // A bare script/stylesheet url (no hash in its own name) must always
      // revalidate, so an edge can never pin yesterday's asset against today's
      // HTML — the 9 Aug outage, and the 2 Sep staleness. A page we serve now
      // carries only hashed urls (asset-hashing's rewriteTags), which the
      // immutable route above answers; this catches a direct hit on a bare name —
      // a bookmark, a hand-typed url, or an HTML copy cached before the fix.
      if (/\.(m?js|css)$/.test(filePath)) return res.setHeader('Cache-Control', 'no-cache');
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
  // …and the pixel, for the same reason. These extension-less paths are exactly
  // the ones an ad links to (/sale, a vanity path in a bio, a mistyped link), so
  // a fallback with no pixel would miss precisely the traffic it is there for.
  res.send(
    metaPixel.inject(
      moduleAssets.rewriteTags(moduleAssets.inject(html)),
      settings.get('analytics', 'meta_pixel_id')
    )
  );
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
  // The Tranzila sweep: once at boot (rows since the persisted last sweep, so a
  // deploy gap is read back), then checked every 15 seconds — a sweep every
  // minute while an unpaid Tranzila session was opened in the last half hour,
  // every 10 minutes otherwise. Single-flight. Only when Tranzila is configured;
  // unref()'d and fire-and-forget like the scans below.
  if (tranzila.isConfigured()) {
    const logSweep = (e) => console.error('[tranzila] sweep failed: ' + ((e && e.message) || e));
    setTimeout(() => {
      tranzilaSweeper.sweep().catch(logSweep);
    }, 0).unref();
    const tzTimer = setInterval(
      () => {
        tranzilaSweeper.tick().catch(logSweep);
      },
      positiveNumber(process.env.TRANZILA_SWEEP_TICK_MS, 15 * 1000)
    );
    if (tzTimer.unref) tzTimer.unref();
  }
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
// The Tranzila sweeper and its alert cap (the times of batches sent in the last
// hour), for tests: a sweep can be run on demand instead of waiting for the
// timers (which tests never start).
module.exports.tranzilaSweeper = tranzilaSweeper;
module.exports.tranzilaAlertSends = tranzilaAlertSends;
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
module.exports.pickupStickerOrders = pickupStickerOrders;
module.exports.stickerBatch = stickerBatch;
module.exports.stickerEntries = stickerEntries;
module.exports.pawnPhotoFiles = pawnPhotoFiles;
module.exports.pawnPhotoFrames = pawnPhotoFrames;
module.exports.pawnPhotoCutouts = pawnPhotoCutouts;
module.exports.orderArgs = orderArgs;
module.exports.cardEstimate = cardEstimate;
module.exports.pawnCardArgs = pawnCardArgs;
// The two render caches, exported so a test can pin that they are SEPARATE — the
// property the pawn card's per-order keys depend on (see pawnCardCache).
module.exports.previewCache = previewCache;
module.exports.pawnCardCache = pawnCardCache;
