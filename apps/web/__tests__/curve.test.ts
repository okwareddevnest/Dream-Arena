// Smooth curves that cannot lie.
//
// The obvious way to smooth a line is Catmull-Rom, and it OVERSHOOTS: between
// two points it can bulge past both, drawing a value the data never contained.
// On a PnL chart that means rendering a loss that never happened. Monotone cubic
// interpolation is smooth AND shape-preserving — it never leaves the interval
// its neighbours define — so the curve stays a statement about the data.
import { describe, it, expect } from 'vitest';
import { monotoneCubicPath, sampleCubic } from '../lib/curve';

const P = (xs: number[], ys: number[]) => xs.map((x, i) => ({ x, y: ys[i]! }));

describe('monotoneCubicPath', () => {
  it('emits cubic segments, not straight lines', () => {
    const d = monotoneCubicPath(P([0, 50, 100], [10, 40, 20]));
    expect(d).toMatch(/^M/);
    expect(d).toContain('C');
    expect(d).not.toContain('NaN');
  });

  it('passes exactly through every data point', () => {
    const pts = P([0, 40, 80, 120], [10, 55, 30, 70]);
    const d = monotoneCubicPath(pts);
    // Every anchor appears as a curve endpoint.
    for (const p of pts.slice(1)) {
      expect(d).toContain(`${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    }
    expect(d.startsWith(`M${pts[0]!.x.toFixed(2)},${pts[0]!.y.toFixed(2)}`)).toBe(true);
  });

  it('NEVER overshoots — the whole reason for monotone cubic', () => {
    // A sharp step: a naive spline bulges below 10 and above 90 here.
    const pts = P([0, 25, 50, 75, 100], [10, 10, 90, 90, 90]);
    const ys = sampleCubic(pts, 400).map((p) => p.y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(Math.max(...ys)).toBeLessThanOrEqual(90 + 1e-9);
  });

  it('keeps a monotonic run monotonic', () => {
    const ys = sampleCubic(P([0, 20, 40, 60], [0, 5, 30, 31]), 200).map((p) => p.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]! - 1e-9);
  });

  it('handles a flat series as a flat line', () => {
    const ys = sampleCubic(P([0, 50, 100], [7, 7, 7]), 100).map((p) => p.y);
    for (const y of ys) expect(y).toBeCloseTo(7, 9);
  });

  it('degrades safely on short input', () => {
    expect(monotoneCubicPath([])).toBe('');
    expect(monotoneCubicPath(P([5], [5]))).toMatch(/^M/);
    expect(monotoneCubicPath(P([0, 10], [1, 2]))).toMatch(/^M/);
  });

  it('never emits a NaN from duplicate x values', () => {
    expect(monotoneCubicPath(P([0, 0, 10], [1, 2, 3]))).not.toContain('NaN');
  });
});
