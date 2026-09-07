// T-012 — spot ingester (FR-D1). A bad tick is worse than no tick: it poisons
// the EWMV recurrence permanently, so most of these assertions are about what
// the ingester REFUSES to pass on.
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock, type Tick } from '@arena/shared';
import { EventBus } from '../bus.ts';
import {
  Ingester, binanceSource, fixtureSource, gbmFixture, somniaFeedSource, type SpotSource,
} from '../ingester.ts';

const src = (name: 'fixture' | 'somnia-feed' = 'fixture', read?: SpotSource['read']): SpotSource => ({
  name,
  read: read ?? (async () => ({ price: 79_000, tsMs: 1 })),
});

const mk = (over: Partial<ConstructorParameters<typeof Ingester>[0]> = {}) => {
  const bus = new EventBus();
  const clock = new VirtualClock(0);
  const ticks: Tick[] = [];
  bus.on('tick', (t) => ticks.push(t));
  const ing = new Ingester({ bus, clock, source: src(), symbols: ['BTC'], pollMs: 500, ...over });
  return { bus, clock, ticks, ing };
};

describe('T-012 monotonic sequencing', () => {
  it('assigns strictly increasing seq numbers', () => {
    const { ing, ticks } = mk();
    for (let i = 1; i <= 100; i++) ing.ingest('BTC', 79_000 + i, i);
    expect(ticks.map((t) => t.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it('stamps the source name onto every tick', () => {
    const { ing, ticks } = mk({ source: src('somnia-feed') });
    ing.ingest('BTC', 79_000, 1);
    expect(ticks[0]!.source).toBe('somnia-feed');
  });

  it('keeps seq monotonic across several symbols', () => {
    const { ing, ticks } = mk({ symbols: ['BTC', 'ETH'] });
    ing.ingest('BTC', 79_000, 1);
    ing.ingest('ETH', 2_500, 1);
    ing.ingest('BTC', 79_100, 2);
    expect(ticks.map((t) => t.seq)).toEqual([1, 2, 3]);
  });
});

describe('T-012 rejecting bad observations', () => {
  it('drops a non-positive price (ln would be -Infinity or NaN)', () => {
    const { ing, ticks } = mk();
    expect(ing.ingest('BTC', 0, 1)).toBeNull();
    expect(ing.ingest('BTC', -5, 2)).toBeNull();
    expect(ticks).toHaveLength(0);
    expect(ing.statsSnapshot().malformed).toBe(2);
  });

  it('drops a NaN or Infinite price', () => {
    const { ing, ticks } = mk();
    expect(ing.ingest('BTC', Number.NaN, 1)).toBeNull();
    expect(ing.ingest('BTC', Infinity, 2)).toBeNull();
    expect(ticks).toHaveLength(0);
  });

  it('drops a non-finite timestamp', () => {
    const { ing } = mk();
    expect(ing.ingest('BTC', 79_000, Number.NaN)).toBeNull();
  });

  it('drops a duplicate timestamp', () => {
    const { ing, ticks } = mk();
    ing.ingest('BTC', 79_000, 100);
    expect(ing.ingest('BTC', 79_100, 100)).toBeNull();
    expect(ticks).toHaveLength(1);
    expect(ing.statsSnapshot().duplicates).toBe(1);
  });

  it('drops an out-of-order timestamp', () => {
    const { ing, ticks } = mk();
    ing.ingest('BTC', 79_000, 100);
    expect(ing.ingest('BTC', 79_100, 99)).toBeNull();
    expect(ticks).toHaveLength(1);
    expect(ing.statsSnapshot().outOfOrder).toBe(1);
  });

  it('tracks ordering per symbol, so one symbol cannot block another', () => {
    const { ing, ticks } = mk({ symbols: ['BTC', 'ETH'] });
    ing.ingest('BTC', 79_000, 500);
    expect(ing.ingest('ETH', 2_500, 100)).not.toBeNull();   // ETH's own first tick
    expect(ticks).toHaveLength(2);
  });

  it('never crashes the ingester on a bad observation', () => {
    const { ing } = mk();
    for (const [p, t] of [[0, 1], [Number.NaN, 2], [-1, 3], [Infinity, 4]] as const) {
      expect(() => ing.ingest('BTC', p, t)).not.toThrow();
    }
    expect(ing.ingest('BTC', 79_000, 10)).not.toBeNull();   // still working
  });
});

describe('T-012 frame parsing', () => {
  it('parses a JSON string frame', () => {
    const { ing, ticks } = mk();
    expect(ing.ingestFrame('{"symbol":"BTC","price":79000,"tsMs":5}')).not.toBeNull();
    expect(ticks[0]!.price).toBe(79_000);
  });

  it('parses an object frame', () => {
    const { ing, ticks } = mk();
    ing.ingestFrame({ symbol: 'BTC', price: 79_100, tsMs: 6 });
    expect(ticks[0]!.price).toBe(79_100);
  });

  it('accepts a string price (exchanges send them)', () => {
    const { ing, ticks } = mk();
    ing.ingestFrame({ s: 'BTC', p: '79340.43', E: 7 });
    expect(ticks[0]!.price).toBeCloseTo(79_340.43, 6);
  });

  it('drops malformed JSON without throwing, and counts it', () => {
    const { ing, ticks } = mk();
    expect(ing.ingestFrame('{not json')).toBeNull();
    expect(ing.ingestFrame('')).toBeNull();
    expect(ing.ingestFrame(null)).toBeNull();
    expect(ing.ingestFrame(42)).toBeNull();
    expect(ticks).toHaveLength(0);
    expect(ing.statsSnapshot().malformed).toBe(4);
  });

  it('drops a frame with no symbol and no hint', () => {
    const { ing } = mk();
    expect(ing.ingestFrame({ price: 79_000, tsMs: 1 })).toBeNull();
  });

  it('uses the symbol hint when the frame omits it', () => {
    const { ing, ticks } = mk();
    expect(ing.ingestFrame({ price: 79_000, tsMs: 1 }, 'BTC')).not.toBeNull();
    expect(ticks[0]!.symbol).toBe('BTC');
  });

  it('falls back to the clock when the frame carries no timestamp', () => {
    const { ing, ticks, clock } = mk();
    clock.advance(1_234);
    ing.ingestFrame({ symbol: 'BTC', price: 79_000 });
    expect(ticks[0]!.tsMs).toBe(1_234);
  });
});

describe('T-012 polling and backoff', () => {
  it('polls every symbol sequentially, not in a fan-out', async () => {
    // T-S4: a 30-way fan-out on the indexer returned 20 % errors and a 29 s
    // p99. Overlapping reads here are how an agent finds that out on stage.
    let inFlight = 0;
    let maxInFlight = 0;
    const source: SpotSource = {
      name: 'fixture',
      read: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return { price: 79_000, tsMs: Date.now() };
      },
    };
    const { ing } = mk({ source, symbols: ['BTC', 'ETH', 'SOL', 'DOGE'] });
    await ing.poll();
    expect(maxInFlight).toBe(1);
  });

  it('publishes a tick per symbol per poll', async () => {
    let n = 0;
    const source: SpotSource = { name: 'fixture', read: async () => ({ price: 79_000 + ++n, tsMs: n }) };
    const { ing, ticks } = mk({ source, symbols: ['BTC', 'ETH'] });
    await ing.poll();
    expect(ticks).toHaveLength(2);
  });

  it('uses the configured cadence when healthy', () => {
    const { ing } = mk({ pollMs: 500 });
    expect(ing.nextDelayMs()).toBe(500);
  });

  it('backs off exponentially after consecutive failures', async () => {
    const source: SpotSource = { name: 'fixture', read: async () => { throw new Error('feed down'); } };
    const { ing } = mk({ source, backoffBaseMs: 400, backoffMaxMs: 10_000 });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) { await ing.poll(); delays.push(ing.nextDelayMs()); }
    // Jitter is 50-100% of the capped value, so compare against the floor.
    for (let i = 1; i < delays.length; i++) expect(delays[i]!).toBeGreaterThanOrEqual(200);
    expect(delays[4]!).toBeGreaterThan(delays[0]!);
  });

  it('caps the backoff so a long outage still retries predictably', async () => {
    const source: SpotSource = { name: 'fixture', read: async () => { throw new Error('down'); } };
    const { ing } = mk({ source, backoffBaseMs: 400, backoffMaxMs: 5_000 });
    for (let i = 0; i < 30; i++) await ing.poll();
    expect(ing.nextDelayMs()).toBeLessThanOrEqual(5_000);
  });

  it('applies jitter so restarted instances do not retry in lockstep', async () => {
    const source: SpotSource = { name: 'fixture', read: async () => { throw new Error('down'); } };
    const { ing } = mk({ source, backoffBaseMs: 1_000 });
    for (let i = 0; i < 4; i++) await ing.poll();
    const samples = new Set(Array.from({ length: 20 }, () => ing.nextDelayMs()));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('resets the backoff and counts a reconnect on recovery', async () => {
    let fail = true;
    const source: SpotSource = {
      name: 'fixture',
      read: async () => { if (fail) throw new Error('down'); return { price: 79_000, tsMs: Date.now() }; },
    };
    const { ing } = mk({ source });
    await ing.poll();
    await ing.poll();
    expect(ing.nextDelayMs()).toBeGreaterThan(0);
    fail = false;
    await ing.poll();
    expect(ing.statsSnapshot().reconnects).toBe(1);
    expect(ing.nextDelayMs()).toBe(500);
  });

  it('publishes an error event and calls onError on failure', async () => {
    const onError = vi.fn();
    const source: SpotSource = { name: 'fixture', read: async () => { throw new Error('feed 503'); } };
    const bus = new EventBus();
    const wheres: string[] = [];
    bus.on('error', (d) => { wheres.push(d.where); });
    const ing = new Ingester({ bus, clock: new VirtualClock(0), source, symbols: ['BTC'], onError });
    await ing.poll();
    expect(wheres).toEqual(['ingester.BTC']);
    expect(onError).toHaveBeenCalled();
  });

  it('start is idempotent and stop halts polling', async () => {
    const source: SpotSource = { name: 'fixture', read: async () => ({ price: 79_000, tsMs: Date.now() }) };
    const { ing, clock } = mk({ source });
    ing.start();
    ing.start();
    expect(ing.isRunning).toBe(true);
    clock.advance(1);
    await new Promise((r) => setTimeout(r, 5));
    ing.stop();
    expect(ing.isRunning).toBe(false);
    const before = ing.statsSnapshot().published;
    clock.advance(10_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(ing.statsSnapshot().published).toBe(before);
  });
});

describe('T-012 the journal hook is off the path', () => {
  it('publishes the tick even when the journal hook throws', () => {
    const bus = new EventBus();
    const ticks: Tick[] = [];
    bus.on('tick', (t) => ticks.push(t));
    const ing = new Ingester({
      bus, clock: new VirtualClock(0), source: src(), symbols: ['BTC'],
      onTick: () => { throw new Error('disk full'); },
    });
    expect(() => ing.ingest('BTC', 79_000, 1)).not.toThrow();
    expect(ticks).toHaveLength(1);
  });

  it('publishes to the bus before journalling', () => {
    const order: string[] = [];
    const bus = new EventBus();
    bus.on('tick', () => order.push('bus'));
    const ing = new Ingester({
      bus, clock: new VirtualClock(0), source: src(), symbols: ['BTC'],
      onTick: () => order.push('journal'),
    });
    ing.ingest('BTC', 79_000, 1);
    expect(order).toEqual(['bus', 'journal']);
  });
});

describe('T-012 latency (ARCH §4: feed frame to bus < 5 ms)', () => {
  it('ingests 10 000 observations at p99 far inside the budget', () => {
    const { ing } = mk();
    const samples: number[] = [];
    for (let i = 1; i <= 10_000; i++) {
      const t0 = performance.now();
      ing.ingest('BTC', 79_000 + (i % 13), i);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.99)]!).toBeLessThan(5);
  });

  it('does no I/O on the ingest path', () => {
    const { ing } = mk();
    // A promise return would invite an await on the tick path.
    expect(ing.ingest('BTC', 79_000, 1)).not.toBeInstanceOf(Promise);
  });
});

describe('T-012 sources', () => {
  it('fixtureSource replays deterministically and loops', async () => {
    const f = fixtureSource({ prices: [1, 2, 3], stepMs: 100 });
    const a = [await f.read('BTC'), await f.read('BTC'), await f.read('BTC'), await f.read('BTC')];
    f.reset();
    const b = [await f.read('BTC'), await f.read('BTC'), await f.read('BTC'), await f.read('BTC')];
    expect(a).toEqual(b);
    expect(a.map((x) => x.price)).toEqual([1, 2, 3, 1]);      // looped
    expect(a.map((x) => x.tsMs)).toEqual([100, 200, 300, 400]);
  });

  it('fixtureSource can be one-shot and report exhaustion', async () => {
    const f = fixtureSource({ prices: [1], once: true });
    await f.read('BTC');
    expect(f.exhausted).toBe(true);
    await expect(f.read('BTC')).rejects.toThrow(/exhausted/);
  });

  it('two identical fixture runs produce byte-identical tick streams', async () => {
    const prices = gbmFixture({ start: 79_000, sigma: 0.6, stepMs: 500, n: 200, seed: 5 });
    const run = async () => {
      const bus = new EventBus();
      const ticks: Tick[] = [];
      bus.on('tick', (t) => ticks.push(t));
      const ing = new Ingester({
        bus, clock: new VirtualClock(0), source: fixtureSource({ prices, stepMs: 500, once: true }),
        symbols: ['BTC'],
      });
      for (let i = 0; i < prices.length; i++) await ing.poll();
      return JSON.stringify(ticks);
    };
    expect(await run()).toBe(await run());
  });

  it('gbmFixture is reproducible for a seed and realizes the requested vol', () => {
    const a = gbmFixture({ start: 100, sigma: 0.6, stepMs: 500, n: 50, seed: 9 });
    const b = gbmFixture({ start: 100, sigma: 0.6, stepMs: 500, n: 50, seed: 9 });
    expect(a).toEqual(b);
    const c = gbmFixture({ start: 100, sigma: 0.6, stepMs: 500, n: 20_000, seed: 3 });
    const rs: number[] = [];
    for (let i = 1; i < c.length; i++) rs.push(Math.log(c[i]! / c[i - 1]!));
    const mean = rs.reduce((x, y) => x + y, 0) / rs.length;
    const varr = rs.reduce((x, y) => x + (y - mean) ** 2, 0) / (rs.length - 1);
    const annual = Math.sqrt(varr * ((365 * 24 * 60 * 60 * 1000) / 500));
    expect(annual).toBeGreaterThan(0.5);
    expect(annual).toBeLessThan(0.7);
  });

  it('binanceSource maps a symbol and parses the response', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toContain('BTCUSDT');
      return { ok: true, json: async () => ({ symbol: 'BTCUSDT', price: '79340.43' }) };
    }) as unknown as typeof fetch;
    const s = binanceSource(fetchImpl);
    expect(s.name).toBe('binance');
    expect((await s.read('BTC')).price).toBeCloseTo(79_340.43, 6);
  });

  it('binanceSource rejects a non-OK response and a bad price', async () => {
    const bad = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(binanceSource(bad).read('BTC')).rejects.toThrow(/429/);
    const weird = (async () => ({ ok: true, json: async () => ({ price: 'abc' }) })) as unknown as typeof fetch;
    await expect(binanceSource(weird).read('BTC')).rejects.toThrow(/bad price/);
  });

  it('somniaFeedSource wraps a reader and is the LIVE default name', async () => {
    const s = somniaFeedSource(async () => ({ price: 79_183.325, tsMs: 1_788_790_585_000 }));
    expect(s.name).toBe('somnia-feed');
    expect((await s.read('BTC')).price).toBeCloseTo(79_183.325, 6);
  });
});
