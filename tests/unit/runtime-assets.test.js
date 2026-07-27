// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// The generator reads data files off disk at request time. Anything it reads has
// to be COPYed into the runtime image, and nothing was checking that: the seed
// word pools under content/ were never copied, so every deployed order with
// fewer than TARGET personal words died mid-generation with
//   FileNotFoundError: '/app/content/wordlists/generic-350.txt'
// It survived review because topup() only opens the pools when it actually needs
// filler, so a local run with a long word list never touches them.
//
// These tests are deliberately about the CONTRACT between the generator's
// on-disk reads and the Dockerfile, not about any one file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, '..', '..');

const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');

// Source paths the Dockerfile copies into the image, e.g. 'generator/'.
const copied = dockerfile
  .split('\n')
  .filter((l) => /^\s*COPY\s/.test(l) && !/--from=/.test(l))
  .map((l) => l.trim().split(/\s+/).slice(1, -1))
  .flat();

// True when `rel` is inside something the image copies.
const isCopied = (rel) =>
  copied.some((src) => {
    const s = src.replace(/\/$/, '');
    return rel === s || rel.startsWith(s + '/');
  });

// A COPY line is only half the story. .dockerignore excludes EVERYTHING with a
// leading `*` and then re-includes each build input with `!`, so a path the
// Dockerfile copies but the ignore file never re-includes is simply absent from
// the build context — the COPY then matches nothing and either fails the build or
// ships an empty directory. That is exactly how `content/` was missed twice: the
// COPY was added without the matching re-include.
const dockerignore = fs
  .readFileSync(path.join(repo, '.dockerignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const excludesEverythingByDefault = dockerignore.includes('*');

// True when the ignore file re-includes `rel` (or a parent of it) via `!`.
const isReincluded = (rel) =>
  dockerignore.some((line) => {
    if (!line.startsWith('!')) return false;
    const p = line
      .slice(1)
      .replace(/\/\*\*$/, '')
      .replace(/\/$/, '');
    return rel === p || rel.startsWith(p + '/');
  });

describe('runtime assets are packaged into the image', () => {
  // Every directory the Python generator opens at request time.
  const RUNTIME_DIRS = [
    'generator', // the code, recipes/, themes.json, word-fonts/
    'content', // topup.py's seed word pools
    'resources/canva/templates', // per-theme clean art + fonts
  ];

  for (const dir of RUNTIME_DIRS) {
    it(`Dockerfile copies ${dir}/`, () => {
      expect(fs.existsSync(path.join(repo, dir))).toBe(true);
      expect(isCopied(dir)).toBe(true);
    });

    it(`.dockerignore re-includes ${dir}/ so the COPY has a source`, () => {
      if (!excludesEverythingByDefault) return; // no blanket exclude, nothing to re-include
      expect(isReincluded(dir)).toBe(true);
    });
  }

  it('every path the Dockerfile copies survives .dockerignore', () => {
    // The general form of the rule above: no COPY may reference a path the
    // ignore file drops. Catches a future COPY added without its `!` line.
    if (!excludesEverythingByDefault) return;
    const dropped = copied
      .map((s) => s.replace(/^\.\//, '').replace(/\/$/, ''))
      .filter((s) => s && !s.startsWith('/') && !s.includes('*'))
      .filter((s) => fs.existsSync(path.join(repo, s)))
      .filter((s) => !isReincluded(s));
    expect(dropped).toEqual([]);
  });

  it('copies the wordlists directory topup.py resolves', () => {
    // topup.py: WORKDIR is /app and WORDLISTS_DIR = <repo>/content/wordlists.
    expect(isCopied('content/wordlists')).toBe(true);
  });
});

describe('the seed word pools the generator resolves all exist', () => {
  const wordlists = path.join(repo, 'content', 'wordlists');
  const themes = JSON.parse(fs.readFileSync(path.join(repo, 'generator', 'themes.json'), 'utf8'));

  it('the generic fallback pool exists', () => {
    // topup.py falls back to this for EVERY theme, so a missing file here breaks
    // every order, not just one design's.
    expect(fs.existsSync(path.join(wordlists, 'generic-350.txt'))).toBe(true);
  });

  for (const [key, cfg] of Object.entries(themes)) {
    if (!cfg || !cfg.wordlist) continue;
    it(`${key} -> ${cfg.wordlist} exists`, () => {
      expect(fs.existsSync(path.join(wordlists, cfg.wordlist))).toBe(true);
    });
  }
});
