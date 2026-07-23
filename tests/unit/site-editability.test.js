import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Coverage tests for the site-wide content-editor tagging (feat/site-editability).
// The content store keeps only OVERRIDES; the shipped HTML is the default. So making
// a string owner-editable means adding a data-edit* attribute whose element already
// holds the shipped default. These tests assert, on the real HTML files, that:
//   • every tagged key is accepted by the SERVER's key validator (keyOk),
//   • the representative NEW keys are actually present per page,
//   • every text-editable node ships a NON-EMPTY default (nothing renders blank),
//   • the client apply path overlays a new key.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

let keyOk;
let editor;
beforeAll(async () => {
  ({ keyOk } = await import('../../server/content.js'));
  await import('../../site/js/editor.js');
  editor = window.__dugriEditor;
});

const PAGES = [
  'index.html',
  'how.html',
  'products.html',
  'product.html',
  'collect.html',
  'options.html',
  'timer.html',
];

// Pull every data-edit / -img / -bg / -photos / -pd key value out of a page.
function keysIn(html) {
  const out = [];
  const re = /data-edit(?:-img|-bg|-photos|-pd)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

describe('every tagged key is valid per the server key validator', () => {
  for (const page of PAGES) {
    it(`${page}: all data-edit* keys pass keyOk`, () => {
      const keys = keysIn(read(page));
      for (const k of keys) {
        // data-edit-pd carries a design-agnostic FIELD (e.g. "about-heading") that
        // product.js prefixes into product-<id>-<field>; the field itself is also a
        // valid kebab key, so keyOk accepts every stored/derived key shape.
        expect(keyOk(k), `${page} key "${k}"`).toBe(k);
      }
    });
  }
});

describe('representative NEW owner-editable keys are present on each page', () => {
  const EXPECT = {
    'index.html': [
      'index-nav-order',
      'index-nav-shop',
      'index-footer-brand',
      'index-footer-wa-label',
    ],
    'how.html': ['how-nav-designs', 'how-nav-how', 'how-footer-brand', 'how-footer-mail-label'],
    'products.html': ['products-nav-shop', 'products-footer-brand', 'products-footer-wa-label'],
    'product.html': [
      'product-nav-shop',
      'product-back-label',
      'product-store-cta',
      'product-footer-brand',
    ],
    // Checkout version options (pickup/delivery/pdf/custom): each option's TITLE
    // and NOTE are owner-editable text, priced separately in admin-pricing.
    'collect.html': [
      'collect-ver-pdf-title',
      'collect-ver-pdf-note',
      'collect-ver-pickup-title',
      'collect-ver-pickup-note',
      'collect-ver-delivery-title',
      'collect-ver-delivery-note',
      'collect-ver-delivery-note2',
      'collect-ver-custom-title',
      'collect-ver-custom-note',
      'collect-ver-custom-note2',
    ],
    'options.html': [
      'options-nav-designs',
      'options-step1-title',
      'options-step2-sub',
      'options-photos-title',
      'options-step4-title',
      'options-chasers-desc',
      'options-code-summary',
    ],
  };
  for (const [page, keys] of Object.entries(EXPECT)) {
    it(`${page}: has ${keys.length} representative new keys`, () => {
      const present = new Set(keysIn(read(page)));
      for (const k of keys) expect(present.has(k), `${page} missing "${k}"`).toBe(true);
    });
  }
});

describe('every text-editable node ships a NON-EMPTY default (page unchanged until edited)', () => {
  for (const page of PAGES) {
    it(`${page}: no data-edit text node is empty in the shipped HTML`, () => {
      const doc = new window.DOMParser().parseFromString(read(page), 'text/html');
      // Only text-editable nodes (data-edit). Image/photo containers legitimately
      // hold no text; data-edit-pd nodes carry their own shipped text too.
      doc.querySelectorAll('[data-edit]').forEach((el) => {
        expect(
          el.textContent.trim().length,
          `${page} ${el.getAttribute('data-edit')}`
        ).toBeGreaterThan(0);
      });
    });
  }
});

describe('the client apply path overlays a new key onto the real markup', () => {
  it('an override for options-step1-title replaces the shipped default, others untouched', () => {
    const doc = new window.DOMParser().parseFromString(read('options.html'), 'text/html');
    const before = doc.querySelector('[data-edit="options-step2-title"]').textContent;
    editor.applyOverrides(doc, { 'options-step1-title': { text: 'כותרת חדשה' } });
    expect(doc.querySelector('[data-edit="options-step1-title"]').textContent).toBe('כותרת חדשה');
    // a sibling new key with no override keeps its shipped default
    expect(doc.querySelector('[data-edit="options-step2-title"]').textContent).toBe(before);
  });

  it('a checkout version override replaces only that option, and never the price span', () => {
    const doc = new window.DOMParser().parseFromString(read('collect.html'), 'text/html');
    const pickupNote = doc.querySelector('[data-edit="collect-ver-pickup-note"]').textContent;
    editor.applyOverrides(doc, { 'collect-ver-pdf-title': { text: 'הדיגיטלי החדש' } });
    // the edited title changed…
    expect(doc.querySelector('[data-edit="collect-ver-pdf-title"]').textContent).toBe(
      'הדיגיטלי החדש'
    );
    // …a sibling option's note is untouched…
    expect(doc.querySelector('[data-edit="collect-ver-pickup-note"]').textContent).toBe(pickupNote);
    // …and the JS-stamped price span is NOT tagged, so it can never be flattened by
    // a content override (it lives outside every data-edit node).
    const pdfLabel = doc.querySelector('input[name="payVersion"][value="pdf"]').closest('.pay-opt');
    const priceEl = pdfLabel.querySelector('.opt-price');
    expect(priceEl.hasAttribute('data-edit')).toBe(false);
    expect(priceEl.closest('[data-edit]')).toBe(null);
  });
});
