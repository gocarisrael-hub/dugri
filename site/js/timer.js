// timer.js — pure timer logic extracted from site/timer.html.
// The 60-second hourglass: given elapsed time, compute remaining seconds,
// fill progress, and whether the timer is done.

/**
 * Compute timer state for a given elapsed time.
 *
 * @param {number} elapsedMs - milliseconds elapsed since start (>=0).
 * @param {number} [durationMs=60000] - total duration in milliseconds.
 * @returns {{remaining:number, progress:number, done:boolean}}
 *   remaining - whole seconds left, rounded up (ceil), clamped to >=0.
 *   progress  - fill 0..1 (elapsed / duration), clamped.
 *   done      - true once elapsedMs >= durationMs.
 */
export function tick(elapsedMs, durationMs = 60000) {
  const e = Math.max(0, elapsedMs);
  const progress = Math.min(1, Math.max(0, e / durationMs));
  const done = e >= durationMs;
  const remaining = Math.max(0, Math.ceil((durationMs - e) / 1000));
  return { remaining, progress, done };
}

/**
 * Optional thin renderer helper for the hourglass SVG used in timer.html.
 * Pure given the elements; mirrors the original render()/setCount() logic.
 * Not required for the pure `tick` tests but handy for UI wiring.
 *
 * @param {object} els
 * @param {SVGRectElement} els.sandTop
 * @param {SVGRectElement} els.sandBottom
 * @param {SVGRectElement} [els.stream]
 * @param {Element} [els.count]
 * @param {boolean} [running=false] - whether the timer is actively counting.
 * @param {number} elapsedMs
 * @param {number} [durationMs=60000]
 * @returns {{remaining:number, progress:number, done:boolean}}
 */
export function renderHourglass(els, elapsedMs, running = false, durationMs = 60000) {
  const state = tick(elapsedMs, durationMs);
  const p = state.progress;

  if (els.sandTop) {
    els.sandTop.setAttribute('y', String(12 + 68 * p));
    els.sandTop.setAttribute('height', String(68 * (1 - p)));
  }
  if (els.sandBottom) {
    const botH = 68 * p;
    els.sandBottom.setAttribute('y', String(148 - botH));
    els.sandBottom.setAttribute('height', String(botH));
  }
  if (els.stream) {
    els.stream.setAttribute('opacity', running && p < 1 ? '0.85' : '0');
  }
  if (els.count) {
    els.count.textContent = String(state.remaining);
  }
  return state;
}
