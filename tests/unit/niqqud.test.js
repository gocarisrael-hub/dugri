// @vitest-environment node
//
// THE NIQQUD REFUSAL — "can you decline emojis or punctuation (ניקוד) in new
// words in the collecting words page?" (the shop owner).
//
// Why it exists: the vowel points and cantillation marks are COMBINING marks,
// and the card faces are display fonts drawn for unpointed Hebrew (Gveret Levin,
// Comix, Aharoni CLM…). A pointed word therefore does not print as a pointed
// word — the marks land as boxes, collide with the letter, or vanish — on a deck
// that has already been paid for. They also spend the 25-character entry cap:
// "שָׁלוֹם" counts 8 for a 5-letter word.
//
// Why REFUSED and not quietly unpointed, since that is the decision these tests
// protect: nothing in this codebase silently rewrites what a person typed. A
// refusal is a correction she makes herself in one line; a strip is a change
// nobody is ever told about. (This is the weaker form of the emoji argument —
// שָׁלוֹם and שלום do read the same — so the message carries the unpointed word,
// making the fix a copy-paste rather than a puzzle.)
//
// Two halves, and the second is what stops it becoming a nuisance:
//
//   1. REFUSED — the Hebrew combining marks, and only those.
//   2. ACCEPTED — the Hebrew block's PUNCTUATION, which is ordinary printable
//      type: the maqaf in בן־גוריון, the gershayim in ר״ח, the geresh. A buyer
//      refused for typing a normal Hebrew word is a lost order.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  NIQQUD_CHARS as CLIENT_CHARS,
  hasNiqqud as clientHas,
  stripNiqqud as clientStrip,
  wordNiqqudMessage as clientWordMessage,
  splitByNiqqud as clientSplit,
  batchNiqqudMessage as clientBatchMessage,
} from '../../site/js/niqqud.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let validate;
let db;
let app;
let server;
let base;

// Pointed strings a real contributor might paste — from a siddur, a song lyric,
// a WhatsApp message typed with a keyboard that points.
const REFUSE = {
  'a fully pointed word': 'שָׁלוֹם',
  'a single vowel point': 'אֵם',
  'a dagesh': 'אִמָּא',
  'a shin dot': 'שׁיר',
  'a holam': 'תּוֹרָה',
  'cantillation marks': 'בְּרֵאשִׁ֖ית',
  'one pointed word inside a plain phrase': 'ליל שַׁבָּת',
  'a qamats qatan': 'כָּל־הָעוֹלָם',
};

// Everything a normal Hebrew word may carry and still be printed as typed.
const ACCEPT = {
  'a plain Hebrew word': 'שלום',
  'a maqaf between names': 'בן־גוריון',
  'gershayim in an abbreviation': 'ר״ח',
  'a geresh': 'צ׳יפס',
  'an ordinary multi-word entry': 'מכבי חיפה',
  'a Latin word': 'party',
  'a Latin word with its own diacritic': 'café',
  digits: '40',
  'punctuation a phone inserts': 'דנה–יוסי',
};

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-niqqud-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of [
    'db.js',
    'validate.js',
    'wordlists.js',
    'pelecard.js',
    'notify.js',
    'index.js',
  ]) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  validate = require(path.join(serverDir, 'validate.js'));
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
});

async function req(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('what counts as niqqud (server/validate.js)', () => {
  for (const [what, s] of Object.entries(REFUSE)) {
    it('refuses ' + what + ' — ' + s, () => {
      expect(validate.hasNiqqud(s)).toBe(true);
    });
  }

  for (const [what, s] of Object.entries(ACCEPT)) {
    it('accepts ' + what + ' — ' + s, () => {
      expect(validate.hasNiqqud(s)).toBe(false);
    });
  }

  it('draws the line at the MARKS, not at the Hebrew block', () => {
    // The pair that explains the rule: U+05B7 (patah) is a combining mark and is
    // refused; U+05BE (maqaf) sits between them in the same block, is ordinary
    // printable punctuation, and must stay accepted — otherwise בן־גוריון is a
    // refused word.
    expect(validate.hasNiqqud('ַ')).toBe(true);
    expect(validate.hasNiqqud('־')).toBe(false);
    expect(validate.hasNiqqud('׀')).toBe(false); // paseq
    expect(validate.hasNiqqud('׃')).toBe(false); // sof pasuq
    expect(validate.hasNiqqud('׳')).toBe(false); // geresh
    expect(validate.hasNiqqud('״')).toBe(false); // gershayim
  });

  it('unpoints a word without touching anything else', () => {
    expect(validate.stripNiqqud('שָׁלוֹם')).toBe('שלום');
    expect(validate.stripNiqqud('כָּל־הָעוֹלָם')).toBe('כל־העולם');
    for (const s of Object.values(ACCEPT)) expect(validate.stripNiqqud(s)).toBe(s);
  });
});

describe('the Hebrew refusal', () => {
  it('says what is wrong, why, and what to type instead', () => {
    const msg = validate.wordNiqqudMessage('שָׁלוֹם');
    expect(msg).toContain('ניקוד'); // what
    expect(msg).toContain('להדפיס'); // why — it cannot be printed
    expect(msg).toContain('שלום'); // what to type instead
  });

  it('shows the clean word rather than pointing at an invisible mark', () => {
    // A message naming the marks themselves would read as "remove: ֶ ּ" — a
    // string of floating accents nobody can locate in their own typing.
    expect(validate.wordNiqqudMessage('אִמָּא')).toContain('אמא');
  });

  it('is null for a clean word', () => {
    for (const s of Object.values(ACCEPT)) expect(validate.wordNiqqudMessage(s)).toBe(null);
  });

  it('names up to three words of a pointed batch, unpointed', () => {
    const msg = validate.batchNiqqudMessage(['שָׁלוֹם', 'אִמָּא', 'תּוֹרָה', 'אֵם']);
    expect(msg).toContain('4 מילים');
    expect(msg).toContain('שלום');
    expect(msg).toContain('ועוד');
    expect(msg).not.toContain('אם,'); // the fourth is not listed
  });

  it('falls back to the single-word message for a batch of one', () => {
    expect(validate.batchNiqqudMessage(['שָׁלוֹם'])).toBe(validate.wordNiqqudMessage('שָׁלוֹם'));
  });
});

describe('db.addWords', () => {
  it('refuses a pointed entry and counts it on its own', () => {
    const c = db.createCollection('ניקוד');
    const r = db.addWords(c.id, ['שָׁלוֹם', 'מסיבה']);
    expect(r.niqqud).toBe(1);
    expect(r.added).toBe(1);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(['מסיבה']);
  });

  it('stores nothing pointed, and never a silently unpointed word', () => {
    // The failure this guards: "שָׁלוֹם" landing as "שלום" without anyone saying
    // so. The entry is refused; the store is untouched.
    const c = db.createCollection('ניקוד');
    db.addWords(c.id, ['שָׁלוֹם']);
    expect(db.listWords(c.id)).toHaveLength(0);
  });

  it('keeps the good words of a partly pointed paste', () => {
    // A 40-word paste with three pointed words must land the other 37 — losing
    // them because of a neighbour is the expensive failure here.
    const c = db.createCollection('הדבקה');
    const r = db.addWords(c.id, ['שָׁלוֹם', 'חוף', 'אִמָּא', 'ריקוד', 'צחוק']);
    expect(r.added).toBe(3);
    expect(r.niqqud).toBe(2);
  });

  it('leaves every accepted word alone', () => {
    const c = db.createCollection('תקינות');
    const words = Object.values(ACCEPT);
    const r = db.addWords(c.id, words);
    expect(r.niqqud).toBe(0);
    expect(r.added).toBe(words.length);
  });
});

// A word that was stored BEFORE this rule existed: written the only way it could
// have been, by reaching past the entry gate the way production data did.
function seedLegacy(name) {
  const c = db.createCollection(name);
  db.addWords(c.id, ['מים']);
  db.listWords(c.id)[0].text = 'שָׁלוֹם';
  return c;
}

describe('db.editWord', () => {
  it('refuses an edit that ADDS niqqud and leaves the stored word untouched', () => {
    const c = db.createCollection('עריכה');
    db.addWords(c.id, ['שלום']);
    const w = db.listWords(c.id)[0];
    const r = db.editWord(c.id, w.id, 'שָׁלוֹם', c.owner_token);
    expect(r.error).toBe('niqqud');
    expect(r.clean).toBe('שלום');
    expect(db.listWords(c.id)[0].text).toBe('שלום');
  });

  it('keeps a word stored before the rule byte-for-byte', () => {
    // Nothing migrates old data and nothing in the read or render path enforces
    // this — an order placed before the rule must still list and still produce.
    const c = seedLegacy('ותיקה');
    expect(db.listWords(c.id)[0].text).toBe('שָׁלוֹם');
    const problems = validate.validateOrderForProduction(
      c,
      null,
      db.listWords(c.id).map((w) => w.text)
    );
    expect(problems.join(' ')).not.toContain('ניקוד');
  });

  it('does apply to what an edit SUBMITS, even for a legacy word', () => {
    // Re-saving the same pointed text is still an entry, so the rule refuses it
    // — and the stored word is left exactly as it was. What makes the legacy
    // word safe in practice is the page, which short-circuits an unchanged edit
    // before it ever reaches here (startWordEdit in collect.html).
    const c = seedLegacy('עריכה ותיקה');
    const w = db.listWords(c.id)[0];
    expect(db.editWord(c.id, w.id, 'שָׁלוֹם', c.owner_token).error).toBe('niqqud');
    expect(db.listWords(c.id)[0].text).toBe('שָׁלוֹם');
  });
});

describe('POST /api/collections/:id/words', () => {
  it('reports the pointed entries it refused', async () => {
    const c = db.createCollection('מסלול');
    const r = await req('POST', '/api/collections/' + c.id + '/words', {
      words: ['שָׁלוֹם', 'מסיבה'],
    });
    expect(r.status).toBe(200);
    expect(r.body.niqqud).toBe(1);
    expect(r.body.added).toBe(1);
  });

  it('adds nothing pointed even from a caller that is not the page', async () => {
    // The page filters these out while the word is still on screen; the API is
    // the authority behind it, for a stale tab or a non-browser client.
    const c = db.createCollection('מסלול');
    await req('POST', '/api/collections/' + c.id + '/words', { words: ['אִמָּא'] });
    expect(db.countWords(c.id)).toBe(0);
  });
});

describe('PATCH /api/collections/:id/words/:wordId', () => {
  it('rejects an edit that adds niqqud, with a message that shows the clean word', async () => {
    const c = db.createCollection('עריכה מסלול');
    db.addWords(c.id, ['שלום']);
    const w = db.listWords(c.id)[0];
    // Token in the BODY, not the URL, so it is never logged — same as delete.
    const r = await req('PATCH', '/api/collections/' + c.id + '/words/' + w.id, {
      owner_token: c.owner_token,
      text: 'שָׁלוֹם',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('niqqud');
    expect(r.body.message).toContain('שלום');
    expect(r.body.clean).toBe('שלום');
    expect(db.listWords(c.id)[0].text).toBe('שלום');
  });
});

describe('the browser copy (site/js/niqqud.js) agrees with the server', () => {
  it('uses character-for-character the same class', () => {
    // A drift here means the field and the API disagree about what is
    // acceptable: a word the box accepts and the server refuses, or worse.
    expect(CLIENT_CHARS).toBe(validate.NIQQUD_CHARS);
  });

  it('reaches the same verdict on every string in both tables', () => {
    for (const s of Object.values(REFUSE)) expect(clientHas(s)).toBe(true);
    for (const s of Object.values(ACCEPT)) expect(clientHas(s)).toBe(false);
  });

  it('produces the same Hebrew messages the server would', () => {
    expect(clientWordMessage('שָׁלוֹם')).toBe(validate.wordNiqqudMessage('שָׁלוֹם'));
    expect(clientBatchMessage(['שָׁלוֹם', 'אִמָּא'])).toBe(
      validate.batchNiqqudMessage(['שָׁלוֹם', 'אִמָּא'])
    );
    expect(clientStrip('שָׁלוֹם')).toBe(validate.stripNiqqud('שָׁלוֹם'));
  });

  it('splits a batch so the good words still go and the rest are named', () => {
    const { ok, withNiqqud } = clientSplit(['שָׁלוֹם', 'חוף', 'ריקוד']);
    expect(ok).toEqual(['חוף', 'ריקוד']);
    expect(withNiqqud).toEqual(['שָׁלוֹם']);
  });
});
