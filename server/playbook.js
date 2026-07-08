// playbook.js — tiny JSON-file store for the internal operational playbook /
// notebook. Same pattern as db.js: an in-memory array loaded at boot, mutated
// through helpers, written to disk atomically (temp file + rename) on every
// change. The file lives under DATA_DIR (a persistent Railway volume in
// production) so the owner's notes survive redeploys.
//
// A "note" is one organized entry: { id, section, title, body, pinned,
// created_at, updated_at }. `section` groups notes in the UI; `body` is plain
// multiline text (recipes, prompts, reminders). The store SEEDS itself once with
// the starter recipes so the notebook is useful on first open; every seeded note
// is fully editable/deletable — the owner owns all of it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'playbook-notes.json');

function newId() {
  return crypto.randomBytes(8).toString('hex');
}
function now() {
  return new Date().toISOString();
}

// Starter content — seeded once (only when no notes file exists yet). Mirrors the
// recipes the team already relies on. The image prompt is a placeholder until the
// owner pastes her exact ChatGPT wording.
function seedNotes() {
  const t = now();
  const mk = (section, title, body, pinned) => ({
    id: newId(),
    section,
    title,
    body,
    pinned: !!pinned,
    created_at: t,
    updated_at: t,
  });
  return [
    mk(
      'תמונות',
      'פרומפט ChatGPT לתמונות קרוסלה',
      [
        '[[ להדביק כאן את הפרומפט המדויק ליצירת תמונות המוצר לקרוסלה ]]',
        '',
        'לכלול: סגנון, זווית, תאורה, רקע, יחס גובה-רוחב;',
        'מה חייב להופיע (חפיסת קלפים + לוח משחק);',
        'מה משתנה לכל עיצוב/אירוע (צבעים, מוטיב).',
      ].join('\n'),
      true
    ),
    mk(
      'תמונות',
      'רקע לבן + מידות (ImageMagick)',
      [
        'רקע לבן — flood fill מהפינות (fuzz 14%), שמירה ל-cover.webp:',
        'magick input.png -fuzz 14% -fill white \\',
        '  -draw "color 0,0 floodfill" -draw "color %[fx:w-1],0 floodfill" \\',
        '  -draw "color 0,%[fx:h-1] floodfill" -draw "color %[fx:w-1],%[fx:h-1] floodfill" \\',
        '  -resize 900x -quality 86 site/assets/designs/<id>/cover.webp',
        '',
        'גלריה חדה לעמוד המוצר (~1100px):',
        'magick -density 200 -background white input.png -resize 1100x -quality 88 \\',
        '  site/assets/designs/<id>/gallery-front.webp',
        '',
        'הירו (רוחב מלא ~1600px):',
        'magick input.png -resize 1600x -quality 82 site/assets/hero-1.jpg',
      ].join('\n')
    ),
    mk(
      'ייצור',
      'רשימת מילים → CSV → Bulk Create (Canva)',
      [
        '32 עמודות c1w1…c8w4 (c=קלף, w=מילה). כל שורה = דף של 8 קלפים × 4 מילים.',
        'מסירים כפילויות, מערבבים, משלימים את השורה האחרונה במחרוזות ריקות עד 32.',
        'תבנית: alias Shira · Canva design id DAHML5i7T6k. הלוח נשאר עותק יחיד.',
        '',
        'import csv, random, math',
        'def build_csv(words, out, shuffle=True, seed=42):',
        '    seen=set(); uniq=[w for w in (x.strip() for x in words)',
        '                       if w and not (w in seen or seen.add(w))]',
        '    if shuffle: random.seed(seed); random.shuffle(uniq)',
        '    PER=32; pages=math.ceil(len(uniq)/PER)',
        "    padded=uniq+['']*(pages*PER-len(uniq))",
        '    headers=[f"c{c}w{w}" for c in range(1,9) for w in range(1,5)]',
        "    with open(out,'w',encoding='utf-8',newline='') as f:",
        '        wr=csv.writer(f); wr.writerow(headers)',
        '        for p in range(pages): wr.writerow(padded[p*PER:(p+1)*PER])',
      ].join('\n')
    ),
    mk(
      'הדפסה',
      'הוראות הדפסה וגזירה',
      [
        'קלפים: נייר 300 גרם, צבע.',
        'קריטי: להדפיס בגודל מקורי 100% — לא "התאם לעמוד".',
        'כולל קווי גזירה + הוראות גזירה בקובץ.',
        'אספקה: עד 24 שעות מרגע קבלת רשימת המילים (לא מרגע התשלום).',
      ].join('\n')
    ),
  ];
}

let _notes = load();
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw)) return raw;
  } catch {
    /* missing / unreadable — fall through to seed */
  }
  const seeded = seedNotes();
  try {
    _notes = seeded;
    save();
  } catch {
    /* read-only fs (e.g. tests) — keep the seed in memory */
  }
  return seeded;
}
function save() {
  // Ensure the data dir exists before the atomic tmp-write+rename — otherwise
  // writeFileSync throws ENOENT on the first save when DATA_DIR hasn't been
  // created yet (server/db.js does the same guard before its atomic write).
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_notes, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

// Sort for display: pinned first, then by section, then newest-updated first.
function list() {
  return _notes.slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    const s = (a.section || '').localeCompare(b.section || '', 'he');
    if (s !== 0) return s;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });
}

function add({ section, title, body, pinned } = {}) {
  const note = {
    id: newId(),
    section: String(section || '').slice(0, 80) || 'כללי',
    title: String(title || '').slice(0, 200),
    body: String(body || '').slice(0, 20000),
    pinned: !!pinned,
    created_at: now(),
    updated_at: now(),
  };
  _notes.push(note);
  save();
  return note;
}

function update(id, patch = {}) {
  const n = _notes.find((x) => x.id === id);
  if (!n) return null;
  if (patch.section != null) n.section = String(patch.section).slice(0, 80) || 'כללי';
  if (patch.title != null) n.title = String(patch.title).slice(0, 200);
  if (patch.body != null) n.body = String(patch.body).slice(0, 20000);
  if (patch.pinned != null) n.pinned = !!patch.pinned;
  n.updated_at = now();
  save();
  return n;
}

function remove(id) {
  const i = _notes.findIndex((x) => x.id === id);
  if (i === -1) return false;
  _notes.splice(i, 1);
  save();
  return true;
}

module.exports = { list, add, update, remove, _file: FILE };
