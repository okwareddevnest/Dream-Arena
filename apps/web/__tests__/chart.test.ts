// Chart primitive acceptance — sharpness and accuracy are the whole point.
//
// The previous sparkline used preserveAspectRatio="none", which scales x and y
// by DIFFERENT factors: the stroke is stretched with the geometry, so the line
// renders at an inconsistent width and reads as blurry. Drawing in true pixel
// space and pinning the stroke fixes it. Accuracy is separate and equally
// testable: a value must land where the axis says it lands.
import { describe, it, expect } from 'vitest';
import { buildSeriesPath, niceTicks, scaleLinear, extent } from '../lib/chart';

const pts = (ys: number[]) => ys.map((y, i) => ({ x: i, y }));

describe('scaleLinear', () => {
  it('maps a domain onto a range exactly at both ends', () => {
    const s = scaleLinear([0, 10], [0, 100]);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
    expect(s(2.5)).toBe(25);
  });
  it('inverts when the range is inverted, as screen y must be', () => {
    const s = scaleLinear([0, 1], [40, 0]);   // y grows downward
    expect(s(0)).toBe(40);
    expect(s(1)).toBe(0);
  });
  it('centres a zero-width domain instead of dividing by zero', () => {
    const s = scaleLinear([5, 5], [0, 100]);
    expect(Number.isFinite(s(5))).toBe(true);
    expect(s(5)).toBe(50);
  });
});

describe('extent', () => {
  it('finds min and max', () => {
    expect(extent([3, -1, 7])).toEqual([-1, 7]);
  });
  it('pads a flat series so it draws through the middle', () => {
    const [lo, hi] = extent([4, 4, 4]);
    expect(lo).toBeLessThan(hi);
  });
  it('handles an empty series without NaN', () => {
    const [lo, hi] = extent([]);
    expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
  });
});

describe('niceTicks', () => {
  it('returns round, human numbers inside the domain', () => {
    const t = niceTicks(0, 100, 4);
    expect(t.length).toBeGreaterThanOrEqual(2);
    for (const v of t) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
    expect(t.every((v) => Number.isFinite(v))).toBe(true);
  });
  it('copes with a negative-through-positive domain, including zero', () => {
    const t = niceTicks(-20, 35, 4);
    expect(t.some((v) => v === 0)).toBe(true);
  });
  it('never loops forever on a degenerate domain', () => {
    expect(niceTicks(5, 5, 4).length).toBeGreaterThan(0);
  });
});

describe('buildSeriesPath', () => {
  const box = { width: 200, height: 100, padL: 0, padR: 0, padT: 0, padB: 0 };

  it('draws in PIXEL space so the stroke is never scaled', () => {
    const { d } = buildSeriesPath(pts([0, 10]), box);
    // first point at x=0, last at the full pixel width — not a 0..1 viewBox
    expect(d).toMatch(/^M0(\.0+)?,/);
    expect(d).toContain('200');
    expect(d).not.toContain('NaN');
  });

  it('places a value at the position the axis promises', () => {
    // y domain 0..10 over 100px, inverted: y=10 -> 0px, y=0 -> 100px
    const { d, y } = buildSeriesPath(pts([0, 5, 10]), box);
    expect(y(0)).toBeCloseTo(100, 6);
    expect(y(5)).toBeCloseTo(50, 6);
    expect(y(10)).toBeCloseTo(0, 6);
    expect(d.split('L').length).toBe(3);
  });

  it('returns an area path that closes along the baseline', () => {
    const { area } = buildSeriesPath(pts([1, 2, 3]), box);
    expect(area.startsWith('M')).toBe(true);
    expect(area.trim().endsWith('Z')).toBe(true);
  });

  it('renders a single point as a visible horizontal segment', () => {
    const { d } = buildSeriesPath(pts([7]), box);
    expect(d).toMatch(/^M/);
    expect(d).toContain('L');
  });

  it('is empty for an empty series rather than drawing a fake zero line', () => {
    expect(buildSeriesPath([], box).d).toBe('');
  });

  it('respects padding so labels never overlap the plot', () => {
    const padded = { width: 200, height: 100, padL: 20, padR: 10, padT: 5, padB: 15 };
    const { d } = buildSeriesPath(pts([0, 10]), padded);
    expect(d).toMatch(/^M20(\.0+)?,/);          // starts after the left gutter
    expect(d).toContain('190');                  // ends before the right gutter
  });
});
