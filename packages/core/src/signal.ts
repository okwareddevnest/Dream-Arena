// Edge signal with hysteresis (FR-E3, FR-E4; GWT-1, GWT-2, GWT-3).
//
// This component answers WHETHER to act, never HOW MUCH — sizing is the sizer's
// job (T-023) and permission is the risk guard's (T-024). Keeping the three
// separate is what makes each one testable in isolation.
//
// ── Why hysteresis exists ──────────────────────────────────────────────────
// The engine re-evaluates every market on every tick. A single threshold would
// therefore fire an order on every tick that edge spent above it — hundreds per
// minute, all the same trade, each paying fees. So entry and exit use DIFFERENT
// thresholds (edgeIn > edgeOut) and a per-market latch:
//
//        edge >  edgeIn , disengaged  -> ENTER      (and latch)
//        edge >= edgeOut, engaged     -> HOLD       (already in; do nothing)
//        edge <  edgeOut, engaged     -> STAND_DOWN (unlatch)
//        edge <= edgeIn , disengaged  -> HOLD       (waiting for a crossing)
//
// The band between edgeOut and edgeIn is dead space: inside it nothing happens,
// whichever direction you arrived from. GWT-2 is exactly this property, and the
// no-spam test drives a thousand oscillations through the band to prove it.
//
// ── Direction ──────────────────────────────────────────────────────────────
// The side comes from `pModel` vs `pMarket`, NOT from the sign of the edge.
// This matters: in the money, higher volatility LOWERS the probability of
// finishing above the strike, so a positive volatility edge there is a NO
// signal. Deriving the side from the edge's sign would invert those trades.
//
// ── Scope, stated plainly ──────────────────────────────────────────────────
// Only `edge > edgeIn` opens a position, so MIRA is long volatility only: it
// trades when it believes the market UNDERprices vol, and stands aside when it
// believes vol is overpriced. That is WP §4 and card T-022 as written, and it
// has a bounded worst case. A symmetric version would also trade `edge < -edgeIn`
// (selling vol); it is not implemented because it is not specified.
import {
  newId,
  type AgentId, type HysteresisState, type Ms, type RiskConfig,
  type Side, type Signal, type SignalAction, type Valuation,
} from '@arena/shared';

export interface SignalEngineOptions {
  agent: AgentId;
  risk: RiskConfig;
}

interface Latch { engaged: boolean; lastActionTsMs: Ms; cooldownUntilMs: Ms }

export class SignalEngine {
  private readonly agent: AgentId;
  private readonly risk: RiskConfig;
  private readonly latches = new Map<string, Latch>();

  constructor(opts: SignalEngineOptions) {
    this.agent = opts.agent;
    this.risk = opts.risk;
    if (!(opts.risk.edgeIn > opts.risk.edgeOut)) {
      throw new RangeError(
        `SignalEngine: edgeIn (${opts.risk.edgeIn}) must exceed edgeOut (${opts.risk.edgeOut}) — ` +
        `equal thresholds are not hysteresis and the agent would spam orders.`,
      );
    }
  }

  isEngaged(marketId: string): boolean {
    return this.latches.get(marketId)?.engaged ?? false;
  }

  state(marketId: string): HysteresisState {
    const l = this.latches.get(marketId);
    return {
      marketId,
      engaged: l?.engaged ?? false,
      lastActionTsMs: l?.lastActionTsMs ?? 0,
      cooldownUntilMs: l?.cooldownUntilMs ?? 0,
    };
  }

  /**
   * Start the post-fill cooldown for a market.
   *
   * Called by the engine when a fill arrives. Cooldown deliberately keys on
   * fills rather than on ENTER decisions: an order that is placed and never
   * fills has cost nothing and must not lock the market out, while an order
   * that DID fill has moved our inventory and deserves a pause before adding
   * more. The risk guard (T-024) enforces the same window authoritatively.
   */
  noteFill(marketId: string, nowMs: Ms): void {
    const l = this.latches.get(marketId) ?? { engaged: false, lastActionTsMs: nowMs, cooldownUntilMs: 0 };
    this.latches.set(marketId, { ...l, cooldownUntilMs: nowMs + this.risk.cooldownMs });
  }

  reset(): void { this.latches.clear(); }

  /** Decide what to do about one valuation. Pure with respect to everything
   *  except this engine's own latch state. */
  evaluate(v: Valuation, nowMs: Ms): Signal {
    const latch = this.latches.get(v.marketId) ?? { engaged: false, lastActionTsMs: 0, cooldownUntilMs: 0 };
    const { edgeIn, edgeOut, minEdgeFloor } = this.risk;

    // ── 1. A skipped valuation is not a signal at any edge. ──
    // A null implied vol means F2 could not price the quote; the reported edge
    // is meaningless. Unlatching here matters: a market that goes stale while
    // engaged must not stay latched, or it would re-enter the instant a quote
    // returns without a fresh edgeIn crossing.
    if (v.skipReason !== null || v.sigmaImplied === null) {
      const reason = v.skipReason ?? 'DEGENERATE';
      this.latches.set(v.marketId, { ...latch, engaged: false, lastActionTsMs: nowMs });
      return this.signal(v, 'SKIP', null, nowMs, `skipped: ${reason}`);
    }

    // ── 2. Engaged: decide whether to stay in or stand down. ──
    if (latch.engaged) {
      if (v.edge < edgeOut) {
        this.latches.set(v.marketId, { engaged: false, lastActionTsMs: nowMs, cooldownUntilMs: latch.cooldownUntilMs });
        return this.signal(v, 'STAND_DOWN', null, nowMs,
          `edge ${v.edge.toFixed(4)} fell below edgeOut ${edgeOut}`);
      }
      return this.signal(v, 'HOLD', this.sideOf(v), nowMs,
        `engaged, edge ${v.edge.toFixed(4)} still above edgeOut ${edgeOut}`);
    }

    // ── 3. Disengaged: the only path to an order. ──
    if (v.edge <= edgeIn) {
      return this.signal(v, 'HOLD', null, nowMs,
        `edge ${v.edge.toFixed(4)} below entry threshold edgeIn ${edgeIn}`);
    }
    if (v.edge < minEdgeFloor) {
      // Below the floor the expected edge does not clear fees + spread + noise,
      // so the trade is negative-expectancy however confident the model is.
      return this.signal(v, 'HOLD', null, nowMs,
        `edge ${v.edge.toFixed(4)} below minEdgeFloor ${minEdgeFloor} (fees + spread + noise)`);
    }
    // Cooldown is keyed on FILLS, not on decisions (see `noteFill`). Suppressing
    // the signal here is a courtesy that keeps the tape and the journal quiet;
    // the risk guard (T-024) is the authoritative gate.
    if (nowMs < latch.cooldownUntilMs) {
      return this.signal(v, 'HOLD', null, nowMs,
        `cooldown active until ${latch.cooldownUntilMs} (last fill)`);
    }
    const side = this.sideOf(v);
    if (side === null) {
      return this.signal(v, 'HOLD', null, nowMs,
        'no directional view: pModel equals pMarket');
    }

    // Latching is all that happens here. The cooldown clock starts on a FILL,
    // not on a decision: an order that never fills must not lock the market out.
    this.latches.set(v.marketId, {
      engaged: true, lastActionTsMs: nowMs, cooldownUntilMs: latch.cooldownUntilMs,
    });
    return this.signal(v, 'ENTER', side, nowMs,
      `edge ${v.edge.toFixed(4)} above edgeIn ${edgeIn}; ${side}`);
  }

  /** Direction from the probabilities, not the edge sign (see the header note). */
  private sideOf(v: Valuation): Side | null {
    if (v.pModel > v.pMarket) return 'YES';
    if (v.pModel < v.pMarket) return 'NO';
    return null;
  }

  private signal(v: Valuation, action: SignalAction, side: Side | null, nowMs: Ms, reason: string): Signal {
    return {
      id: newId('sig'),
      marketId: v.marketId,
      agent: this.agent,
      action,
      side: action === 'ENTER' || action === 'HOLD' ? side : null,
      edge: v.skipReason !== null ? 0 : v.edge,
      pModel: v.pModel,
      pMarket: v.pMarket,
      sizeContracts: 0,          // the sizer fills this in (T-023)
      kellyFull: 0,
      kellyApplied: 0,
      reason,
      valuation: v,
      tsMs: nowMs,
    };
  }
}
