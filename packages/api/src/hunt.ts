// Hunt rounds and pro-rata settlement (FR-S3, F-A5, GWT-5, WP §6, IF §11).
//
// The economy in one sentence: MIRA's positive round PnL is redistributed to
// the top-N humans by Brier score. "Losing to the machine is free education;
// beating it is paid."
//
// ── The payout rule, and why it is shaped this way ─────────────────────────
//   pot        = max(0, miraPnlUsd)          for THIS round's window only
//   eligible   = top-N by ascending Brier
//   weight_i   = (1 - brier_i) / Σ(1 - brier_j)
//   payout_i   = pot × weight_i
//
// `1 - brier` rather than `1/brier` is the important choice. Inverse-Brier
// diverges: a forecaster who scores 0.0001 would take essentially the entire
// pot, so the whole hunt would hinge on one lucky near-certain call.
// `1 - brier` is bounded in [0,1], degrades smoothly, and still pays the best
// forecaster the most. A perfect round (every brier 0) splits the pot evenly
// among the top N, which is the right answer when nobody can be separated.
//
// ── Three failure modes this guards against ────────────────────────────────
//  1. A LOSS MUST STILL SETTLE. `pot = max(0, pnl)` means a losing round pays
//     nothing and closes cleanly. A round that could not settle would jam the
//     clock and take the leaderboard down with it.
//  2. DOUBLE PAYOUT. Settling is idempotent, keyed on roundId: a retried
//     settlement returns the original result rather than paying again.
//  3. AN UNCLAIMED POT. If nobody is eligible, the pot ROLLS FORWARD rather
//     than vanishing — the money was MIRA's profit and the humans' claim on it
//     does not expire because a round happened to be quiet.
import {
  newId,
  type Bus, type Clock, type Forecast, type Ms, type Outcome, type Payout,
  type Round, type Score, type Settlement, type Usd,
} from '@arena/shared';
import { rankRound } from './brier.ts';

export interface HuntOptions {
  clock: Clock;
  bus?: Bus;
  /** Round length. */
  roundDurationMs?: number;
  /** How many humans share the pot. */
  topN?: number;
  /** Journal hook; the returned seq is recorded on the Settlement (GWT-5). */
  onSettle?: (s: Settlement) => number;
}

export interface HuntStats {
  roundsOpened: number;
  roundsSettled: number;
  totalPaidUsd: Usd;
  rolledOverUsd: Usd;
}

/** Payout weights from scores. Exported so a settlement can be re-audited. */
export function proRataWeights(scores: Score[]): { userAddr: string; brier: number; weight: number }[] {
  if (scores.length === 0) return [];
  const raw = scores.map((s) => ({ userAddr: s.userAddr, brier: s.brier, w: Math.max(0, 1 - s.brier) }));
  const total = raw.reduce((a, r) => a + r.w, 0);
  if (total <= 0) {
    // Every eligible forecaster scored a perfect 1.0 (confidently wrong on
    // everything). Splitting evenly is the only defensible answer: they are
    // all equally bad and all equally eligible.
    const even = 1 / raw.length;
    return raw.map((r) => ({ userAddr: r.userAddr, brier: r.brier, weight: even }));
  }
  return raw.map((r) => ({ userAddr: r.userAddr, brier: r.brier, weight: r.w / total }));
}

export class HuntService {
  private readonly clock: Clock;
  private readonly bus: Bus | undefined;
  private readonly durationMs: number;
  private readonly topN: number;
  private readonly onSettle: ((s: Settlement) => number) | undefined;

  private current: Round | null = null;
  private index = 0;
  private rollover: Usd = 0;
  private readonly settled = new Map<string, Settlement>();
  private stats: HuntStats = { roundsOpened: 0, roundsSettled: 0, totalPaidUsd: 0, rolledOverUsd: 0 };

  constructor(o: HuntOptions) {
    this.clock = o.clock;
    this.bus = o.bus;
    this.durationMs = o.roundDurationMs ?? 300_000;
    this.topN = o.topN ?? 5;
    this.onSettle = o.onSettle;
  }

  get round(): Round | null { return this.current; }
  get rolloverUsd(): Usd { return this.rollover; }
  statsSnapshot(): HuntStats { return { ...this.stats, rolledOverUsd: this.rollover }; }
  settlementFor(roundId: string): Settlement | null { return this.settled.get(roundId) ?? null; }

  /** Open a round. Any open round is closed for scoring first. */
  open(marketIds: string[]): Round {
    const now = this.clock.now();
    if (this.current && this.current.status === 'OPEN') this.closeForScoring();
    this.index += 1;
    this.stats.roundsOpened += 1;
    const round: Round = {
      roundId: newId('round', this.clock),
      index: this.index,
      openMs: now,
      closeMs: now + this.durationMs,
      status: 'OPEN',
      marketIds: [...marketIds],
      miraPnlUsd: 0,
      // A pot rolled over from a previous quiet round is visible from the
      // moment this one opens, so the UI can show what is at stake.
      potUsd: this.rollover,
      topN: this.topN,
    };
    this.current = round;
    this.bus?.publish({ t: 'round', d: round });
    return round;
  }

  /** True once the clock has passed the close time. */
  isDue(nowMs: Ms = this.clock.now()): boolean {
    return this.current !== null && this.current.status === 'OPEN' && nowMs >= this.current.closeMs;
  }

  /** OPEN -> SCORING. Forecasts submitted after this are not scored. */
  closeForScoring(miraPnlUsd?: Usd): Round | null {
    if (!this.current || this.current.status !== 'OPEN') return this.current;
    const r: Round = {
      ...this.current,
      status: 'SCORING',
      miraPnlUsd: miraPnlUsd ?? this.current.miraPnlUsd,
    };
    this.current = r;
    this.bus?.publish({ t: 'round', d: r });
    return r;
  }

  /** Record MIRA's PnL for the round window. */
  setMiraPnl(usd: Usd): void {
    if (this.current) this.current = { ...this.current, miraPnlUsd: usd };
  }

  /**
   * Settle: rank, weight, pay, journal.
   *
   * Idempotent on roundId — a retried settlement returns the original result
   * rather than paying twice.
   */
  settle(args: {
    roundId?: string;
    miraPnlUsd?: Usd;
    forecasts: Forecast[];
    outcomes: Outcome[];
  }): Settlement {
    const roundId = args.roundId ?? this.current?.roundId;
    if (!roundId) throw new Error('HuntService.settle: no round to settle');

    const prior = this.settled.get(roundId);
    if (prior) return prior;                        // idempotent (GWT-5)

    const now = this.clock.now();
    const miraPnlUsd = args.miraPnlUsd ?? this.current?.miraPnlUsd ?? 0;

    // A losing round pays nothing and still settles cleanly.
    const earned = Math.max(0, miraPnlUsd);
    const pot = earned + this.rollover;

    const scores = rankRound({ roundId, forecasts: args.forecasts, outcomes: args.outcomes });
    const eligible = scores.slice(0, this.topN);
    const weights = proRataWeights(eligible);

    let payouts: Payout[] = [];
    if (eligible.length === 0 || pot <= 0) {
      // Nobody to pay, or nothing to pay with. The pot rolls forward: the
      // humans' claim on MIRA's profit does not expire because a round was
      // quiet.
      payouts = [];
      this.rollover = pot;
      if (pot > 0) this.stats.rolledOverUsd = pot;
    } else {
      payouts = weights.map((w) => ({
        userAddr: w.userAddr,
        brier: w.brier,
        weight: w.weight,
        amountUsd: pot * w.weight,
      }));
      // Absorb float residue into the top payout so the sum is exact to 1e-9.
      // Without this, `payouts.sum() === pot` fails at the 1e-16 level and a
      // settlement that "nearly" balances is not a settlement.
      const sum = payouts.reduce((a, p) => a + p.amountUsd, 0);
      const residue = pot - sum;
      if (payouts[0] && Math.abs(residue) > 0) {
        payouts[0] = { ...payouts[0], amountUsd: payouts[0].amountUsd + residue };
      }
      this.rollover = 0;
      this.stats.totalPaidUsd += pot;
    }

    const settlement: Settlement = {
      roundId,
      miraPnlUsd,
      potUsd: pot,
      scores,
      payouts,
      method: 'BRIER_PRO_RATA',
      // Set below from the journal hook: GWT-5 requires the settlement to
      // record where it was journaled, so the payout is verifiable.
      journalSeq: 0,
      tsMs: now,
    };

    const seq = this.onSettle ? this.onSettle(settlement) : 0;
    const finalSettlement: Settlement = { ...settlement, journalSeq: seq };

    this.settled.set(roundId, finalSettlement);
    this.stats.roundsSettled += 1;
    if (this.current && this.current.roundId === roundId) {
      this.current = { ...this.current, status: 'SETTLED', miraPnlUsd, potUsd: pot };
      this.bus?.publish({ t: 'round', d: this.current });
    }
    this.bus?.publish({ t: 'settlement', d: finalSettlement });
    return finalSettlement;
  }

  /** Leaderboard for a round, whether or not it has settled. */
  leaderboard(args: { roundId?: string; forecasts: Forecast[]; outcomes: Outcome[] }): Score[] {
    const roundId = args.roundId ?? this.current?.roundId;
    if (!roundId) return [];
    return rankRound({ roundId, forecasts: args.forecasts, outcomes: args.outcomes });
  }
}
