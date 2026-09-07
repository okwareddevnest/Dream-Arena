// Risk guard and kill switch (FR-X2; GWT-7). The "runaway bankroll" leg of the
// integrity quartet (WP §7).
//
// Design rules, all of them learned from what goes wrong on camera:
//
//   • The kill switch is checked FIRST and is a plain boolean field. No async,
//     no network, no venue round-trip. GWT-7 gives it one second; this gives it
//     a nanosecond, because the one thing an operator must be able to rely on
//     is that the halt does not depend on the thing that is misbehaving.
//   • The session-loss stop does NOT un-trip. A stop that re-arms itself after
//     a winning trade is not a stop — trading out of a drawdown is precisely
//     the behaviour the rule exists to prevent.
//   • REDUCING orders are always allowed through the position caps. Otherwise a
//     position that drifts past its cap (a reconciler adopting a larger chain
//     position, say) could never be closed.
//   • Rejections publish; approvals do not. The bus carries the tick path, and
//     a risk event per permitted order would be tens of thousands of events an
//     hour saying "fine".
import type {
  AgentId, Bus, Fill, Ms, Order, RiskConfig, RiskVerdict, Usd,
} from '@arena/shared';

export interface RiskGuardOptions {
  risk: RiskConfig;
  agent: AgentId;
  bus?: Bus;
}

export interface RiskSnapshot {
  killSwitch: boolean;
  killedBy: string | null;
  sessionPnlUsd: Usd;
  sessionLossTripped: boolean;
  grossContracts: number;
  netByMarket: Record<string, number>;
  ordersLastMinute: number;
}

const ROLLING_WINDOW_MS = 60_000;

/** A permitted order costs nothing to represent; share one frozen object. */
const OK: RiskVerdict = Object.freeze({ ok: true });

export class RiskGuard {
  private readonly cfg: RiskConfig;
  private readonly agent: AgentId;
  private readonly bus: Bus | undefined;

  private killSwitch: boolean;
  private killer: string | null = null;
  private pnl: Usd = 0;
  private lossTripped = false;
  private readonly net = new Map<string, number>();
  private readonly lastFillMs = new Map<string, Ms>();
  /** Timestamps of recent placements, pruned to the rolling window. */
  private placements: Ms[] = [];

  constructor(opts: RiskGuardOptions) {
    this.cfg = opts.risk;
    this.agent = opts.agent;
    this.bus = opts.bus;
    this.killSwitch = opts.risk.killSwitch;
    if (this.killSwitch) this.killer = 'config';
  }

  // ── Kill switch (GWT-7) ──────────────────────────────────────────────────
  get killed(): boolean { return this.killSwitch; }
  get killedBy(): string | null { return this.killer; }

  kill(by: string): void {
    this.killSwitch = true;
    this.killer = by;
    this.bus?.publish({ t: 'kill', d: { on: true, by, tsMs: Date.now() } });
  }

  /** Deliberate release. Never called by `reset` — see the note there. */
  unkill(by: string): void {
    this.killSwitch = false;
    this.killer = by;
    this.bus?.publish({ t: 'kill', d: { on: false, by, tsMs: Date.now() } });
  }

  // ── State the guard needs to do its job ──────────────────────────────────
  get sessionPnlUsd(): Usd { return this.pnl; }
  get sessionLossTripped(): boolean { return this.lossTripped; }

  /** Fold in realized PnL. Once the session cap is breached it stays breached. */
  onRealizedPnl(deltaUsd: Usd): void {
    this.pnl += deltaUsd;
    if (this.pnl <= -Math.abs(this.cfg.maxSessionLossUsd)) this.lossTripped = true;
  }

  onFill(f: Fill): void {
    const signed = f.side === 'YES' ? f.sizeContracts : -f.sizeContracts;
    this.net.set(f.marketId, (this.net.get(f.marketId) ?? 0) + signed);
    this.lastFillMs.set(f.marketId, f.tsMs);
  }

  onOrderPlaced(tsMs: Ms): void {
    this.placements.push(tsMs);
    this.prune(tsMs);
  }

  recentOrderCount(nowMs: Ms): number {
    this.prune(nowMs);
    return this.placements.length;
  }

  /**
   * May this order be placed? Rules are ordered cheapest-and-most-decisive
   * first, so a killed agent never touches the position maps.
   */
  check(o: Order, nowMs: Ms): RiskVerdict {
    // 1. Kill switch — before everything, and independent of everything.
    if (this.killSwitch) {
      return this.deny('killSwitch', `trading halted by ${this.killer ?? 'operator'}`, nowMs);
    }

    // 2. Session stop.
    if (this.lossTripped) {
      return this.deny('maxSessionLossUsd',
        `session loss ${this.pnl.toFixed(2)} breached the ${this.cfg.maxSessionLossUsd} cap; ` +
        `the stop does not re-arm`, nowMs);
    }

    // 3. Post-fill cooldown on this market.
    const last = this.lastFillMs.get(o.marketId);
    if (last !== undefined && nowMs - last < this.cfg.cooldownMs) {
      return this.deny('cooldownMs',
        `market ${o.marketId} filled ${nowMs - last} ms ago, inside the ${this.cfg.cooldownMs} ms cooldown`, nowMs);
    }

    // 4. Rolling-window order rate.
    this.prune(nowMs);
    if (this.placements.length >= this.cfg.maxOrdersPerMinute) {
      return this.deny('maxOrdersPerMinute',
        `${this.placements.length} orders in the last 60 s, cap ${this.cfg.maxOrdersPerMinute}`, nowMs);
    }

    // 5. Notional. A MARKET order has no limit price, so it is measured against
    //    the worst case — a price of 1.0. Treating a null price as zero
    //    notional would let market orders through every notional cap.
    const worstPrice = o.limitPrice ?? 1;
    const notional = o.sizeContracts * worstPrice;
    if (notional > this.cfg.maxNotionalUsd) {
      return this.deny('maxNotionalUsd',
        `notional $${notional.toFixed(2)} exceeds the $${this.cfg.maxNotionalUsd} cap`, nowMs);
    }

    // 6. Position caps. A reducing order is always allowed: the caps exist to
    //    stop exposure growing, not to trap it.
    const signedNow = this.net.get(o.marketId) ?? 0;
    const delta = o.side === 'YES' ? o.sizeContracts : -o.sizeContracts;
    const signedAfter = signedNow + delta;
    const reducing = Math.abs(signedAfter) < Math.abs(signedNow);

    if (!reducing) {
      if (Math.abs(signedAfter) > this.cfg.maxNetContractsPerMarket) {
        return this.deny('maxNetContractsPerMarket',
          `net would become ${signedAfter} in ${o.marketId}, cap ${this.cfg.maxNetContractsPerMarket}`, nowMs);
      }
      let gross = 0;
      for (const [id, n] of this.net) gross += id === o.marketId ? Math.abs(signedAfter) : Math.abs(n);
      if (!this.net.has(o.marketId)) gross += Math.abs(signedAfter);
      if (gross > this.cfg.maxGrossContracts) {
        return this.deny('maxGrossContracts',
          `gross would become ${gross}, cap ${this.cfg.maxGrossContracts}`, nowMs);
      }
    }

    return OK;
  }

  snapshot(nowMs: Ms): RiskSnapshot {
    let gross = 0;
    for (const n of this.net.values()) gross += Math.abs(n);
    return {
      killSwitch: this.killSwitch,
      killedBy: this.killer,
      sessionPnlUsd: this.pnl,
      sessionLossTripped: this.lossTripped,
      grossContracts: gross,
      netByMarket: Object.fromEntries(this.net),
      ordersLastMinute: this.recentOrderCount(nowMs),
    };
  }

  /**
   * Clear accounting state (positions, PnL, rate window) — used by the
   * reconciler after adopting chain state, and between SIM runs.
   *
   * Deliberately does NOT clear the kill switch. An operator halt must survive
   * every internal reset, or some unrelated code path could silently re-arm
   * trading after a halt that was pressed for a reason.
   */
  reset(): void {
    this.pnl = 0;
    this.lossTripped = false;
    this.net.clear();
    this.lastFillMs.clear();
    this.placements = [];
  }

  private prune(nowMs: Ms): void {
    const cutoff = nowMs - ROLLING_WINDOW_MS;
    // Placements are appended in time order, so drop from the front.
    let i = 0;
    while (i < this.placements.length && this.placements[i]! <= cutoff) i++;
    if (i > 0) this.placements = this.placements.slice(i);
  }

  private deny(rule: string, detail: string, nowMs: Ms): RiskVerdict {
    const verdict: RiskVerdict = { ok: false, rule, detail };
    this.bus?.publish({ t: 'risk', d: { verdict, agent: this.agent, tsMs: nowMs } });
    return verdict;
  }
}
