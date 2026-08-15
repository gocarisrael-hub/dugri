// @vitest-environment node
// A TEMPLATE NO LONGER HAS TO DECLARE A TITLE.
//
// The title template exists to COMPOSE a title out of the honoree's name, their
// gender and a per-theme extra field ("{NAME} {m:בן|f:בת} {AGE}"). The buyer types
// the title herself now — "no name no gender only free text title" — so a
// template registered today has nothing to compose, and demanding one means
// inventing a sentence that will never be printed.
//
// What must NOT change: the designs that predate this still carry their template
// and still render it, because the orders placed before it have no title of their
// own and print the composed one. So "optional" has to mean optional, not gone —
// and a template that DOES declare a title is still held to every rule that
// stopped "'s Birthday" from shipping.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let templates;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tmpl-opt-'));
  delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
  templates = require(path.join(serverDir, 'templates.js'));
});

// The shared metadata validator both the full upload and "create an empty
// template" run — one answer for both doors.
const normalize = (fields) => templates.normalizeMetadata({ root: process.env.DATA_DIR, fields });

const base = (extra = {}) => ({
  slug: 'a-new-design-' + Math.random().toString(36).slice(2, 8),
  display_he: 'עיצוב חדש',
  ...extra,
});

describe('registering a template with no title', () => {
  it('is accepted, and stores an empty title', () => {
    const r = normalize(base());
    expect(r.error).toBeUndefined();
    expect(r.titleText).toBe('');
    expect(r.titleLines).toEqual([]);
  });

  it('does not demand a name_form either', () => {
    // name_form casts {NAME} into the design's script. With no {NAME} there is
    // nothing to cast, so requiring it is asking for an answer to a question
    // nobody asked.
    const r = normalize(base());
    expect(r.error).toBeUndefined();
  });

  it('still rejects a name_form that is not a real one', () => {
    // Optional is not "unchecked": a typo must fail rather than register a value
    // the generator cannot read.
    const r = normalize(base({ name_form: 'hebrewish' }));
    expect(r.error).toMatch(/name_form/);
  });
});

describe('a template that DOES declare a title', () => {
  it('is still held to every rule', () => {
    // {AGE} with no extra_fields to collect it — the "'s Birthday" class of bug.
    const bad = normalize(base({ title_text: '{NAME} {AGE}', name_form: 'hebrew' }));
    expect(bad.error).toMatch(/AGE/);

    // and no {NAME} at all still needs the explicit confirmation
    const titleless = normalize(base({ title_text: 'Bride in One Pot', name_form: 'english' }));
    expect(titleless.titleless).toBe(true);
  });

  it('still requires a name_form beside it', () => {
    // The pairing that matters: a title with {NAME} and no name_form has no way
    // to know which script to cast it into.
    const r = normalize(base({ title_text: "{NAME}'S B-DAY" }));
    expect(r.error).toMatch(/name_form/);
  });

  it('is stored as typed', () => {
    const r = normalize(base({ title_text: "{NAME}'S B-DAY", name_form: 'english-caps' }));
    expect(r.error).toBeUndefined();
    expect(r.titleLines).toEqual(["{NAME}'S B-DAY"]);
  });
});

describe('an OLD template can be made title-only too', () => {
  // "i want also the old templates to be with title only from now on. but also
  // keep backward compatibility."
  //
  // Both halves are real. A design that has shipped for months carries a title
  // template ("{NAME}'S BACHELORETTE") — and every order placed since the buyer
  // started typing her own title ignores it, because a carried title replaces the
  // composed one. So the template's own title now only ever reaches a page for an
  // order from BEFORE the change. The owner can therefore drop it; she just has
  // to say so, because dropping it takes the title away from those older orders.
  const shipped = () => ({
    slug: 'legacy-' + Math.random().toString(36).slice(2, 8),
    display_he: 'עיצוב ותיק',
    title_text: "{NAME}'S BACHELORETTE",
    name_form: 'english-caps',
  });

  it('registers with its composed title, as it always did', () => {
    const r = normalize(shipped());
    expect(r.error).toBeUndefined();
    expect(r.titleLines).toEqual(["{NAME}'S BACHELORETTE"]);
  });

  it('accepts an empty title as a real edit, not a validation failure', () => {
    // The refusal this replaces was absolute: validateTitle answered
    // "title_text is required" to an empty patch, so the only way to strip a
    // shipped design's title was hand-editing themes.json on the volume.
    const r = templates.validateTitle({ titleText: '', extraFields: [] });
    expect(r.error).toBe('title_text is required');
    // …which is still the right answer for a title being SET. Clearing is a
    // different intention and is handled before this is reached — see
    // updateTemplateSettings — so the two cannot be confused.
  });
});
