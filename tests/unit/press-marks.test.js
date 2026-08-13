// @vitest-environment node
// ONE BUTTON. "the create pdf button is working very well. the create pdf for
// printing shop is not so good… i want when i press the create pdf button this
// is what will be created. no need to separate 2 different button."
//
// So producing an order runs the owner's own generator/press_marks.py over the
// deck it just made: every page grows outward to carry the bleed the artwork
// already holds plus crop marks, and TrimBox/BleedBox are written so the shop's
// imposition software knows where the card ends.
//
// The two things this file guards are the two that would go unnoticed:
//   1. the press file is REALLY a press file — bigger pages, boxes, marks — and
//      not the deck copied under another name;
//   2. a failure here leaves the ORDER produced. The customer's deck is already
//      correct; refusing to record it because a shop's copy failed would turn a
//      finished order into a broken one.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const repoRoot = path.join(__dirname, '..', '..');

let pressMarks;
let dir;

// pikepdf is in the runtime image; a machine without it should SKIP rather than
// fail — the guarantee is about our wiring, not about the local interpreter.
function hasPikepdf() {
  try {
    execFileSync('python3', ['-c', 'import pikepdf'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A deck-shaped PDF: the real card page box (223.92 x 312 pt = 79 x 110 mm,
// which is the 74x105mm card plus the ~2.5mm bleed the artwork carries).
function makeDeck(file, pages = 3) {
  execFileSync('python3', [
    '-c',
    [
      'import pikepdf,sys',
      'pdf=pikepdf.new()',
      'for i in range(int(sys.argv[2])):',
      '    p=pdf.add_blank_page(page_size=(223.92,312))',
      '    p.contents_add(pdf.make_stream(b"0.9 0.2 0.2 rg 10 10 200 290 re f"))',
      'pdf.save(sys.argv[1])',
    ].join('\n'),
    file,
    String(pages),
  ]);
  return file;
}

// The page and box geometry of a PDF, read back through pikepdf.
function geometry(file) {
  const out = execFileSync('python3', [
    '-c',
    [
      'import pikepdf,sys,json',
      'p=pikepdf.open(sys.argv[1])',
      'pg=p.pages[0]',
      'mb=[float(v) for v in pg.mediabox]',
      'tb=[float(v) for v in pg.obj["/TrimBox"]] if "/TrimBox" in pg.obj else None',
      'bb=[float(v) for v in pg.obj["/BleedBox"]] if "/BleedBox" in pg.obj else None',
      'print(json.dumps({"pages":len(p.pages),"media":mb,"trim":tb,"bleed":bb}))',
    ].join('\n'),
    file,
  ]);
  return JSON.parse(String(out));
}

const MM = 72 / 25.4;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-press-marks-'));
  delete require.cache[require.resolve(path.join(serverDir, 'press-marks.js'))];
  pressMarks = require(path.join(serverDir, 'press-marks.js'));
});

describe('the script is in the repo, where the server expects it', () => {
  it('is at generator/press_marks.py', () => {
    // It arrived as a loose file in the owner's checkout. A server that spawns a
    // script nobody committed works on her laptop and on nothing else.
    expect(pressMarks.SCRIPT).toBe(path.join(repoRoot, 'generator', 'press_marks.py'));
    expect(fs.existsSync(pressMarks.SCRIPT)).toBe(true);
  });
});

describe.skipIf(!hasPikepdf())('the press file it builds', () => {
  it('grows every page and writes the boxes the shop reads', async () => {
    const deck = makeDeck(path.join(dir, 'deck.pdf'), 3);
    const out = path.join(dir, 'deck.press.pdf');
    const r = await pressMarks.addMarks(deck, out);
    expect(r.ok).toBe(true);

    const before = geometry(deck);
    const after = geometry(out);
    expect(after.pages).toBe(before.pages);
    // The page grew by the mark margin on every side; the CARD did not move.
    expect(after.media[2]).toBeGreaterThan(before.media[2]);
    expect(after.media[3]).toBeGreaterThan(before.media[3]);
    // TrimBox is the finished card — 74x105mm — which is what says where to cut.
    expect(after.trim).toBeTruthy();
    expect((after.trim[2] - after.trim[0]) / MM).toBeCloseTo(74, 1);
    expect((after.trim[3] - after.trim[1]) / MM).toBeCloseTo(105, 1);
    // BleedBox sits outside it, and inside the page.
    expect(after.bleed[0]).toBeLessThan(after.trim[0]);
    expect(after.bleed[2]).toBeGreaterThan(after.trim[2]);
    expect(after.bleed[2]).toBeLessThanOrEqual(after.media[2] + 0.01);
  });

  it('leaves the deck itself untouched', () => {
    // The customer's file is the one that must not change: the press copy is a
    // separate artifact, written beside it.
    const deck = path.join(dir, 'deck.pdf');
    const g = geometry(deck);
    expect(g.media[2]).toBeCloseTo(223.92, 2);
    expect(g.trim).toBe(null);
  });

  it('publishes nothing when the deck is missing', async () => {
    const out = path.join(dir, 'absent.press.pdf');
    const r = await pressMarks.addMarks(path.join(dir, 'no-such-deck.pdf'), out);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/missing/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('never leaves a half-written file at the published path', async () => {
    // The partial goes to its own name and is moved into place, so a download
    // that arrives mid-build gets the previous file or none — never a torn one.
    const deck = makeDeck(path.join(dir, 'deck2.pdf'), 2);
    const out = path.join(dir, 'deck2.press.pdf');
    await pressMarks.addMarks(deck, out);
    expect(fs.existsSync(out + '.partial.pdf')).toBe(false);
  });
});

describe('the press state recorded on the order', () => {
  let db;
  beforeAll(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-press-state-'));
    delete require.cache[require.resolve(path.join(serverDir, 'db.js'))];
    db = require(path.join(serverDir, 'db.js'));
  });

  it('is a MERGE — the colour pass must not erase the production record', () => {
    // THE BUG THIS EXISTS TO PREVENT. setProduction REPLACES the record, and the
    // colour pass finishes minutes after the produce request answered. Using it
    // there would wipe pdf_file, pages and the capability token the customer's
    // download link is built from — an order that produced fine would lose its
    // file to a background job about the SHOP's copy.
    const c = db.createCollection('לקוחה');
    const produced = db.setProduction(c.id, {
      state: 'generated',
      pdf_file: c.id + '.pdf',
      pages: 208,
      press: 'converting',
    });
    expect(produced.pdf_token).toBeTruthy();

    const after = db.setPressState(c.id, 'cmyk');
    expect(after.press).toBe('cmyk');
    expect(after.state).toBe('generated');
    expect(after.pdf_file).toBe(c.id + '.pdf');
    expect(after.pages).toBe(208);
    expect(after.pdf_token).toBe(produced.pdf_token);
  });

  it('does nothing for an order that never produced', () => {
    // A late callback for a deleted or never-produced order must not invent a
    // production record out of one field.
    const c = db.createCollection('בלי הפקה');
    expect(db.setPressState(c.id, 'cmyk')).toBe(null);
    expect(db.getCollection(c.id).production).toBeFalsy();
  });

  it('survives a reload — it is stored, not remembered', () => {
    const c = db.createCollection('אחרי ריסטארט');
    db.setProduction(c.id, { state: 'generated', pdf_file: 'x.pdf' });
    db.setPressState(c.id, 'rgb');
    expect(db.getCollection(c.id).production.press).toBe('rgb');
  });
});
