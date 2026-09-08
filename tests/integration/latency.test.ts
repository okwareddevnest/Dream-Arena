// Latency budget (T-071 · PRD §8 · F-A1).
//
// The number that matters is the DECISION path: tick in, order out. The
// architecture budgets it at p99 < 3 ms, and the reason it can hold is that the
// journal, the persona and the broadcaster are all off the hot path — nothing
// on the decision path awaits I/O.
import { describe, it, expect } from 'vitest';
import { VirtualClock, loadConfig } from '@arena/shared';
import { EventBus } from '@arena/data';
import { Engine, Persona } from '@arena/core';
import { SimulatedVenue } from '@arena/venue';

const ENV = {
  VENUE_MODE: 'SIM', SPOT_FEED: 'fixture', EDGE_IN: '0.06', EDGE_OUT: '0.02',
  MIN_EDGE_FLOOR: '0.015', KELLY_FRACTION: '0.25', MAX_ORDERS_PER_MINUTE: '6000',
  COOLDOWN_MS: '0', EWMV_MIN_OBS: '2', EWMV_SEED_VOL: '2.0',
};
const cfg = loadConfig(ENV as never);

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

describe('decision latency', () => {
  it('holds p99 under 3 ms across a long run, with the commentary lane attached', async () => {
    const clock = new VirtualClock();
    const bus = new EventBus();
    const venue = new SimulatedVenue({
      agent: 'MIRA', clock, spread: 0.0005,
      markets: Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`, asset: 'BTC', strike: 100, mode: 'fixed' as const,
        fairProb: 0.5, expiryMs: clock.now() + 86_400_000,
      })),
    });
    await venue.connect();
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: cfg.risk, vol: cfg.vol,
      balance: () => 100_000, quoteCacheMs: 0, marketsCacheMs: 0,
    });
    // The persona subscribes to the same bus: this proves it costs the decision
    // path nothing, which is the F-A9 requirement.
    const persona = new Persona({ bus, clock });
    persona.subscribe(bus);

    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const p = 100 + Math.sin(i / 3) * 0.4;
      venue.setSpot('BTC', p);
      clock.advance(1_000);
      const t0 = performance.now();
      await engine.onTick('BTC', p, clock.now());
      samples.push(performance.now() - t0);
    }

    const p50 = quantile(samples, 0.5);
    const p99 = quantile(samples, 0.99);
    console.log(`  decision latency over ${samples.length} ticks, 10 markets: p50 ${p50.toFixed(3)}ms · p99 ${p99.toFixed(3)}ms`);
    expect(p99, 'p99 decision latency').toBeLessThan(3);
    expect(engine.statsSnapshot().valuations).toBeGreaterThan(0);
  });

  it('a stalled quip generator cannot slow a decision (F-A9)', async () => {
    const clock = new VirtualClock();
    const bus = new EventBus();
    const venue = new SimulatedVenue({
      agent: 'MIRA', clock, spread: 0.0005,
      markets: [{ id: 'm1', asset: 'BTC', strike: 100, mode: 'fixed', fairProb: 0.5, expiryMs: clock.now() + 86_400_000 }],
    });
    await venue.connect();
    const engine = new Engine({
      agent: 'MIRA', venue, bus, clock, risk: cfg.risk, vol: cfg.vol,
      balance: () => 1_000, quoteCacheMs: 0, marketsCacheMs: 0,
    });
    // A generator that never returns. The cache is the default, not the fallback.
    const persona = new Persona({
      bus, clock, generator: () => new Promise<string>(() => { /* never resolves */ }),
    });
    persona.subscribe(bus);

    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const p = 100 + Math.sin(i / 3) * 0.4;
      venue.setSpot('BTC', p);
      clock.advance(1_000);
      const t0 = performance.now();
      await engine.onTick('BTC', p, clock.now());
      samples.push(performance.now() - t0);
    }
    expect(quantile(samples, 0.99), 'a hung generator adds nothing').toBeLessThan(3);
  });
});
