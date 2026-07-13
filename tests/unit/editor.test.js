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

describe('createContentState — dirtiness is DOM-vs-last-saved (no event/flag races)', () => {
  it('initText sets the baseline once; a field is dirty until a SUCCESSFUL save', () => {
    const s = editor.createContentState();
    s.initText('f', 'orig');
    s.initText('f', 'later'); // ignored — baseline set once
    expect(s.isTextDirty('f', 'orig')).toBe(false);
    expect(s.isTextDirty('f', 'changed')).toBe(true);
    // markTextSaved advances the baseline to the value that was actually saved.
    s.markTextSaved('f', 'changed');
    expect(s.isTextDirty('f', 'changed')).toBe(false);
    expect(s.textKeys()).toContain('f');
  });

  it('an older save completing AFTER a newer failure still leaves the field dirty', async () => {
    // Regression for the ordering race: save1('A') is slow-SUCCESS, save2('B') FAILS
    // first. If save1 later clears the field to its OLDER value while the DOM holds
    // the newer 'B', the field MUST remain dirty (and get re-saved) — never look saved.
    const s = editor.createContentState();
    s.initText('f', 'A0');
    const node = { textContent: 'A0' };

    node.textContent = 'A';
    let resolve1;
    const save1 = new Promise((r) => (resolve1 = r)).then(() => s.markTextSaved('f', 'A'));

    node.textContent = 'B';
    await Promise.reject().catch(() => {}); // save2 fails → NO markTextSaved
    expect(s.isTextDirty('f', node.textContent)).toBe(true); // 'B' !== 'A0'

    resolve1(); // the OLDER save now succeeds, writing the OLDER value 'A'
    await save1;
    expect(s.isTextDirty('f', node.textContent)).toBe(true); // 'B' !== 'A' → still dirty
  });

  it('tracks image fields as pending/failed until an upload succeeds', () => {
    const s = editor.createContentState();
    expect(s.isImgUnsaved('p')).toBe(false);
    s.setImg('p', 'pending');
    expect(s.isImgUnsaved('p')).toBe(true);
    s.setImg('p', 'failed');
    expect(s.isImgUnsaved('p')).toBe(true); // a failed upload stays unsaved (retry)
    expect(s.imgKeys()).toContain('p');
    s.setImg('p', null); // success clears it
    expect(s.isImgUnsaved('p')).toBe(false);
    expect(s.imgKeys()).not.toContain('p');
  });
});

// A tiny controller mirroring enableEditMode's saveDirty/hasUnsaved wiring so the
// end-to-end save flows can be exercised over createContentState + attemptCommit.
function makeController(post) {
  const state = editor.createContentState();
  const nodes = Object.create(null);
  return {
    register(key, value) {
      nodes[key] = { textContent: value };
      state.initText(key, value);
    },
    set(key, value) {
      nodes[key].textContent = value;
    },
    saveDirty() {
      const saves = [];
      Object.keys(nodes).forEach((k) => {
        const cur = nodes[k].textContent;
        if (state.isTextDirty(k, cur)) {
          saves.push(
            post(k, cur).then(
              () => state.markTextSaved(k, cur),
              () => {}
            )
          );
        }
      });
      return Promise.all(saves);
    },
    hasUnsaved() {
      return Object.keys(nodes).some((k) => state.isTextDirty(k, nodes[k].textContent));
    },
  };
}

describe('attemptCommit — one flow for Save / Save&Exit / page-switch', () => {
  it('awaits saveDirty before proceeding, then runs onClean when nothing is unsaved', async () => {
    let resolveSave;
    const saveDirty = vi.fn(() => new Promise((r) => (resolveSave = r)));
    const onClean = vi.fn();
    const setStatus = vi.fn();
    const done = editor.attemptCommit({
      saveDirty,
      hasUnsaved: () => false,
      setStatus,
      onClean,
    });
    expect(setStatus).toHaveBeenCalledWith('שומר…');
    expect(onClean).not.toHaveBeenCalled(); // waits for the save
    resolveSave();
    await done;
    expect(onClean).toHaveBeenCalledTimes(1);
  });

  it('runs onBlocked and shows שגיאה when something is still unsaved', async () => {
    const onClean = vi.fn();
    const onBlocked = vi.fn();
    const setStatus = vi.fn();
    await editor.attemptCommit({
      saveDirty: () => Promise.resolve([]),
      hasUnsaved: () => true,
      setStatus,
      onClean,
      onBlocked,
    });
    expect(onClean).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenLastCalledWith('שגיאה בשמירה');
  });
});

describe('save flows over the real state (Save / Save&Exit / picker)', () => {
  it('a failed save is RETRYABLE — Save re-POSTs and clears the field once the server recovers', async () => {
    let fail = true;
    const post = vi.fn(() => (fail ? Promise.reject(new Error('500')) : Promise.resolve()));
    const c = makeController(post);
    c.register('f', 'old');
    c.set('f', 'new'); // an edit

    // First Save fails → field stays dirty → error (NOT a false "נשמר").
    const s1 = vi.fn();
    await editor.attemptCommit({
      saveDirty: c.saveDirty,
      hasUnsaved: c.hasUnsaved,
      setStatus: s1,
      onClean: () => s1('נשמר'),
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(c.hasUnsaved()).toBe(true);
    expect(s1).toHaveBeenLastCalledWith('שגיאה בשמירה');

    // Server recovers; clicking שמור again RE-POSTs (the field is still dirty) and clears.
    fail = false;
    const s2 = vi.fn();
    await editor.attemptCommit({
      saveDirty: c.saveDirty,
      hasUnsaved: c.hasUnsaved,
      setStatus: s2,
      onClean: () => s2('נשמר'),
    });
    expect(post).toHaveBeenCalledTimes(2); // retried, not stuck
    expect(c.hasUnsaved()).toBe(false);
    expect(s2).toHaveBeenLastCalledWith('נשמר');
  });

  it('Save&Exit refuses to leave while a field stays dirty, but escapes on confirm', async () => {
    const post = vi.fn(() => Promise.reject(new Error('403'))); // every save fails
    const c = makeController(post);
    c.register('f', 'old');
    c.set('f', 'new');

    // Decline the discard prompt → stay (edit preserved).
    const navigate = vi.fn();
    let confirmReturn = false;
    await editor.attemptCommit({
      saveDirty: c.saveDirty,
      hasUnsaved: c.hasUnsaved,
      setStatus: vi.fn(),
      onClean: navigate,
      onBlocked: () => {
        if (confirmReturn) navigate();
      },
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(c.hasUnsaved()).toBe(true);

    // Accept the discard prompt → leave anyway (never stranded on a failing key).
    confirmReturn = true;
    await editor.attemptCommit({
      saveDirty: c.saveDirty,
      hasUnsaved: c.hasUnsaved,
      setStatus: vi.fn(),
      onClean: navigate,
      onBlocked: () => {
        if (confirmReturn) navigate();
      },
    });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('a failed field does NOT permanently block the page picker — discard-and-switch works', async () => {
    const post = vi.fn(() => Promise.reject(new Error('500'))); // an edit elsewhere is stuck failed
    const c = makeController(post);
    c.register('other', 'x');
    c.set('other', 'y'); // dirty + will fail

    // Owner picks another page and confirms switching without saving → navigates.
    const navigate = vi.fn();
    const revert = vi.fn();
    let confirmSwitch = true;
    await editor.attemptCommit({
      saveDirty: c.saveDirty,
      hasUnsaved: c.hasUnsaved,
      setStatus: vi.fn(),
      onClean: navigate,
      onBlocked: () => (confirmSwitch ? navigate() : revert()),
    });
    expect(navigate).toHaveBeenCalledTimes(1); // switched despite the failure
    expect(revert).not.toHaveBeenCalled();

    // Declining instead reverts the <select> rather than leaving the picker dead.
    confirmSwitch = false;
    navigate.mockClear();
    await editor.attemptCommit({
      saveDirty: c.saveDirty,
      hasUnsaved: c.hasUnsaved,
      setStatus: vi.fn(),
      onClean: navigate,
      onBlocked: () => (confirmSwitch ? navigate() : revert()),
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledTimes(1);
  });
});
