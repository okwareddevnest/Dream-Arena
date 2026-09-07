// ECHO — the adversarial market maker (F-A4, WP §5).
//
// ── Why this exists, in one measurement ─────────────────────────────────────
// T-S4 probed the live testnet venue and found 584 binary markets, 9 of them
// active, and `tradeCount: 0` on every single one. There is no organic
// counterparty. So without ECHO the tape is empty — not occasionally, not under
// bad luck, but always, on LIVE and on SIM alike.
//
// That makes ECHO load-bearing three times over:
//   • the demo has something to show (PRD §10 R3),
//   • MIRA has someone to trade against, so integration testing has a
//     counterparty instead of a stub,
//   • and the arena's claim that "agent activity IS liquidity" (WP §3) is
//     literally true rather than aspirational.
//
// ── Two constraints from the real venue ─────────────────────────────────────
// 1. SELF-MATCHING IS BLOCKED (RFC-001 A7). ECHO must sign with a key that is
//    not MIRA's, or the two never trade with each other and the tape stays
//    empty in a new and more confusing way. Enforced at construction.
// 2. SELLING REQUIRES INVENTORY (RFC-001 A6). A two-sided quote needs both
//    outcome tokens, so ECHO mints a pair before it can offer the sell side.
//
// ── Strategy ────────────────────────────────────────────────────────────────
// Post-only quotes either side of a fair probability, skewed to unwind
// inventory as it accumulates. Post-only matters: a crossing maker eats its own
// resting quote and manufactures fake volume, which would make the tape a lie.
import {
  newClientOrderId, kindFor,
  type AgentId, type Bus, type Clock, type Fill, type Market, type Ms, type Order,
  type Quote, type RiskConfig, type Side, type Venue,
} from '@arena/shared';
import { RiskGuard } from './risk.ts';

export interface EchoOptions {
  venue: Venue;
  bus: Bus;
  clock: Clock;
  risk: RiskConfig;
  /** Half-spread in probability units, either side of fair. */
  spread?: number;
  /** Contracts per side per quote. */
  quoteSize?: number;
  /** Requote cadence. */
  refreshMs?: number;
  /** Net inventory past which it quotes only the unwinding side. */
  maxInventory?: number;
  /** MIRA's signer, so the self-matching check can fail loudly at construction. */
  peerKey?: string | null;
  ownKey?: string | null;
}

export interface EchoStats {
  cycles: number;
  quotesPlaced: number;
  quotesRejected: number;
  mints: number;
  cancels: number;
  skewedCycles: number;
  fills: number;
}

export class EchoAgent {
  readonly agent: AgentId = 'ECHO';
  private readonly venue: Venue;
  private readonly bus: Bus;
  private readonly clock: Clock;
  private readonly guard: RiskGuard;
  private readonly spread: number;
  private readonly quoteSize: number;
  private readonly refreshMs: number;
  private readonly maxInventory: number;

  private lastCycleMs = -Infinity;
  private readonly net = new Map<string, number>();
  private readonly minted = new Set<string>();
  private readonly openIds = new Map<string, string[]>();
  private stats: EchoStats = {
    cycles: 0, quotesPlaced: 0, quotesRejected: 0, mints: 0,
    cancels: 0, skewedCycles: 0, fills: 0,
  };
  private offFill: (() => void) | null = null;

  constructor(o: EchoOptions) {
    // RFC-001 A7. Checked here rather than at first order because the failure
    // is silent: two agents on one key simply never fill each other, and the
    // symptom is an empty tape with no error anywhere.
    if (o.ownKey && o.peerKey && o.ownKey === o.peerKey) {
      throw new Error(
        'EchoAgent: ECHO and MIRA share a signing key. The venue blocks self-matching, ' +
        'so the two agents would never trade with each other and the tape would stay empty. ' +
        'Set ECHO_PRIVATE_KEY to a different funded key (RFC-001 A7).',
      );
    }
    if (o.venue.agent === 'MIRA') {
      throw new Error(
        `EchoAgent: was handed MIRA's venue instance. ECHO needs its own Venue bound to its ` +
        `own signer (RFC-001 A7).`,
      );
    }
    this.venue = o.venue;
    this.bus = o.bus;
    this.clock = o.clock;
    this.spread = o.spread ?? 0.02;
    this.quoteSize = o.quoteSize ?? 5;
    this.refreshMs = o.refreshMs ?? 10_000;
    this.maxInventory = o.maxInventory ?? 20;
    this.guard = new RiskGuard({ risk: o.risk, agent: 'ECHO', bus: o.bus });
  }

  get riskGuard(): RiskGuard { return this.guard; }
  statsSnapshot(): EchoStats { return { ...this.stats }; }
  net_(marketId: string): number { return this.net.get(marketId) ?? 0; }

  async start(): Promise<void> {
    this.offFill = this.venue.onFill((f) => this.onFill(f));
  }

  async stop(): Promise<void> {
    this.offFill?.();
    this.offFill = null;
  }

  onFill(f: Fill): void {
    if (f.agent !== this.agent) return;
    this.stats.fills++;
    this.guard.onFill(f);
    const signed = f.side === 'YES' ? f.sizeContracts : -f.sizeContracts;
    this.net.set(f.marketId, (this.net.get(f.marketId) ?? 0) + signed);
  }

  /** True when the requote cadence has elapsed. */
  due(nowMs: Ms = this.clock.now()): boolean {
    return nowMs - this.lastCycleMs >= this.refreshMs;
  }

  /**
   * One quoting cycle over the given markets.
   *
   * Cancels its previous quotes first: leaving them would stack stale prices on
   * the book with escrow locked, which is the decision bot-kit gotcha 4 warns
   * about ("an unfilled limit remainder rests with escrow locked, invisibly").
   */
  async cycle(markets: Market[], fair: (m: Market) => number | null, force = false): Promise<void> {
    const now = this.clock.now();
    if (!force && !this.due(now)) return;
    this.lastCycleMs = now;
    this.stats.cycles++;

    if (this.guard.killed) {
      await this.cancelAll();
      return;
    }

    for (const mk of markets) {
      if (mk.status !== 'Trading') continue;
      const p = fair(mk);
      if (p === null || !(p > 0) || !(p < 1)) continue;
      await this.requote(mk, p, now);
    }
  }

  private async requote(mk: Market, fair: number, nowMs: Ms): Promise<void> {
    await this.cancelFor(mk.id);

    const inv = this.net.get(mk.id) ?? 0;
    const half = this.maxInventory / 2;

    // Inventory skew. Past half the cap ECHO quotes ONLY the side that reduces
    // its position: a maker that keeps quoting both sides while accumulating
    // one of them is just a slow way to breach its own inventory limit.
    let sides: Side[] = ['YES', 'NO'];
    if (inv > half) { sides = ['NO']; this.stats.skewedCycles++; }
    else if (inv < -half) { sides = ['YES']; this.stats.skewedCycles++; }

    for (const side of sides) {
      // Quoting a BUY of `side` means resting a bid on that outcome. A YES bid
      // sits below fair; a NO bid sits below (1 - fair).
      const base = side === 'YES' ? fair : 1 - fair;
      const price = base - this.spread / 2;
      if (!(price > 0) || !(price < 1)) continue;

      // RFC-001 A6: to also OFFER the outcome later, ECHO needs inventory.
      // Minting once per market gives it both tokens to work with.
      if (!this.minted.has(mk.id)) {
        const ack = await this.venue.mintPair(mk.id, this.quoteSize * 4).catch(() => null);
        if (ack && ack.status !== 'REJECTED') { this.minted.add(mk.id); this.stats.mints++; }
      }

      const order = this.buildQuote(mk, side, price, nowMs);
      const verdict = this.guard.check(order, nowMs);
      if (!verdict.ok) continue;

      try {
        const ack = await this.venue.placeOrder(order);
        this.bus.publish({ t: 'order', d: order });
        this.bus.publish({ t: 'ack', d: ack });
        if (ack.status === 'REJECTED') {
          this.stats.quotesRejected++;
        } else {
          this.stats.quotesPlaced++;
          this.guard.onOrderPlaced(nowMs);
          const ids = this.openIds.get(mk.id) ?? [];
          ids.push(order.clientOrderId);
          this.openIds.set(mk.id, ids);
        }
      } catch (e) {
        this.stats.quotesRejected++;
        this.bus.publish({
          t: 'error',
          d: { where: 'echo.placeOrder', msg: e instanceof Error ? e.message : String(e), tsMs: nowMs },
        });
      }
    }
  }

  private buildQuote(mk: Market, side: Side, price: number, nowMs: Ms): Order {
    const scale = 10 ** mk.priceDecimals;
    const raw = (BigInt(Math.round(price * scale)) / mk.tickRaw) * mk.tickRaw;
    return {
      clientOrderId: newClientOrderId(this.agent, this.clock),
      marketId: mk.id,
      agent: this.agent,
      side,
      kind: kindFor(side, 'BUY'),
      // POST_ONLY: a maker that crosses eats its own quote and manufactures
      // fake volume, which would make the tape a lie rather than thin.
      type: 'POST_ONLY',
      limitPrice: Number(raw) / scale,
      limitPriceRaw: raw,
      sizeContracts: this.quoteSize,
      sizeRaw: BigInt(Math.round(this.quoteSize * scale)),
      // Just past the requote interval, so a crashed maker's quotes age off the
      // book by themselves (bot-kit gotcha 5).
      expiresMs: Math.min(mk.expiryMs, nowMs + this.refreshMs * 2),
      signalId: null,
      tsMs: nowMs,
    };
  }

  private async cancelFor(marketId: string): Promise<void> {
    const ids = this.openIds.get(marketId);
    if (!ids || ids.length === 0) return;
    for (const id of ids) {
      try { await this.venue.cancel(id); this.stats.cancels++; } catch { /* stale id is fine */ }
    }
    this.openIds.set(marketId, []);
  }

  async cancelAll(): Promise<void> {
    try {
      const acks = await this.venue.cancelAll(this.agent);
      this.stats.cancels += acks.length;
    } catch { /* halting must never throw */ }
    this.openIds.clear();
  }

  /** A fair probability derived from the book itself, for when no model is
   *  available. Falls back to the mid, then to 0.5. */
  static fairFromQuote(q: Quote | null): number | null {
    if (!q) return null;
    if (q.mid > 0 && q.mid < 1) return q.mid;
    return null;
  }
}
