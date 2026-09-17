// THE PARENT HALF OF TRANZILA'S APPLE PAY FLOW.
//
// The wallet button is inside their iframe; the sheet is opened by a script on
// OUR page. With no parent listening the button renders, passes its own gate and
// does nothing when tapped — visible and inert, which is what the owner reported.
//
// What is worth testing here is not "does it add a script tag". It is the two
// places this can go quietly wrong on the money path:
//
//   * loading 89KB of jQuery and a third-party script for buyers who can never
//     use either (another provider, or a browser with no Apple Pay), and
//   * their script's last line, `window.onload = function(){…}` — an ASSIGNMENT
//     that clobbers whatever the page had, carrying a validate_apple POST that
//     stops running entirely if the script is loaded after `load` has fired.
//
// The behaviour itself can only be proven by tapping the button on a real iPhone
// against staging; these are the parts that can be held still in a test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const TRANZILA_URL = 'https://directng.tranzila.com/dugri/iframenew.php?sum=199';
const PELECARD_URL = 'https://gateway21.pelecard.biz/PaymentGW/xxxx';

// A fresh module per test: `armApplePay` memoises its work in module state, which
// is the point of it (one load per page), and would otherwise leak between cases.
async function freshModule() {
  vi.resetModules();
  return import('../../site/js/apple-pay.js');
}

// Stand in for the network: record what was asked for, perform the side effect the
// real file would have had, then fire its load event.
function stubLoading({ theirOnload } = {}) {
  const asked = [];
  const appended = vi.spyOn(document.head, 'appendChild').mockImplementation(
    /** @param {any} el */ (el) => {
      const src = String(el.src || '');
      asked.push(src);
      if (src.includes('jquery')) {
        window.jQuery = {
          noConflict(deep) {
            if (deep) {
              delete window.jQuery;
              delete window.$;
            }
            return { ajax: () => {}, each: () => {} };
          },
        };
      } else if (src.includes('tranzilanapple') && theirOnload) {
        window.onload = theirOnload; // the clobber, exactly as their file does it
      }
      setTimeout(() => el.dispatchEvent(new Event('load')), 0);
      return el;
    }
  );
  return { asked, appended };
}

describe('what it refuses to load, and for whom', () => {
  beforeEach(() => {
    window.ApplePaySession = function () {};
  });
  afterEach(() => {
    delete window.ApplePaySession;
    vi.restoreAllMocks();
  });

  it('knows a Tranzila payment window from anyone else’s', async () => {
    const { isTranzilaFrame } = await freshModule();
    expect(isTranzilaFrame(TRANZILA_URL)).toBe(true);
    // The other provider on this very page, and the two shapes that must not throw.
    expect(isTranzilaFrame(PELECARD_URL)).toBe(false);
    expect(isTranzilaFrame('about:blank')).toBe(false);
    expect(isTranzilaFrame(undefined)).toBe(false);
    // A look-alike host must not pass: this string is also their script's own
    // origin gate, so anything it lets through could not talk to them anyway.
    expect(isTranzilaFrame('https://directng.tranzila.com.evil.test/x')).toBe(false);
  });

  it('loads NOTHING for a charge going to the other provider', async () => {
    const { armApplePay } = await freshModule();
    const { asked } = stubLoading();
    await expect(armApplePay(PELECARD_URL)).resolves.toBe(false);
    expect(asked).toEqual([]);
  });

  it('loads NOTHING in a browser that cannot open an Apple Pay sheet', async () => {
    delete window.ApplePaySession; // Chrome, Firefox, every Android browser
    const { armApplePay } = await freshModule();
    const { asked } = stubLoading();
    await expect(armApplePay(TRANZILA_URL)).resolves.toBe(false);
    expect(asked).toEqual([]);
  });
});

describe('what it does when the wallet can actually be used', () => {
  let pageOnload;
  beforeEach(() => {
    window.ApplePaySession = function () {};
    pageOnload = () => {};
    window.onload = pageOnload;
  });
  afterEach(() => {
    delete window.ApplePaySession;
    delete window.$n;
    window.onload = null;
    vi.restoreAllMocks();
  });

  it('loads jQuery first, then their script, and hands over `$n`', async () => {
    const { armApplePay } = await freshModule();
    const { asked } = stubLoading();
    await expect(armApplePay(TRANZILA_URL)).resolves.toBe(true);
    expect(asked).toHaveLength(2);
    // Order is not cosmetic: `$n` has to exist before their handlers run.
    expect(asked[0]).toContain('/vendor/jquery/jquery-3.6.0.min.js');
    expect(asked[1]).toBe('https://directng.tranzila.com/assets/js/tranzilanapple_v3.js');
    // `$n` is what their script calls; `$`/`jQuery` must NOT be left on window,
    // because this page has its own `$`.
    expect(typeof window.$n.ajax).toBe('function');
    expect(window.jQuery).toBeUndefined();
    expect(window.$).toBeUndefined();
  });

  it('does it once, however many times the window is opened', async () => {
    const { armApplePay } = await freshModule();
    const { asked } = stubLoading();
    await armApplePay(TRANZILA_URL);
    await armApplePay(TRANZILA_URL);
    await armApplePay(TRANZILA_URL);
    expect(asked).toHaveLength(2);
  });

  // THE LANDMINE. Their file ends with `window.onload = function(){…}`.
  it('puts the page’s own onload back, and still runs the work theirs carried', async () => {
    const theirOnload = vi.fn();
    const { armApplePay } = await freshModule();
    stubLoading({ theirOnload });

    await armApplePay(TRANZILA_URL);
    // The clobber is undone: whatever the page had is what the page still has.
    expect(window.onload).toBe(pageOnload);
    // …and their validate_apple ping is not simply dropped. It is invoked by hand,
    // after a turn, because loading the script post-`load` means their assignment
    // would otherwise never fire at all.
    expect(theirOnload).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(theirOnload).toHaveBeenCalledTimes(1);
  });

  it('survives their script failing, and lets a later window try again', async () => {
    const { armApplePay } = await freshModule();
    const asked = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation(
      /** @param {any} el */ (el) => {
        asked.push(String(el.src || ''));
        setTimeout(() => el.dispatchEvent(new Event('error')), 0);
        return el;
      }
    );
    // Never rejects: the card payment underneath must not depend on the wallet.
    await expect(armApplePay(TRANZILA_URL)).resolves.toBe(false);
    expect(window.onload).toBe(pageOnload);
    expect(asked).toHaveLength(1);
    await armApplePay(TRANZILA_URL).catch(() => {});
    expect(asked.length).toBeGreaterThan(1);
  });
});

// A half-finished re-vendor must not merge: the module names the file explicitly.
describe('the vendored library is really here', () => {
  it('ships the jQuery build their script needs, with its licence', () => {
    const src = read('site', 'js', 'apple-pay.js');
    const named = /const JQUERY_SRC = '([^']+)'/.exec(src)[1];
    expect(named).toBe('/vendor/jquery/jquery-3.6.0.min.js');
    const onDisk = read('site', named.replace(/^\//, ''));
    // The full build, not `slim`: slim has no `ajax`, which is all their script uses.
    expect(onDisk).toContain('ajax');
    // MIT asks that the notice travels with the software.
    expect(read('site', 'vendor', 'jquery', 'LICENSE.txt')).toMatch(/MIT|Permission is hereby/i);
    expect(onDisk.slice(0, 200)).toContain('jQuery v3.6.0');
  });
});

// Source guards: the page has to actually call this, and only from the one place
// that opens a payment window.
describe('the payment window arms it', () => {
  const html = read('site', 'collect.html');

  it('imports it and arms it where the frame is opened', () => {
    expect(html).toContain("import { armApplePay } from './js/apple-pay.js'");
    const open = html.slice(html.indexOf('function openPayFrame('));
    expect(open.slice(0, 600)).toContain('armApplePay(url)');
  });

  it('does not await it, so the card path cannot be held up by the wallet', () => {
    const open = html.slice(html.indexOf('function openPayFrame('), html.length);
    expect(open.slice(0, 600)).not.toContain('await armApplePay');
  });
});
