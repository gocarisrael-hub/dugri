// @vitest-environment node
//
// The per-ENTRY word length cap (validate.MAX_WORD_LEN = 25).
//
// The rule: one word entry may be at most 25 characters, counted over the WHOLE
// entry with its spaces — not per unbroken token. "מכבי חיפה" (9) passes,
// "בית ספר" (7) passes, a 30-character entry does not. Per-entry is a deliberate
// design decision about how a card reads, so these tests pin the per-entry
// reading specifically (see the "counts the WHOLE entry" cases below).
//
// The boundary is asserted at EXACTLY 25 (accepted) and EXACTLY 26 (rejected) on
// every path, because an off-by-one here is invisible until a card comes out
// wrong.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  MAX_WORD_LEN as CLIENT_MAX,
  cleanWord,
  isWordTooLong,
  wordLengthMessage,
  splitByLength,
  batchLengthMessage,
} from '../../site/js/collect.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let validate;
let app;
let db;
let server;
let base;
let genDir;
let wordsDumpDir;

// Hebrew strings of an exact character length, so the boundary cases read as the
// real thing rather than as 'x'.repeat(26).
const AT_LIMIT = 'אבגדהוזחטיכלמנסעפצקרשתאבגד'.slice(0, 25); // exactly 25
const OVER_LIMIT = 'אבגדהוזחטיכלמנסעפצקרשתאבגדה'.slice(0, 26); // exactly 26

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wordlen-'));
  genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wordlen-gen-'));
  wordsDumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wordlen-dump-'));
  process.env.GENERATED_DIR = genDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

  // Fake generator (same shape as tests/unit/generate-routes.test.js) with ONE
  // addition: it copies the words file the route handed it into wordsDumpDir, so
  // a test can assert exactly which bytes reached the generator.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wordlen-py-'));
  const fake = path.join(fakeDir, 'fake-generator.sh');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      '# $1=script $2=theme $3=name $4=wordsfile $5=outpdf',
      'out="$5"',
      'cp "$4" "' + wordsDumpDir + '/words.txt"',
      'printf "%%PDF-1.4 fake" > "$out"',
      'printf "%%PDF-1.4 fake board" > "${out%.pdf}.board.pdf"',
      'echo "wrote $out (3 pages)"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PYTHON = fake;

  for (const f of ['db.js', 'validate.js', 'pelecard.js', 'notify.js', 'index.js']) {
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

// ---------------------------------------------------------------------------

describe('the cap itself (server/validate.js)', () => {
  it('is 25', () => {
    expect(validate.MAX_WORD_LEN).toBe(25);
    expect(AT_LIMIT.length).toBe(25);
    expect(OVER_LIMIT.length).toBe(26);
  });

  it('accepts exactly 25 and rejects exactly 26', () => {
    expect(validate.isWordTooLong(AT_LIMIT)).toBe(false);
    expect(validate.isWordTooLong(OVER_LIMIT)).toBe(true);
  });

  it('counts the WHOLE entry, spaces included — not the longest token', () => {
    // The owner chose per-entry over per-token deliberately. A phrase of short
    // tokens that totals 26 characters is REJECTED even though no single token is
    // anywhere near the limit; per-token counting would have let it through.
    const phrase = 'אבג דהו זחט יכל מנס עפצ קרש'; // 27 chars, longest token 3
    expect(phrase.length).toBe(27);
    expect(Math.max(...phrase.split(' ').map((t) => t.length))).toBe(3);
    expect(validate.isWordTooLong(phrase)).toBe(true);
  });

  it('lets ordinary multi-word entries through', () => {
    expect(validate.isWordTooLong('מכבי חיפה')).toBe(false); // 9
    expect(validate.isWordTooLong('בית ספר')).toBe(false); // 7
  });

  it('measures the NORMALIZED entry, so padding and double spaces do not count', () => {
    // What matters is what lands on the card, not what was typed.
    expect(validate.normalizeWordText('  מכבי   חיפה  ')).toBe('מכבי חיפה');
    expect(validate.isWordTooLong('   ' + AT_LIMIT + '   ')).toBe(false);
  });

  it('names the actual length AND the limit in Hebrew, not "invalid input"', () => {
    const msg = validate.wordLengthMessage(OVER_LIMIT);
    expect(msg).toContain('26'); // what they typed
    expect(msg).toContain('25'); // what is allowed
    expect(msg).toMatch(/[֐-׿]/); // Hebrew, matching the surrounding copy
    expect(validate.wordLengthMessage(AT_LIMIT)).toBeNull();
  });
});

describe('the browser copy of the cap (site/js/collect.js)', () => {
  it('matches the server constant', () => {
    // The browser needs its own copy to catch a long entry WHILE it is typed, but
    // server/validate.js is the authority. If these ever drift, the form and the
    // API disagree about what is acceptable — so pin them together.
    expect(CLIENT_MAX).toBe(validate.MAX_WORD_LEN);
  });

  it('agrees with the server on the 25/26 boundary', () => {
    expect(isWordTooLong(AT_LIMIT)).toBe(false);
    expect(isWordTooLong(OVER_LIMIT)).toBe(true);
    expect(cleanWord('  מכבי   חיפה ')).toBe('מכבי חיפה');
  });

  it('produces the same Hebrew message the server would', () => {
    expect(wordLengthMessage(OVER_LIMIT)).toBe(validate.wordLengthMessage(OVER_LIMIT));
    expect(wordLengthMessage(AT_LIMIT)).toBeNull();
  });

  it('splits a batch into what may be submitted and what is too long', () => {
    const { ok, tooLong } = splitByLength(['מים', OVER_LIMIT, AT_LIMIT, '  ', 'אש']);
    expect(ok).toEqual(['מים', AT_LIMIT, 'אש']);
    expect(tooLong).toEqual([OVER_LIMIT]);
  });

  it('names the offending words in a batch message', () => {
    expect(batchLengthMessage([])).toBeNull();
    // One bad word → the single-word message (with its exact length).
    expect(batchLengthMessage([OVER_LIMIT])).toContain('26');
    // Several → the count, the limit, and the words themselves.
    const many = batchLengthMessage([OVER_LIMIT, OVER_LIMIT + 'x', OVER_LIMIT + 'yy']);
    expect(many).toContain('3');
    expect(many).toContain('25');
    expect(many).toContain(OVER_LIMIT);
  });
});

describe('db.addWords', () => {
  it('stores an entry of exactly 25 and refuses exactly 26', () => {
    const c = db.createCollection('גבול');
    const r = db.addWords(c.id, [AT_LIMIT, OVER_LIMIT]);
    expect(r.added).toBe(1);
    expect(r.tooLong).toBe(1);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual([AT_LIMIT]);
  });

  it('REFUSES an over-length entry rather than truncating it', () => {
    // The old behaviour was .slice(0, 80), which silently turned the buyer's word
    // into a different, shorter word. A refusal the customer can see and fix beats
    // a mutation nobody notices until the deck is printed.
    const c = db.createCollection('בלי חיתוך');
    db.addWords(c.id, ['א'.repeat(40)]);
    expect(db.listWords(c.id)).toHaveLength(0);
  });

  it('accepts the good words in a mixed batch and reports the rest', () => {
    // Partial acceptance: one over-long sentence in a WhatsApp message must not
    // discard the good words that came with it.
    const c = db.createCollection('חלקי');
    const r = db.addWords(c.id, ['מים', OVER_LIMIT, 'אש']);
    expect(r.added).toBe(2);
    expect(r.tooLong).toBe(1);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(['מים', 'אש']);
  });

  it('counts an over-length entry as tooLong, not as a duplicate or quota block', () => {
    const c = db.createCollection('ספירה');
    const r = db.addWords(c.id, [OVER_LIMIT]);
    expect(r).toMatchObject({ added: 0, skipped: 0, blocked: 0, tooLong: 1 });
  });
});

describe('db.editWord', () => {
  it('accepts an edit to exactly 25 and rejects one to exactly 26', () => {
    const c = db.createCollection('עריכה');
    db.addWords(c.id, ['קצר']);
    const w = db.listWords(c.id)[0];

    expect(db.editWord(c.id, w.id, AT_LIMIT, c.owner_token).text).toBe(AT_LIMIT);

    const bad = db.editWord(c.id, w.id, OVER_LIMIT, c.owner_token);
    expect(bad.error).toBe('too_long');
    expect(bad.len).toBe(26);
    // and the stored word is untouched by the rejected edit
    expect(db.listWords(c.id)[0].text).toBe(AT_LIMIT);
  });

  it('does not truncate an over-length edit into a different word', () => {
    const c = db.createCollection('עריכה בלי חיתוך');
    db.addWords(c.id, ['קצר']);
    const w = db.listWords(c.id)[0];
    db.editWord(c.id, w.id, 'ב'.repeat(40), c.owner_token);
    expect(db.listWords(c.id)[0].text).toBe('קצר');
  });
});

describe('POST /api/collections/:id/words', () => {
  it('stores 25 and refuses 26, reporting the count and the limit', async () => {
    const c = db.createCollection('מסלול הוספה');
    const r = await req('POST', '/api/collections/' + c.id + '/words', {
      words: [AT_LIMIT, OVER_LIMIT],
    });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(1);
    expect(r.body.too_long).toBe(1);
    expect(r.body.max_word_len).toBe(25);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual([AT_LIMIT]);
  });

  it('cannot be talked into seating a 40-character entry', async () => {
    // A client-side limit is only a suggestion; this is the route a non-browser
    // caller (or a stale tab) would use to walk around it.
    const c = db.createCollection('עקיפה');
    await req('POST', '/api/collections/' + c.id + '/words', { words: ['ג'.repeat(40)] });
    expect(db.listWords(c.id)).toHaveLength(0);
  });
});

describe('PATCH /api/collections/:id/words/:wordId', () => {
  it('accepts 25 and rejects 26 with a Hebrew message naming both numbers', async () => {
    const c = db.createCollection('מסלול עריכה');
    db.addWords(c.id, ['קצר']);
    const w = db.listWords(c.id)[0];

    const ok = await req('PATCH', '/api/collections/' + c.id + '/words/' + w.id, {
      owner_token: c.owner_token,
      text: AT_LIMIT,
    });
    expect(ok.status).toBe(200);

    const bad = await req('PATCH', '/api/collections/' + c.id + '/words/' + w.id, {
      owner_token: c.owner_token,
      text: OVER_LIMIT,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('too_long');
    expect(bad.body.len).toBe(26);
    expect(bad.body.max_word_len).toBe(25);
    expect(bad.body.message).toContain('26');
    expect(bad.body.message).toContain('25');
    expect(bad.body.message).toMatch(/[֐-׿]/);
  });
});

describe('WhatsApp-harvested words go through the same gate', () => {
  it('refuses an over-length entry that arrives via db.addWords from the webhook', () => {
    // The webhook harvests words with whatsapp.splitWords and hands them straight
    // to db.addWords — enforcing in the STORE (rather than only in the HTTP route)
    // is what makes that path safe without a second, competing validator.
    const c = db.createCollection('וואטסאפ');
    const r = db.addWords(c.id, ['מים', OVER_LIMIT], 'דנה');
    expect(r.added).toBe(1);
    expect(r.tooLong).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GRANDFATHERING — the rule the next person is most likely to "tidy up".
// ---------------------------------------------------------------------------

describe('existing word lists that predate the cap', () => {
  // Production has real, PAID orders with 416 / 224 / 109 words, collected when
  // the only limit was a silent 80-character truncation. The owner's decision was
  // explicit: "leave old orders alone." So the 25-character cap is an ENTRY-time
  // rule only — nothing in the read or render path enforces it, there is no
  // migration, and no stored entry is rewritten or truncated.
  //
  // If you are here because you want to enforce the cap at generation time too:
  // that is the thing this test exists to stop. A paid order must not stop
  // producing because a rule arrived after it was placed.
  const LEGACY = 'ד'.repeat(41); // over the cap, the way a pre-cap entry can be

  function seedLegacy(name) {
    const c = db.createCollection(name);
    db.addWords(c.id, ['מים', 'אש']);
    // Write the over-length entry the way it exists in production data: already in
    // the store, never passed through today's add path.
    const w = db.listWords(c.id)[0];
    const raw = db.listWords(c.id).find((x) => x.id === w.id);
    raw.text = LEGACY;
    return c;
  }

  it('keeps the stored entry byte-for-byte — no truncation, no cleanup', () => {
    const c = seedLegacy('הזמנה ישנה');
    expect(db.listWords(c.id)[0].text).toBe(LEGACY);
    expect(db.listWords(c.id)[0].text).toHaveLength(41);
  });

  it('passes pre-production validation — an old order is still producible', () => {
    const c = seedLegacy('הזמנה ישנה לבדיקה');
    const words = db.listWords(c.id).map((w) => w.text);
    const problems = validate.validateOrderForProduction(c, null, words);
    // Whatever else it may say, it must never object to an entry's LENGTH.
    expect(problems.join(' ')).not.toContain('ארוכה');
  });

  it('still generates, and the generator receives the long entry verbatim', async () => {
    const c = seedLegacy('Shira');
    const r = await req('POST', '/api/admin/collections/' + c.id + '/generate?key=' + ADMIN_KEY, {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    expect(r.body.production.state).toBe('generated');

    // The words file the route wrote for the generator still contains the
    // over-length entry, unmodified — the render path filters nothing.
    const sent = fs.readFileSync(path.join(wordsDumpDir, 'words.txt'), 'utf8').split('\n');
    expect(sent).toContain(LEGACY);
  });
});

describe('a full deck of maximum-length entries', () => {
  it('accepts and generates a list where every entry is exactly 25 characters', async () => {
    // The cap is only useful if a list that sits exactly ON it is producible.
    const c = db.createCollection('Maxima');
    // Exempt from the free-word quota (which stops at 20) — this test is about the
    // LENGTH cap over a realistic deck, not about the payment gate.
    db.getCollection(c.id).free_limit_applies = false;
    // 80 distinct 25-character entries (over the 70-word minimum).
    const words = [];
    for (let i = 0; i < 80; i++) {
      const suffix = String(i).padStart(2, '0');
      words.push(AT_LIMIT.slice(0, 23) + suffix);
    }
    expect(words.every((w) => w.length === 25)).toBe(true);

    const add = await req('POST', '/api/collections/' + c.id + '/words', { words });
    expect(add.body.added).toBe(80);
    expect(add.body.too_long).toBe(0);

    const r = await req('POST', '/api/admin/collections/' + c.id + '/generate?key=' + ADMIN_KEY, {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    expect(r.body.production.state).toBe('generated');
  });
});
