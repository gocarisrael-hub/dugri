// @vitest-environment jsdom
//
// GA on the company pages (A8.5): the real /asakim render (server/occasions.js renderBusinessPage) loaded into jsdom with
// site/js/analytics.js. Its view is occasion_view {audience: business}, every quote button sends occasion_cta_click with its
// place, every WhatsApp link is whatsapp_click cta: business with the occasion, and the lead form's success sends
// business_lead_submit with the occasion (js/home-new.js tracks business_lead once /api/business-lead accepts it; the E2E
// spec drives that form for real).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const occ = require(path.join(root, 'server', 'occasions.js'));
const read = (f) => fs.readFileSync(path.join(root, 'site', f), 'utf8');

function mount(slug) {
  const html = occ.renderBusinessPage(
    read('occasion-business.html'),
    read('new.html'),
    occ.resolve(occ.find(slug), '')
  );
  const doc = new window.DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = doc.head.innerHTML;
  document.body.innerHTML = doc.body.innerHTML;
}

let calls;
const added = [];
async function load() {
  vi.resetModules();
  calls = [];
  window.gtag = (...a) => calls.push(a);
  globalThis.gtag = window.gtag;
  const real = document.addEventListener.bind(document);
  const spy = vi.spyOn(document, 'addEventListener').mockImplementation((t, fn, o) => {
    added.push([t, fn, o]);
    return real(t, fn, o);
  });
  try {
    return await import('../../site/js/analytics.js');
  } finally {
    spy.mockRestore();
  }
}
const events = () => calls.filter((c) => c[0] === 'event').map((c) => [c[1], c[2]]);
// a click that jsdom does not follow (an href to wa.me would try to navigate)
const click = (el) => {
  el.addEventListener('click', (e) => e.preventDefault(), { once: true });
  el.click();
};

afterEach(() => {
  for (const [t, fn, o] of added.splice(0)) document.removeEventListener(t, fn, o);
  delete window.gtag;
  delete globalThis.gtag;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const LIVE = occ
  .live()
  .filter((o) => o.audience === 'business')
  .map((o) => o.slug);

describe('GA on the company pages', () => {
  it('there are live company pages to measure', () => {
    expect(LIVE).toContain('asakim');
  });

  for (const slug of LIVE) {
    it(`${slug}: the view, every quote button, WhatsApp and the sent lead carry the occasion`, async () => {
      mount(slug);
      const mod = await load();
      expect(events().filter(([n]) => n === 'occasion_view')).toEqual([
        ['occasion_view', { audience: 'business', occasion: slug }],
      ]);

      calls.length = 0;
      const quotes = [...document.querySelectorAll('a[href="#biz"][data-ga="occasion_cta_click"]')];
      const places = quotes.map((a) => a.dataset.gaCta);
      expect(places).toEqual(
        expect.arrayContaining(['header', 'hero', 'steps', 'designs', 'faq', 'menu', 'design_view'])
      );
      for (const a of quotes) click(a);
      expect(events()).toEqual(
        places.map((cta) => ['occasion_cta_click', { cta, occasion: slug }])
      );

      calls.length = 0;
      const was = [...document.querySelectorAll('a[data-ga="whatsapp_click"]')];
      expect(was.length).toBeGreaterThanOrEqual(3);
      for (const a of was) click(a);
      const sent = events();
      expect(sent).toHaveLength(was.length);
      for (const [name, p] of sent) {
        expect(name).toBe('whatsapp_click');
        expect(p.cta).toBe('business');
        expect(p.occasion).toBe(slug);
      }

      calls.length = 0;
      mod.track('business_lead', {});
      expect(events()).toEqual([
        ['business_lead', { occasion: slug }],
        ['business_lead_submit', { occasion: slug }],
      ]);
    });
  }

  it('a question opened on a company page sends faq_open with the occasion', async () => {
    mount('asakim');
    await load();
    calls.length = 0;
    const d = document.querySelectorAll('#faq details')[3];
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    expect(events()).toEqual([
      ['faq_open', { question: 'העובדים צריכים לעשות משהו?', position: 4, occasion: 'asakim' }],
    ]);
  });
});
