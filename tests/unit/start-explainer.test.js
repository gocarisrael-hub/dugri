import { describe, it, expect, beforeAll } from 'vitest';

// Unit tests for the pure helpers of the 4-step order explainer
// (site/js/start-explainer.js). Like editor.js it is a classic script that
// bootstraps ONLY when loaded as a real <script> (document.currentScript is set);
// an ESM import in jsdom leaves currentScript null, so importing it here just hangs
// the helpers on window.__dugriStartExplainer without touching the page.
let sx;
beforeAll(async () => {
  await import('../../site/js/start-explainer.js');
  sx = window.__dugriStartExplainer;
});

describe('isPlainClick — only a plain left click is ours to intercept', () => {
  const base = { button: 0, defaultPrevented: false };

  it('accepts a plain primary click', () => {
    expect(sx.isPlainClick(base)).toBe(true);
    // A synthetic event without a button property is still a plain click.
    expect(sx.isPlainClick({ defaultPrevented: false })).toBe(true);
  });

  it('lets a modified click through to the browser (open in a new tab/window)', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      expect(sx.isPlainClick({ ...base, [mod]: true }), mod).toBe(false);
    }
  });

  it('ignores a middle / right click', () => {
    expect(sx.isPlainClick({ ...base, button: 1 })).toBe(false);
    expect(sx.isPlainClick({ ...base, button: 2 })).toBe(false);
  });

  it('stands down when something already handled the event, and on no event', () => {
    expect(sx.isPlainClick({ ...base, defaultPrevented: true })).toBe(false);
    expect(sx.isPlainClick(null)).toBe(false);
  });
});

describe('resolveContinueHref — the briefing never loses the wizard target', () => {
  function anchor(href) {
    const a = document.createElement('a');
    if (href != null) a.setAttribute('href', href);
    return a;
  }

  it("carries the trigger's query params (design preselection + step)", () => {
    expect(sx.resolveContinueHref(anchor('options.html?design=japanese&step=2'))).toBe(
      'options.html?design=japanese&step=2'
    );
  });

  it('keeps a bare wizard link as-is', () => {
    expect(sx.resolveContinueHref(anchor('options.html'))).toBe('options.html');
  });

  it('falls back to the wizard for a missing/blank/absent trigger, so it still sells', () => {
    expect(sx.resolveContinueHref(anchor(null))).toBe('options.html');
    expect(sx.resolveContinueHref(anchor('   '))).toBe('options.html');
    expect(sx.resolveContinueHref(null)).toBe('options.html');
    expect(sx.resolveContinueHref({})).toBe('options.html');
  });

  it('trims incidental whitespace', () => {
    expect(sx.resolveContinueHref(anchor('  options.html?design=kids&step=2  '))).toBe(
      'options.html?design=kids&step=2'
    );
  });
});

describe('nextFocusIndex — the Tab trap wraps at both ends', () => {
  it('advances and wraps forward', () => {
    expect(sx.nextFocusIndex(3, 0, false)).toBe(1);
    expect(sx.nextFocusIndex(3, 2, false)).toBe(0);
  });

  it('retreats and wraps backward', () => {
    expect(sx.nextFocusIndex(3, 2, true)).toBe(1);
    expect(sx.nextFocusIndex(3, 0, true)).toBe(2);
  });

  it('enters at the first (or last, shift) item when focus is outside the sheet', () => {
    expect(sx.nextFocusIndex(3, -1, false)).toBe(0);
    expect(sx.nextFocusIndex(3, -1, true)).toBe(2);
  });

  it('reports "nowhere to go" for an empty sheet', () => {
    expect(sx.nextFocusIndex(0, -1, false)).toBe(-1);
  });
});

describe('focusablesIn', () => {
  it('collects links, buttons and tabbables, skipping disabled/hidden ones', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<button type="button" id="x">×</button>',
      '<a href="https://wa.me/972546577715" id="wa">wa</a>',
      '<a id="nohref">no href</a>',
      '<button type="button" disabled id="off">off</button>',
      '<a href="#" hidden id="hid">hidden</a>',
      '<span tabindex="-1" id="skip">skip</span>',
      '<span tabindex="0" id="tab">tab</span>',
      '<a href="options.html" id="go">go</a>',
    ].join('');
    expect(sx.focusablesIn(root).map((el) => el.id)).toEqual(['x', 'wa', 'tab', 'go']);
  });

  it('is safe with no root', () => {
    expect(sx.focusablesIn(null)).toEqual([]);
  });
});

describe('buildOverlay — the briefing markup', () => {
  let overlay;
  beforeAll(() => {
    overlay = sx.buildOverlay(document);
  });

  it('is an accessible dialog labelled by its own title', () => {
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-labelledby')).toBe('sxTitle');
    expect(overlay.querySelector('#sxTitle')).toBeTruthy();
    // Closed until opened.
    expect(overlay.classList.contains('is-open')).toBe(false);
  });

  it('explains exactly four stages, numbered 1-4', () => {
    const steps = overlay.querySelectorAll('[data-testid="start-explainer-step"]');
    expect(steps).toHaveLength(4);
    expect([...steps].map((li) => li.querySelector('.sx-num').textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it("keeps the WhatsApp number in its OWN anchor so the editor can't eat the href", () => {
    const wa = overlay.querySelector('[data-testid="start-explainer-wa"]');
    expect(wa.getAttribute('href')).toBe('https://wa.me/972546577715');
    expect(wa.getAttribute('rel')).toBe('noopener');
    // The step's body copy is a sibling, not the link's parent — so overwriting
    // either one's textContent leaves the other intact.
    expect(wa.querySelector('p')).toBeNull();
  });

  it('tags every text node with an owner-editable key', () => {
    const keys = [...overlay.querySelectorAll('[data-edit]')].map((el) =>
      el.getAttribute('data-edit')
    );
    expect(keys).toContain('start-explainer-title');
    expect(keys).toContain('start-explainer-sub');
    expect(keys).toContain('start-explainer-continue');
    for (const step of ['step1', 'step2', 'step3', 'step4']) {
      expect(keys).toContain(`start-explainer-${step}-title`);
      expect(keys).toContain(`start-explainer-${step}-text`);
    }
    // Every key is now unique. The continue label used to be the one deliberate
    // duplicate, because the button was rendered twice; the sheet is one page with
    // one button, so a duplicate key here would mean a stray second copy came back.
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it('ships exactly ONE continue CTA, pointing at the wizard', () => {
    const gos = [...overlay.querySelectorAll('[data-sx-continue]')];
    expect(gos).toHaveLength(1);
    expect(gos[0].getAttribute('href')).toBe('options.html');
    expect(gos[0].textContent.length).toBeGreaterThan(0);
    expect(gos[0].getAttribute('data-testid')).toBe('start-explainer-continue');
    expect(gos[0].getAttribute('data-edit')).toBe('start-explainer-continue');
    // The placement tag existed only to tell the two copies apart in analytics.
    expect(gos[0].hasAttribute('data-sx-place')).toBe(false);
    expect(overlay.querySelector('[data-testid="start-explainer-continue-bottom"]')).toBeNull();
  });

  it('puts the continue AFTER the last step — nothing follows it', () => {
    const nodes = [...overlay.querySelectorAll('*')];
    const steps = [...overlay.querySelectorAll('[data-testid="start-explainer-step"]')];
    const cta = overlay.querySelector('[data-sx-continue]');
    expect(nodes.indexOf(cta)).toBeGreaterThan(nodes.indexOf(steps[steps.length - 1]));
    // …and it is the last child of the sheet, so "at the bottom" cannot be satisfied
    // by a CTA that merely trails step 4 with more content beneath it.
    const inner = overlay.querySelector('.sx-inner');
    expect(inner.lastElementChild.contains(cta)).toBe(true);
  });

  it('never uses the trademarked word', () => {
    expect(overlay.textContent).not.toContain('אליאס');
  });
});
