// Smooth, shape-preserving curves.
//
// WHY NOT CATMULL-ROM. The usual one-liner for "make the line smooth" overshoots:
// between two points the spline can bulge past both, so the rendered curve shows
// a value the data never contained. On a PnL chart that is a loss that never
// happened; on a price chart it is a high that was never traded. A chart that
// invents values is a chart that lies, however good it looks.
//
// Monotone cubic (Fritsch–Carlson) is smooth AND shape-preserving: every segment
// stays inside the interval its endpoints define, and a monotonic run stays
// monotonic. It is the interpolation you can put in front of someone and still
// say the picture is the data.
import type { Point } from './chart';

/** Fritsch–Carlson tangents: the slopes that make the spline non-overshooting. */
function tangents(pts: Point[]): number[] {
  const n = pts.length;
  const dx: number[] = [], dy: number[] = [], slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1]!.x - pts[i]!.x;
    dx.push(h);
    dy.push(pts[i + 1]!.y - pts[i]!.y);
    slope.push(h === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / h);   // duplicate x → flat, never NaN
  }

  const m: number[] = new Array(n).fill(0);
  m[0] = slope[0] ?? 0;
  m[n - 1] = slope[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1]!, s1 = slope[i]!;
    // A sign change is a local extremum: the tangent must be flat there, which
    // is precisely what stops the curve sailing past the point.
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }

  // Clamp so no segment can exceed three times its secant slope (the
  // Fritsch–Carlson condition for monotonicity).
  for (let i = 0; i < n - 1; i++) {
    const s = slope[i]!;
    if (s === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i]! / s, b = m[i + 1]! / s;
    const h = Math.hypot(a, b);
    if (h > 3) { m[i] = (3 / h) * a * s; m[i + 1] = (3 / h) * b * s; }
  }
  return m;
}

/** An SVG path of cubic segments through every point, without overshoot. */
export function monotoneCubicPath(pts: Point[]): string {
  if (!pts.length) return '';
  const f = (v: number) => v.toFixed(2);
  if (pts.length === 1) return `M${f(pts[0]!.x)},${f(pts[0]!.y)}`;
  const m = tangents(pts);
  let d = `M${f(pts[0]!.x)},${f(pts[0]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!, p1 = pts[i + 1]!;
    const h = (p1.x - p0.x) / 3;
    d += `C${f(p0.x + h)},${f(p0.y + m[i]! * h)} ${f(p1.x - h)},${f(p1.y - m[i + 1]! * h)} ${f(p1.x)},${f(p1.y)}`;
  }
  return d;
}

/** Sample the same curve numerically — used by the tests that prove it cannot
 *  overshoot, and available for hit-testing. */
export function sampleCubic(pts: Point[], steps: number): Point[] {
  if (pts.length < 2) return [...pts];
  const m = tangents(pts);
  const out: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!, p1 = pts[i + 1]!;
    const h = p1.x - p0.x;
    const per = Math.max(2, Math.round(steps / (pts.length - 1)));
    for (let k = 0; k <= per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      // Hermite basis.
      const y = (2 * t3 - 3 * t2 + 1) * p0.y
              + (t3 - 2 * t2 + t) * h * m[i]!
              + (-2 * t3 + 3 * t2) * p1.y
              + (t3 - t2) * h * m[i + 1]!;
      out.push({ x: p0.x + t * h, y });
    }
  }
  return out;
}
