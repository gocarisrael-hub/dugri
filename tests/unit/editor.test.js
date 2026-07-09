import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

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
