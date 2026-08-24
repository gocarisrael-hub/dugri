// The buyer's look at her own deck, before it is printed.
//
// WHY THE PDF AND NOT A SECOND RENDER. The obvious build is to draw the cards
// again in the browser from the same word list. That is the exact drift this
// project has already paid for twice — a screen that fits words one way and a
// press that fits them another. A proof that can disagree with the artefact is
// worse than no proof, because it is believed. So these pages come out of the
// produced PDF itself, through the ghostscript that is already in the image for
// the marks pass. If the proof looks right, the file IS right; there is nothing
// left to diverge.
//
// WHERE IT SITS. Production is two hand-pressed steps — produce the deck, then
// send it to the shop. The proof goes between them: it needs a produced deck to
// read, and it is only worth anything before the shop has the file.
const fs = require('fs');
const path = require('path');
const generatorProc = require('./generator-proc');

// A deck is ~104 pages and each one is a ghostscript page plus a Pillow resize.
// Measured at ~7s for 104 pages on this box; the cap is for a pathological file,
// not for a real order.
const PROOF_TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS || 180000);
// Grid width in CSS pixels. The renderer draws at 2x for the enlarged view.
const PROOF_WIDTH = Number(process.env.PROOF_WIDTH || 320);

// One build per collection at a time. Two tabs, or a reload mid-build, must not
// start a second ghostscript over the same directory — they'd race on the same
// filenames and the loser would serve half a deck. Everyone waits on the first.
const inflight = new Map();

function proofDir(generatedDir, id) {
  return path.join(generatedDir, id + '.proof');
}

function manifestPath(generatedDir, id) {
  return path.join(proofDir(generatedDir, id), 'proof.json');
}

// Fresh means: a manifest exists, and it is NOT older than the deck it claims to
// show. Re-producing an order rewrites <id>.pdf in place, so mtime is the whole
// question — a stale proof is a buyer approving last week's words.
function readFresh(generatedDir, id) {
  const deck = path.join(generatedDir, id + '.pdf');
  const mf = manifestPath(generatedDir, id);
  try {
    if (fs.statSync(mf).mtimeMs < fs.statSync(deck).mtimeMs) return null;
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    return m && m.pages ? m : null;
  } catch {
    return null; // absent or unreadable — rebuild
  }
}

// Render the deck to page images. Resolves with the manifest, or an Error.
function build({ generatedDir, id, python, repoRoot, width = PROOF_WIDTH }) {
  const deck = path.join(generatedDir, id + '.pdf');
  if (!fs.existsSync(deck)) return Promise.reject(new Error('no pdf'));
  if (inflight.has(id)) return inflight.get(id);

  const out = proofDir(generatedDir, id);
  const run = new Promise((resolve, reject) => {
    const child = generatorProc.spawnGenerator(
      python,
      [path.join('generator', 'proof_sheet.py'), deck, out, '--width', String(width)],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      generatorProc.killGenerator(child);
      reject(new Error('proof timed out'));
    }, PROOF_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim().split('\n').pop());
      } catch {
        /* the child answers in JSON or it has failed */
      }
      if (!parsed || parsed.error || !parsed.pages) {
        return reject(new Error((parsed && parsed.error) || stderr.slice(-300) || 'proof failed'));
      }
      resolve(parsed);
    });
  }).finally(() => inflight.delete(id));

  inflight.set(id, run);
  return run;
}

// The manifest, building it first if there isn't a current one.
async function ensure(opts) {
  const fresh = readFresh(opts.generatedDir, opts.id);
  if (fresh) return fresh;
  return build(opts);
}

// Resolve one page number to a file inside the proof directory. Returns null for
// anything that isn't a plain page number in range — the page number comes off
// the URL, and it must never be able to name a file of its own choosing.
function pageFile(generatedDir, id, n, manifest) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > (manifest ? manifest.pages : 0)) return null;
  const name = String(num).padStart(4, '0') + '.webp';
  return path.join(proofDir(generatedDir, id), name);
}

// Drop a proof when its deck goes: clearing production unlinks <id>.pdf, and a
// proof of a deck that no longer exists is a picture of nothing.
function remove(generatedDir, id) {
  try {
    fs.rmSync(proofDir(generatedDir, id), { recursive: true, force: true });
  } catch {
    /* absent is the state we wanted */
  }
}

module.exports = { build, ensure, readFresh, pageFile, proofDir, remove, PROOF_WIDTH };
