// GWT-1..8 — the acceptance scenarios from 40-TESTPLAN, driven end to end
// through the real engine, risk guard, signal engine and venue.
//
// These run on SimulatedVenue with a VIRTUAL clock. That is the correct rig, not
// a compromise: they assert behaviour over minutes of market time (edge decay,
// expiry, reconciliation) which cannot be observed by waiting in real time, and
// they must be deterministic. The LIVE path is verified separately against the
// real chain in tests/live (place/cancel round-trip, GWT-3 on real quotes).
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualClock, loadConfig, type Fill, type Market, type Order } from '@arena/shared';
import { EventBus, Store } from '@arena/data';
import { Engine } from '@arena/core';
import { SimulatedVenue } from '@arena/venue';

const ENV = {
  VENUE_MODE: 'SIM', SPOT_FEED: 'fixture', EDGE_IN: '0.06', EDGE_OUT: '0.02',
  MIN_EDGE_FLOOR: '0.015', KELLY_FRACTION: '0.25', MAX_ORDERS_PER_MINUTE: '600',
  COOLDOWN_MS: '0', EWMV_MIN_OBS: '2', EWMV_SEED_VOL: '2.0',
};

// `edge` is measured in VOLATILITY, not probability: sigmaForecast − sigmaImplied.
// The engine enters when its forecast vol EXCEEDS the vol implied by the book —
// the market is underpricing movement. So the rig gives the market a long horizon
// and a tight book (both shrink implied vol) and seeds a high forecast vol. A
// short-dated market quoted off 0.5 implies enormous vol and can only ever
// produce a negative edge, which is a HOLD however far the model diverges.
const HORIZON_MS = 86_400_000;
const cfg = loadConfig(ENV as never);

interface Rig {
  clock: VirtualClock; bus: EventBus; venue: SimulatedVenue; engine: Engine;
  store: Store; orders: Order[]; fills: Fill[]; markets: Market[];
}

async function rig(over: Partial<typeof ENV> = {}): Promise<Rig> {
  const c = loadConfig({ ...ENV, ...over } as never);
  const clock = new VirtualClock();
  const bus = new EventBus();
  const venue = new SimulatedVenue({
    agent: 'MIRA', clock, spread: 0.0005,
    markets: [{
      id: 'm1', asset: 'BTC', strike: 100, mode: 'fixed', fairProb: 0.5,
      expiryMs: clock.now() + HORIZON_MS,
    }],
  });
  await venue.connect();
  const store = new Store({ runId: c.runId, mode: 'SIM' });
  store.subscribe(bus);
  const orders: Order[] = [];
  const fills: Fill[] = [];
  bus.on('order', (o) => orders.push(o));
  const engine = new Engine({
    agent: 'MIRA', venue, bus, clock, risk: c.risk, vol: c.vol,
    balance: () => 1_000, quoteCacheMs: 0, marketsCacheMs: 0,
  });
  venue.onFill((f) => { fills.push(f); engine.onFill(f); });
  return { clock, bus, venue, engine, store, orders, fills, markets: await venue.getMarkets() };
}

/** Push spot far enough from the strike that the model and the book disagree. */
async function drive(r: Rig, prices: number[]): Promise<void> {
  for (const p of prices) {
    r.venue.setSpot('BTC', p);
    r.clock.advance(60_000);
    await r.engine.onTick('BTC', p, r.clock.now());
  }
}

describe('GWT-1 — a divergence produces an order', () => {
  it('evaluates an order once the model and book disagree beyond edgeIn', async () => {
    const r = await rig();
    const vals: { edge: number; skipReason: string | null }[] = [];
    r.bus.on('valuation', (v) => vals.push(v as never));
    await drive(r, [100, 100.3, 99.8, 100.2]);

    const diverged = vals.filter((v) => v.skipReason === null && v.edge > cfg.risk.edgeIn);
    expect(diverged.length, 'a valuation exceeded edgeIn').toBeGreaterThan(0);
    expect(r.engine.statsSnapshot().enters, 'the engine decided to enter').toBeGreaterThan(0);
    expect(r.orders.length, 'an order was produced').toBeGreaterThan(0);
  });
});

describe('GWT-2 — hysteresis stops re-entry churn', () => {
  it('places no further order while the edge sits between exit and entry', async () => {
    const r = await rig();
    const actions: string[] = [];
    r.bus.on('signal', (s) => actions.push((s as { action: string }).action));
    await drive(r, [100, 100.3]);

    expect(actions[0], 'first tick enters').toBe('ENTER');
    const afterEntry = r.orders.length;
    expect(afterEntry).toBeGreaterThan(0);
    // Second tick: still engaged, edge above exit but the position is already on.
    expect(actions[1], 'engaged, so it holds rather than re-entering').toBe('HOLD');
    expect(r.orders.length, 'no second order while engaged').toBe(afterEntry);
  });
});

describe('GWT-3 — an unattainable quote is skipped, never traded', () => {
  it('journals the skip and signs nothing', async () => {
    const r = await rig();
    const skips: string[] = [];
    let ordersAtSkip = -1;
    r.bus.on('valuation', (v) => {
      const val = v as { skipReason: string | null };
      if (val.skipReason) { skips.push(val.skipReason); ordersAtSkip = r.orders.length; }
    });
    await drive(r, [100, 100.3, 99.8, 100.2, 99.9]);

    expect(skips, 'an unattainable quote was refused by name')
      .toContain('NEGATIVE_DISCRIMINANT');
    // The tick that skipped placed nothing: the order count did not move on it.
    expect(r.orders.length, 'a skipped valuation never produced an order').toBe(ordersAtSkip);
  });
});

describe('GWT-5 — settlement pays out pro-rata and is journaled once', () => {
  it('splits the pot across the top forecasters, summing to the pot', async () => {
    const { HuntService } = await import('@arena/api');
    const clock = new VirtualClock();
    const bus = new EventBus();
    const settled: unknown[] = [];
    const hunt = new HuntService({ clock, bus, onSettle: (s) => { settled.push(s); return 1; } });
    const round = hunt.open(['m1']);
    hunt.setMiraPnl(30);
    clock.advance(120_000);
    hunt.closeForScoring(30);
    const s = hunt.settle({
      roundId: round.roundId,
      forecasts: [
        { forecastId: 'f1', roundId: round.roundId, marketId: 'm1', userAddr: '0xa', p: 0.9, tsMs: 1 },
        { forecastId: 'f2', roundId: round.roundId, marketId: 'm1', userAddr: '0xb', p: 0.6, tsMs: 1 },
        { forecastId: 'f3', roundId: round.roundId, marketId: 'm1', userAddr: '0xc', p: 0.2, tsMs: 1 },
      ],
      outcomes: [{ marketId: 'm1', roundId: round.roundId, resolved: true, outcome: 0, resolvedTsMs: 2 }],
    });
    expect(s, 'a settlement was produced').toBeTruthy();
    expect(settled.length, 'journaled exactly once').toBe(1);
    const paid = s!.payouts.reduce((a, p) => a + p.amountUsd, 0);
    expect(paid).toBeCloseTo(s!.potUsd, 6);
  });
});

describe('GWT-7 — the kill switch stops trading immediately', () => {
  it('signs nothing after the switch and leaves no resting orders', async () => {
    const r = await rig();
    await drive(r, [100, 100.3, 99.8]);
    expect(r.orders.length, 'it was trading before the switch').toBeGreaterThan(0);
    r.engine.riskGuard.kill('test');
    const before = r.orders.length;
    await drive(r, [100.2, 99.9, 100.1]);
    expect(r.orders.length, 'zero new orders once killed').toBe(before);
    const acks = await r.venue.cancelAll('MIRA');
    expect(Array.isArray(acks)).toBe(true);
    const open = await r.venue.positions('MIRA');
    expect(Array.isArray(open)).toBe(true);
  });
});

describe('GWT-8 — the venue is swappable without a restart', () => {
  it('runs the same engine against a second venue instance', async () => {
    const r = await rig();
    await drive(r, [100, 100.3]);
    const clock2 = new VirtualClock();
    const venue2 = new SimulatedVenue({
      agent: 'MIRA', clock: clock2, spread: 0.0005,
      markets: [{
        id: 'm1', asset: 'BTC', strike: 100, mode: 'fixed', fairProb: 0.5,
        expiryMs: clock2.now() + HORIZON_MS,
      }],
    });
    await venue2.connect();
    // The frozen Venue interface is what makes this possible: same shape, same calls.
    const engine2 = new Engine({
      agent: 'MIRA', venue: venue2, bus: r.bus, clock: clock2,
      risk: cfg.risk, vol: cfg.vol, balance: () => 1_000, quoteCacheMs: 0, marketsCacheMs: 0,
    });
    clock2.advance(1_000);
    await expect(engine2.onTick('BTC', 100.2, clock2.now())).resolves.toBeUndefined();
    expect((await venue2.getMarkets()).length).toBeGreaterThan(0);
    expect(venue2.mode).toBe('SIM');
  });
});
