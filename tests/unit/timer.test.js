import { describe, it, expect } from 'vitest';
import { tick } from '../../site/js/timer.js';

describe('tick', () => {
  it('at 0ms -> remaining 60, progress 0, not done', () => {
    const s = tick(0);
    expect(s.remaining).toBe(60);
    expect(s.progress).toBe(0);
    expect(s.done).toBe(false);
  });

  it('at 30000ms -> remaining 30, progress 0.5, not done', () => {
    const s = tick(30000);
    expect(s.remaining).toBe(30);
    expect(s.progress).toBeCloseTo(0.5, 5);
    expect(s.done).toBe(false);
  });

  it('at exactly 60000ms -> done, remaining 0, progress 1', () => {
    const s = tick(60000);
    expect(s.done).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.progress).toBe(1);
  });

  it('beyond duration -> done, remaining 0, progress clamped to 1', () => {
    const s = tick(75000);
    expect(s.done).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.progress).toBe(1);
  });

  it('ceils remaining seconds (fractional second left)', () => {
    // 100ms elapsed -> 59.9s left -> ceil = 60
    expect(tick(100).remaining).toBe(60);
    // 59500ms elapsed -> 0.5s left -> ceil = 1
    expect(tick(59500).remaining).toBe(1);
  });

  it('clamps negative elapsed to start', () => {
    const s = tick(-5000);
    expect(s.remaining).toBe(60);
    expect(s.progress).toBe(0);
    expect(s.done).toBe(false);
  });

  it('respects a custom duration', () => {
    const s = tick(15000, 30000);
    expect(s.remaining).toBe(15);
    expect(s.progress).toBeCloseTo(0.5, 5);
    expect(s.done).toBe(false);
    expect(tick(30000, 30000).done).toBe(true);
  });
});
