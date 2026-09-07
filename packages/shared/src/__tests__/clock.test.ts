// T-002 — SIM correctness depends entirely on the clock being injectable.
// 40-TESTPLAN §6 rule 1: no test may read the wall clock.
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock, SystemClock } from '../index.ts';

describe('T-002 VirtualClock', () => {
  it('starts at its seed and advance(n) moves now() by exactly n', () => {
    const c = new VirtualClock(1_000);
    expect(c.now()).toBe(1_000);
    c.advance(250);
    expect(c.now()).toBe(1_250);
    c.advance(0);
    expect(c.now()).toBe(1_250);
  });

  it('fires due timers in chronological order, not insertion order', () => {
    const c = new VirtualClock(0);
    const seen: string[] = [];
    c.setTimeout(() => seen.push('c'), 30);
    c.setTimeout(() => seen.push('a'), 10);
    c.setTimeout(() => seen.push('b'), 20);
    c.advance(100);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('fires ties in insertion order (stable)', () => {
    const c = new VirtualClock(0);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) c.setTimeout(() => seen.push(i), 10);
    c.advance(10);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not fire a timer scheduled beyond the advance', () => {
    const c = new VirtualClock(0);
    const fn = vi.fn();
    c.setTimeout(fn, 100);
    c.advance(99);
    expect(fn).not.toHaveBeenCalled();
    c.advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sets now() to each timer’s due time while it runs (a timer sees its own deadline)', () => {
    const c = new VirtualClock(0);
    const at: number[] = [];
    c.setTimeout(() => at.push(c.now()), 10);
    c.setTimeout(() => at.push(c.now()), 40);
    c.advance(100);
    expect(at).toEqual([10, 40]);
    expect(c.now()).toBe(100);
  });

  it('runs timers scheduled by other timers within the same advance', () => {
    const c = new VirtualClock(0);
    const seen: string[] = [];
    c.setTimeout(() => { seen.push('outer'); c.setTimeout(() => seen.push('inner'), 5); }, 10);
    c.advance(100);
    expect(seen).toEqual(['outer', 'inner']);
  });

  it('clearTimeout cancels a pending timer', () => {
    const c = new VirtualClock(0);
    const fn = vi.fn();
    const h = c.setTimeout(fn, 10);
    c.clearTimeout(h);
    c.advance(50);
    expect(fn).not.toHaveBeenCalled();
  });

  it('setInterval repeats on cadence and stops when cleared', () => {
    const c = new VirtualClock(0);
    let n = 0;
    const h = c.setInterval(() => { n++; }, 10);
    c.advance(35);
    expect(n).toBe(3);
    c.clearTimeout(h);
    c.advance(100);
    expect(n).toBe(3);
  });

  it('advances an hour of virtual time in under 10 ms of real time (T-031 budget)', () => {
    const c = new VirtualClock(0);
    let n = 0;
    c.setInterval(() => { n++; }, 1_000);
    const t0 = performance.now();
    c.advance(3_600_000);
    const el = performance.now() - t0;
    expect(n).toBe(3_600);
    expect(el).toBeLessThan(10);
  });

  it('a throwing timer does not stop the remaining timers', () => {
    const c = new VirtualClock(0);
    const seen: string[] = [];
    c.setTimeout(() => { throw new Error('boom'); }, 10);
    c.setTimeout(() => seen.push('after'), 20);
    expect(() => c.advance(50)).not.toThrow();
    expect(seen).toEqual(['after']);
    expect(c.errors.length).toBe(1);
  });

  it('refuses to go backwards', () => {
    const c = new VirtualClock(100);
    expect(() => c.advance(-1)).toThrow();
  });
});

describe('T-002 SystemClock', () => {
  it('reports wall time and is monotone across reads', () => {
    const c = new SystemClock();
    const a = c.now();
    const b = c.now();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Math.abs(a - Date.now())).toBeLessThan(1_000);
  });
  it('schedules real timers that can be cleared', async () => {
    const c = new SystemClock();
    const fn = vi.fn();
    const h = c.setTimeout(fn, 5);
    c.clearTimeout(h);
    await new Promise((r) => setTimeout(r, 20));
    expect(fn).not.toHaveBeenCalled();
  });
});
