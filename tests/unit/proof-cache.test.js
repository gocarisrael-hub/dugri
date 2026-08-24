// @vitest-environment node
//
// The proof CACHE — the part with the sharp edges.
//
// Rendering is ghostscript's job and the generator tests cover it against a real
// PDF. What lives here is everything around it: is this proof still the deck's,
// can a page number off a URL name a file, does a second tab start a second
// ghostscript over the same directory. Each of those is a way to show a buyer
// the wrong thing while looking like it worked.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proof = require(path.join(__dirname, '..', '..', 'server', 'proof.js'));

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-proof-'));
});

// A produced order: the deck, then a proof of it written afterwards.
function seed(id, pages = 3, { stale = false } = {}) {
  fs.writeFileSync(path.join(dir, id + '.pdf'), 'PDF');
  const pd = path.join(dir, id + '.proof');
  fs.mkdirSync(pd, { recursive: true });
  const files = [];
  for (let n = 1; n <= pages; n++) {
    const name = String(n).padStart(4, '0') + '.webp';
    fs.writeFileSync(path.join(pd, name), 'IMG');
    files.push(name);
  }
  fs.writeFileSync(path.join(pd, 'proof.json'), JSON.stringify({ pages, files, width: 320 }));
  if (stale) {
    // The deck re-produced AFTER the proof was made.
    const later = Date.now() + 60000;
    fs.utimesSync(path.join(dir, id + '.pdf'), later / 1000, later / 1000);
  }
  return pd;
}

describe('is this proof still the deck it claims to show', () => {
  it('reads back a proof written after its deck', () => {
    seed('a', 4);
    expect(proof.readFresh(dir, 'a').pages).toBe(4);
  });

  it('REFUSES a proof older than its deck', () => {
    // The failure this guards: an order re-produced with corrected words, and a
    // buyer approving the pages of the version that was thrown away.
    seed('a', 4, { stale: true });
    expect(proof.readFresh(dir, 'a')).toBe(null);
  });

  it('has no opinion about an order that was never produced', () => {
    expect(proof.readFresh(dir, 'ghost')).toBe(null);
  });

  it('treats an unreadable manifest as absent, not as an error', () => {
    seed('a', 2);
    fs.writeFileSync(path.join(dir, 'a.proof', 'proof.json'), '{ truncated');
    expect(proof.readFresh(dir, 'a')).toBe(null);
  });
});

describe('a page number off the URL never names a file', () => {
  const manifest = { pages: 5 };

  it('resolves a page in range to its own file', () => {
    const f = proof.pageFile(dir, 'a', 3, manifest);
    expect(path.basename(f)).toBe('0003.webp');
    expect(path.dirname(f)).toBe(path.join(dir, 'a.proof'));
  });

  it('refuses a page past the end of the deck', () => {
    expect(proof.pageFile(dir, 'a', 6, manifest)).toBe(null);
    expect(proof.pageFile(dir, 'a', 0, manifest)).toBe(null);
  });

  it.each(['../../../etc/passwd', '1/../../secret', '2.5', 'NaN', '', '1e1'])(
    'refuses %j',
    (bad) => {
      expect(proof.pageFile(dir, 'a', bad, manifest)).toBe(null);
    }
  );

  it('rebuilds the name from digits rather than passing the input through', () => {
    // '3' and 3 must land on the same file, and neither may contribute a
    // separator: the name is built from the NUMBER, never from the text.
    expect(proof.pageFile(dir, 'a', '3', manifest)).toBe(proof.pageFile(dir, 'a', 3, manifest));
  });
});

describe('building', () => {
  it('refuses to build a proof of a deck that does not exist', async () => {
    await expect(
      proof.build({ generatedDir: dir, id: 'ghost', python: 'python3', repoRoot: process.cwd() })
    ).rejects.toThrow('no pdf');
  });

  it('a second request joins the first build instead of starting its own', async () => {
    // Two tabs, or a reload mid-render. A second ghostscript over the same
    // directory would race on the same filenames and one of them would win
    // halfway through a deck.
    fs.writeFileSync(path.join(dir, 'b.pdf'), 'PDF');
    const opts = { generatedDir: dir, id: 'b', python: 'definitely-not-python', repoRoot: dir };
    const one = proof.build(opts);
    const two = proof.build(opts);
    expect(two).toBe(one);
    await Promise.allSettled([one, two]);
  });

  it('lets a later request build again once the first has finished', async () => {
    fs.writeFileSync(path.join(dir, 'c.pdf'), 'PDF');
    const opts = { generatedDir: dir, id: 'c', python: 'definitely-not-python', repoRoot: dir };
    await proof.build(opts).catch(() => {});
    const again = proof.build(opts);
    await again.catch(() => {});
    expect(again).toBeInstanceOf(Promise);
  });

  it('ensure serves the cached manifest without spawning anything', async () => {
    seed('d', 6);
    const m = await proof.ensure({
      generatedDir: dir,
      id: 'd',
      python: 'definitely-not-python', // a spawn here would reject
      repoRoot: dir,
    });
    expect(m.pages).toBe(6);
  });
});

describe('clearing', () => {
  it('takes the proof with the deck', () => {
    const pd = seed('e', 3);
    proof.remove(dir, 'e');
    expect(fs.existsSync(pd)).toBe(false);
  });

  it('is content when there was nothing to remove', () => {
    expect(() => proof.remove(dir, 'never-existed')).not.toThrow();
  });
});
