// @vitest-environment node
// WHAT THE FILLER WORDS MAY BE ABOUT.
//
// A deck is 412 words and almost nobody writes 412, so the rest are drawn from a
// seed pool (content/wordlists, generator/topup.py). Those words are printed on
// the cards beside the buyer's own — she did not choose them and does not see
// them until the game is open in a room full of people.
//
// So the pools were read, and they contained הלוויה, בית חולים, תאונה, דם, מוות,
// אמבולנס, מלחמה and אזעקה. `kids-birthday-350` — the pool behind a CHILD's
// birthday — carried a funeral, a hospital, a car crash and blood. Nobody put
// them there to be cruel; they are ordinary Hebrew nouns, and a list assembled
// for coverage will pick them up unless something says not to.
//
// This is that something. It guards the SHIPPED baseline only: the owner's own
// pools live on the volume and are hers to write as she likes — including
// deliberately spicy ones. What ships in the box is a different promise.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'content',
  'wordlists'
);

// EXACT words, never substrings. "כאב ראש" is a joke everyone has lived, "משבר
// גיל 30" is the whole premise of a 30th birthday, "ריבה" is jam and "אמסטרדם"
// is a trip — a substring rule would take all four with it.
const BANNED = [
  // death, injury, war
  'הלוויה',
  'בית חולים',
  'תאונה',
  'דם',
  'מוות',
  'אמבולנס',
  'מלחמה',
  'אזעקה',
  'שני פנסים כחולים',
  // grief and the flat sadnesses
  'עצוב',
  'עצב',
  'בכי',
  'דמעות',
  'בדידות',
  'שנאה',
  'ריב',
  'לריב',
  'כועס',
  'פחד',
  'לפחד',
  'פחדן',
  'כאב',
  'חרדה',
  'משבר',
  'פרידה',
  'גרוש',
  'זקן',
  'מבוכה',
];

const pools = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => [
    f,
    fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .map((w) => w.trim()),
  ]);

describe('the shipped filler pools', () => {
  it('are all present, so this test cannot pass by finding nothing', () => {
    expect(pools.length).toBeGreaterThan(5);
    for (const [name, words] of pools)
      expect(words.filter(Boolean).length, name).toBeGreaterThan(50);
  });

  // Reported per pool with the offending words named: "a banned word exists"
  // sends someone grepping 3000 lines, and the point is to make the fix obvious.
  it.each(BANNED)('never offer %s', (bad) => {
    const found = pools.filter(([, words]) => words.includes(bad)).map(([name]) => name);
    expect(found, `"${bad}" is in: ${found.join(', ')}`).toEqual([]);
  });

  // The rule is exact-match, and this proves it stays that way: each of these is
  // a GOOD phrase that a substring rule ("contains כאב", "contains חולים")
  // would have deleted. They are still in the pools, and they are not banned.
  it('keeps the phrases a substring rule would have taken by mistake', () => {
    const all = new Set(pools.flatMap(([, words]) => words));
    for (const good of ['כאב ראש', 'קופת חולים']) {
      expect(all.has(good), `"${good}" was removed — the rule is exact-match`).toBe(true);
      expect(BANNED).not.toContain(good);
    }
  });
});
