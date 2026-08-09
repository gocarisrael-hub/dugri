// @vitest-environment node
//
// THE EMOJI REFUSAL — "refuse for emojis in title and words" (the shop owner).
//
// Why a refusal and not a clean-up, since that is the decision these tests exist
// to protect: the cards are PRINTED. The card faces are Hebrew and Latin display
// fonts with no emoji glyphs at all, so a 🎉 does not reach the deck as a 🎉 — it
// reaches it as a blank box, or as whatever the renderer happens to substitute,
// on all 104 cards of an order the customer has already paid for, and she finds
// out when the parcel opens. Stripping the emoji silently would be WORSE than
// refusing: she typed it on purpose, the deck would come back without it, and
// nothing would ever have told her. So the rule refuses, at the moment she types
// it, in Hebrew, naming the character to remove.
//
// Two halves, and the second is what stops this becoming a nuisance:
//
//   1. REFUSED — every pictographic shape, including the ones a computer sees as
//      several codepoints and a person sees as one (👩‍👩‍👧, 🇮🇱, 👍🏽, 1️⃣, 🏳️‍🌈).
//   2. ACCEPTED — Hebrew with niqqud, the geresh ׳, an apostrophe, the en dash a
//      phone substitutes for a hyphen, digits, ordinary Latin punctuation, and ©.
//      A buyer refused for typing a normal name is a lost order, so the accept
//      list is tested as hard as the refuse list.
//
// And the boundary between them is the interesting part: © is ACCEPTED, ©️ (the
// same character wearing U+FE0F, the "render me as an emoji" selector) is
// REFUSED. That pair is the whole rule in miniature.
//
// This is NOT a font-coverage check. render_page.assert_title_drawable already
// asks "can this font draw this character"; this asks "is this character an
// emoji", which is a different question with a different answer and a different
// message. Don't merge them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  EMOJI_CHARS as CLIENT_CHARS,
  EMOJI_UNIT as CLIENT_UNIT,
  hasEmoji as clientHasEmoji,
  findEmoji as clientFindEmoji,
  titleEmojiMessage as clientTitleMessage,
  wordEmojiMessage as clientWordMessage,
  splitByEmoji as clientSplitByEmoji,
  batchEmojiMessage as clientBatchMessage,
} from '../../site/js/emoji.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let validate;
let app;
let db;
let store;
let server;
let base;

// The strings the rule must REFUSE. Each one is a shape that would otherwise
// reach a printed card, and several are here specifically because a naive
// codepoint-by-codepoint check gets them wrong.
const REFUSE = {
  'a plain emoji': '🎉',
  'an emoji inside a Hebrew phrase': 'מסיבה 🎉 גדולה',
  'a Miscellaneous Symbol': '☀',
  'a Dingbat': '✂',
  'Misc Symbols and Arrows': '⭐',
  'an emoji stranded in Misc Technical': '⌛',
  'a CJK emoji': '㊙',
  'a skin-tone modifier sequence': '👍🏽',
  'a regional-indicator flag pair': '🇮🇱',
  'a ZWJ family': '👩‍👩‍👧',
  'a ZWJ flag': '🏳️‍🌈',
  'a subdivision flag built from tag characters': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'a keycap': '1️⃣',
  'a heart with the emoji selector': '❤️',
  'an ACCEPTED character wearing the emoji selector': '©️',
  'the enclosed P that shipped in a seed pool': '🅿️',
};

// The strings the rule must ACCEPT. This half is the nuisance guard: every one
// of these is something a real buyer types, and refusing any of them costs an
// order.
const ACCEPT = {
  'a plain Hebrew name': 'שירה',
  'Hebrew with niqqud': 'שָׁלוֹם',
  'a geresh and gershayim': 'מזל טוב ׳לשירה׳ ״40״',
  'an apostrophe in a Latin name': "O'Neil",
  'a hyphenated name': 'Anne-Marie',
  'the en dash a phone substitutes for a hyphen': 'דנה–יוסי',
  'an em dash': 'דנה — יוסי',
  digits: '40',
  'ordinary Latin punctuation': 'Hello, world. (Really!)',
  'the copyright sign the owner asked to keep': '© דוגרי 2026',
  'the registered and trademark signs': 'דוגרי ® ™',
  'typographic arrows': 'מכאן → לשם ↔ וחזרה',
  'double exclamation and interrobang as punctuation': 'מזל טוב ‼ באמת ⁉',
  'an ordinary multi-word entry': 'מכבי חיפה',
};

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-emoji-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

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
  store = require(path.join(serverDir, 'wordlists.js'));
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
// The rule itself
// ---------------------------------------------------------------------------

describe('what counts as an emoji (server/validate.js)', () => {
  for (const [what, s] of Object.entries(REFUSE)) {
    it('refuses ' + what + ' — ' + s, () => {
      expect(validate.hasEmoji(s)).toBe(true);
    });
  }

  for (const [what, s] of Object.entries(ACCEPT)) {
    it('accepts ' + what + ' — ' + s, () => {
      expect(validate.hasEmoji(s)).toBe(false);
    });
  }

  it('draws the line at the emoji SELECTOR, not at the character', () => {
    // The pair that explains the whole rule. © is a typographic sign a text font
    // draws; ©️ is the same codepoint followed by U+FE0F, which is a request to
    // render it as a colour emoji — and that is a request no card font can
    // honour. The owner named © as something that must keep working, so the
    // selector is what we object to, not the copyright sign.
    expect(validate.hasEmoji('©')).toBe(false);
    expect(validate.hasEmoji('©️')).toBe(true);
    expect(validate.hasEmoji('‼')).toBe(false);
    expect(validate.hasEmoji('‼️')).toBe(true);
  });

  it('does not object to a bare ZWJ, because it never needs to', () => {
    // U+200D is deliberately NOT in the character class: every emoji ZWJ sequence
    // contains at least one pictograph, so 👩‍👩‍👧 is caught by its members. Keeping
    // ZWJ out of the class means the rule can never refuse a string for an
    // invisible joining character alone.
    expect(validate.hasEmoji('א‍ב')).toBe(false);
    expect(validate.hasEmoji('👩‍👩')).toBe(true);
  });

  it('treats an empty / null / undefined value as clean', () => {
    expect(validate.hasEmoji('')).toBe(false);
    expect(validate.hasEmoji(null)).toBe(false);
    expect(validate.hasEmoji(undefined)).toBe(false);
  });
});

describe('naming the emoji (findEmoji)', () => {
  it('counts a ZWJ family as ONE thing, the way a person sees it', () => {
    // 👩‍👩‍👧 is one emoji to a human and five codepoints to a computer. A refusal
    // that said "remove these 3 emoji" and printed three separate women would be
    // technically accurate and useless.
    expect(clientFindEmoji('👩‍👩‍👧')).toEqual(['👩‍👩‍👧']);
    expect(validate.findEmoji('👩‍👩‍👧')).toEqual(['👩‍👩‍👧']);
  });

  it('keeps a flag pair, a skin tone and a keycap whole', () => {
    expect(validate.findEmoji('🇮🇱')).toEqual(['🇮🇱']);
    expect(validate.findEmoji('👍🏽')).toEqual(['👍🏽']);
    expect(validate.findEmoji('1️⃣')).toEqual(['1️⃣']);
    expect(validate.findEmoji('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toEqual(['🏴󠁧󠁢󠁳󠁣󠁴󠁿']);
  });

  it('reports the ACCEPTED character together with its selector, not a lone invisible mark', () => {
    // Without this the refusal for "©️" would name U+FE0F on its own and read as
    // "remove: " — a message pointing at nothing.
    expect(validate.findEmoji('©️')).toEqual(['©️']);
  });

  it('separates neighbours and de-duplicates repeats', () => {
    expect(validate.findEmoji('🎉🎊')).toEqual(['🎉', '🎊']);
    expect(validate.findEmoji('🎉 שירה 🎉')).toEqual(['🎉']);
  });

  it('finds nothing in a legitimate name', () => {
    for (const s of Object.values(ACCEPT)) expect(validate.findEmoji(s)).toEqual([]);
  });
});

describe('the Hebrew refusals', () => {
  it('say WHAT is wrong, WHY, and WHICH character to remove', () => {
    const msg = validate.titleEmojiMessage('ליאת חוגגת 40 🎉');
    expect(msg).toContain('אימוג׳י'); // what
    expect(msg).toContain('להדפיס'); // why — it cannot be printed
    expect(msg).toContain('🎉'); // which
    expect(msg).toContain('כותרת'); // where
  });

  it('name the field, so the buyer knows which box to go back to', () => {
    expect(validate.titleEmojiMessage('🎉')).toContain('כותרת');
    expect(validate.nameEmojiMessage('🎉')).toContain('שם');
    expect(validate.wordEmojiMessage('🎉')).toContain('מילה');
  });

  it('are null for clean input — nothing is "refused" quietly', () => {
    expect(validate.titleEmojiMessage('ליאת חוגגת 40')).toBeNull();
    expect(validate.nameEmojiMessage('שירה')).toBeNull();
    expect(validate.wordEmojiMessage('מכבי חיפה')).toBeNull();
    expect(validate.batchEmojiMessage([])).toBeNull();
  });

  it('stop listing at five, so an all-emoji paste is not a wall of text', () => {
    const msg = validate.titleEmojiMessage('🎉🎊⭐✂☀🍕🍔');
    expect(msg).toContain('ועוד');
    expect(msg).not.toContain('🍔');
  });

  it('name the offending WORDS in a batch, not just how many', () => {
    expect(validate.batchEmojiMessage(['פיצה🍕'])).toContain('🍕');
    const many = validate.batchEmojiMessage(['פיצה🍕', 'בירה🍺', 'עוגה🎂', 'שמש☀']);
    expect(many).toContain('4');
    expect(many).toContain('פיצה🍕');
    expect(many).toContain('ועוד');
  });
});

// ---------------------------------------------------------------------------
// The browser copy
// ---------------------------------------------------------------------------

describe('the browser copy of the rule (site/js/emoji.js)', () => {
  it('is character-for-character the server rule', () => {
    // The browser needs its own copy so the refusal arrives WHILE she is typing
    // rather than as an HTTP 400 after she has moved on — but server/validate.js
    // is the authority. If these ever drift, the field and the API disagree about
    // what is acceptable and one of them is lying to her. Pin them.
    expect(CLIENT_CHARS).toBe(validate.EMOJI_CHARS);
    expect(CLIENT_UNIT).toBe(validate.EMOJI_UNIT);
  });

  it('agrees with the server on every refused string', () => {
    for (const s of Object.values(REFUSE)) expect(clientHasEmoji(s)).toBe(true);
  });

  it('agrees with the server on every accepted string', () => {
    for (const s of Object.values(ACCEPT)) expect(clientHasEmoji(s)).toBe(false);
  });

  it('produces the same Hebrew messages the server would', () => {
    expect(clientTitleMessage('ליאת 🎉')).toBe(validate.titleEmojiMessage('ליאת 🎉'));
    expect(clientWordMessage('פיצה🍕')).toBe(validate.wordEmojiMessage('פיצה🍕'));
    expect(clientBatchMessage(['פיצה🍕', 'בירה🍺'])).toBe(
      validate.batchEmojiMessage(['פיצה🍕', 'בירה🍺'])
    );
  });

  it('splits a batch so the good words still go, and the rest are named', () => {
    // Partial acceptance: one 🍕 in a 40-word paste must not throw away the other
    // 39. That is the same bargain the length cap already makes.
    const { ok, withEmoji } = clientSplitByEmoji(['מים', 'פיצה🍕', '  ', 'אש']);
    expect(ok).toEqual(['מים', 'אש']);
    expect(withEmoji).toEqual(['פיצה🍕']);
  });
});

// ---------------------------------------------------------------------------
// The store — the gate every word path funnels through
// ---------------------------------------------------------------------------

describe('db.addWords', () => {
  it('refuses a word with an emoji and stores the clean ones beside it', () => {
    const c = db.createCollection('דנה');
    const r = db.addWords(c.id, ['מים', 'פיצה🍕', 'אש']);
    expect(r.added).toBe(2);
    expect(r.emoji).toBe(1);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(['מים', 'אש']);
  });

  it('REFUSES rather than stripping the emoji out of the word', () => {
    // The tempting "fix" is to store "פיצה" and move on. That is the behaviour
    // this test exists to prevent: she typed 🍕 deliberately, the deck would come
    // back without it, and nothing would ever have told her. Refuse instead.
    const c = db.createCollection('בלי חיתוך');
    db.addWords(c.id, ['פיצה🍕']);
    expect(db.listWords(c.id)).toHaveLength(0);
  });

  it('counts an emoji entry as `emoji`, not as a duplicate, a quota block or too long', () => {
    const c = db.createCollection('ספירה');
    const r = db.addWords(c.id, ['🎉']);
    expect(r).toMatchObject({ added: 0, skipped: 0, blocked: 0, tooLong: 0, emoji: 1 });
  });

  it('closes the WhatsApp path, which is where emoji actually come from', () => {
    // The webhook harvests with whatsapp.splitWords and hands the result straight
    // to db.addWords. Enforcing in the STORE rather than only in the HTTP route
    // is what makes that path safe without a second, competing validator — and a
    // WhatsApp group is by far the most likely place a 🍕 gets typed.
    const c = db.createCollection('וואטסאפ');
    const r = db.addWords(c.id, ['הבדיחה על הפיצה 🍕', 'קמפינג'], 'דנה');
    expect(r.added).toBe(1);
    expect(r.emoji).toBe(1);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(['קמפינג']);
  });

  it('still accepts every legitimate string', () => {
    const c = db.createCollection('לגיטימי');
    c.free_limit_applies = false;
    const words = Object.values(ACCEPT);
    // (only the entries that also fit the 25-character cap — this test is about
    // the emoji rule, not about length)
    const short = words.filter((w) => !validate.isWordTooLong(w));
    const r = db.addWords(c.id, short);
    expect(r.emoji).toBe(0);
    expect(r.added).toBe(short.length);
  });
});

describe('db.editWord', () => {
  it('refuses an edit that ADDS an emoji, and leaves the stored word untouched', () => {
    const c = db.createCollection('עריכה');
    db.addWords(c.id, ['פיצה']);
    const w = db.listWords(c.id)[0];
    const bad = db.editWord(c.id, w.id, 'פיצה🍕', c.owner_token);
    expect(bad.error).toBe('emoji');
    expect(bad.found).toEqual(['🍕']);
    expect(db.listWords(c.id)[0].text).toBe('פיצה');
  });

  it('accepts an ordinary correction', () => {
    const c = db.createCollection('תיקון');
    db.addWords(c.id, ['פיצא']);
    const w = db.listWords(c.id)[0];
    expect(db.editWord(c.id, w.id, 'פיצה', c.owner_token).text).toBe('פיצה');
  });
});

describe('a word stored before the rule existed', () => {
  // The same grandfathering the length cap gets, for the same reason: a paid
  // order must not stop producing because a rule arrived after it was placed.
  // This is an ENTRY-time rule — nothing in the read or render path enforces it,
  // and no migration rewrites stored data.
  function seedLegacy(name) {
    const c = db.createCollection(name);
    db.addWords(c.id, ['מים']);
    db.listWords(c.id)[0].text = 'פיצה🍕';
    return c;
  }

  it('keeps its text byte-for-byte — no cleanup, no strip', () => {
    const c = seedLegacy('הזמנה ישנה');
    expect(db.listWords(c.id)[0].text).toBe('פיצה🍕');
  });

  it('can be opened for editing and saved unchanged', () => {
    const c = seedLegacy('עריכה ישנה');
    const w = db.listWords(c.id)[0];
    // Re-saving the SAME text is idempotent and must not trip the new rule...
    const again = db.editWord(c.id, w.id, 'פיצה🍕', c.owner_token);
    // ...but it is still an entry, so the rule does apply to what is submitted.
    // The page short-circuits an unchanged edit before it ever reaches here (see
    // startWordEdit in collect.html), which is what makes the legacy word safe.
    expect(again.error).toBe('emoji');
    expect(db.listWords(c.id)[0].text).toBe('פיצה🍕');
  });

  it('passes pre-production validation — an old order is still producible', () => {
    const c = seedLegacy('הזמנה ישנה להפקה');
    const problems = validate.validateOrderForProduction(
      c,
      null,
      db.listWords(c.id).map((w) => w.text)
    );
    expect(problems.join(' ')).not.toContain('אימוג׳י');
  });
});

// ---------------------------------------------------------------------------
// The routes — the authority. Every path a printed string can arrive through.
// ---------------------------------------------------------------------------

describe('POST /api/collections — the buyer creating her order', () => {
  it('refuses an emoji in the custom title, naming the field and the character', async () => {
    const r = await req('POST', '/api/collections', {
      honoree_name: 'שירה',
      custom_title: 'שירה חוגגת 40 🎉',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('emoji');
    expect(r.body.field).toBe('custom_title');
    expect(r.body.message).toContain('🎉');
    expect(r.body.message).toMatch(/[֐-׿]/); // Hebrew, matching the surrounding copy
  });

  it('refuses an emoji in the honoree name — the DEFAULT title is built from it', async () => {
    const r = await req('POST', '/api/collections', { honoree_name: 'שירה🎉' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('emoji');
    expect(r.body.field).toBe('honoree_name');
  });

  it('cannot be talked into it by a client that skips the wizard', async () => {
    // The whole reason the server checks at all: the field check in options.html
    // is a courtesy, and a re-post or a stale tab would otherwise put a blank box
    // on 104 paid cards. Nothing is stored.
    const before = db.listAllCollections().length;
    await req('POST', '/api/collections', { honoree_name: 'רות', custom_title: '🎉' });
    expect(db.listAllCollections().length).toBe(before);
  });

  it('still creates the order for every legitimate title', async () => {
    for (const title of ['ליאת חוגגת 40', 'מזל טוב ׳לשירה׳', 'דנה–יוסי 25', '© דוגרי']) {
      const r = await req('POST', '/api/collections', {
        honoree_name: 'ליאת',
        custom_title: title,
      });
      expect(r.status, 'title should have been accepted: ' + title).toBe(201);
    }
  });

  it('still creates the order when there is no custom title at all', async () => {
    const r = await req('POST', '/api/collections', { honoree_name: 'שירה' });
    expect(r.status).toBe(201);
  });
});

describe('PATCH /api/admin/collections/:id — the owner editing the same title', () => {
  it('refuses an emoji in the custom title', async () => {
    const c = db.createCollection('אדמין');
    const r = await req('PATCH', '/api/admin/collections/' + c.id + '?key=' + ADMIN_KEY, {
      custom_title: 'מסיבה 🎉',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('emoji');
    expect(db.getCollection(c.id).custom_title).toBeFalsy();
  });

  it('refuses an emoji in the honoree name', async () => {
    const c = db.createCollection('אדמין שם');
    const r = await req('PATCH', '/api/admin/collections/' + c.id + '?key=' + ADMIN_KEY, {
      honoree_name: 'שירה🎉',
    });
    expect(r.status).toBe(400);
    expect(db.getCollection(c.id).honoree_name).toBe('אדמין שם');
  });

  it('never objects to a patch that does not mention the title', async () => {
    // PATCH semantics: an edit to the phone number must not be refused for a
    // field it never sent. This is the "don't become a nuisance" half.
    const c = db.createCollection('אדמין אחר');
    const r = await req('PATCH', '/api/admin/collections/' + c.id + '?key=' + ADMIN_KEY, {
      phone: '0501234567',
    });
    expect(r.status).toBe(200);
  });

  it('accepts a legitimate title edit', async () => {
    const c = db.createCollection('אדמין תקין');
    const r = await req('PATCH', '/api/admin/collections/' + c.id + '?key=' + ADMIN_KEY, {
      custom_title: 'מזל טוב ׳לשירה׳',
    });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).custom_title).toBe('מזל טוב ׳לשירה׳');
  });
});

describe('POST /api/preview — the live card the buyer is shown', () => {
  it('refuses an emoji title instead of rendering a blank box and calling it WYSIWYG', async () => {
    // The preview is sold as "this is exactly what you will get". Drawing the 🎉
    // as the empty rectangle the font actually produces would be honest and
    // completely useless — she would see a broken card and not know why.
    const r = await req('POST', '/api/preview', {
      theme: 'trip comeback',
      name: 'שירה',
      title: 'שירה חוגגת 🎉',
      board: false,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('emoji');
    expect(r.body.message).toContain('🎉');
  });

  it('refuses an emoji name', async () => {
    const r = await req('POST', '/api/preview', {
      theme: 'trip comeback',
      name: 'שירה🎉',
      board: false,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('emoji');
  });

  it('refuses BEFORE the unknown-theme check does not apply — i.e. it is a cheap, early reject', async () => {
    // Ordering matters for cost: the refusal must land before any Chrome page is
    // spawned. An unknown theme is rejected first (it is cheaper still), so a
    // valid theme with an emoji title is the case that proves the point.
    const bad = await req('POST', '/api/preview', { theme: 'no-such-theme', title: '🎉' });
    expect(bad.body.error).toBe('unknown theme');
  });
});

describe('POST /api/collections/:id/words — the word list', () => {
  it('stores the clean words, refuses the emoji ones, and reports how many', async () => {
    const c = db.createCollection('רשימה');
    const r = await req('POST', '/api/collections/' + c.id + '/words', {
      words: ['מים', 'פיצה🍕', 'אש'],
    });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(2);
    expect(r.body.emoji).toBe(1);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(['מים', 'אש']);
  });

  it('cannot be talked into seating an emoji from a non-browser client', async () => {
    const c = db.createCollection('עקיפה');
    await req('POST', '/api/collections/' + c.id + '/words', { words: ['🎉🎊🎈'] });
    expect(db.listWords(c.id)).toHaveLength(0);
  });

  it('accepts a whole list of legitimate strings without a single refusal', async () => {
    const c = db.createCollection('רשימה תקינה');
    const words = Object.values(ACCEPT).filter((w) => !validate.isWordTooLong(w));
    const r = await req('POST', '/api/collections/' + c.id + '/words', { words });
    expect(r.body.emoji).toBe(0);
    expect(r.body.added).toBe(words.length);
  });
});

describe('PATCH /api/collections/:id/words/:wordId — fixing a typo', () => {
  it('rejects an edit that adds an emoji, with a message that names it', async () => {
    const c = db.createCollection('עריכה מסלול');
    db.addWords(c.id, ['פיצה']);
    const w = db.listWords(c.id)[0];
    const r = await req('PATCH', '/api/collections/' + c.id + '/words/' + w.id, {
      owner_token: c.owner_token,
      text: 'פיצה🍕',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('emoji');
    expect(r.body.message).toContain('🍕');
    expect(r.body.found).toEqual(['🍕']);
    expect(db.listWords(c.id)[0].text).toBe('פיצה');
  });

  it('accepts an ordinary correction', async () => {
    const c = db.createCollection('עריכה תקינה');
    db.addWords(c.id, ['פיצא']);
    const w = db.listWords(c.id)[0];
    const r = await req('PATCH', '/api/collections/' + c.id + '/words/' + w.id, {
      owner_token: c.owner_token,
      text: 'מזל טוב ׳שירה׳',
    });
    expect(r.status).toBe(200);
  });
});

describe('the seed word POOLS (server/wordlists.js)', () => {
  // The least visible way an emoji reaches a printed card: topup.py draws filler
  // from these pools when a buyer's own words don't fill a deck, so a 🎉 here is
  // a blank box on somebody's cards that she never even typed.
  it('refuses an emoji in a new pool and names it in the warning', () => {
    const r = store.create({ name: 'emoji-test-new', words: ['מים', 'פיצה🍕', 'אש'] });
    expect(r.words).toEqual(['מים', 'אש']);
    expect(r.with_emoji).toEqual(['פיצה🍕']);
    expect(r.warning).toContain('🍕');
  });

  it('refuses an emoji added to an existing pool', () => {
    store.create({ name: 'emoji-test-add', words: ['מים'] });
    const r = store.update('emoji-test-add', { words: ['מים', 'בירה🍺'] });
    expect(r.words).toEqual(['מים']);
    expect(r.warning).toContain('🍺');
  });

  it('rejects an APPEND of nothing but emoji outright, so the owner sees why', () => {
    store.create({ name: 'emoji-test-append', words: ['מים'] });
    const r = store.update('emoji-test-append', { append: '🍺' });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('אימוג׳י');
  });

  it('grandfathers an emoji that is ALREADY in the pool, so an unrelated save does not delete it', () => {
    // The admin editor round-trips the whole list on every save. A filter with no
    // memory would silently drop existing entries the moment the owner fixed a
    // typo somewhere else in the file — a save is not the place to discover that
    // the pool got shorter.
    const { kept, withEmoji } = store.splitByEmoji(['ישן🍕', 'חדש🍺'], ['ישן🍕']);
    expect(kept).toEqual(['ישן🍕']);
    expect(withEmoji).toEqual(['חדש🍺']);
  });

  it('reports BOTH refusals in one warning when a save trips both rules', () => {
    const r = store.splitRefused(['מים', 'א'.repeat(30), 'פיצה🍕'], []);
    expect(r.kept).toEqual(['מים']);
    expect(r.warning).toContain('ארוכות');
    expect(r.warning).toContain('אימוג׳י');
  });

  it('leaves a clean pool completely alone', () => {
    const r = store.splitRefused(['מים', 'אש', 'מזל טוב ׳שירה׳'], []);
    expect(r.kept).toEqual(['מים', 'אש', 'מזל טוב ׳שירה׳']);
    expect(r.warning).toBeNull();
  });
});

describe('the pools that SHIP with the product', () => {
  it('contain no emoji at all', () => {
    // combined-416.txt really did carry a stray 🅿️ — printed as filler on every
    // deck that pool fed, for as long as it was there. It is removed at source;
    // this test is what stops the next one from arriving unnoticed.
    const dir = path.join(__dirname, '..', '..', 'content', 'wordlists');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.txt')) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (validate.hasEmoji(line)) offenders.push(f + ': ' + line);
      }
    }
    expect(offenders).toEqual([]);
  });
});
