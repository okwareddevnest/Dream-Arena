// The round lifecycle.
//
// HuntService can open, close and settle a round, but it does not decide WHEN —
// it is driven. Nothing was driving it, so no round ever opened: forecasts were
// accepted and never scored, the leaderboard stayed empty, and every user's
// scorecard reported "untested". This is the missing loop.
//
// Outcomes come from the CHAIN, never from a guess. A market that has not
// resolved scores nobody, which is why an open round simply waits.
import type { Clock, Forecast, Market, Outcome, Settlement, Usd } from '@arena/shared';
import type { HuntService } from './hunt.ts';

export interface RoundDriverOptions {
  hunt: HuntService;
  clock: Clock;
  /** Markets worth forecasting right now. */
  markets: () => Market[];
  /** Resolved outcomes, read from the venue. */
  outcomes: () => Outcome[] | Promise<Outcome[]>;
  /** Every forecast received this session. */
  forecasts: () => Forecast[];
  /** MIRA's realised PnL — the pot the humans are playing for. */
  miraPnlUsd: () => Usd;
  onSettle?: (s: Settlement) => void;
  onError?: (e: Error) => void;
  /** How many markets a round covers. */
  maxMarkets?: number;
}

export class RoundDriver {
  private readonly o: RoundDriverOptions;
  private readonly maxMarkets: number;

  constructor(o: RoundDriverOptions) {
    this.o = o;
    this.maxMarkets = o.maxMarkets ?? 6;
  }

  /**
   * Advance the lifecycle by one step. Safe to call on a timer; never throws,
   * because a settlement problem must not be able to stop the trading loop it
   * runs beside.
   */
  async tick(): Promise<void> {
    try {
      const { hunt, clock } = this.o;
      const now = clock.now();

      if (hunt.round && hunt.round.status === 'OPEN') {
        if (!hunt.isDue(now)) return;             // still running: leave it be
        const closed = hunt.closeForScoring(this.o.miraPnlUsd());
        if (!closed) return;
        const outcomes = await this.o.outcomes();
        const s = hunt.settle({
          roundId: closed.roundId,
          forecasts: this.o.forecasts().filter((f) => f.roundId === closed.roundId),
          outcomes,
        });
        if (s) this.o.onSettle?.(s);
        return;
      }

      // Nothing open. Start one, if there is anything to forecast.
      const live = this.o.markets()
        .filter((m) => m.status === 'Trading' && m.expiryMs > now)
        .sort((a, b) => a.expiryMs - b.expiryMs)
        .slice(0, this.maxMarkets);
      if (!live.length) return;                   // no markets, no round
      hunt.open(live.map((m) => m.id));
    } catch (e) {
      this.o.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Drive on an interval. Returns a stop function. */
  start(everyMs: number, setIntervalFn = setInterval, clearIntervalFn = clearInterval): () => void {
    const h = setIntervalFn(() => { void this.tick(); }, everyMs);
    return () => clearIntervalFn(h as never);
  }
}
