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
  .map((l) => {
    const rest = l.trim().replace(/^COPY\s+/, '');
    // JSON-array form: COPY ["src with space", "dest"]. Docker REQUIRES it when
    // a path contains a space, so a whitespace split would read those paths as
    // several broken fragments and silently report the file as never copied —
    // which is precisely the case most likely to be wrong in the first place.
    if (rest.startsWith('[')) {
      try {
        return JSON.parse(rest).slice(0, -1);
      } catch {
        return [];
      }
    }
    return rest.split(/\s+/).slice(0, -1);
  })
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

// `isReincluded` above only looks for a `!` line. That is not how .dockerignore
// actually resolves: rules are applied IN ORDER and the LAST match wins, so a
// re-included tree can be carved up again by a later exclude — which is exactly
// what happened to filled/. `!resources/canva/templates/**` made the checks above
// pass while two later lines stripped every filled/ directory back out.
//
// This is the real evaluator: walk the rules in order, last match wins.
function ruleRegex(pattern) {
  const rx = pattern
    .split('/')
    .map((seg) =>
      seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    )
    .join('/');
  // A rule that matches a directory also covers everything beneath it.
  return new RegExp('^' + rx + '(/.*)?$');
}

const rules = dockerignore.map((line) => ({
  negated: line.startsWith('!'),
  re: ruleRegex(line.replace(/^!/, '').replace(/\/$/, '')),
}));

// True when `rel` survives .dockerignore and is therefore in the build context.
function inBuildContext(rel) {
  let included = true;
  for (const r of rules) if (r.re.test(rel)) included = r.negated;
  return included;
}

describe('.dockerignore resolves last-match-wins', () => {
  it('the evaluator agrees with the blanket exclude', () => {
    // Sanity: without this the assertions below would pass on any input.
    expect(excludesEverythingByDefault).toBe(true);
    expect(inBuildContext('node_modules/express/index.js')).toBe(false);
    expect(inBuildContext('.git/config')).toBe(false);
    expect(inBuildContext('CLAUDE.md')).toBe(false);
  });

  it('keeps the code and assets the image runs on', () => {
    expect(inBuildContext('server/index.js')).toBe(true);
    expect(inBuildContext('site/index.html')).toBe(true);
    expect(inBuildContext('generator/topup.py')).toBe(true);
    expect(inBuildContext('content/wordlists/generic-350.txt')).toBe(true);
  });

  // The press export reads this ICC profile off disk when the admin presses
  // "PDF לבית דפוס". It was committed to git with a .gitignore exception and
  // shipped anyway broken, because .dockerignore drops all of resources/ and
  // NOTHING re-included it — so deployed, the button answered
  //   500 press ICC profile missing  /app/resources/print shop/...
  // The path also carries a space, which is why the Dockerfile COPY has to use
  // the JSON-array form; a bare COPY would split it into two arguments.
  it('ships the press ICC profile the CMYK export reads', () => {
    const icc = 'resources/print shop/SWOP2006_Coated3v2.icc';
    expect(fs.existsSync(path.join(repo, icc))).toBe(true);
    expect(inBuildContext(icc)).toBe(true);
    expect(isCopied(icc)).toBe(true);
  });

  // The re-include is deliberately narrow. Generated press samples land in that
  // same folder and are megabytes each; sweeping the directory in would grow
  // every image build for nothing.
  it('does not sweep the rest of that folder into the image', () => {
    expect(inBuildContext('resources/print shop/dugri-press-sample.pdf')).toBe(false);
  });

  // The SHIPPED THEMES are deliberately out of the image now. They were the
  // image's copy of designs the owner has since re-onboarded through the admin,
  // and the volume copy (DATA_DIR/templates) shadows the image one — so what the
  // image carried had stopped being what renders, at a cost of 131MB in the image
  // and 131MB in every `railway up` upload.
  //
  // This inverts an older guard that pinned filled/ INTO the image. That guard was
  // right for its time: the server diffs clean/ against filled/ to detect slots,
  // and "שחזור למקור" restored from the shipped copy, so stripping filled/ once
  // cost the owner nine SVGs outright. Both of those now read the volume, which is
  // the single source of artwork — and the reason scripts/backup-templates.mjs
  // exists. Restoring these lines would put the 131MB back.
  const themesDir = path.join(repo, 'resources', 'canva', 'templates');
  const templateDirs = fs
    .readdirSync(themesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_shared')
    .map((d) => d.name);

  for (const t of templateDirs) {
    it(`keeps ${t}/ out of the image — the volume's copy is what renders`, () => {
      expect(inBuildContext(`resources/canva/templates/${t}/clean/fronts.svg`)).toBe(false);
      expect(inBuildContext(`resources/canva/templates/${t}/fonts/Any.ttf`)).toBe(false);
    });
  }

  // _shared is NOT a theme and must survive the exclusion above: the photo card
  // falls back to its pawns on any order with fewer than four customer photos, so
  // an image without it fails an order that renders perfectly in dev.
  it('still ships _shared/ — the photo card reads it per order', () => {
    expect(inBuildContext('resources/canva/templates/_shared/photo-fallback/1.svg')).toBe(true);
    expect(inBuildContext('resources/canva/templates/_shared/photo-card/photo.svg')).toBe(true);
  });
});

// The upload is a THIRD filter, after .dockerignore and the COPY list, and it is
// the one that broke: `railway up` tars the working directory, so a file the
// image never sees still crosses the wire. It reached ~250MB and stopped
// completing at all.
describe('.railwayignore keeps the upload in step with the image', () => {
  const railwayignore = fs
    .readFileSync(path.join(repo, '.railwayignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const uploadRules = railwayignore.map((line) => ({
    negated: line.startsWith('!'),
    re: ruleRegex(line.replace(/^!/, '').replace(/\/$/, '')),
  }));

  const inUpload = (rel) => {
    let included = true;
    for (const r of uploadRules) if (r.re.test(rel)) included = r.negated;
    return included;
  };

  it('uploads everything the Dockerfile copies', () => {
    expect(inUpload('server/index.js')).toBe(true);
    expect(inUpload('site/index.html')).toBe(true);
    expect(inUpload('generator/build.py')).toBe(true);
    expect(inUpload('content/wordlists/generic-350.txt')).toBe(true);
    expect(inUpload('resources/print shop/SWOP2006_Coated3v2.icc')).toBe(true);
    expect(inUpload('resources/canva/templates/_shared/photo-fallback/1.svg')).toBe(true);
  });

  it('does not upload what the image no longer contains', () => {
    expect(inUpload('resources/canva/templates/grapefruit/clean/2.svg')).toBe(false);
    expect(inUpload('resources/canva/staging/posttrip/front.svg')).toBe(false);
    expect(inUpload('tests/unit/runtime-assets.test.js')).toBe(false);
  });
});

describe('runtime assets are packaged into the image', () => {
  // Every directory the Python generator opens at request time.
  const RUNTIME_DIRS = [
    'generator', // the code, recipes/, themes.json, word-fonts/
    'content', // topup.py's seed word pools
    // The per-theme artwork is NOT here any more — it lives on the volume and is
    // shadowed there. Only _shared (the photo card's fallback pawns) still ships.
    'resources/canva/templates/_shared',
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
