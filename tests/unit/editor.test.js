import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';

// Unit tests for the client engine (site/js/editor.js). The file is a classic
// script that auto-runs ONLY when loaded as a real <script> (document.currentScript
// is set); an ESM import in jsdom leaves currentScript null, so importing it here
// just hangs the pure helpers on window.__dugriEditor without firing the network
// bootstrap. We test those helpers directly.
let editor;
beforeAll(async () => {
  await import('../../site/js/editor.js');
  editor = window.__dugriEditor;
});

describe('derivePage', () => {
  it('maps a pathname to the html file the server serves for it', () => {
    expect(editor.derivePage('/index.html')).toBe('index.html');
    expect(editor.derivePage('/how.html')).toBe('how.html');
    expect(editor.derivePage('/sub/dir/collect.html')).toBe('collect.html');
    // The server serves extension-less routes as "<name>.html" (express.static
    // extensions:['html']), so we must resolve them the same way — NOT to index.
    expect(editor.derivePage('/products')).toBe('products.html');
    expect(editor.derivePage('/how')).toBe('how.html');
    expect(editor.derivePage('/collect')).toBe('collect.html');
    // the bare root / empty path is the homepage
    expect(editor.derivePage('/')).toBe('index.html');
    expect(editor.derivePage('')).toBe('index.html');
    // a real non-page asset extension falls back to the homepage
    expect(editor.derivePage('/favicon.ico')).toBe('index.html');
  });
});

describe('resolvePage — the served document decides the page, not the URL', () => {
  function withMeta(content) {
    document.head.innerHTML =
      content == null ? '' : '<meta name="dugri:page" content="' + content + '">';
    return document;
  }

  it('uses the page the served document declares (vanity URL served as index.html)', () => {
    // A marketing/vanity route like /promo has no promo.html, so the server's
    // catch-all serves index.html — whose meta declares index.html. The URL alone
    // would wrongly derive promo.html and miss the homepage overrides.
    expect(editor.resolvePage(withMeta('index.html'), '/promo')).toBe('index.html');
    // A real page served at its extension-less path declares its own file.
    expect(editor.resolvePage(withMeta('how.html'), '/how')).toBe('how.html');
  });

  it('falls back to the URL heuristic when the meta is missing or invalid', () => {
    expect(editor.resolvePage(withMeta(null), '/how')).toBe('how.html');
    expect(editor.resolvePage(withMeta('../evil.html'), '/collect')).toBe('collect.html');
    expect(editor.resolvePage(withMeta('index.php'), '/')).toBe('index.html');
    document.head.innerHTML = '';
  });
});

describe('applyOverrides', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('overrides text on every matching [data-edit] node', () => {
    document.body.innerHTML =
      '<h1 data-edit="hero">old</h1><p data-edit="hero">old</p><span data-edit="other">keep</span>';
    editor.applyOverrides(document, { hero: { text: 'new headline' } });
    document.querySelectorAll('[data-edit="hero"]').forEach((el) => {
      expect(el.textContent).toBe('new headline');
    });
    // untouched key keeps its shipped default
    expect(document.querySelector('[data-edit="other"]').textContent).toBe('keep');
  });

  it('swaps <img> src for [data-edit-img] and background-image for [data-edit-bg]', () => {
    document.body.innerHTML =
      '<img data-edit-img="photo" src="a.jpg"><div data-edit-bg="hero"></div>';
    editor.applyOverrides(document, {
      photo: { img: '/content-uploads/aaaaaaaaaaaaaaaa.png' },
      hero: { img: '/content-uploads/bbbbbbbbbbbbbbbb.webp' },
    });
    expect(document.querySelector('[data-edit-img="photo"]').getAttribute('src')).toBe(
      '/content-uploads/aaaaaaaaaaaaaaaa.png'
    );
    expect(document.querySelector('[data-edit-bg="hero"]').style.backgroundImage).toBe(
      'url("/content-uploads/bbbbbbbbbbbbbbbb.webp")'
    );
  });

  it('is a no-op for an unknown key and when text is absent', () => {
    document.body.innerHTML = '<h1 data-edit="hero">keep</h1>';
    editor.applyOverrides(document, { ghost: { text: 'nope' } });
    expect(document.querySelector('[data-edit="hero"]').textContent).toBe('keep');
    // an img-only override must not blank the text node
    editor.applyOverrides(document, { hero: { img: '/content-uploads/cccccccccccccccc.png' } });
    expect(document.querySelector('[data-edit="hero"]').textContent).toBe('keep');
  });

  it('tolerates null/empty overrides without throwing', () => {
    document.body.innerHTML = '<h1 data-edit="hero">keep</h1>';
    expect(() => editor.applyOverrides(document, null)).not.toThrow();
    expect(() => editor.applyOverrides(null, { hero: { text: 'x' } })).not.toThrow();
    expect(document.querySelector('[data-edit="hero"]').textContent).toBe('keep');
  });
});

describe('syncSameKey — duplicated editable content stays in sync during a live edit', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mirrors the new text onto EVERY node sharing the same data-edit key', () => {
    // The marquee ships each phrase as 8 identical clones (2 halves × 4 groups).
    // A live edit only mutates the clicked node; syncSameKey propagates it to the
    // rest so the seamless loop never desyncs mid-session (until a reload).
    document.body.innerHTML =
      '<span data-edit="m1">old</span><span data-edit="m1">old</span>' +
      '<span data-edit="m1">old</span><span data-edit="other">keep</span>';
    editor.syncSameKey(document, 'm1', 'חדש');
    document.querySelectorAll('[data-edit="m1"]').forEach((el) => {
      expect(el.textContent).toBe('חדש');
    });
    // a different key is never touched
    expect(document.querySelector('[data-edit="other"]').textContent).toBe('keep');
  });

  it('is a safe no-op for a missing key/root and never throws', () => {
    document.body.innerHTML = '<span data-edit="m1">keep</span>';
    expect(() => editor.syncSameKey(document, '', 'x')).not.toThrow();
    expect(() => editor.syncSameKey(null, 'm1', 'x')).not.toThrow();
    expect(document.querySelector('[data-edit="m1"]').textContent).toBe('keep');
  });
});

describe('resolveEdit — edit mode is fail-closed', () => {
  const noKey = { getItem: () => null };
  const storedKey = { getItem: () => 'stored-secret' };

  it('is OFF for a normal visitor (no ?edit, no key)', () => {
    expect(editor.resolveEdit('', noKey).active).toBe(false);
    expect(editor.resolveEdit('?key=secret', noKey).active).toBe(false); // key but no ?edit
  });

  it('is OFF with ?edit but no key available (would prompt, not auto-enable)', () => {
    const r = editor.resolveEdit('?edit=1', noKey);
    expect(r.edit).toBe(true);
    expect(r.key).toBe('');
    expect(r.active).toBe(false);
  });

  it('is ON only with BOTH ?edit=1 AND a key (from the query or storage)', () => {
    const fromQuery = editor.resolveEdit('?edit=1&key=secret', noKey);
    expect(fromQuery.active).toBe(true);
    expect(fromQuery.key).toBe('secret');

    const fromStorage = editor.resolveEdit('?edit=1', storedKey);
    expect(fromStorage.active).toBe(true);
    expect(fromStorage.key).toBe('stored-secret');
  });
});

describe('pageEditUrl — the picker keeps the owner in edit mode', () => {
  it('always carries ?edit=1 and forwards the key so the target page loads editing', () => {
    expect(editor.pageEditUrl('collect.html', 'secret')).toBe('collect.html?edit=1&key=secret');
    expect(editor.pageEditUrl('how.html', 'k-e-y')).toBe('how.html?edit=1&key=k-e-y');
    // a key with a query-breaking char is percent-encoded so it can't corrupt the URL
    expect(editor.pageEditUrl('index.html', 'a&b c')).toBe('index.html?edit=1&key=a%26b%20c');
    // no key → still edit mode (bootstrap will fall back to the stored key / prompt)
    expect(editor.pageEditUrl('timer.html', '')).toBe('timer.html?edit=1');
  });
});

describe('exitHref — leaving edit mode drops ?edit but keeps other params', () => {
  it('removes only the edit param', () => {
    expect(editor.exitHref('/index.html', '?edit=1')).toBe('/index.html');
    expect(editor.exitHref('/index.html', '?edit=1&key=secret')).toBe('/index.html?key=secret');
    expect(editor.exitHref('/how.html', '')).toBe('/how.html');
  });
});

describe('the page picker lists every editable page', () => {
  it('covers the real site pages with RTL labels', () => {
    const pages = editor.EDITABLE_PAGES.map((p) => p.page);
    expect(pages).toEqual([
      'index.html',
      'options.html',
      'collect.html',
      'how.html',
      'products.html',
      'product.html',
      'timer.html',
    ]);
    // every entry has a non-empty Hebrew label
    editor.EDITABLE_PAGES.forEach((p) => expect(p.label.trim().length).toBeGreaterThan(0));
  });
});

describe('buildToolbar — Save/Save&Exit buttons + page picker', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the Save, Save&Exit, and Reset buttons', () => {
    const bar = editor.buildToolbar('index.html', 'secret');
    expect(bar.querySelector('[data-role="save"]').textContent).toBe('שמור');
    expect(bar.querySelector('[data-role="exit"]').textContent).toBe('שמירה ויציאה');
    expect(bar.querySelector('[data-role="reset"]').textContent).toBe('אפס לברירת מחדל');
    expect(bar.querySelector('[data-role="status"]')).toBeTruthy();
  });

  it('builds a page picker whose options are correct ?edit=1&key=… URLs', () => {
    const bar = editor.buildToolbar('how.html', 'secret');
    const select = bar.querySelector('[data-role="pageselect"]');
    const opts = Array.from(select.options);
    // one option per editable page, each value keeps edit mode + key
    expect(opts.map((o) => o.value)).toEqual(
      editor.EDITABLE_PAGES.map((p) => p.page + '?edit=1&key=secret')
    );
    // the CURRENT page starts selected
    expect(select.value).toBe('how.html?edit=1&key=secret');
    expect(opts.find((o) => o.selected).value).toBe('how.html?edit=1&key=secret');
  });
});

describe('saveAction — "שמור" commits a focused edit + confirms, staying in edit mode', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('blurs the focused editable (flushing its pending save) and shows נשמר', async () => {
    // Simulate a focused editable whose blur fires the auto-save (as editor.js wires).
    document.body.innerHTML = '<span data-edit="hero" tabindex="0">edit</span>';
    const el = document.querySelector('[data-edit="hero"]');
    let flushed = false;
    el.addEventListener('blur', () => {
      flushed = true;
    });
    el.focus();

    const setStatus = vi.fn();
    const flush = vi.fn(() => Promise.resolve([true]));
    await editor.saveAction({ activeEl: el, flush, setStatus });

    expect(flushed).toBe(true); // the pending edit was committed (blur → save)
    expect(flush).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenLastCalledWith('נשמר');
  });

  it('surfaces an error when a tracked save failed', async () => {
    const setStatus = vi.fn();
    const flush = vi.fn(() => Promise.resolve([true, false]));
    await editor.saveAction({ activeEl: null, flush, setStatus });
    expect(setStatus).toHaveBeenLastCalledWith('שגיאה בשמירה');
  });
});

describe('saveExitAction — "שמירה ויציאה" commits BEFORE dropping ?edit', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('waits for pending saves to settle, then navigates (never before)', async () => {
    document.body.innerHTML = '<span data-edit="hero" tabindex="0">edit</span>';
    const el = document.querySelector('[data-edit="hero"]');
    let flushed = false;
    el.addEventListener('blur', () => {
      flushed = true;
    });
    el.focus();

    let resolveFlush;
    const flush = vi.fn(() => new Promise((r) => (resolveFlush = r)));
    const navigate = vi.fn();
    const setStatus = vi.fn();

    const done = editor.saveExitAction({ activeEl: el, flush, setStatus, navigate });

    // The focused edit is committed immediately, but we have NOT navigated yet:
    // the save is still in flight.
    expect(flushed).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    resolveFlush([true]); // the pending save lands
    await done;
    expect(navigate).toHaveBeenCalledTimes(1); // only now do we leave edit mode
  });

  it('does NOT navigate when a save failed — the edit is not silently lost', async () => {
    const navigate = vi.fn();
    const setStatus = vi.fn();
    await editor.saveExitAction({
      activeEl: null,
      flush: () => Promise.resolve([false]),
      setStatus,
      navigate,
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith('שגיאה בשמירה');
  });
});

describe('commitActive — only an editable field is blurred (fail-closed)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('blurs a focused [data-edit] node but ignores anything else', () => {
    document.body.innerHTML =
      '<span data-edit="hero" tabindex="0">a</span><button id="b">x</button>';
    const el = document.querySelector('[data-edit="hero"]');
    let blurred = false;
    el.addEventListener('blur', () => (blurred = true));
    el.focus();
    expect(editor.commitActive(el)).toBe(true);
    expect(blurred).toBe(true);

    // a non-editable element (e.g. the Save button itself) is never committed
    expect(editor.commitActive(document.getElementById('b'))).toBe(false);
    expect(editor.commitActive(null)).toBe(false);
  });
});
