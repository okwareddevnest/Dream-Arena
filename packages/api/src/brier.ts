// Brier scoring and the leaderboard (FR-S3, WP §6, IF §11).
//
// The Brier score is `(p - o)²` — the squared error of a probabilistic forecast
// against a binary outcome. Lower is better; 0 is perfect, 1 is confidently
// wrong, and 0.25 is what you get for shrugging and saying 0.5. It is the right
// scoring rule here for one specific reason: it is STRICTLY PROPER, meaning a
// forecaster maximises their expected score only by reporting their true
// belief. Nothing about the leaderboard rewards hedging or extremity, which is
// what makes the captured forecasts worth anything as a dataset (WP §3.4).
//
// ── Two decisions that shape the ranking ───────────────────────────────────
//
//  1. UNRESOLVED MARKETS ARE EXCLUDED, not scored as anything. A pending market
//     has no outcome, so any score for it would be invented. This is why
//     `nForecasts` counts RESOLVED forecasts rather than submitted ones.
//
//  2. A USER WITH ZERO RESOLVED FORECASTS IS EXCLUDED, not scored 0. Scoring
//     them 0 would rank someone who never forecast anything above every human
//     who actually played — and 0 is the PERFECT score, so the leaderboard
//     would be topped by the least engaged participant. They are simply absent.
import type { Forecast, Outcome, Prob, Score } from '@arena/shared';

/** The Brier score of one forecast against one outcome. */
export function brierScore(p: Prob, outcome: 0 | 1): number {
  return (p - outcome) ** 2;
}

/** The score a forecaster gets for declining to have an opinion. Useful as a
 *  reference line on the leaderboard: beating 0.25 means beating a coin flip. */
export const UNINFORMED_BRIER = 0.25;

export interface ScoreInput {
  roundId: string;
  forecasts: Forecast[];
  outcomes: Outcome[];
}

/**
 * Rank forecasters for one round.
 *
 * Ties break on the EARLIEST forecast, which is deliberate and not arbitrary:
 * two people with identical accuracy are separated by who committed first, and
 * rewarding the earlier commitment is the behaviour the arena wants (a
 * forecast made late, closer to resolution, is worth less). It also makes the
 * ranking deterministic, which the settlement test requires.
 */
export function rankRound(input: ScoreInput): Score[] {
  const resolved = new Map<string, 0 | 1>();
  for (const o of input.outcomes) {
    if (o.roundId !== input.roundId) continue;
    if (!o.resolved || o.outcome === null) continue;
    resolved.set(o.marketId, o.outcome);
  }

  interface Acc { sum: number; n: number; earliestMs: number }
  const byUser = new Map<string, Acc>();

  for (const f of input.forecasts) {
    if (f.roundId !== input.roundId) continue;
    const outcome = resolved.get(f.marketId);
    if (outcome === undefined) continue;              // unresolved: excluded
    if (!Number.isFinite(f.p) || f.p < 0 || f.p > 1) continue;   // not a probability
    const a = byUser.get(f.userAddr) ?? { sum: 0, n: 0, earliestMs: Number.POSITIVE_INFINITY };
    a.sum += brierScore(f.p, outcome);
    a.n += 1;
    a.earliestMs = Math.min(a.earliestMs, f.tsMs);
    byUser.set(f.userAddr, a);
  }

  const rows = [...byUser.entries()]
    // A user with no resolved forecasts never entered the map, so this is
    // belt-and-braces rather than the mechanism.
    .filter(([, a]) => a.n > 0)
    .map(([userAddr, a]) => ({
      userAddr,
      roundId: input.roundId,
      brier: a.sum / a.n,
      nForecasts: a.n,
      earliestMs: a.earliestMs,
    }))
    .sort((x, y) => (x.brier !== y.brier ? x.brier - y.brier : x.earliestMs - y.earliestMs));

  return rows.map((r, i): Score => ({
    userAddr: r.userAddr,
    roundId: r.roundId,
    brier: r.brier,
    nForecasts: r.nForecasts,
    rank: i + 1,
  }));
}

/**
 * Only the forecasts a round can actually score, for display and for auditing
 * a settlement after the fact.
 */
export function scorableForecasts(input: ScoreInput): Forecast[] {
  const resolved = new Set(
    input.outcomes
      .filter((o) => o.roundId === input.roundId && o.resolved && o.outcome !== null)
      .map((o) => o.marketId),
  );
  return input.forecasts.filter((f) => f.roundId === input.roundId && resolved.has(f.marketId));
}

/** How many distinct humans a round can rank. Drives "no eligible forecasters". */
export function eligibleCount(input: ScoreInput): number {
  return rankRound(input).length;
}
