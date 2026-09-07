// T-025 — the MIRA engine (F-A2, ARCH §3; GWT-1, GWT-2, GWT-3).
// This is where every prior card meets the others, so the assertions are about
// ORDERING, ISOLATION and LATENCY rather than about arithmetic.
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock, type BusEvent, type Order, type RiskConfig } from '@arena/shared';
import { EventBus } from '@arena/data';
import { SimulatedVenue, NonceManager, TxQueue } from '@arena/venue';
import { Engine } from '../engine.ts';

const risk = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  maxNetContractsPerMarket: 500, maxGrossContracts: 2_000, maxNotionalUsd: 5_000,
  maxSessionLossUsd: 1_000, maxOrdersPerMinute: 1_000, cooldownMs: 0,
  edgeIn: 0.06, edgeOut: 0.02, kellyFraction: 0.25, minEdgeFloor: 0.015,
  maxQuoteAgeMs: 4_000, killSwitch: false, ...over,
});

/**
 * A rig with one BTC market carrying a POSITIVE volatility edge.
 *
 * Getting this right took a measurement. An at-the-money market is useless
 * here: with tau ~ 1.9e-5 years, sigma*sqrt(tau) is tiny, so prices cluster
 * hard around 0.5 and a price of 0.30 on an ATM 10-minute binary implies
 * sigma_implied = 242 (24 200 % annualized). The edge is then -241 and MIRA
 * correctly stands aside, because it only trades UNDERpriced volatility.
 *
 * A tradable edge needs a slightly out-of-the-money strike, where the price
 * carries real volatility information: strike 79 100 against a spot of 79 000
 * at a fair price of 0.40 gives sigma_implied = 0.72 against a forecast of
 * 1.41, i.e. edge = +0.70.
 */
const rig = async (over: {
  risk?: Partial<RiskConfig>;
  fairProb?: number;
  seedVol?: number;
  depth?: number;
  latencyMs?: number;
  markets?: ConstructorParameters<typeof SimulatedVenue>[0]['markets'];
} = {}) => {
  const clock = new VirtualClock(0);
  const bus = new EventBus();
  const venue = new SimulatedVenue({
    clock, agent: 'MIRA', depth: over.depth ?? 200, spread: 0.02,
    latencyMs: over.latencyMs ?? 0, balanceUsd: 10_000,
    markets: over.markets ?? [{
      id: 'btc-60', asset: 'BTC', strike: 79_100, intervalSec: 60,
      expiryMs: 600_000, fairProb: over.fairProb ?? 0.40,
    }],
  });
  await venue.connect();
  const engine = new Engine({
    agent: 'MIRA', venue, bus, clock, risk: risk(over.risk),
    vol: { lambda: 0.94, minObs: 2, seedVol: over.seedVol ?? 1.5 },
    quoteCacheMs: 0, marketsCacheMs: 0,
  });
  await engine.start();
  return { clock, bus, venue, engine };
};

/** Drive N ticks of a rising price so the model has volatility and an edge. */
const drive = async (
  engine: Engine, clock: VirtualClock, n: number, opts: { step?: number; dt?: number } = {},
) => {
  const step = opts.step ?? 0.0004;
  const dt = opts.dt ?? 500;
  let p = 79_000;
  for (let i = 0; i < n; i++) {
    p *= 1 + (i % 2 === 0 ? step : -step * 0.8);
    clock.advance(dt);
    await engine.onTick('BTC', p, clock.now());
  }
};

describe('T-025 the pipeline runs in order', () => {
  it('publishes model, valuation, signal, order, ack in that order', async () => {
    const { engine, clock, bus } = await rig();
    const seen: BusEvent['t'][] = [];
    bus.onAny((e) => { if (e.t !== 'risk' && e.t !== 'error') seen.push(e.t); });
    await drive(engine, clock, 12);
    const idx = (t: string) => seen.indexOf(t as BusEvent['t']);
    expect(idx('model')).toBeGreaterThanOrEqual(0);
    expect(idx('valuation')).toBeGreaterThan(idx('model'));
    expect(idx('signal')).toBeGreaterThan(idx('valuation'));
    if (idx('order') >= 0) {
      expect(idx('order')).toBeGreaterThan(idx('signal'));
      expect(idx('ack')).toBeGreaterThan(idx('order'));
    }
  });

  it('produces exactly one valuation per open market per tick', async () => {
    const { engine, clock, bus } = await rig({
      markets: [
        { id: 'a', asset: 'BTC', strike: 79_100, intervalSec: 60, expiryMs: 600_000, fairProb: 0.4 },
        { id: 'b', asset: 'BTC', strike: 79_200, intervalSec: 60, expiryMs: 600_000, fairProb: 0.4 },
      ],
    });
    let vals = 0;
    bus.on('valuation', () => { vals++; });
    await drive(engine, clock, 5);
    expect(vals).toBe(10);                       // 2 markets x 5 ticks
  });

  it('ignores markets for a different underlying', async () => {
    const { engine, clock, bus } = await rig({
      markets: [
        { id: 'btc', asset: 'BTC', strike: 79_100, intervalSec: 60, expiryMs: 600_000, fairProb: 0.4 },
        { id: 'eth', asset: 'ETH', strike: 2_505, intervalSec: 60, expiryMs: 600_000, fairProb: 0.4 },
      ],
    });
    const ids: string[] = [];
    bus.on('valuation', (v) => { ids.push(v.marketId); });
    await drive(engine, clock, 3);
    expect(new Set(ids)).toEqual(new Set(['btc']));
  });

  it('keeps one volatility model per underlying, not per market', async () => {
    const { engine, clock } = await rig({
      markets: [
        { id: 'a', asset: 'BTC', strike: 79_100, intervalSec: 60, expiryMs: 600_000 },
        { id: 'b', asset: 'BTC', strike: 79_200, intervalSec: 60, expiryMs: 600_000 },
      ],
    });
    await drive(engine, clock, 6);
    expect(engine.models()).toHaveLength(1);
    expect(engine.models()[0]!.nObs).toBe(5);    // every return, not half of them
  });
});

describe('T-025 GWT-1: divergence produces exactly one order', () => {
  it('places one order with a fresh clientOrderId on an ENTER', async () => {
    const { engine, clock, venue } = await rig({ risk: { cooldownMs: 0 } });
    const placed: Order[] = [];
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 20);
    for (const c of spy.mock.calls) placed.push(c[0] as Order);
    expect(placed.length).toBeGreaterThan(0);
    expect(new Set(placed.map((o) => o.clientOrderId)).size).toBe(placed.length);
    for (const o of placed) {
      expect(o.agent).toBe('MIRA');
      expect(o.signalId).not.toBeNull();
      expect(o.expiresMs).toBeGreaterThan(o.tsMs);
      expect(o.limitPriceRaw).not.toBeNull();
    }
  });

  it('reports enters in its stats', async () => {
    const { engine, clock } = await rig();
    await drive(engine, clock, 20);
    expect(engine.statsSnapshot().ordersPlaced).toBeGreaterThan(0);
  });
});

describe('T-025 GWT-3: a skipped valuation never becomes an order', () => {
  it('places zero orders when every market is reference-mode with no boundary', async () => {
    const { engine, clock, venue } = await rig({
      markets: [{
        id: 'ref', asset: 'BTC', strike: null, mode: 'reference',
        intervalSec: 300, expiryMs: 600_000, fairProb: 0.4,
      }],
    });
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 20);
    expect(spy).not.toHaveBeenCalled();
    expect(engine.statsSnapshot().skips).toBeGreaterThan(0);
  });

  it('places zero orders while quotes are frozen stale', async () => {
    const { engine, clock, venue } = await rig();
    venue.freezeQuotes(600_000);
    clock.advance(10_000);
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 20);
    expect(spy).not.toHaveBeenCalled();
  });

  it('places zero orders on a market that is not Trading', async () => {
    const { engine, clock, venue } = await rig({
      markets: [{
        id: 'later', asset: 'BTC', strike: 79_100, intervalSec: 900,
        tradingStartMs: 3_600_000, expiryMs: 4_500_000, fairProb: 0.4,
      }],
    });
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 20);
    expect(spy).not.toHaveBeenCalled();
  });

  it('places zero orders when the book has no depth', async () => {
    const { engine, clock, venue } = await rig();
    venue.setDepth(0);
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 20);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('T-025 GWT-2: no order spam', () => {
  it('does not re-enter a market while it stays engaged', async () => {
    const { engine, clock, venue } = await rig({ risk: { cooldownMs: 0 } });
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 200, { step: 0.0004 });
    // 200 ticks with a persistent edge must not be 200 orders. Hysteresis
    // latches after the first, so orders come only from fresh crossings.
    expect(spy.mock.calls.length).toBeLessThan(40);
  });

  it('respects the post-fill cooldown', async () => {
    const { engine, clock, venue } = await rig({ risk: { cooldownMs: 30_000 } });
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 40, { dt: 500 });      // 20 s of virtual time
    const withCooldown = spy.mock.calls.length;
    expect(withCooldown).toBeLessThanOrEqual(2);
  });
});

describe('T-025 the risk gate is the last word', () => {
  it('places zero orders once the kill switch is set (GWT-7)', async () => {
    const { engine, clock, venue } = await rig();
    engine.riskGuard.kill('test');
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 30);
    expect(spy).not.toHaveBeenCalled();
    expect(engine.statsSnapshot().vetoes).toBeGreaterThan(0);
  });

  it('publishes a risk event when it vetoes', async () => {
    const { engine, clock, bus } = await rig();
    const rules: string[] = [];
    bus.on('risk', (d) => { if (!d.verdict.ok) rules.push(d.verdict.rule); });
    engine.riskGuard.kill('test');
    await drive(engine, clock, 10);
    expect(rules).toContain('killSwitch');
  });

  it('stops trading after the session loss cap trips', async () => {
    const { engine, clock, venue } = await rig({ risk: { maxSessionLossUsd: 5 } });
    engine.onRealizedPnl(-10);
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 30);
    expect(spy).not.toHaveBeenCalled();
  });

  it('panic kills and cancels every open order in one call', async () => {
    const { engine, clock, venue } = await rig();
    await drive(engine, clock, 20);
    const cancelAll = vi.spyOn(venue, 'cancelAll');
    await engine.panic('director');
    expect(engine.riskGuard.killed).toBe(true);
    expect(cancelAll).toHaveBeenCalledWith('MIRA');
  });

  it('panic does not throw even if the venue cancel fails', async () => {
    const { engine, venue } = await rig();
    vi.spyOn(venue, 'cancelAll').mockRejectedValue(new Error('rpc down'));
    await expect(engine.panic('director')).resolves.toBeUndefined();
    expect(engine.riskGuard.killed).toBe(true);
  });
});

describe('T-025 isolation from non-essential components', () => {
  it('places an order even when the journal hook throws', async () => {
    // The property that separates "full disk" from "outage".
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const venue = new SimulatedVenue({
      clock, agent: 'MIRA', depth: 200, balanceUsd: 10_000,
      markets: [{ id: 'btc-60', asset: 'BTC', strike: 79_100, intervalSec: 60,
        expiryMs: 600_000, fairProb: 0.40 }],
    });
    await venue.connect();
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: risk(),
      vol: { lambda: 0.94, minObs: 2, seedVol: 1.5 },
      quoteCacheMs: 0, marketsCacheMs: 0,
      onJournal: () => { throw new Error('disk full'); },
    });
    await engine.start();
    const spy = vi.spyOn(venue, 'placeOrder');
    await drive(engine, clock, 20);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it('keeps running when a bus subscriber throws', async () => {
    const { engine, clock, bus, venue } = await rig();
    bus.on('valuation', () => { throw new Error('bad subscriber'); });
    const spy = vi.spyOn(venue, 'placeOrder');
    await expect(drive(engine, clock, 20)).resolves.toBeUndefined();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it('survives a getQuote rejection and reports it', async () => {
    const { engine, clock, bus, venue } = await rig();
    const errs: string[] = [];
    bus.on('error', (d) => { errs.push(d.where); });
    vi.spyOn(venue, 'getQuote').mockRejectedValue(new Error('indexer timeout'));
    await expect(drive(engine, clock, 5)).resolves.toBeUndefined();
    expect(errs).toContain('engine.getQuote');
    expect(engine.statsSnapshot().quoteErrors).toBeGreaterThan(0);
  });

  it('survives a getMarkets rejection by keeping the previous list', async () => {
    const { engine, clock, bus, venue } = await rig();
    await drive(engine, clock, 3);                    // populate the cache
    const errs: string[] = [];
    bus.on('error', (d) => { errs.push(d.where); });
    vi.spyOn(venue, 'getMarkets').mockRejectedValue(new Error('indexer down'));
    let vals = 0;
    bus.on('valuation', () => { vals++; });
    await drive(engine, clock, 3);
    expect(errs).toContain('engine.getMarkets');
    expect(vals).toBeGreaterThan(0);                  // still evaluating
  });

  it('survives a placeOrder rejection and reports it', async () => {
    const { engine, clock, bus, venue } = await rig();
    const errs: string[] = [];
    bus.on('error', (d) => { errs.push(d.where); });
    vi.spyOn(venue, 'placeOrder').mockRejectedValue(new Error('reverted'));
    await expect(drive(engine, clock, 20)).resolves.toBeUndefined();
    expect(errs).toContain('engine.place');
    expect(engine.statsSnapshot().orderErrors).toBeGreaterThan(0);
  });
});

describe('T-025 caching honours the measured limits (T-S4)', () => {
  it('does not call getMarkets on every tick when a cache window is set', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const venue = new SimulatedVenue({
      clock, agent: 'MIRA', depth: 200,
      markets: [{ id: 'btc-60', asset: 'BTC', strike: 79_100, intervalSec: 60, expiryMs: 600_000 }],
    });
    await venue.connect();
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: risk(),
      vol: { lambda: 0.94, minObs: 2, seedVol: 1.5 },
      marketsCacheMs: 15_000, quoteCacheMs: 1_500,
    });
    await engine.start();
    const spy = vi.spyOn(venue, 'getMarkets');
    await drive(engine, clock, 20, { dt: 500 });       // 10 s of virtual time
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('reuses a cached quote inside its window', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const venue = new SimulatedVenue({
      clock, agent: 'MIRA', depth: 200,
      markets: [{ id: 'btc-60', asset: 'BTC', strike: 79_100, intervalSec: 60, expiryMs: 600_000 }],
    });
    await venue.connect();
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: risk(),
      vol: { lambda: 0.94, minObs: 2, seedVol: 1.5 },
      marketsCacheMs: 15_000, quoteCacheMs: 1_500,
    });
    await engine.start();
    const spy = vi.spyOn(venue, 'getQuote');
    await drive(engine, clock, 6, { dt: 200 });        // 1.2 s of virtual time
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('T-025 integration with the tx queue (T-033)', () => {
  it('routes every order through the queue, deduped and serialized', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const venue = new SimulatedVenue({
      clock, agent: 'MIRA', depth: 200, balanceUsd: 10_000,
      markets: [{ id: 'btc-60', asset: 'BTC', strike: 79_100, intervalSec: 60,
        expiryMs: 600_000, fairProb: 0.4 }],
    });
    await venue.connect();
    const nonces = new NonceManager({ getTransactionCount: async () => 0 });
    const queue = new TxQueue({ nonces, timeoutMs: 0 });
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: risk(),
      vol: { lambda: 0.94, minObs: 2, seedVol: 1.5 },
      quoteCacheMs: 0, marketsCacheMs: 0, submitter: queue,
    });
    await engine.start();
    await drive(engine, clock, 20);
    await queue.drain();
    const s = queue.statsSnapshot();
    expect(s.submitted).toBeGreaterThan(0);
    expect(s.submitted).toBe(engine.statsSnapshot().ordersPlaced);
    expect(s.completed).toBe(s.submitted);
  });
});

describe('T-025 latency (ARCH §4: decision path < 3 ms p99)', () => {
  it('decides in well under 3 ms at p99 over 10 000 ticks', async () => {
    const { engine, clock } = await rig({ risk: { cooldownMs: 0 } });
    const samples: number[] = [];
    let p = 79_000;
    for (let i = 0; i < 10_000; i++) {
      p *= 1 + (i % 2 === 0 ? 0.0002 : -0.00016);
      clock.advance(100);
      const t0 = performance.now();
      await engine.onTick('BTC', p, clock.now());
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)]!;
    expect(p99).toBeLessThan(3);
  });
});

describe('T-025 position tracking', () => {
  it('folds venue fills into net position, cooldown and the risk guard', async () => {
    const { engine, clock } = await rig({ risk: { cooldownMs: 0 } });
    await drive(engine, clock, 20);
    expect(Math.abs(engine.net('btc-60'))).toBeGreaterThan(0);
    expect(engine.riskGuard.snapshot(clock.now()).grossContracts).toBeGreaterThan(0);
  });

  it('lets the reconciler overwrite its belief (T-035)', async () => {
    const { engine, clock } = await rig();
    await drive(engine, clock, 20);
    engine.adoptNet('btc-60', 3);
    expect(engine.net('btc-60')).toBe(3);
    engine.dropNet('btc-60');
    expect(engine.net('btc-60')).toBe(0);
  });

  it('exposes pModel for the gauge, or null when the market is unpriceable', async () => {
    const { engine, clock } = await rig();
    await drive(engine, clock, 10);
    const p = engine.pModelFor(
      { ...(await (await rig()).venue.getMarkets())[0]! }, clock.now());
    expect(p === null || (p >= 0 && p <= 1)).toBe(true);
  });
});
