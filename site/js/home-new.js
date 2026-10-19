// The redesigned homepage (new.html), DESIGN.md's "The Game Night Table": a deck that deals the real cards, an endless strip of the
// designs that takes on each one's colour, a tapped design that floods the screen, the reviews row, the menu and the business form.
// Ported from redesign/directions/r17.html. Live data: the designs and their names (designs.js), the price (pricing.js), the owner's text and photos (editor.js, by data-edit keys); the rules that turn them into what is shown are in home-data.js.
import { PUBLIC_DESIGNS, syncDesignNames, loadCustomDesigns } from './designs.js';
import { fetchPricing } from './pricing.js';
import { track } from './analytics.js';
import {
  homeDesigns,
  floodColor,
  panelColors,
  priceText,
  validateLead,
  leadFieldError,
  LEAD_MESSAGES,
  sendLead,
  autoDealAllowed,
  AUTO_DEAL_MS,
  cardSrcset,
} from './home-data.js';
import { initIllustrations } from './home-illos.js';
import { initMenu, trapTab } from './home-menu.js';
import { initZoom } from './home-zoom.js';

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.random() * (b - a);
// a card picture with its sharper twin for 2x/3x screens; `sizes` is how wide the page draws it
const cardImg = (src, sizes, attrs) => {
  const set = cardSrcset(src);
  return `<img src="${esc(src)}"${set ? ` srcset="${esc(set)}" sizes="${sizes}"` : ''} ${attrs}>`;
};
const DECK_SIZES = '(min-width: 900px) 210px, 150px',
  STRIP_SIZES = '(min-width: 900px) 340px, (min-width: 431px) 250px, 58vw', // 340: the still three-column grid
  VIEW_SIZES = '170px';
const shuffle = (a) => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/* ---------- the designs: the built-in ones at once, then the admin's names and custom designs as they arrive ---------- */
let designs = homeDesigns(PUBLIC_DESIGNS);
const byId = () => Object.fromEntries(designs.map((d) => [d.id, d]));
let D = byId();
let price = null;

/* ---------- hero: a small deck deals real cards onto a loose pile beside it; every card is a real object ---------- */
const stage = $('stage'),
  deckBtn = $('deck'),
  hint = $('hint'),
  said = $('said');
const F = 0.92,
  SF = 0.88; // per-frame friction: sliding, spinning (a short toss settles sooner)
const cards = [];
let z = 10,
  lastKey = null,
  nextKey = null;
const recent = {}; // per design, the fronts shown lately, so a design shows a new card each time
const dealable = () => designs.filter((d) => d.deal).map((d) => d.id);

function front(k) {
  const all = D[k].fronts,
    r = (recent[k] = recent[k] || []);
  const opts = all.filter((f) => !r.includes(f));
  const f = opts.length ? opts[(Math.random() * opts.length) | 0] : all[0];
  r.push(f);
  if (r.length > 5) r.shift();
  return f;
}
// the deck's top back is the design it deals next, never the one just dealt
function showNext(force) {
  const keys = dealable();
  if (!keys.length) return;
  const opts = keys.filter((k) => k !== lastKey);
  nextKey =
    force && D[force] && D[force].deal ? force : opts[(Math.random() * opts.length) | 0] || keys[0];
  const [a, b, top] = deckBtn.children,
    under = shuffle(keys.filter((k) => k !== nextKey));
  const put = (img, src) => {
    img.sizes = DECK_SIZES;
    img.srcset = cardSrcset(src);
    img.src = src;
  };
  put(a, D[under[0] || nextKey].back);
  put(b, D[under[1] || under[0] || nextKey].back);
  put(top, D[nextKey].back);
}
// the deck on the right, the pile one short toss to its left, the pair centred on the table
const geo = () => {
  const W = stage.clientWidth,
    H = stage.clientHeight,
    cw = deckBtn.offsetWidth,
    ch = deckBtn.offsetHeight;
  const gap = cw * 0.38,
    left = (W - (cw * 2 + gap)) / 2;
  const dy = (H - ch) / 2 + 4;
  return { W, H, cw, ch, dx: left + cw + gap, dy, px: left, py: dy - 4 };
};
function placeDeck() {
  const g = geo();
  Object.assign(deckBtn.style, { left: g.dx + 'px', top: g.dy + 'px' });
  Object.assign(hint.style, {
    left: g.dx + 'px',
    width: g.cw + 'px',
    top: g.dy + g.ch + 14 + 'px',
  });
}
const draw = (c) => {
  c.el.style.transform = `translate3d(${c.x}px, ${c.y}px, 0) rotate(${c.r}deg) scale(${c.s})`;
  c.el.style.setProperty('--o', (4 + (c.s - 1) * 70).toFixed(1) + 'px'); // lifted higher, the shadow falls further
};
const cap = () => (window.innerWidth >= 900 ? 7 : 6);
// where the next card lands: on the pile, a little off true, never twice in the same spot
const spot = (g) => ({
  x: Math.max(window.innerWidth >= 900 ? g.cw * 0.22 : -1e9, g.px + rnd(-0.13, 0.13) * g.cw),
  y: g.py + rnd(-0.08, 0.08) * g.ch,
  r: rnd(-13, 13),
});

function deal(want, auto) {
  const k = want || nextKey;
  if (!k || !D[k]) return;
  const g = geo(),
    to = spot(g);
  lastKey = k;
  const el = document.createElement('div');
  el.className = 'card down';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="in">${cardImg(front(k), DECK_SIZES, 'class="f" alt="" draggable="false"')}${cardImg(D[k].back, DECK_SIZES, 'class="b" alt="" draggable="false"')}</div>`;
  stage.appendChild(el);
  const c = {
    el,
    k,
    x: g.dx,
    y: g.dy,
    r: 0,
    s: 1,
    vx: 0,
    vy: 0,
    vr: 0,
    t: window.performance.now(),
    held: false,
    gone: false,
    launch: true,
  };
  el.style.zIndex = String(++z);
  cards.push(c);
  bind(c);
  if (!auto) said.textContent = `קלף מהעיצוב ${D[k].name}`;
  showNext();
  if (reduce) {
    Object.assign(c, to);
    el.classList.remove('down');
    draw(c);
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240 });
  } else {
    // velocity that friction brings to rest exactly on the pile; now and then a full turn on the way
    const tr = to.r + (Math.random() < 0.1 ? (Math.random() < 0.5 ? 360 : -360) : 0);
    c.vx = (to.x - c.x) * (1 - F);
    c.vy = (to.y - c.y) * (1 - F) - 1.2;
    c.vr = tr * (1 - SF);
    draw(c);
    requestAnimationFrame(() => el.classList.remove('down')); // turns face up in the air
    deckBtn.lastElementChild.animate(
      [{ transform: 'translate(0, -4px) rotate(-1.5deg)' }, { transform: 'none' }],
      { duration: 240, easing: 'cubic-bezier(.3, 1.6, .5, 1)' }
    );
    kick(c);
  }
  retire();
}
// past the cap, the card nobody touched longest slides off and fades
function retire() {
  let on = cards.filter((c) => !c.gone);
  while (on.length > cap()) {
    const old = on.filter((c) => !c.held).sort((a, b) => a.t - b.t)[0];
    if (!old) return;
    old.gone = true;
    live.delete(old);
    const from = old.el.style.transform;
    old.el.style.pointerEvents = 'none';
    old.el.animate(
      [
        { transform: from, opacity: 1 },
        {
          transform: `${from} translate(${reduce ? 0 : -18}px, ${reduce ? 0 : 22}px) rotate(${reduce ? 0 : -6}deg)`,
          opacity: 0,
        },
      ],
      { duration: reduce ? 200 : 380, easing: 'cubic-bezier(.5, 0, .7, .4)', fill: 'forwards' }
    ).onfinish = () => {
      old.el.remove();
      cards.splice(cards.indexOf(old), 1);
    };
    on = cards.filter((c) => !c.gone);
  }
}
// a held card follows the finger exactly and turns about the point you hold; it keeps the speed you let go with; a tap flips it
function bind(c) {
  let px,
    py,
    lx,
    ly,
    t0,
    moved,
    samples,
    id = null;
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const worldGrab = () => {
    const a = (c.r * Math.PI) / 180;
    return [lx * Math.cos(a) - ly * Math.sin(a), lx * Math.sin(a) + ly * Math.cos(a)];
  };
  c.el.addEventListener('pointerdown', (e) => {
    if (c.gone || id !== null) return;
    e.preventDefault();
    id = e.pointerId;
    c.el.setPointerCapture(id);
    stage.classList.add('touched');
    c.held = true;
    c.launch = false;
    live.delete(c);
    c.vx = c.vy = c.vr = 0;
    c.t = window.performance.now();
    c.el.classList.add('held');
    c.el.style.zIndex = String(++z);
    [px, py] = local(e);
    const w = c.el.offsetWidth,
      h = c.el.offsetHeight,
      a = (-c.r * Math.PI) / 180,
      dx = px - (c.x + w / 2),
      dy = py - (c.y + h / 2);
    lx = dx * Math.cos(a) - dy * Math.sin(a);
    ly = dx * Math.sin(a) + dy * Math.cos(a);
    t0 = window.performance.now();
    moved = 0;
    samples = [{ x: px, y: py, t: t0 }];
    c.s = reduce ? 1 : 1.04;
    draw(c);
  });
  c.el.addEventListener('pointermove', (e) => {
    if (!c.held || e.pointerId !== id) return;
    const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of co.length ? co : [e]) {
      const [nx, ny] = local(ev),
        ddx = nx - px,
        ddy = ny - py;
      if (!ddx && !ddy) continue;
      moved += Math.hypot(ddx, ddy);
      px = nx;
      py = ny;
      if (!reduce) {
        // the pull swings the card so its centre trails the held point, like dragging a real card by its corner
        const [gx, gy] = worldGrab();
        c.r += (((gx * ddy - gy * ddx) / (gx * gx + gy * gy + 900)) * 0.62 * 180) / Math.PI;
      }
      samples.push({ x: px, y: py, t: ev.timeStamp || window.performance.now() });
    }
    const [gx, gy] = worldGrab(),
      w = c.el.offsetWidth,
      h = c.el.offsetHeight;
    c.x = px - gx - w / 2;
    c.y = py - gy - h / 2;
    draw(c);
    while (samples.length > 2 && samples[samples.length - 1].t - samples[0].t > 100)
      samples.shift();
  });
  const up = (e) => {
    if (!c.held || e.pointerId !== id) return;
    id = null;
    c.held = false;
    c.el.classList.remove('held');
    c.t = window.performance.now();
    if (moved < 8 && window.performance.now() - t0 < 350) {
      c.el.classList.toggle('down');
      c.s = 1;
      draw(c);
      kick(c);
      return;
    }
    const a = samples[0],
      b = samples[samples.length - 1],
      dt = Math.max(16, b.t - a.t);
    const still = e.timeStamp - b.t > 120; // a finger that stopped before letting go puts the card down where it is
    if (!reduce && !still) {
      c.vx = Math.max(-60, Math.min(60, ((b.x - a.x) / dt) * 16.67));
      c.vy = Math.max(-60, Math.min(60, ((b.y - a.y) / dt) * 16.67));
      const [gx, gy] = worldGrab();
      c.vr = Math.max(
        -16,
        Math.min(16, ((gx * c.vy - gy * c.vx) / (gx * gx + gy * gy + 900)) * 40)
      );
    }
    if (reduce) {
      c.s = 1;
      clampIn(c);
      draw(c);
    } else kick(c);
  };
  c.el.addEventListener('pointerup', up);
  c.el.addEventListener('pointercancel', up);
  c.el.addEventListener('lostpointercapture', (e) => {
    if (c.held) up(e);
  });
}
// the deck keeps its spot clear: a card that comes to rest on it is pushed off
const deckZone = (g, m = 0) => ({
  x0: g.dx - m,
  y0: g.dy - m,
  x1: g.dx + g.cw + m,
  y1: g.dy + g.ch + m,
});
const onDeck = (x, y, g, m = 0) => {
  const d = deckZone(g, m);
  return x < d.x1 && x + g.cw > d.x0 && y < d.y1 && y + g.ch > d.y0;
};
// a card may hang well over the table's edges before the soft walls push it back
const bounds = (g) => ({
  x0: -g.cw * 0.45,
  x1: g.W - g.cw * 0.55,
  y0: -g.ch * 0.45,
  y1: g.H - g.ch * 0.55,
});
function offDeck(c, g) {
  const d = deckZone(g, 8);
  const push = [
    [d.x0 - g.cw - c.x, 0],
    [d.x1 - c.x, 0],
    [0, d.y0 - g.ch - c.y],
    [0, d.y1 - c.y],
  ]
    .filter(([px, py]) => {
      const b = bounds(g),
        nx = c.x + px,
        ny = c.y + py;
      return nx >= b.x0 && nx <= b.x1 && ny >= b.y0 && ny <= b.y1;
    })
    .sort((a, b) => Math.hypot(...a) - Math.hypot(...b))[0];
  return push || [0, 0];
}
function clampIn(c) {
  const g = geo(),
    b = bounds(g);
  c.x = Math.max(b.x0, Math.min(b.x1, c.x));
  c.y = Math.max(b.y0, Math.min(b.y1, c.y));
  if (onDeck(c.x, c.y, g, -12)) {
    const [px, py] = offDeck(c, g);
    c.x += px;
    c.y += py;
  }
}
const live = new Set();
let raf = 0,
  tPrev = 0;
function kick(c) {
  live.add(c);
  if (!raf) {
    tPrev = window.performance.now();
    raf = requestAnimationFrame(step);
  }
}
function step(t) {
  const k = Math.min(3, (t - tPrev) / 16.67);
  tPrev = t;
  const g = geo(),
    b = bounds(g);
  for (const c of live) {
    if (c.held || c.gone) {
      live.delete(c);
      continue;
    }
    c.x += c.vx * k;
    c.y += c.vy * k;
    c.r += c.vr * k;
    c.vx *= F ** k;
    c.vy *= F ** k;
    c.vr *= SF ** k;
    let out = false; // soft walls push a card back instead of stopping it dead
    if (c.x < b.x0) {
      c.vx += (b.x0 - c.x) * 0.12 * k;
      c.vx *= 0.84 ** k;
      out = true;
    }
    if (c.x > b.x1) {
      c.vx += (b.x1 - c.x) * 0.12 * k;
      c.vx *= 0.84 ** k;
      out = true;
    }
    if (c.y < b.y0) {
      c.vy += (b.y0 - c.y) * 0.12 * k;
      c.vy *= 0.84 ** k;
      out = true;
    }
    if (c.y > b.y1) {
      c.vy += (b.y1 - c.y) * 0.12 * k;
      c.vy *= 0.84 ** k;
      out = true;
    }
    if (c.launch && !onDeck(c.x, c.y, g)) c.launch = false; // a dealt card is exempt until it has cleared the deck
    if (!c.launch && onDeck(c.x, c.y, g, -12)) {
      const [px, py] = offDeck(c, g);
      c.vx += px * 0.1 * k;
      c.vy += py * 0.1 * k;
      c.vx *= 0.86 ** k;
      c.vy *= 0.86 ** k;
      out = true;
    }
    const v = Math.hypot(c.vx, c.vy);
    c.s += (1 + Math.min(0.1, v * 0.007) - c.s) * Math.min(1, 0.35 * k); // a fast card is in the air
    draw(c);
    if (!out && v < 0.05 && Math.abs(c.vr) < 0.03 && Math.abs(c.s - 1) < 0.002) {
      c.s = 1;
      draw(c);
      live.delete(c);
    }
  }
  raf = live.size ? requestAnimationFrame(step) : 0;
}
let dealt = 0;
deckBtn.addEventListener('click', () => {
  stage.classList.add('touched');
  deal();
  if (++dealt === 1) track('deck_deal', {});
});
// every AUTO_DEAL_MS the deck deals one card by itself, unless autoDealAllowed says to leave the table alone. It never
// focuses anything and never scrolls, and a screen reader hears nothing (only a card you deal is announced).
let heroSeen = false,
  lastTouch = 0,
  autoT = 0;
const touched = () => {
  lastTouch = window.performance.now();
};
['pointerdown', 'keydown', 'wheel'].forEach((ev) =>
  stage.addEventListener(ev, touched, { passive: true })
);
function autoTick() {
  autoT = setTimeout(autoTick, AUTO_DEAL_MS);
  const ok = autoDealAllowed({
    reduce,
    pageHidden: document.hidden,
    heroOnScreen: heroSeen,
    dialogOpen: !!document.querySelector('dialog[open]'),
    holding: cards.some((c) => c.held),
    sinceTouch: window.performance.now() - lastTouch,
  });
  if (ok) deal(null, true);
}
function startAutoDeal() {
  if (reduce || autoT) return;
  autoT = setTimeout(autoTick, AUTO_DEAL_MS);
}
if (window.IntersectionObserver)
  new window.IntersectionObserver((es) => {
    heroSeen = es[es.length - 1].isIntersecting;
  }).observe(stage);
else heroSeen = true;

/* ---------- designs: an endless strip that leans with swipe speed; the panel takes on the centred design's colour ---------- */
const strip = $('strip'),
  bgs = $('bgs');
const COPIES = reduce ? 1 : 5,
  MID = reduce ? 0 : 2;
let N = 0,
  items = [],
  layers = [];
let lastSL = 0,
  lastT = window.performance.now(),
  target = 0,
  lean = 0,
  leanV = 0,
  looping = false,
  settle = 0;
const span = () => (items[0] && items[0].offsetWidth) || 1;
// five copies of the list; the middle one is the real one, and the scroll is quietly moved back to it whenever it settles
function buildStrip() {
  N = designs.length;
  strip.innerHTML = Array.from({ length: COPIES * N }, (_, j) => {
    const d = designs[j % N],
      real = ((j / N) | 0) === MID;
    return `<button class="dz" type="button" data-k="${esc(d.id)}"${real ? '' : ' tabindex="-1" aria-hidden="true"'} aria-label="${esc(d.name)}: לראות את הקלפים והלוח"><div class="tilt">${cardImg(d.fronts[0], STRIP_SIZES, `alt="" draggable="false" loading="${real ? 'eager' : 'lazy'}"`)}</div><span class="nm">${esc(d.name)}</span></button>`;
  }).join('');
  bgs.innerHTML = designs
    .map((d) => {
      const [a, b] = panelColors(d.color);
      return `<i style="background:linear-gradient(180deg, ${a}, ${b} 48%, #fff1de)"></i>`;
    })
    .join('');
  items = [...strip.children];
  layers = [...bgs.children];
}
function recentre() {
  if (reduce) return;
  const copy = N * span(),
    sl = strip.scrollLeft;
  let to = sl;
  while (to < (MID - 0.5) * copy) to += copy;
  while (to > (MID + 0.5) * copy) to -= copy;
  if (to !== sl) {
    strip.scrollLeft = to;
    lastSL = to;
    paint();
  } // the same cards in the same places: nothing visible moves
}
function paint() {
  if (reduce) return; // a static grid on the section's own colour
  const w = span(),
    mid = strip.scrollLeft + strip.clientWidth / 2;
  const op = new Array(N).fill(0);
  items.forEach((el, j) => {
    const d = (el.offsetLeft + w / 2 - mid) / w;
    if (Math.abs(d) > 3) return;
    const ad = Math.min(1.4, Math.abs(d));
    el.firstChild.style.transform = `translateY(${ad * 18}px) rotateY(${(-lean * 1.4 - d * 14).toFixed(2)}deg) rotateZ(${(lean * 0.7 + d * 6).toFixed(2)}deg) scale(${(1 - ad * 0.16).toFixed(3)})`;
    op[j % N] = Math.max(op[j % N], 1 - Math.abs(d)); // neighbours cross-fade: the colour morphs, also across the wrap
  });
  layers.forEach((l, k) => {
    l.style.opacity = op[k].toFixed(3);
  });
}
function loop() {
  // spring toward the lean the swipe asks for; settling past upright gives the little overshoot
  target *= 0.86;
  leanV += (target - lean) * 0.18;
  leanV *= 0.72;
  lean += leanV;
  paint();
  if (Math.abs(lean) + Math.abs(leanV) + Math.abs(target) > 0.02) requestAnimationFrame(loop);
  else {
    lean = 0;
    paint();
    looping = false;
  }
}
strip.addEventListener(
  'scroll',
  () => {
    const t = window.performance.now(),
      v = (strip.scrollLeft - lastSL) / Math.max(8, t - lastT);
    lastSL = strip.scrollLeft;
    lastT = t;
    if (reduce) return;
    clearTimeout(settle);
    settle = setTimeout(recentre, 160);
    const copy = N * span();
    if (strip.scrollLeft < 0.6 * copy || strip.scrollLeft > (COPIES - 1.6) * copy) recentre();
    target = Math.max(-22, Math.min(22, v * 9));
    if (!looping) {
      looping = true;
      requestAnimationFrame(loop);
    }
  },
  { passive: true }
);
strip.addEventListener('scrollend', recentre);
let swiped = false;
strip.addEventListener(
  'scroll',
  () => {
    if (!swiped) {
      swiped = true;
      track('design_swipe', {});
    }
  },
  { passive: true, once: true }
);
function startStrip() {
  if (reduce) return;
  strip.scrollLeft = (MID * N + 1) * span();
  lastSL = strip.scrollLeft;
  paint();
}

/* ---------- the tapped view: a modal dialog in the design's colour, its front and back landing on its board ---------- */
const flood = $('flood'),
  tableau = $('tableau');
// the board and the cards zoom together under the fingers; reset on every open and close
const zoom = initZoom(flood, flood.querySelector('.spread'), {
  isPicture: (t) => !!(t && t.closest && t.closest('.tableau img')),
});
let openFrom = null,
  openId = null;
function fillFlood(d) {
  flood.style.setProperty('--fc', floodColor(d.color));
  $('floodName').textContent = d.name;
  tableau.className = 'tableau' + (d.board ? '' : ' solo');
  tableau.innerHTML =
    (d.board
      ? `<img class="bd" src="${esc(d.board.src)}"${d.board.srcset ? ` srcset="${esc(d.board.srcset)}" sizes="(min-width: 650px) 520px, 80vw"` : ''} alt="הלוח של ${esc(d.name)}">`
      : '') +
    cardImg(d.fronts[0], VIEW_SIZES, `class="fc fr" alt="קלף מהעיצוב ${esc(d.name)}"`) +
    (d.back ? cardImg(d.back, VIEW_SIZES, `class="fc bk" alt="גב הקלף של ${esc(d.name)}"`) : '');
  $('floodOrder').href = d.href;
  $('floodOrder').dataset.gaDesign = d.id;
  stampPrice();
}
function openDesign(btn, x, y) {
  const d = D[btn.dataset.k];
  if (!d) return;
  openFrom = btn;
  openId = d.id;
  zoom.reset();
  fillFlood(d);
  flood.showModal();
  track('design_open', { design: d.id });
  const R = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  if (reduce) {
    flood.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  } else {
    flood.animate(
      [
        { clipPath: `circle(0px at ${x}px ${y}px)` },
        { clipPath: `circle(${R}px at ${x}px ${y}px)` },
      ],
      { duration: 520, easing: 'cubic-bezier(.6, 0, .25, 1)', fill: 'forwards' }
    );
    requestAnimationFrame(() => {
      const bd = tableau.querySelector('.bd'),
        fr = tableau.querySelector('.fr'),
        bk = tableau.querySelector('.bk');
      if (!fr) return;
      if (bd)
        bd.animate(
          [
            { transform: 'rotate(-9deg) scale(.82) translateY(-30px)', opacity: 0 },
            { transform: 'rotate(-2.5deg)', opacity: 1 },
          ],
          { duration: 560, delay: 120, easing: 'cubic-bezier(.3, 1.25, .45, 1)', fill: 'both' }
        );
      const from = btn.querySelector('img').getBoundingClientRect(),
        to = fr.getBoundingClientRect(),
        base = getComputedStyle(fr).transform;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2),
        dy = from.top + from.height / 2 - (to.top + to.height / 2);
      fr.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${from.width / (to.width || 1)})` },
          { transform: base },
        ],
        { duration: 640, delay: 60, easing: 'cubic-bezier(.3, .9, .3, 1.05)', fill: 'both' }
      );
      if (bk)
        bk.animate(
          [
            {
              transform: `translate(${fr.offsetLeft - bk.offsetLeft}px, 0) rotate(-7deg)`,
              opacity: 0,
            },
            { transform: getComputedStyle(bk).transform, opacity: 1 },
          ],
          { duration: 480, delay: 520, easing: 'cubic-bezier(.3, 1.3, .45, 1)', fill: 'both' }
        );
    });
  }
  // once the opening animations finish they are dropped, so nothing stays on a layer rasterised at the starting scale (it blurred)
  const opening = flood.getAnimations({ subtree: true });
  requestAnimationFrame(() => {
    const all = [...opening, ...flood.getAnimations({ subtree: true })];
    Promise.all(all.map((a) => a.finished)).then(
      () => {
        if (flood.open && !flood.classList.contains('closing')) all.forEach((a) => a.cancel());
      },
      () => {}
    );
  });
  $('floodX').focus({ preventScroll: true, focusVisible: false });
}
function closeDesign() {
  if (!flood.open || flood.classList.contains('closing')) return;
  flood.classList.add('closing');
  const r = openFrom.querySelector('img').getBoundingClientRect(),
    x = r.left + r.width / 2,
    y = r.top + r.height / 2;
  const done = () => {
    flood.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    flood.classList.remove('closing');
    flood.close();
    zoom.reset();
    tableau.innerHTML = '';
    openId = null;
    openFrom.focus({ preventScroll: true });
  };
  if (reduce) {
    flood.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).onfinish = done;
    return;
  }
  tableau.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: 'translateY(26px) scale(.94)', opacity: 0 },
    ],
    { duration: 260, easing: 'cubic-bezier(.5, 0, .7, .4)', fill: 'forwards' }
  );
  const R = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  flood.animate(
    [{ clipPath: `circle(${R}px at ${x}px ${y}px)` }, { clipPath: `circle(0px at ${x}px ${y}px)` }],
    { duration: 480, delay: 120, easing: 'cubic-bezier(.6, 0, .3, 1)', fill: 'forwards' }
  ).onfinish = done;
}
strip.addEventListener('click', (e) => {
  const btn = e.target.closest('.dz');
  if (!btn) return;
  const r = btn.querySelector('img').getBoundingClientRect();
  openDesign(btn, e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2);
});
$('floodX').addEventListener('click', closeDesign);
flood.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeDesign();
}); // Esc animates out like every other close
// tap outside the board, the cards and the button, or swipe down, to close
let fy0 = null;
flood.addEventListener('pointerdown', (e) => {
  fy0 = e.clientY;
});
flood.addEventListener('pointerup', (e) => {
  const dy = fy0 == null ? 0 : e.clientY - fy0;
  fy0 = null;
  if (zoom.busy()) return; // a pinch, a pan or a zoomed view: never a tap-to-close or a swipe down
  if (dy > 70) return closeDesign();
  if (Math.abs(dy) < 8 && !e.target.closest('.tableau img, .pill, .x, .pr')) closeDesign();
});
trapTab(flood);

/* ---------- the price: only ever the admin's live price; the line stays hidden until it is known ---------- */
function stampPrice() {
  const el = $('floodPrice');
  if (!price) return;
  // M PLUS draws ₪ as heavy as the 900 digits; set beside the number a little smaller and lighter, as a price tag would
  const amount = (text) => {
    const f = document.createDocumentFragment();
    f.append(text.replace(/\s*₪$/, ''));
    const cur = document.createElement('span');
    cur.className = 'cur';
    cur.textContent = '₪';
    f.append(' ', cur);
    return f;
  };
  el.hidden = false;
  el.replaceChildren(amount(price.now));
  if (price.was) {
    const s = document.createElement('s');
    s.append(amount(price.was));
    s.setAttribute('aria-label', `במקום ${price.was}`);
    el.append(s);
  }
}

/* ---------- reviews: an endless row that drifts; a card opens the review itself in a sheet ---------- */
const sheet = $('sheet'),
  sheetPic = $('sheetPic'),
  sheetCap = $('sheetCap');
const row = $('row'),
  trackEl = $('track');
const one = [...trackEl.children];
for (let i = 0; i < 2; i++)
  one.forEach((c) => {
    const k = c.cloneNode(true);
    k.setAttribute('aria-hidden', 'true');
    k.querySelectorAll('[data-edit]').forEach((e) => {
      e.dataset.editMirror = e.dataset.edit;
      e.removeAttribute('data-edit');
    });
    k.querySelectorAll('[data-edit-img]').forEach((e) => {
      e.dataset.editImgMirror = e.dataset.editImg;
      e.removeAttribute('data-edit-img');
    });
    if (k.tagName === 'BUTTON') k.tabIndex = -1;
    trackEl.appendChild(k);
  });
// in the content editor (?edit=1) the row holds still, a card does not open, and an emptied card stays to be filled again
const editing = () =>
  document.documentElement.classList.contains('dugri-editing') ||
  /[?&]edit=1(&|$)/.test(window.location.search);
// The owner's edits reach the two copies too: every text, the screenshot and the logo. A review whose quote she empties,
// or a logo whose name she empties, leaves the row (all three copies); the logo's name is its picture's alt text.
// The spare cards at the end of the row ship empty, so they show only once she fills one (a logo needs its picture too).
const SLOT = /\/slot\.svg$/;
const mirror = () => {
  trackEl.querySelectorAll('[data-edit-mirror]').forEach((m) => {
    const src = trackEl.querySelector(`[data-edit="${m.dataset.editMirror}"]`);
    if (src) m.textContent = src.textContent;
  });
  trackEl.querySelectorAll('[data-edit-img-mirror]').forEach((m) => {
    const src = trackEl.querySelector(`[data-edit-img="${m.dataset.editImgMirror}"]`);
    if (src && m.getAttribute('src') !== src.getAttribute('src'))
      m.setAttribute('src', src.getAttribute('src'));
  });
  const edit = editing();
  [...trackEl.children].forEach((c) => {
    const name = c.querySelector('.lname'),
      empty =
        !(c.querySelector('.ttl') || name).textContent.trim() ||
        (!!name && SLOT.test(c.querySelector('img').getAttribute('src')));
    if (name) c.querySelector('img').alt = name.textContent.trim();
    c.hidden = empty && !edit;
    c.classList.toggle('rc-empty', empty);
  });
  pos = copyW(); // runs after the editor's overlay (never during this module's first pass), so the row is set up by now
  setPos();
};
let sheetFrom = null,
  dragged = false;
trackEl.addEventListener('click', (e) => {
  const b = e.target.closest('button.rc');
  if (!b || dragged || editing()) return;
  sheetFrom = b;
  const img = new window.Image(),
    shot = b.querySelector('.shot').getAttribute('src');
  img.src = shot;
  img.alt = `ההמלצה המלאה: ${b.querySelector('.ttl').textContent}`;
  if (SLOT.test(shot))
    sheetPic.replaceChildren(); // a filled spare card with no screenshot yet: the caption alone
  else sheetPic.replaceChildren(img);
  // the caption under the screenshot: the owner's name · date line, or the occasion until she writes one
  sheetCap.textContent =
    b.querySelector('.cap').textContent.trim() || b.querySelector('.tag').textContent;
  sheet.showModal();
  if (!reduce)
    sheet.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], {
      duration: 360,
      easing: 'cubic-bezier(.2, .9, .3, 1.08)',
    });
  track('review_open', { review: img.src.split('/').pop() });
});
// three copies side by side; the scroll is kept inside the middle one, so the row never ends. It drifts toward the reading
// direction unless a finger, a mouse or focus is on it, or it is off screen
// one copy's width: from the first card still shown to its twin in the next copy
const copyW = () => {
  const i = Math.max(
    0,
    one.findIndex((c) => !c.hidden)
  );
  return trackEl.children[one.length + i].offsetLeft - one[i].offsetLeft || 1;
};
let pos = 0,
  seen = false,
  rowT = 0,
  wrapT = 0,
  hovering = false,
  touching = false,
  kbFocus = false,
  mdrag = null;
const wrap = () => {
  const w = copyW();
  if (pos < w * 0.5) pos += w;
  if (pos > w * 1.5) pos -= w;
};
const setPos = () => {
  row.scrollLeft = pos;
};
function tickRow(t) {
  const dt = Math.min(64, t - (rowT || t));
  rowT = t;
  if (
    !hovering &&
    !touching &&
    !kbFocus &&
    !mdrag &&
    seen &&
    !document.hidden &&
    !sheet.open &&
    !editing()
  ) {
    pos -= dt * 0.03;
    wrap();
    setPos();
  }
  requestAnimationFrame(tickRow);
}
row.addEventListener(
  'scroll',
  () => {
    if (Math.abs(row.scrollLeft - pos) > 2) {
      pos = row.scrollLeft;
      clearTimeout(wrapT);
      wrapT = setTimeout(() => {
        wrap();
        setPos();
      }, 140);
    }
  },
  { passive: true }
);
row.addEventListener('pointerenter', (e) => {
  if (e.pointerType === 'mouse') hovering = true;
});
row.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse') hovering = false;
});
let tx = null,
  rel = 0;
row.addEventListener('pointerdown', (e) => {
  tx = e.clientX;
  dragged = false;
  if (e.pointerType === 'mouse' && e.button === 0) mdrag = { x: e.clientX, sl: row.scrollLeft }; // a mouse drags the row like a finger
});
window.addEventListener('pointermove', (e) => {
  if (tx != null && Math.abs(e.clientX - tx) > 8) dragged = true;
  if (mdrag && dragged) {
    row.scrollLeft = mdrag.sl - (e.clientX - mdrag.x);
    pos = row.scrollLeft;
    row.classList.add('dragging');
  }
});
const rowUp = () => {
  if (tx == null) return;
  tx = null;
  if (mdrag) {
    mdrag = null;
    row.classList.remove('dragging');
    wrap();
    setPos();
  }
  setTimeout(() => {
    dragged = false;
  }, 0); // a drag is not a tap on the card under it
};
window.addEventListener('pointerup', rowUp);
window.addEventListener('pointercancel', rowUp);
row.addEventListener(
  'touchstart',
  () => {
    clearTimeout(rel);
    touching = true;
  },
  { passive: true }
);
const lift = (e) => {
  if (!e.touches.length) {
    clearTimeout(rel);
    rel = setTimeout(() => {
      touching = false;
    }, 1800);
  }
};
row.addEventListener('touchend', lift);
row.addEventListener('touchcancel', lift);
// Safari before 15.4 throws on :focus-visible; there any focus in the row holds it still
const FOCUS_KB = (() => {
  try {
    document.querySelector(':focus-visible');
    return ':focus-visible';
  } catch {
    return ':focus';
  }
})();
row.addEventListener('focusin', () => {
  kbFocus = !!row.querySelector(FOCUS_KB);
});
row.addEventListener('focusout', () => {
  kbFocus = false;
});
new window.IntersectionObserver((es) => {
  seen = es[0].isIntersecting;
}).observe(row);
function startRow() {
  pos = copyW();
  setPos();
  if (!reduce) requestAnimationFrame(tickRow);
}
function closeSheet() {
  if (!sheet.open) return;
  const done = () => {
    sheet.close();
    if (sheetFrom) sheetFrom.focus({ preventScroll: true });
  };
  if (reduce) return done();
  sheet.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], {
    duration: 240,
    easing: 'cubic-bezier(.5, 0, .8, .4)',
    fill: 'forwards',
  }).onfinish = () => {
    done();
    sheet.getAnimations().forEach((a) => a.cancel());
  };
}
$('sheetX').addEventListener('click', closeSheet);
sheet.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSheet();
});
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) {
    const r = sheet.getBoundingClientRect();
    if (e.clientY < r.top || e.clientX < r.left || e.clientX > r.right) closeSheet();
  }
});
let sy0 = null;
sheet.addEventListener('pointerdown', (e) => {
  sy0 = sheet.scrollTop <= 0 ? e.clientY : null;
});
sheet.addEventListener('pointerup', (e) => {
  if (sy0 != null && e.clientY - sy0 > 70) closeSheet();
  sy0 = null;
});

/* ---------- the menu (home-menu.js, shared with new-faq.html) ---------- */
initMenu(reduce);

/* ---------- business enquiries: POST /api/business-lead ---------- */
const lead = $('lead'),
  leadOk = $('leadOk'),
  leadErr = $('leadErr');
const FIELDS = { name: 'lName', company: 'lCo', phone: 'lTel' };
const showField = (f, code) => {
  const i = $(FIELDS[f]),
    m = code ? LEAD_MESSAGES[f][code] : '';
  i.setAttribute('aria-invalid', String(!!m));
  $(FIELDS[f] + 'E').textContent = m;
  return !m;
};
const check = (f) => showField(f, leadFieldError(f, $(FIELDS[f]).value));
for (const f of Object.keys(FIELDS)) {
  $(FIELDS[f]).addEventListener('blur', () => {
    if ($(FIELDS[f]).value) check(f);
  });
  $(FIELDS[f]).addEventListener('input', () => {
    if ($(FIELDS[f]).getAttribute('aria-invalid') === 'true') check(f);
  });
}
let sending = false;
lead.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  leadErr.hidden = true;
  const values = {
    name: $('lName').value,
    company: $('lCo').value,
    phone: $('lTel').value,
    website: $('lWeb').value,
  };
  const bad = validateLead(values);
  for (const f of Object.keys(FIELDS)) showField(f, bad[f] || '');
  const first = Object.keys(FIELDS).find((f) => bad[f]);
  if (first) {
    $(FIELDS[first]).focus();
    return;
  }
  const btn = lead.querySelector('button[type=submit]');
  sending = true;
  btn.setAttribute('aria-disabled', 'true');
  const out = await sendLead(values, { source: location.pathname });
  sending = false;
  btn.removeAttribute('aria-disabled');
  if (out.state === 'ok') {
    lead.hidden = true;
    leadOk.hidden = false;
    leadOk.focus();
    track('business_lead', {});
  } else if (out.state === 'invalid') {
    for (const f of Object.keys(FIELDS)) showField(f, out.fields[f] || '');
    const f0 = Object.keys(FIELDS).find((f) => out.fields[f]);
    if (f0) $(FIELDS[f0]).focus();
  } else {
    $('leadErrText').textContent =
      out.state === 'rate'
        ? 'נשלחו מכאן הרבה פניות בזמן קצר. נסו שוב בעוד שעה, או כתבו לנו בוואטסאפ.'
        : 'משהו השתבש ולא הצלחנו לשלוח. אפשר לנסות שוב, או לכתוב לנו בוואטסאפ.';
    leadErr.hidden = false;
    leadErr.focus();
  }
});

/* ---------- start ---------- */
buildStrip();
showNext('bachelorette');
placeDeck();
initIllustrations();
fetchPricing().then((p) => {
  if (p.ok) {
    price = priceText(p);
    if (openId) stampPrice();
  }
});
// the public designs she added, the admin's names and the designs she hid (they leave PUBLIC_DESIGNS): re-render once
// they have answered (each gives up on its own after 2.5 s)
loadCustomDesigns().then(async (extra) => {
  await syncDesignNames(() => {}, { lists: [PUBLIC_DESIGNS, extra] });
  const next = homeDesigns([...PUBLIC_DESIGNS, ...extra]);
  const same =
    next.length === designs.length &&
    next.every((d, i) => d.id === designs[i].id && d.name === designs[i].name);
  if (same) return;
  designs = next;
  D = byId();
  buildStrip();
  startStrip();
  showNext();
});
// the owner's text and photos: the editor fills them in; the reviews' copies follow
if (window.dugriEditor && window.dugriEditor.onReady)
  window.dugriEditor.onReady(() => setTimeout(mirror, 0));
else window.addEventListener('load', mirror);
window.addEventListener('load', () => {
  placeDeck();
  startStrip();
  startRow();
  setTimeout(() => deal(), reduce ? 0 : 450);
  startAutoDeal();
});
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  paint();
  if (Math.abs(window.innerWidth - lastW) < 2) return;
  lastW = window.innerWidth;
  placeDeck();
  startStrip();
  pos = copyW();
  setPos();
  cards.forEach((c) => (reduce ? (clampIn(c), draw(c)) : kick(c)));
  retire();
});
