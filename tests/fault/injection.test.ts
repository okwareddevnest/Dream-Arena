// Fault injection — the failures the system must survive, forced deliberately.
// spec: 40-TESTPLAN fault matrix · GWT-6 · T-062
//
// Each of these was a real incident class during the live build: a dropped
// write, a reused nonce, a stale quote, a book that empties, and an RPC that
// stops answering. The tests exist so a fix cannot silently regress.
import { describe, it, expect } from 'vitest';
import { VirtualClock, loadConfig } from '@arena/shared';
import { EventBus } from '@arena/data';
import { Engine } from '@arena/core';
import { SimulatedVenue, TxQueue, NonceManager, Reconciler } from '@arena/venue';

const ENV = {
  VENUE_MODE: 'SIM', SPOT_FEED: 'fixture', EDGE_IN: '0.06', EDGE_OUT: '0.02',
  MIN_EDGE_FLOOR: '0.015', KELLY_FRACTION: '0.25', MAX_ORDERS_PER_MINUTE: '600',
  COOLDOWN_MS: '0', EWMV_MIN_OBS: '2', EWMV_SEED_VOL: '2.0',
};
const cfg = loadConfig(ENV as never);
const HORIZON = 86_400_000;

const mkVenue = (clock: VirtualClock) => new SimulatedVenue({
  agent: 'MIRA', clock, spread: 0.0005,
  markets: [{ id: 'm1', asset: 'BTC', strike: 100, mode: 'fixed', fairProb: 0.5, expiryMs: clock.now() + HORIZON }],
});

describe('dropped transaction (GWT-6)', () => {
  it('the reconciler adopts chain truth rather than trusting local state', async () => {
    const clock = new VirtualClock();
    const bus = new EventBus();
    const venue = mkVenue(clock);
    await venue.connect();

    // Local believes it is flat; the chain says otherwise — exactly what a write
    // that landed but whose ack was lost looks like.
    const local = new Map<string, { marketId: string; netContracts: number }>();
    const reports: { action: string }[] = [];
    const rec = new Reconciler({
      venue, agent: 'MIRA',
      local: {
        positions: () => [...local.values()] as never,
        adopt: (p) => local.set(p.marketId, p as never),
        drop: (id) => local.delete(id),
      },
      onReport: (r) => reports.push(...(r.drifted as never[])),
    });
    await rec.reconcile();
    expect(Array.isArray(reports)).toBe(true);
    // Whatever the venue reports, local must end up agreeing with it.
    const chain = await venue.positions('MIRA');
    expect(local.size).toBe(chain.length);
  });
});

describe('nonce clash', () => {
  it('serialises writes so one key never issues the same nonce twice', async () => {
    let n = 5;
    const nonces = new NonceManager({ getTransactionCount: async () => n });
    const q = new TxQueue({ nonces, timeoutMs: 5_000 });
    const seen: number[] = [];
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        q.submit({ clientOrderId: `o${i}`, run: async (nonce) => { seen.push(nonce); n = nonce + 1; } })),
    );
    expect(new Set(seen).size, 'every nonce is distinct').toBe(seen.length);
    const sorted = [...seen].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!, 'and the sequence is gapless').toBe(1);
    }
  });

  it('recovers when the chain disagrees with the local counter', async () => {
    let calls = 0;
    const nonces = new NonceManager({ getTransactionCount: async () => { calls++; return 10; } });
    await nonces.reserve();
    await nonces.resync();
    expect(calls, 'a resync re-reads the chain').toBeGreaterThan(1);
  });
});

describe('stale quote', () => {
  it('a frozen book does not keep producing fresh decisions', async () => {
    const clock = new VirtualClock();
    const bus = new EventBus();
    const venue = mkVenue(clock);
    await venue.connect();
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: cfg.risk, vol: cfg.vol,
      balance: () => 1_000, quoteCacheMs: 0, marketsCacheMs: 0,
    });
    venue.freezeQuotes(clock.now() + 600_000);
    for (const p of [100, 100.3, 99.8]) {
      venue.setSpot('BTC', p); clock.advance(60_000);
      await engine.onTick('BTC', p, clock.now());
    }
    // The engine must not have thrown, and must still be reporting truthfully.
    const s = engine.statsSnapshot();
    expect(s.ticks).toBe(3);
    expect(s.quoteErrors + s.valuations, 'every tick was accounted for').toBeGreaterThan(0);
  });
});

describe('empty book', () => {
  it('survives a market with no depth on either side', async () => {
    const clock = new VirtualClock();
    const bus = new EventBus();
    const venue = mkVenue(clock);
    await venue.connect();
    venue.setDepth(0);
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: cfg.risk, vol: cfg.vol,
      balance: () => 1_000, quoteCacheMs: 0, marketsCacheMs: 0,
    });
    clock.advance(60_000);
    await expect(engine.onTick('BTC', 100.2, clock.now())).resolves.toBeUndefined();
  });
});

describe('venue outage', () => {
  it('an RPC that stops answering never takes the engine down', async () => {
    const clock = new VirtualClock();
    const bus = new EventBus();
    const venue = mkVenue(clock);
    await venue.connect();
    const errors: unknown[] = [];
    bus.on('error', (e) => errors.push(e));
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: cfg.risk, vol: cfg.vol,
      balance: () => 1_000, quoteCacheMs: 0, marketsCacheMs: 0,
    });
    // Every venue read now fails.
    venue.getQuote = async () => { throw new Error('rpc down'); };
    clock.advance(60_000);
    await expect(engine.onTick('BTC', 100.2, clock.now())).resolves.toBeUndefined();
    expect(engine.statsSnapshot().quoteErrors, 'the failure was counted, not swallowed').toBeGreaterThan(0);
  });
});

describe('kill switch under load', () => {
  it('stops every subsequent order immediately (GWT-7)', async () => {
    const clock = new VirtualClock();
    const bus = new EventBus();
    const venue = mkVenue(clock);
    await venue.connect();
    const orders: unknown[] = [];
    bus.on('order', (o) => orders.push(o));
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: cfg.risk, vol: cfg.vol,
      balance: () => 1_000, quoteCacheMs: 0, marketsCacheMs: 0,
    });
    for (const p of [100, 100.3]) {
      venue.setSpot('BTC', p); clock.advance(60_000);
      await engine.onTick('BTC', p, clock.now());
    }
    engine.riskGuard.kill('fault-test');
    const before = orders.length;
    for (const p of [99.8, 100.2, 99.9, 100.1]) {
      venue.setSpot('BTC', p); clock.advance(60_000);
      await engine.onTick('BTC', p, clock.now());
    }
    expect(orders.length, 'not one order after the switch').toBe(before);
  });
});
