// Chart primitives.
//
// SHARPNESS. Everything is computed in TRUE PIXEL SPACE and the SVG viewBox
// matches its rendered size 1:1. The earlier sparkline used
// preserveAspectRatio="none", which scales x and y by different factors — the
// stroke is stretched along with the geometry, so the line renders at an
// inconsistent width and looks soft. Drawing in pixels, pinning the stroke with
// vector-effect, and snapping gridlines to half-pixels keeps every line crisp.
//
// ACCURACY. A value must land exactly where the axis says. The scales are plain
// linear maps with explicit degenerate-domain behaviour, so a flat series or a
// single point cannot silently produce NaN geometry.

import { monotoneCubicPath } from './curve';

export interface Point { x: number; y: number }
export interface Box {
  width: number; height: number;
  padL: number; padR: number; padT: number; padB: number;
}

/** Linear map from domain to range. A zero-width domain maps to the midpoint
 *  rather than dividing by zero. */
export function scaleLinear([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Min and max, padded when flat so a constant series still draws a line. */
export function extent(vals: number[]): [number, number] {
  if (!vals.length) return [0, 1];
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { const pad = Math.abs(lo) * 0.1 || 1; return [lo - pad, hi + pad]; }
  return [lo, hi];
}

/** Round, human tick values across a domain, always including 0 when it is inside. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step / 1e6; v += step) {
    out.push(Number(v.toFixed(10)));
    if (out.length > 24) break;                 // never loop away on bad input
  }
  if (lo < 0 && hi > 0 && !out.some((v) => v === 0)) out.push(0);
  return out.sort((a, b) => a - b);
}

export interface SeriesPath {
  /** Smooth, shape-preserving path (monotone cubic). */
  curve: string;
  d: string;
  area: string;
  x: (v: number) => number;
  y: (v: number) => number;
  domainY: [number, number];
}

/** Line and area paths for a series, in pixel coordinates. */
export function buildSeriesPath(points: Point[], box: Box): SeriesPath {
  const x0 = box.padL;
  const x1 = Math.max(box.padL, box.width - box.padR);
  const y0 = box.padT;
  const y1 = Math.max(box.padT, box.height - box.padB);

  const domainY = extent(points.map((p) => p.y));
  const xs = points.map((p) => p.x);
  const domainX: [number, number] = points.length > 1
    ? [Math.min(...xs), Math.max(...xs)]
    : [0, 1];

  const x = scaleLinear(domainX, [x0, x1]);
  const y = scaleLinear(domainY, [y1, y0]);   // screen y grows downward

  if (!points.length) return { d: '', curve: '', area: '', x, y, domainY };

  // A single reading is real information: draw it as a level, not a dot nobody sees.
  if (points.length === 1) {
    const yy = ((y1 + y0) / 2).toFixed(2);
    const flat = `M${x0.toFixed(2)},${yy}L${x1.toFixed(2)},${yy}`;
    return { d: flat, curve: flat, area: '', x, y, domainY };
  }

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`)
    .join('');
  // Smoothed in SCREEN space, after scaling, so the curve is smooth as drawn.
  const curve = monotoneCubicPath(points.map((p) => ({ x: x(p.x), y: y(p.y) })));
  const area = `${curve}L${x1.toFixed(2)},${y1.toFixed(2)}L${x0.toFixed(2)},${y1.toFixed(2)}Z`;
  return { d, curve, area, x, y, domainY };
}

/** Snap a coordinate to a half-pixel so a 1px rule renders as one crisp line
 *  instead of two half-lit rows. */
export const crisp = (v: number): number => Math.round(v) + 0.5;
