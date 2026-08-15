// The print-shop copy of a deck.
//
// THE OWNER'S RULE: "1 button called create pdf and what it does is creating the
// pdf (as now this button do) and then run this script." The script is
// generator/press_marks.py, which she wrote and which produces a better file than
// the render-time press path did — so producing an order now builds both
// artifacts, and there is no second button to press.
//
// WHAT IT DOES, in one sentence: every page of the finished deck is treated as
// one card, the page grows outward to carry the bleed the artwork already holds
// plus crop marks, and TrimBox/BleedBox are written so the shop's imposition
// software knows where the card ends. The artwork is never scaled or moved
// relative to its own trim — that is the whole reason this is a post-pass over
// the finished PDF rather than a second render.
//
// NO COLOUR CONVERSION. The owner's call: "about the pdf button - remove the
// cymk entirely". It is also what her own script argues for — "a shop that knows
// its own press separates better than we can guess from here" — and it is what
// makes one button possible at all: the marks pass is 0.44s on a real 208-page
// order (3.6 MB, staging 9d6a86ae), where Ghostscript over the same file is
// minutes. So the shop's copy is written before the produce request answers, and
// there is nothing running afterwards to wait for or to explain.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'generator', 'press_marks.py');
const PYTHON = process.env.PYTHON_BIN || 'python3';

// The marks pass is sub-second on a full deck; a minute is a hang, not a slow run.
const MARKS_TIMEOUT_MS = Number(process.env.PRESS_MARKS_TIMEOUT_MS || 60 * 1000);

// Run the script once. Resolves { ok, detail } — never rejects, because a press
// file is an EXTRA: the customer's deck is already produced and correct, and a
// failure here must leave the order produced rather than undo it. The detail is
// the tail of stderr, which is where a Python traceback puts the actual error.
function run(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PYTHON, [SCRIPT, ...args], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, detail: String((e && e.message) || e) });
    }
    let err = '';
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, detail: out.trim().slice(-800) });
      resolve({
        ok: false,
        detail: (err.trim() || out.trim() || 'press_marks exited ' + code).slice(-800),
      });
    });
  });
}

/**
 * Bleed, crop marks and TrimBox/BleedBox over a finished deck.
 *
 * `outPdf` is written only on success — the script writes it itself, and a
 * failed run leaves whatever was there before untouched rather than half a file.
 */
async function addMarks(deckPdf, outPdf) {
  if (!fs.existsSync(deckPdf)) return { ok: false, detail: 'deck pdf missing: ' + deckPdf };
  // Written to a temp path and moved into place, so a reader that arrives
  // mid-write never gets a partial PDF at the published path.
  const tmp = outPdf + '.partial.pdf';
  const r = await run([deckPdf, tmp], MARKS_TIMEOUT_MS);
  if (!r.ok || !fs.existsSync(tmp)) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    return { ok: false, detail: r.detail || 'press_marks produced no file' };
  }
  fs.renameSync(tmp, outPdf);
  return { ok: true, detail: r.detail };
}

module.exports = { addMarks, SCRIPT, MARKS_TIMEOUT_MS };
