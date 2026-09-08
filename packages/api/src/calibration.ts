// What the arena can tell a person about themselves.
//
// MIRA's probability is the same for everyone, so "a unique prediction per user"
// is not the thing to build. The unique thing is a person's OWN RECORD: when you
// forecast you reveal a belief, and once the market resolves that belief can be
// scored — not just "you were wrong by this much" but HOW you were wrong.
//
// Brier decomposes (Murphy 1973) into:
//   brier = reliability − resolution + uncertainty
//   · reliability  — calibration error. When you say 70%, does it happen 70% of
//                    the time? LOWER IS BETTER.
//   · resolution   — discrimination. Do your forecasts separate the likely from
//                    the unlikely at all? HIGHER IS BETTER.
//   · uncertainty  — how hard the questions were. Not your doing.
// A confident forecaster and a timid one can share a Brier score and need
// opposite advice; only the decomposition tells them apart.
import type { Forecast, Outcome } from '@arena/shared';

/** Markets that have actually RESOLVED, as 1 for YES and 0 for NO.
 *  An unresolved market is absent rather than assumed — a question nobody has
 *  answered yet cannot score anybody. */
const resolvedYes = (outcomes: Outcome[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const o of outcomes) {
    if (!o.resolved || o.outcome === null) continue;
    m.set(o.marketId, o.outcome === 0 ? 1 : 0);
  }
  return m;
};

export interface Murphy {
  n: number;
  /** null when nothing has resolved — never a zero standing in for "unknown". */
  brier: number | null;
  reliability: number;
  resolution: number;
  uncertainty: number;
  baseRate: number;
}

export function murphy(forecasts: Forecast[], outcomes: Outcome[], bins = 10): Murphy {
  const truth = resolvedYes(outcomes);
  const scored = forecasts
    .map((f) => ({ p: f.p as number, y: truth.get(f.marketId) }))
    .filter((r): r is { p: number; y: number } => r.y !== undefined);

  const n = scored.length;
  if (!n) return { n: 0, brier: null, reliability: 0, resolution: 0, uncertainty: 0, baseRate: 0 };

  const baseRate = scored.reduce((a, r) => a + r.y, 0) / n;
  const brier = scored.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / n;

  // Group by stated confidence to compare it with what actually happened.
  const groups = new Map<number, { p: number[]; y: number[] }>();
  for (const r of scored) {
    const k = Math.min(bins - 1, Math.floor(r.p * bins));
    const g = groups.get(k) ?? { p: [], y: [] };
    g.p.push(r.p); g.y.push(r.y);
    groups.set(k, g);
  }

  let reliability = 0, resolution = 0;
  for (const g of groups.values()) {
    const k = g.p.length;
    const meanP = g.p.reduce((a, b) => a + b, 0) / k;
    const meanY = g.y.reduce((a, b) => a + b, 0) / k;
    reliability += (k / n) * (meanP - meanY) ** 2;
    resolution += (k / n) * (meanY - baseRate) ** 2;
  }
  return {
    n, brier, reliability, resolution,
    uncertainty: baseRate * (1 - baseRate),
    baseRate,
  };
}

export interface Bucket { stated: number; observed: number | null; n: number; lo: number; hi: number }

/** Stated confidence against observed frequency — the calibration curve. An
 *  untouched bucket stays null: an empty bin is not a 0% hit rate. */
export function calibrationBuckets(forecasts: Forecast[], outcomes: Outcome[], bins = 10): Bucket[] {
  const truth = resolvedYes(outcomes);
  const acc = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins, hi: (i + 1) / bins, ps: [] as number[], ys: [] as number[],
  }));
  for (const f of forecasts) {
    const y = truth.get(f.marketId);
    if (y === undefined) continue;
    const k = Math.min(bins - 1, Math.floor((f.p as number) * bins));
    acc[k]!.ps.push(f.p as number);
    acc[k]!.ys.push(y);
  }
  return acc.map((b) => ({
    lo: b.lo, hi: b.hi, n: b.ys.length,
    stated: b.ps.length ? b.ps.reduce((a, c) => a + c, 0) / b.ps.length : (b.lo + b.hi) / 2,
    observed: b.ys.length ? b.ys.reduce((a, c) => a + c, 0) / b.ys.length : null,
  }));
}

/** One person's record. */
export function userRecord(userAddr: string, all: Forecast[], outcomes: Outcome[]): Murphy {
  const mine = all.filter((f) => f.userAddr?.toLowerCase() === userAddr.toLowerCase());
  return murphy(mine, outcomes);
}

export interface HeadToHead {
  n: number;
  userBrier: number | null;
  miraBrier: number | null;
  verdict: 'ahead' | 'behind' | 'level' | 'untested';
}

/**
 * You against the agent — on the SAME markets only. Comparing a person's score
 * on the markets they chose with MIRA's score across everything would flatter
 * whoever picked the easier questions, which is not a comparison at all.
 */
export function headToHead(
  userAddr: string,
  all: Forecast[],
  miraViews: { marketId: string; pModel: number }[],
  outcomes: Outcome[],
): HeadToHead {
  const truth = resolvedYes(outcomes);
  const mira = new Map(miraViews.map((v) => [v.marketId, v.pModel]));
  const mine = all.filter((f) => f.userAddr?.toLowerCase() === userAddr.toLowerCase());

  const pairs = mine
    .map((f) => ({ p: f.p as number, m: mira.get(f.marketId), y: truth.get(f.marketId) }))
    .filter((r): r is { p: number; m: number; y: number } => r.m !== undefined && r.y !== undefined);

  if (!pairs.length) return { n: 0, userBrier: null, miraBrier: null, verdict: 'untested' };
  const userBrier = pairs.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / pairs.length;
  const miraBrier = pairs.reduce((a, r) => a + (r.m - r.y) ** 2, 0) / pairs.length;
  const d = userBrier - miraBrier;
  return {
    n: pairs.length, userBrier, miraBrier,
    verdict: Math.abs(d) < 1e-9 ? 'level' : d < 0 ? 'ahead' : 'behind',
  };
}
