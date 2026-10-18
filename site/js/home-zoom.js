// The tapped design's zoom (new.html): pinch with two fingers, pan with one once zoomed, double-tap a picture to zoom in
// there (and again to zoom back out), ctrl+wheel / a trackpad pinch on a computer. The pictures (board, front, back) zoom
// together as one layer, and reset() puts them back. The math is pure and exported for tests/unit/home-zoom.test.js;
// initZoom binds it to a dialog. Nothing here closes the dialog, focuses or scrolls: the dialog asks busy() before treating
// a gesture as a tap-to-close or a swipe down.

export const MAX_ZOOM = 4;
export const TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 320,
  DOUBLE_TAP_PX = 30;

/** Keep the zoomed layer covering its own box: no gap opens at any edge. `t` is the layer's offset at scale `s`. */
export function clampView({ s, tx, ty }, w, h) {
  s = Math.max(1, Math.min(MAX_ZOOM, s));
  return {
    s,
    tx: Math.min(0, Math.max(w - w * s, tx)),
    ty: Math.min(0, Math.max(h - h * s, ty)),
  };
}
/** Scale `v` by `k` about the point (px, py), in the layer's own box coordinates, and keep it in bounds. */
export function zoomAbout(v, k, px, py, w, h) {
  const s = Math.max(1, Math.min(MAX_ZOOM, v.s * k)),
    r = s / v.s;
  return clampView({ s, tx: px - (px - v.tx) * r, ty: py - (py - v.ty) * r }, w, h);
}
/** A two-finger move: the content point under the first midpoint follows the fingers, scaled by how far they spread. */
export function pinch(v0, mid0, d0, mid, d, w, h) {
  const s = Math.max(1, Math.min(MAX_ZOOM, (v0.s * d) / (d0 || 1)));
  const cx = (mid0[0] - v0.tx) / v0.s,
    cy = (mid0[1] - v0.ty) / v0.s;
  return clampView({ s, tx: mid[0] - cx * s, ty: mid[1] - cy * s }, w, h);
}

/**
 * Bind the zoom to `root` (the dialog: gestures are read anywhere in it) for the layer `layer` (transformed).
 * `isPicture(target)` says which targets a double-tap zooms on. Returns { reset, busy }.
 */
export function initZoom(root, layer, { isPicture = () => true } = {}) {
  let v = { s: 1, tx: 0, ty: 0 },
    box = null; // the layer's untransformed box, read when a gesture starts at scale 1
  const pts = new Map();
  let g = null, // the gesture in progress
    moved = false, // this gesture zoomed or panned: it is not a tap
    lastTap = null;
  const readBox = () => {
    if (v.s === 1 || !box) {
      layer.style.transform = '';
      const r = layer.getBoundingClientRect();
      box = { left: r.left, top: r.top, w: r.width || 1, h: r.height || 1 };
    }
    return box;
  };
  const local = (e) => [e.clientX - box.left, e.clientY - box.top];
  const apply = () => {
    layer.style.transformOrigin = '0 0';
    layer.style.transform = v.s === 1 ? '' : `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    root.classList.toggle('zoomed', v.s > 1);
  };
  // once a gesture settles, ask the pictures for sources sharp enough for the size they are now drawn at
  const sharpen = () => {
    layer.querySelectorAll('img[srcset]').forEach((img) => {
      if (!img.dataset.sizes) img.dataset.sizes = img.getAttribute('sizes') || '';
      const want = Math.ceil(img.getBoundingClientRect().width);
      if (v.s > 1 && want) img.setAttribute('sizes', want + 'px');
    });
  };
  const two = () => {
    const [a, b] = [...pts.values()];
    return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  };
  const begin = () => {
    if (pts.size >= 2) {
      const t = two();
      g = { kind: 'pinch', v0: v, mid0: t.mid, d0: t.d };
    } else if (pts.size === 1) {
      const [p] = [...pts.values()];
      g = { kind: 'pan', v0: v, p0: p };
    } else g = null;
  };
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    readBox();
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) moved = false;
    begin();
  });
  root.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, local(e));
    if (g.kind === 'pinch' && pts.size >= 2) {
      const t = two();
      v = pinch(g.v0, g.mid0, g.d0, t.mid, t.d, box.w, box.h);
      moved = true;
      apply();
    } else if (g.kind === 'pan' && g.v0.s > 1) {
      const p = pts.get(e.pointerId),
        dx = p[0] - g.p0[0],
        dy = p[1] - g.p0[1];
      if (!moved && Math.hypot(dx, dy) < 6) return;
      v = clampView({ s: g.v0.s, tx: g.v0.tx + dx, ty: g.v0.ty + dy }, box.w, box.h);
      moved = true;
      apply();
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size) return begin(); // one finger lifted from a pinch: carry on as a pan
    g = null;
    if (e.type !== 'pointerup' || moved) return sharpen();
    // a double-tap on a picture zooms in there; on a zoomed view, anywhere, it zooms back out
    const now = window.performance.now();
    if (
      lastTap &&
      now - lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(p[0] - lastTap.p[0], p[1] - lastTap.p[1]) < DOUBLE_TAP_PX &&
      (v.s > 1 || isPicture(e.target))
    ) {
      lastTap = null;
      v = v.s > 1 ? { s: 1, tx: 0, ty: 0 } : zoomAbout(v, TAP_ZOOM, p[0], p[1], box.w, box.h);
      moved = true;
      apply();
      sharpen();
      return;
    }
    lastTap = { t: now, p };
  };
  root.addEventListener('pointerup', end, true); // capture: busy() is known before the dialog's own pointerup reads it
  root.addEventListener('pointercancel', end, true);
  root.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return; // a trackpad pinch, or ctrl + wheel
      e.preventDefault();
      readBox();
      const [px, py] = local(e);
      v = zoomAbout(v, Math.exp(-e.deltaY / 100), px, py, box.w, box.h);
      apply();
      clearTimeout(root._zoomSharpen);
      root._zoomSharpen = setTimeout(sharpen, 200);
    },
    { passive: false }
  );
  // Safari: its own page pinch and double-tap zoom would otherwise take over (touch-action alone does not stop them there)
  ['gesturestart', 'gesturechange'].forEach((ev) =>
    root.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
  );
  root.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 || v.s > 1) e.preventDefault();
    },
    { passive: false }
  );
  return {
    reset() {
      v = { s: 1, tx: 0, ty: 0 };
      pts.clear();
      g = null;
      moved = false;
      lastTap = null;
      box = null;
      apply();
      layer.querySelectorAll('img[data-sizes]').forEach((img) => {
        if (img.dataset.sizes) img.setAttribute('sizes', img.dataset.sizes);
        else img.removeAttribute('sizes');
        delete img.dataset.sizes;
      });
    },
    // the current gesture zoomed or panned, more than one finger is down, or the view is zoomed: not a tap, not a swipe
    busy: () => moved || pts.size > 1 || v.s > 1,
    scale: () => v.s,
  };
}
