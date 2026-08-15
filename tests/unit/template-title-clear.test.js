// @vitest-environment node
// STRIPPING A SHIPPED DESIGN'S OWN TITLE.
//
// "i want also the old templates to be with title only from now on. but also
// keep backward compatibility."
//
// A design that has shipped for months carries a composed title
// ("{NAME}'S BACHELORETTE"). Every order placed since the buyer started typing
// her own title ignores it — a carried title replaces the composed one wherever
// it renders — so those lines now reach a card only for an order from BEFORE the
// change. The owner can therefore drop them.
//
// That is why it is a deliberate edit and not a migration: dropping them takes
// the title away from those older orders. The template keeps its own until she
// says otherwise; this only stops the save being REFUSED.
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
let root;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-clear-'));
  process.env.DATA_DIR = root;
  delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
  templates = require(path.join(serverDir, 'templates.js'));
});

// A shipped design, written into the owner store the way onboarding would.
function shipped(key, entry) {
  const dir = path.join(root, 'templates');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'themes.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[key] = {
    title_text: "{NAME}'S BACHELORETTE",
    title_lines: ["{NAME}'S BACHELORETTE"],
    name_form: 'english-caps',
    language: 'english',
    ...entry,
  };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return key;
}

const patch = (key, p) => templates.updateTemplateSettings({ root, key, patch: p });

describe('clearing an old template’s composed title', () => {
  it('is accepted, and leaves the template with none', () => {
    const key = shipped('legacy-clear');
    const r = patch(key, { title_lines: [] });
    expect(r.error).toBeUndefined();
    const after = templates.loadOwnerThemes(root)[key];
    expect(after.title_lines).toEqual([]);
    expect(after.title_text).toBe('');
  });

  it('takes an empty string the same way — the editor sends what it has', () => {
    const key = shipped('legacy-clear-str');
    expect(patch(key, { title_text: '' }).error).toBeUndefined();
    expect(templates.loadOwnerThemes(root)[key].title_lines).toEqual([]);
  });

  it('treats blank lines as empty, not as a one-line title of spaces', () => {
    const key = shipped('legacy-clear-blank');
    expect(patch(key, { title_lines: ['', '   '] }).error).toBeUndefined();
    expect(templates.loadOwnerThemes(root)[key].title_lines).toEqual([]);
  });

  it('does NOT ask for the no-{NAME} confirmation on the way out', () => {
    // That confirmation exists so a title with no {NAME} is never arrived at by
    // accident. Removing the title altogether is not that mistake — it is the
    // owner saying the design has no title of its own.
    const key = shipped('legacy-clear-noconfirm');
    const r = patch(key, { title_lines: [] });
    expect(r.titleless).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it('still refuses a title that is WRONG rather than absent', () => {
    // Optional is not unchecked: setting a title that names a field the template
    // does not collect is the "'s Birthday" bug, and it is still refused.
    const key = shipped('legacy-bad-title');
    const r = patch(key, { title_lines: ['{NAME} {AGE}'] });
    expect(r.error).toMatch(/AGE/);
    expect(templates.loadOwnerThemes(root)[key].title_lines).toEqual(["{NAME}'S BACHELORETTE"]);
  });

  it('leaves a template alone when the patch never mentions the title', () => {
    const key = shipped('legacy-untouched');
    expect(patch(key, { visibility: 'private' }).error).toBeUndefined();
    expect(templates.loadOwnerThemes(root)[key].title_lines).toEqual(["{NAME}'S BACHELORETTE"]);
  });
});
