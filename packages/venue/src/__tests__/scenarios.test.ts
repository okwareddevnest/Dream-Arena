// T-032 — scenario runner (FR-V2, PRD §10 R3, IF §14).
// The assertions that matter are the measurable ones: VOL_SPIKE must actually
// raise realized volatility, FLAT_DRIFT must actually be boring. A scenario
// that only *claims* to move the market is a demo button that does nothing.
import { describe, it, expect } from 'vitest';
import { VirtualClock, SCENARIO_NAMES, type ScenarioName } from '@arena/shared';
import { EventBus } from '@arena/data';
import { SCENARIOS, ScenarioRunner, ScenarioSpotDriver, type ScenarioTarget } from '../scenarios.ts';
import { SimulatedVenue } from '../simulated.ts';

/** A recording target, so a scenario can be tested without a venue. */
const spy = () => {
  const calls: { op: string; args: unknown[] }[] = [];
  const t: ScenarioTarget = {
    setSpot: (...a) => { calls.push({ op: 'setSpot', args: a }); },
    setFairProb: (...a) => { calls.push({ op: 'setFairProb', args: a }); },
    setSpread: (...a) => { calls.push({ op: 'setSpread', args: a }); },
    setDepth: (...a) => { calls.push({ op: 'setDepth', args: a }); },
    freezeQuotes: (...a) => { calls.push({ op: 'freezeQuotes', args: a }); },
    dropNextTx: () => { calls.push({ op: 'dropNextTx', args: [] }); },
    clashNonce: () => { calls.push({ op: 'clashNonce', args: [] }); },
    setLatency: (...a) => { calls.push({ op: 'setLatency', args: a }); },
  };
  return { target: t, calls };
};

const mk = (over: Partial<ConstructorParameters<typeof ScenarioRunner>[0]> = {}) => {
  const clock = new VirtualClock(0);
  const { target, calls } = spy();
  const bus = new EventBus();
  const runner = new ScenarioRunner({
    clock, target, marketIds: ['m1', 'm2'], asset: 'BTC', baseSpot: 79_000, bus, ...over,
  });
  return { clock, runner, calls, bus, target };
};

describe('T-032 the library covers IF §14', () => {
  it('every ScenarioName has a script', () => {
    for (const n of SCENARIO_NAMES) {
      expect(SCENARIOS[n], `missing script for ${n}`).toBeDefined();
      expect(SCENARIOS[n].name).toBe(n);
      expect(SCENARIOS[n].steps.length).toBeGreaterThan(0);
      expect(SCENARIOS[n].durationMs).toBeGreaterThan(0);
    }
  });

  it('exposes the list the console offers', () => {
    expect([...ScenarioRunner.names()]).toEqual([...SCENARIO_NAMES]);
  });

  it('every step is inside its script duration', () => {
    for (const n of SCENARIO_NAMES) {
      for (const st of SCENARIOS[n].steps) {
        expect(st.atMs).toBeGreaterThanOrEqual(0);
        expect(st.atMs).toBeLessThanOrEqual(SCENARIOS[n].durationMs);
      }
    }
  });

  it('rejects an unknown scenario name', () => {
    const { runner } = mk();
    expect(() => runner.start('NOT_A_SCENARIO' as ScenarioName)).toThrow(/unknown/i);
  });
});

describe('T-032 steps fire at their atMs, in order', () => {
  it('runs every scenario to completion without throwing', () => {
    for (const n of SCENARIO_NAMES) {
      const { clock, runner } = mk();
      runner.start(n);
      clock.advance(SCENARIOS[n].durationMs + 1_000);
      expect(runner.active?.remaining).toBe(0);
    }
  });

  it('fires steps at exactly their scheduled virtual time', () => {
    const { clock, runner, calls } = mk();
    runner.start('THIN_BOOK');
    clock.advance(999);
    const before = calls.filter((c) => c.op === 'setDepth').length;
    clock.advance(1);                                   // reaches atMs 1000
    const after = calls.filter((c) => c.op === 'setDepth').length;
    expect(after).toBe(before + 1);
  });

  it('fires steps in chronological order, not script order', () => {
    const { clock, runner, calls } = mk();
    runner.start('THIN_BOOK');
    clock.advance(60_000);
    const depths = calls.filter((c) => c.op === 'setDepth').map((c) => c.args[0]);
    expect(depths).toEqual([1, 0, 50]);                 // 1s, 15s, 25s
  });

  it('publishes a scenario event so the badge and journal see the trigger', () => {
    const { runner, bus } = mk();
    const seen: ScenarioName[] = [];
    bus.on('scenario', (d) => { seen.push(d.name); });
    runner.start('VOL_SPIKE');
    expect(seen).toEqual(['VOL_SPIKE']);
  });

  it('records a history of triggers for the runbook log', () => {
    const { clock, runner } = mk();
    runner.start('VOL_SPIKE');
    clock.advance(70_000);
    runner.start('FLAT_DRIFT');
    expect(runner.log.map((h) => h.name)).toEqual(['VOL_SPIKE', 'FLAT_DRIFT']);
  });
});

describe('T-032 mid-run triggering (the director’s button)', () => {
  it('starts without restarting the venue', async () => {
    const clock = new VirtualClock(0);
    const venue = new SimulatedVenue({ clock, agent: 'MIRA' });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const before = await venue.getQuote(m.id);

    const runner = new ScenarioRunner({
      clock, target: venue, marketIds: [m.id], asset: 'BTC', baseSpot: 79_000,
    });
    runner.start('VOL_SPIKE');
    clock.advance(3_000);

    const after = await venue.getQuote(m.id);
    expect(after.ask - after.bid).toBeGreaterThan(before.ask - before.bid);
    expect((await venue.health()).ok).toBe(true);       // never disconnected
  });

  it('a second scenario supersedes the first rather than interleaving', () => {
    // Two scripts both writing setSpread would fight, and whichever fired last
    // would win at random. Superseding makes the outcome defined.
    const { clock, runner, calls } = mk();
    runner.start('THIN_BOOK');
    clock.advance(500);
    runner.start('FLAT_DRIFT');
    clock.advance(60_000);
    // THIN_BOOK's depth steps (1s, 15s, 25s) must never have fired.
    expect(calls.filter((c) => c.op === 'setDepth')).toHaveLength(0);
    expect(runner.active?.name).toBe('FLAT_DRIFT');
  });

  it('cancel stops pending steps', () => {
    const { clock, runner, calls } = mk();
    runner.start('THIN_BOOK');
    runner.cancel();
    clock.advance(60_000);
    expect(calls.filter((c) => c.op === 'setDepth')).toHaveLength(0);
    expect(runner.active).toBeNull();
  });

  it('ignores fault ops on a target that cannot inject them', () => {
    // A plain venue has no dropNextTx; a script is data and must not crash it.
    const clock = new VirtualClock(0);
    const plain: ScenarioTarget = {
      setSpot: () => {}, setFairProb: () => {}, setSpread: () => {},
      setDepth: () => {}, freezeQuotes: () => {},
    };
    const runner = new ScenarioRunner({
      clock, target: plain, marketIds: ['m1'], asset: 'BTC', baseSpot: 79_000,
    });
    runner.start('DROPPED_TX');
    expect(() => clock.advance(31_000)).not.toThrow();
  });
});

describe('T-032 measured market effects', () => {
  const DT = 500;   // the LIVE tick cadence measured in T-S4

  /** Walk the spot series for `ms` and return the prices seen. */
  const walk = (runner: ScenarioRunner, driver: ScenarioSpotDriver, clock: VirtualClock, ms: number) => {
    const prices: number[] = [driver.spot];
    for (let t = 0; t < ms; t += DT) {
      clock.advance(DT);
      prices.push(driver.tick(DT));
    }
    return prices;
  };

  it('VOL_SPIKE raises realized volatility by at least 3x baseline', () => {
    const { clock, runner, target } = mk();
    const driver = new ScenarioSpotDriver(runner, {
      clock, target, marketIds: ['m1'], asset: 'BTC', baseSpot: 79_000,
    }, 7);
    runner.start('VOL_SPIKE');
    // First 2 s is baseline (setVol 0.4), then the spike.
    const base = walk(runner, driver, clock, 2_000);
    const spike = walk(runner, driver, clock, 16_000);
    const vBase = ScenarioSpotDriver.realizedVol(base, DT);
    const vSpike = ScenarioSpotDriver.realizedVol(spike, DT);
    expect(vSpike).toBeGreaterThan(vBase * 3);
  });

  it('the driver realizes approximately the volatility the scenario asked for', () => {
    // This is what makes every other vol assertion meaningful.
    const { clock, runner, target } = mk();
    const driver = new ScenarioSpotDriver(runner, {
      clock, target, marketIds: ['m1'], asset: 'BTC', baseSpot: 79_000,
    }, 3);
    runner.start('VOL_SPIKE');
    clock.advance(2_100);                               // into the 3.0 regime
    // Cancel the remaining steps so the regime stays at 3.0 for the whole
    // sample. VOL_SPIKE steps back down at 20 s / 40 s / 60 s, so a long walk
    // through the intact script measures the AVERAGE of four regimes (0.93),
    // not the one being asserted.
    expect(runner.currentVol).toBe(3.0);
    runner.cancel();
    const prices = walk(runner, driver, clock, 400_000);
    const realized = ScenarioSpotDriver.realizedVol(prices, DT);
    expect(realized).toBeGreaterThan(3.0 * 0.9);
    expect(realized).toBeLessThan(3.0 * 1.1);
  });

  it('FLAT_DRIFT produces volatility below a typical entry threshold', () => {
    const { clock, runner, target } = mk();
    const driver = new ScenarioSpotDriver(runner, {
      clock, target, marketIds: ['m1'], asset: 'BTC', baseSpot: 79_000,
    }, 11);
    runner.start('FLAT_DRIFT');
    const prices = walk(runner, driver, clock, 60_000);
    expect(ScenarioSpotDriver.realizedVol(prices, DT)).toBeLessThan(0.1);
  });

  it('NEWS_SHOCK applies a single discontinuous jump of the configured size', () => {
    const { clock, runner, calls } = mk();
    runner.start('NEWS_SHOCK');
    clock.advance(30_000);
    const jumps = calls.filter((c) => c.op === 'setSpot');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!.args[1]).toBeCloseTo(79_000 * 1.035, 6);
  });

  it('STALE_QUOTE freezes quotes long enough for the pricer to skip', async () => {
    const clock = new VirtualClock(0);
    const venue = new SimulatedVenue({ clock, agent: 'MIRA' });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const runner = new ScenarioRunner({
      clock, target: venue, marketIds: [m.id], asset: 'BTC', baseSpot: 79_000,
    });
    runner.start('STALE_QUOTE');
    clock.advance(1_000);                               // freeze fires
    clock.advance(5_000);                               // age accumulates
    const q = await venue.getQuote(m.id);
    expect(q.stale).toBe(true);
    expect(clock.now() - q.tsMs).toBeGreaterThan(4_000);   // beyond maxQuoteAgeMs
  });

  it('THIN_BOOK reduces depth to zero so sizing has nothing to clamp to', async () => {
    const clock = new VirtualClock(0);
    const venue = new SimulatedVenue({ clock, agent: 'MIRA' });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const runner = new ScenarioRunner({
      clock, target: venue, marketIds: [m.id], asset: 'BTC', baseSpot: 79_000,
    });
    runner.start('THIN_BOOK');
    clock.advance(1_100);
    expect((await venue.getQuote(m.id)).depthAsk).toBeLessThanOrEqual(1);
    clock.advance(14_000);
    expect((await venue.getQuote(m.id)).depthAsk).toBe(0);
    clock.advance(11_000);
    expect((await venue.getQuote(m.id)).depthAsk).toBeGreaterThan(1);
  });

  it('DROPPED_TX and NONCE_CLASH reach their fault injectors', () => {
    for (const [name, op] of [['DROPPED_TX', 'dropNextTx'], ['NONCE_CLASH', 'clashNonce']] as const) {
      const { clock, runner, calls } = mk();
      runner.start(name);
      clock.advance(31_000);
      expect(calls.filter((c) => c.op === op)).toHaveLength(1);
    }
  });
});

describe('T-032 realizedVol helper', () => {
  it('returns 0 for a constant series', () => {
    expect(ScenarioSpotDriver.realizedVol([100, 100, 100, 100], 500)).toBe(0);
  });
  it('returns 0 for a series too short to measure', () => {
    expect(ScenarioSpotDriver.realizedVol([100], 500)).toBe(0);
    expect(ScenarioSpotDriver.realizedVol([100, 101], 500)).toBe(0);
  });
  it('grows with the size of the moves', () => {
    const calm = [100, 100.1, 100, 99.9, 100, 100.1];
    const wild = [100, 105, 98, 107, 96, 108];
    expect(ScenarioSpotDriver.realizedVol(wild, 500))
      .toBeGreaterThan(ScenarioSpotDriver.realizedVol(calm, 500));
  });
});
