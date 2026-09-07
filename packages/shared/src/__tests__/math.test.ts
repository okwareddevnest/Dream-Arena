// T-002 — the normal CDF and its inverse are the numerical foundation of WP F1–F3.
// Accuracy here is not cosmetic: F2 inverts F1, so any cdf/inv mismatch manufactures
// synthetic edge, which is exactly the failure WP §4 warns about.
import { describe, it, expect } from 'vitest';
import { norm, clamp, EPS } from '../index.ts';

describe('T-002 norm.cdf', () => {
  it('cdf(0) is exactly 0.5', () => {
    expect(norm.cdf(0)).toBe(0.5);
  });
  it('cdf(1.96) ≈ 0.975 within 1e-4', () => {
    expect(norm.cdf(1.96)).toBeCloseTo(0.975, 4);
  });
  it('matches known quantiles to 1e-12', () => {
    const known: [number, number][] = [
      [-3, 0.001349898031630095], [-2, 0.022750131948179195], [-1, 0.15865525393145705],
      [1, 0.8413447460685429], [2, 0.9772498680518208], [3, 0.9986501019683699],
      [1.6448536269514722, 0.95], [2.5758293035489004, 0.995],
    ];
    for (const [x, want] of known) expect(Math.abs(norm.cdf(x) - want)).toBeLessThan(1e-12);
  });
  it('is symmetric: cdf(-x) === 1 - cdf(x)', () => {
    for (let x = 0; x <= 6; x += 0.25) expect(Math.abs(norm.cdf(-x) - (1 - norm.cdf(x)))).toBeLessThan(1e-15);
  });
  it('is monotone increasing and stays inside [0,1] across the whole real line', () => {
    let prev = -1;
    for (let x = -40; x <= 40; x += 0.1) {
      const c = norm.cdf(x);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
  it('saturates without NaN at extreme inputs', () => {
    expect(norm.cdf(-50)).toBe(0);
    expect(norm.cdf(50)).toBe(1);
    expect(Number.isNaN(norm.cdf(Infinity))).toBe(false);
  });
});

describe('T-002 norm.inv', () => {
  it('inv(0.5) is exactly 0', () => {
    expect(norm.inv(0.5)).toBe(0);
  });
  it('round-trips: inv(cdf(x)) ≈ x within 1e-6 for x in [-4,4]', () => {
    for (let x = -4; x <= 4; x += 0.05) {
      expect(Math.abs(norm.inv(norm.cdf(x)) - x)).toBeLessThan(1e-6);
    }
  });
  it('round-trips the other way: cdf(inv(p)) ≈ p within 1e-12', () => {
    for (let p = 0.001; p < 1; p += 0.001) {
      expect(Math.abs(norm.cdf(norm.inv(p)) - p)).toBeLessThan(1e-12);
    }
  });
  it('returns ±Infinity at the boundaries rather than NaN (F2 must detect, not crash)', () => {
    expect(norm.inv(0)).toBe(-Infinity);
    expect(norm.inv(1)).toBe(Infinity);
  });
  it('rejects probabilities outside [0,1]', () => {
    expect(() => norm.inv(-0.1)).toThrow();
    expect(() => norm.inv(1.1)).toThrow();
    expect(() => norm.inv(Number.NaN)).toThrow();
  });
});

describe('T-002 helpers', () => {
  it('clamp bounds a value both ways and passes through the interior', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
  });
  it('EPS is small enough not to mask a real probability difference', () => {
    expect(EPS).toBeGreaterThan(0);
    expect(EPS).toBeLessThan(1e-9);
  });
});
