// @vitest-environment jsdom
// site/js/home-legacy.js: what the redesigned pages lean on in an old Safari (the owner's own Mac shows no WebP, so Safari 15.6 at
// most). jsdom has no showModal, like Safari before 15.4, so the <dialog> part runs for real here. What these pin:
//   1. a WebP of the page's own art that fails to decode becomes its JPEG twin (PNG for the transparent logos), srcset dropped;
//      any other picture, and a failing twin, is left alone
//   2. a <dialog> opens and closes without the browser's dialog: open, showModal, close, the 'close' event, Esc, the backdrop
//   3. replaceChildren exists
//   4. the file is ES5, so it parses in any Safari
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../site/js/home-legacy.js'
);
const SRC = fs.readFileSync(FILE, 'utf8');

beforeAll(() => {
  delete window.HTMLDialogElement.prototype.showModal; // whatever this jsdom has, behave like Safari before 15.4
  window.eval(SRC);
});

const failImg = (src, srcset) => {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  if (srcset) img.setAttribute('srcset', srcset);
  document.body.appendChild(img);
  img.dispatchEvent(new window.Event('error'));
  return img;
};

describe('a WebP that will not decode', () => {
  it('becomes its JPEG twin, and a transparent logo its PNG twin', () => {
    expect(failImg('/assets/home/cards/japanese-f3.webp').getAttribute('src')).toBe(
      'http://localhost:3000/assets/home/cards/japanese-f3.jpg'
    );
    expect(failImg('assets/home/logos/hm.webp').getAttribute('src')).toBe(
      'http://localhost:3000/assets/home/logos/hm.png'
    );
  });

  it('drops the srcset, so the @2x WebP is not tried again', () => {
    const img = failImg(
      '/assets/home/boards/tarifa.webp',
      '/assets/home/boards/tarifa.webp 1200w, /assets/home/boards/tarifa@2x.webp 2000w'
    );
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(img.getAttribute('src')).toMatch(/\/assets\/home\/boards\/tarifa\.jpg$/);
  });

  it('leaves every other picture alone, and a failing twin too, so nothing loops', () => {
    expect(failImg('/content-uploads/x.webp').getAttribute('src')).toBe('/content-uploads/x.webp');
    expect(failImg('/assets/home/cards/kids-f1.jpg').getAttribute('src')).toBe(
      '/assets/home/cards/kids-f1.jpg'
    );
  });

  it('has a twin beside every WebP the shim may ask for', () => {
    const dir = path.join(path.dirname(FILE), '../assets/home');
    let n = 0;
    for (const sub of ['cards', 'boards', 'logos']) {
      for (const f of fs.readdirSync(path.join(dir, sub))) {
        if (!f.endsWith('.webp') || f.includes('@2x')) continue;
        const twin = f.replace(/\.webp$/, sub === 'logos' ? '.png' : '.jpg');
        expect(fs.existsSync(path.join(dir, sub, twin)), `${sub}/${twin}`).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe('a <dialog> without the browser dialog', () => {
  const make = () => {
    const btn = document.createElement('button');
    const dlg = document.createElement('dialog');
    dlg.innerHTML = '<button id="in">x</button>';
    document.body.append(btn, dlg);
    btn.focus();
    return { btn, dlg };
  };

  it('marks the page, opens with showModal and closes with close, firing close once', () => {
    expect(document.documentElement.classList.contains('no-dialog')).toBe(true);
    const { btn, dlg } = make();
    let closes = 0;
    dlg.addEventListener('close', () => closes++);
    dlg.showModal();
    expect(dlg.open).toBe(true);
    expect(dlg.hasAttribute('open')).toBe(true);
    expect(document.activeElement.id).toBe('in');
    expect(dlg.previousElementSibling.className).toBe('dlg-bd');
    dlg.close();
    dlg.close();
    expect(dlg.open).toBe(false);
    expect(closes).toBe(1);
    expect(document.querySelector('.dlg-bd')).toBe(null);
    expect(document.activeElement).toBe(btn);
  });

  it('closes on Esc and on a tap on the backdrop, unless cancel is prevented', () => {
    const { dlg } = make();
    dlg.showModal();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dlg.open).toBe(false);
    dlg.showModal();
    dlg.previousElementSibling.click();
    expect(dlg.open).toBe(false);
    dlg.showModal();
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dlg.open).toBe(true);
    dlg.close();
  });
});

describe('the rest', () => {
  it('replaceChildren swaps the children', () => {
    const el = document.createElement('div');
    el.innerHTML = '<i></i><b></b>';
    el.replaceChildren(document.createElement('p'), 'text');
    expect(el.innerHTML).toBe('<p></p>text');
  });

  it('is ES5, so any Safari parses it', () => {
    expect(() => acorn.parse(SRC, { ecmaVersion: 5, sourceType: 'script' })).not.toThrow();
  });
});
