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
