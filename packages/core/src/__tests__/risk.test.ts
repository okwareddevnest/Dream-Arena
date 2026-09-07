// T-024 — the risk guard is the "runaway bankroll" leg of the integrity quartet
// (WP §7) and the kill switch is GWT-7. Every rule here has a demo it saves.
import { describe, it, expect, vi } from 'vitest';
import { RiskGuard } from '../risk.ts';
import { EventBus } from '@arena/data';
import type { Fill, Order, RiskConfig } from '@arena/shared';

const risk = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  maxNetContractsPerMarket: 50, maxGrossContracts: 200, maxNotionalUsd: 250,
  maxSessionLossUsd: 100, maxOrdersPerMinute: 12, cooldownMs: 15_000,
  edgeIn: 0.06, edgeOut: 0.02, kellyFraction: 0.25, minEdgeFloor: 0.015,
  maxQuoteAgeMs: 4_000, killSwitch: false, ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  clientOrderId: 'c1', marketId: 'm1', agent: 'MIRA', side: 'YES', kind: 'BUY_YES',
  type: 'LIMIT', limitPrice: 0.5, limitPriceRaw: 500_000n, sizeContracts: 10,
  sizeRaw: 10_000_000n, expiresMs: 60_000, signalId: 's1', tsMs: 1_000, ...over,
});

const fill = (over: Partial<Fill> = {}): Fill => ({
  fillId: 'f1', clientOrderId: 'c1', venueOrderId: 'v1', marketId: 'm1', agent: 'MIRA',
  side: 'YES', sizeContracts: 10, price: 0.5, feeUsd: 0, txHash: null,
  explorerUrl: null, tsMs: 1_000, ...over,
});

const mk = (over: Partial<RiskConfig> = {}, bus?: EventBus) =>
  new RiskGuard({ risk: risk(over), agent: 'MIRA', bus });

describe('T-024 the happy path', () => {
  it('permits an order inside every limit', () => {
    expect(mk().check(order(), 1_000)).toEqual({ ok: true });
  });

  it('names the rule and gives a detail on every rejection', () => {
    const g = mk({ maxNetContractsPerMarket: 5 });
    const v = g.check(order({ sizeContracts: 10 }), 1_000);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.rule).toBe('maxNetContractsPerMarket');
      expect(v.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('T-024 position caps', () => {
  // These exercise the caps, so the post-fill cooldown (its own describe block)
  // is disabled — otherwise it denies first and the cap is never reached.
  it('blocks an order that would exceed maxNetContractsPerMarket', () => {
    const g = mk({ maxNetContractsPerMarket: 50, cooldownMs: 0 });
    g.onFill(fill({ sizeContracts: 45 }));
    const v = g.check(order({ sizeContracts: 10 }), 2_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rule).toBe('maxNetContractsPerMarket');
  });

  it('permits an order that exactly reaches the cap', () => {
    const g = mk({ maxNetContractsPerMarket: 50, cooldownMs: 0 });
    g.onFill(fill({ sizeContracts: 40 }));
    expect(g.check(order({ sizeContracts: 10 }), 2_000).ok).toBe(true);
  });

  it('permits a reducing order even when the cap is breached', () => {
    // Otherwise a position that drifts past its cap can never be closed.
    const g = mk({ maxNetContractsPerMarket: 50, cooldownMs: 0 });
    g.onFill(fill({ sizeContracts: 60 }));
    expect(g.check(order({ side: 'NO', kind: 'BUY_NO', sizeContracts: 20 }), 2_000).ok).toBe(true);
  });

  it('blocks an order that would exceed maxGrossContracts across markets', () => {
    const g = mk({ maxGrossContracts: 100, maxNetContractsPerMarket: 1e6, cooldownMs: 0 });
    g.onFill(fill({ marketId: 'm1', sizeContracts: 60 }));
    g.onFill(fill({ marketId: 'm2', sizeContracts: 35 }));
    const v = g.check(order({ marketId: 'm3', sizeContracts: 10 }), 2_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rule).toBe('maxGrossContracts');
  });

  it('blocks an order whose notional exceeds maxNotionalUsd', () => {
    const v = mk({ maxNotionalUsd: 4 }).check(order({ sizeContracts: 10, limitPrice: 0.5 }), 1_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rule).toBe('maxNotionalUsd');
  });

  it('measures a MARKET order against the worst case, not against nothing', () => {
    // A market order has no limitPrice; treating it as 0 notional would let it
    // through every notional cap.
    const v = mk({ maxNotionalUsd: 4 }).check(
      order({ type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 10 }), 1_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rule).toBe('maxNotionalUsd');
  });
});

describe('T-024 session loss (FR-X2)', () => {
  it('blocks every subsequent order once the session loss cap is breached', () => {
    const g = mk({ maxSessionLossUsd: 50 });
    g.onRealizedPnl(-60);
    const v = g.check(order(), 2_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rule).toBe('maxSessionLossUsd');
    // and it stays blocked
    expect(g.check(order({ marketId: 'm2' }), 9_999).ok).toBe(false);
  });

  it('does not block while the loss is inside the cap', () => {
    const g = mk({ maxSessionLossUsd: 50 });
    g.onRealizedPnl(-49.99);
    expect(g.check(order(), 2_000).ok).toBe(true);
  });

  it('accumulates losses across fills rather than looking at the last one', () => {
    const g = mk({ maxSessionLossUsd: 50 });
    for (let i = 0; i < 6; i++) g.onRealizedPnl(-10);
    expect(g.check(order(), 2_000).ok).toBe(false);
  });

  it('a later profit does NOT re-arm trading — the cap is a session stop', () => {
    // A stop that un-trips itself is not a stop. Recovering by trading more is
    // exactly the behaviour the rule exists to prevent.
    const g = mk({ maxSessionLossUsd: 50 });
    g.onRealizedPnl(-60);
    g.onRealizedPnl(+200);
    expect(g.check(order(), 3_000).ok).toBe(false);
  });

  it('reports the session PnL and the tripped state for the console', () => {
    const g = mk({ maxSessionLossUsd: 50 });
    g.onRealizedPnl(-60);
    expect(g.sessionPnlUsd).toBe(-60);
    expect(g.sessionLossTripped).toBe(true);
  });
});

describe('T-024 order rate limiting', () => {
  it('blocks beyond maxOrdersPerMinute inside a rolling minute', () => {
    const g = mk({ maxOrdersPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect(g.check(order({ clientOrderId: `c${i}` }), 1_000 + i).ok).toBe(true);
      g.onOrderPlaced(1_000 + i);
    }
    const v = g.check(order({ clientOrderId: 'c9' }), 1_100);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rule).toBe('maxOrdersPerMinute');
  });

  it('unblocks once the window has rolled past', () => {
    const g = mk({ maxOrdersPerMinute: 3 });
    for (let i = 0; i < 3; i++) g.onOrderPlaced(1_000 + i);
    expect(g.check(order(), 5_000).ok).toBe(false);
    expect(g.check(order(), 62_000).ok).toBe(true);
  });

  it('is a ROLLING window, not a fixed bucket', () => {
    // Both placements land near the end of the first minute. A fixed per-minute
    // bucket would reset at t=60_000 and immediately allow two more; a rolling
    // window must keep refusing until they age out individually.
    const g = mk({ maxOrdersPerMinute: 2 });
    g.onOrderPlaced(59_000);
    g.onOrderPlaced(59_500);
    expect(g.check(order(), 59_600).ok).toBe(false);
    expect(g.check(order(), 60_001).ok).toBe(false);   // a fixed bucket would allow this
    // At t=119_001 the 59_000 placement has aged out but 59_500 has not, so one
    // slot of the two is free — the window releases capacity per placement,
    // which is precisely what makes it rolling.
    expect(g.check(order(), 119_001).ok).toBe(true);
    expect(g.recentOrderCount(119_001)).toBe(1);
    expect(g.recentOrderCount(119_501)).toBe(0);
  });

  it('does not grow its memory without bound', () => {
    const g = mk({ maxOrdersPerMinute: 1_000_000 });
    for (let i = 0; i < 50_000; i++) g.onOrderPlaced(i * 1_000);
    expect(g.recentOrderCount(50_000_000)).toBeLessThan(100);
  });
});

describe('T-024 post-fill cooldown', () => {
  it('blocks new orders on a market inside its cooldown', () => {
    const g = mk({ cooldownMs: 10_000 });
    g.onFill(fill({ tsMs: 1_000 }));
    const v = g.check(order(), 5_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rule).toBe('cooldownMs');
  });

  it('permits orders on OTHER markets during a cooldown', () => {
    const g = mk({ cooldownMs: 10_000 });
    g.onFill(fill({ marketId: 'm1', tsMs: 1_000 }));
    expect(g.check(order({ marketId: 'm2' }), 5_000).ok).toBe(true);
  });

  it('permits again once the cooldown expires', () => {
    const g = mk({ cooldownMs: 10_000 });
    g.onFill(fill({ tsMs: 1_000 }));
    expect(g.check(order(), 11_001).ok).toBe(true);
  });
});

describe('T-024 the kill switch (GWT-7)', () => {
  it('blocks every order regardless of any other state', () => {
    const g = mk();
    g.kill('operator');
    for (const o of [order(), order({ marketId: 'm2', sizeContracts: 1 })]) {
      const v = g.check(o, 1_000);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.rule).toBe('killSwitch');
    }
  });

  it('is observable immediately and requires no I/O (GWT-7: < 1 s)', () => {
    const g = mk();
    const t0 = performance.now();
    g.kill('operator');
    const flipped = g.killed;
    const el = performance.now() - t0;
    expect(flipped).toBe(true);
    expect(el).toBeLessThan(1);            // sub-millisecond, not sub-second
  });

  it('blocks the very next check with no ordering subtlety', () => {
    const g = mk();
    expect(g.check(order(), 1_000).ok).toBe(true);
    g.kill('operator');
    expect(g.check(order(), 1_001).ok).toBe(false);
  });

  it('honours a kill switch set in config from the start', () => {
    expect(mk({ killSwitch: true }).check(order(), 1_000).ok).toBe(false);
  });

  it('can be released deliberately, and records who did both', () => {
    const g = mk();
    g.kill('director-console');
    expect(g.killedBy).toBe('director-console');
    g.unkill('director-console');
    expect(g.killed).toBe(false);
    expect(g.check(order(), 1_000).ok).toBe(true);
  });

  it('publishes a kill event so the badge and journal see it', () => {
    const bus = new EventBus();
    const seen: { on: boolean; by: string }[] = [];
    bus.on('kill', (d) => { seen.push({ on: d.on, by: d.by }); });
    const g = mk({}, bus);
    g.kill('operator');
    g.unkill('operator');
    expect(seen).toEqual([{ on: true, by: 'operator' }, { on: false, by: 'operator' }]);
  });

  it('takes precedence over every other rule, including a permitted order', () => {
    const g = mk({ maxNetContractsPerMarket: 1e9, maxNotionalUsd: 1e9, maxOrdersPerMinute: 1e9 });
    g.kill('operator');
    const v = g.check(order({ sizeContracts: 1 }), 1_000);
    if (!v.ok) expect(v.rule).toBe('killSwitch');
  });
});

describe('T-024 bus reporting', () => {
  it('publishes a risk event for every rejection', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('risk', (d) => { if (!d.verdict.ok) seen.push(d.verdict.rule); });
    const g = mk({ maxNotionalUsd: 1 }, bus);
    g.check(order(), 1_000);
    expect(seen).toEqual(['maxNotionalUsd']);
  });

  it('does not spam the bus with a risk event for every permitted order', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('risk', fn);
    const g = mk({}, bus);
    for (let i = 0; i < 100; i++) g.check(order(), 1_000 + i);
    expect(fn).not.toHaveBeenCalled();
  });

  it('works without a bus at all (the guard is never optional)', () => {
    expect(() => mk().check(order(), 1_000)).not.toThrow();
  });
});

describe('T-024 hygiene', () => {
  it('checks 100 000 orders in under 50 ms (ARCH §4: risk < 2 ms)', () => {
    const g = mk({ maxOrdersPerMinute: 1e9 });
    const o = order();
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) g.check(o, 1_000 + i);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('exposes a snapshot for the health endpoint', () => {
    const g = mk();
    g.onFill(fill({ sizeContracts: 10 }));
    g.onRealizedPnl(-5);
    const s = g.snapshot(2_000);
    expect(s.killSwitch).toBe(false);
    expect(s.sessionPnlUsd).toBe(-5);
    expect(s.grossContracts).toBe(10);
    expect(s.netByMarket['m1']).toBe(10);
  });

  it('reset clears position, PnL and rate state but NOT a kill switch', () => {
    // Resetting must never silently re-arm trading after an operator halt.
    const g = mk();
    g.onFill(fill()); g.onRealizedPnl(-10); g.kill('operator');
    g.reset();
    expect(g.sessionPnlUsd).toBe(0);
    expect(g.snapshot(1_000).grossContracts).toBe(0);
    expect(g.killed).toBe(true);
  });
});
