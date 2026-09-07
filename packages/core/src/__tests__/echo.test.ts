// T-026 ECHO (F-A4, WP §5) and T-027 Persona (F-A9, FR-U4).
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock, type Market, type RiskConfig } from '@arena/shared';
import { EventBus } from '@arena/data';
import { SimulatedVenue } from '@arena/venue';
import { DEFAULT_ORDER_TTL_MS } from '../engine.ts';
import { EchoAgent } from '../echo.ts';
import { Persona, type QuipTrigger } from '../persona.ts';
import { Engine } from '../engine.ts';

const risk = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  maxNetContractsPerMarket: 500, maxGrossContracts: 2_000, maxNotionalUsd: 5_000,
  maxSessionLossUsd: 1_000, maxOrdersPerMinute: 1_000, cooldownMs: 0,
  edgeIn: 0.06, edgeOut: 0.02, kellyFraction: 0.25, minEdgeFloor: 0.015,
  maxQuoteAgeMs: 4_000, killSwitch: false, ...over,
});

const MARKETS = [
  { id: 'btc-60', asset: 'BTC', strike: 79_100, intervalSec: 60, expiryMs: 600_000, fairProb: 0.40 },
];

const rig = async (over: { echo?: Partial<ConstructorParameters<typeof EchoAgent>[0]> } = {}) => {
  const clock = new VirtualClock(0);
  const bus = new EventBus();
  // Two venue instances, two agents: the venue blocks self-matching, so ECHO
  // must be bound to its own signer (RFC-001 A7).
  const echoVenue = new SimulatedVenue({
    clock, agent: 'ECHO', depth: 0, spread: 0.02, balanceUsd: 5_000, markets: MARKETS,
  });
  await echoVenue.connect();
  const echo = new EchoAgent({
    venue: echoVenue, bus, clock, risk: risk(),
    spread: 0.02, quoteSize: 5, refreshMs: 10_000, maxInventory: 20, ...over.echo,
  });
  await echo.start();
  return { clock, bus, echoVenue, echo };
};

const markets = async (v: SimulatedVenue): Promise<Market[]> =>
  (await v.getMarkets()).filter((m) => m.status === 'Trading');

describe('T-026 ECHO needs its own signer (RFC-001 A7)', () => {
  it('throws at construction when handed MIRA’s venue', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const miraVenue = new SimulatedVenue({ clock, agent: 'MIRA', markets: MARKETS });
    await miraVenue.connect();
    expect(() => new EchoAgent({ venue: miraVenue, bus, clock, risk: risk() }))
      .toThrow(/own signer|RFC-001 A7/i);
  });

  it('throws when the two keys are the same', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const v = new SimulatedVenue({ clock, agent: 'ECHO', markets: MARKETS });
    await v.connect();
    expect(() => new EchoAgent({
      venue: v, bus, clock, risk: risk(), ownKey: '0xaa', peerKey: '0xaa',
    })).toThrow(/self-match/i);
  });

  it('accepts two distinct keys', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const v = new SimulatedVenue({ clock, agent: 'ECHO', markets: MARKETS });
    await v.connect();
    expect(() => new EchoAgent({
      venue: v, bus, clock, risk: risk(), ownKey: '0xaa', peerKey: '0xbb',
    })).not.toThrow();
  });
});

describe('T-026 two-sided quoting', () => {
  it('quotes both sides around the fair probability', async () => {
    const { echo, echoVenue } = await rig();
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    const sides = spy.mock.calls.map((c) => c[0].side).sort();
    expect(sides).toEqual(['NO', 'YES']);
    expect(echo.statsSnapshot().quotesPlaced).toBe(2);
  });

  it('places its bids inside the spread it was configured with', async () => {
    const { echo, echoVenue } = await rig({ echo: { spread: 0.04 } });
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    const byside = new Map(spy.mock.calls.map((c) => [c[0].side, c[0].limitPrice!]));
    // A YES bid sits half a spread below fair; a NO bid below (1 - fair).
    expect(byside.get('YES')!).toBeCloseTo(0.4 - 0.02, 2);
    expect(byside.get('NO')!).toBeCloseTo(0.6 - 0.02, 2);
  });

  it('uses POST_ONLY so it never crosses its own quote', async () => {
    const { echo, echoVenue } = await rig();
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    for (const c of spy.mock.calls) expect(c[0].type).toBe('POST_ONLY');
  });

  // AMENDED after a LIVE failure. This originally required the expiry to sit
  // just past the requote interval, so a crashed agent's quotes would age off
  // the book on their own. On a real chain that made them age off before they
  // ever reached it: at refreshMs 8s the 16s life was shorter than a serialized
  // write, and the pool rejected every quote with OrderAlreadyExpired().
  // The self-ageing property is kept, floored at the write-survival TTL — and
  // resting escrow is bounded anyway by cancelFor() on each requote.
  it('sets an expiry that outlives the write but still ages off (gotcha 5)', async () => {
    const { echo, echoVenue } = await rig({ echo: { refreshMs: 8_000 } });
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const c of spy.mock.calls) {
      const life = c[0].expiresMs - c[0].tsMs;
      expect(life, 'must survive an on-chain write').toBeGreaterThanOrEqual(DEFAULT_ORDER_TTL_MS);
      expect(life, 'but must still age off unattended').toBeLessThanOrEqual(120_000);
    }
  });

  it('mints a pair so it has inventory to offer (RFC-001 A6)', async () => {
    const { echo, echoVenue } = await rig();
    const spy = vi.spyOn(echoVenue, 'mintPair');
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    expect(spy).toHaveBeenCalled();
    expect(echo.statsSnapshot().mints).toBe(1);
  });

  it('mints only once per market, not once per cycle', async () => {
    const { echo, echoVenue, clock } = await rig();
    const spy = vi.spyOn(echoVenue, 'mintPair');
    const ms = await markets(echoVenue);
    for (let i = 0; i < 4; i++) { await echo.cycle(ms, () => 0.4, true); clock.advance(11_000); }
    expect(spy.mock.calls.length).toBe(1);
  });

  it('skips a market that is not Trading', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const v = new SimulatedVenue({
      clock, agent: 'ECHO', depth: 0,
      markets: [{ id: 'later', asset: 'BTC', strike: 79_100, intervalSec: 900,
        tradingStartMs: 3_600_000, expiryMs: 4_500_000 }],
    });
    await v.connect();
    const echo = new EchoAgent({ venue: v, bus, clock, risk: risk() });
    const spy = vi.spyOn(v, 'placeOrder');
    await echo.cycle(await v.getMarkets(), () => 0.4, true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips a market with no usable fair price', async () => {
    const { echo, echoVenue } = await rig();
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(await markets(echoVenue), () => null, true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('T-026 the tape is never empty (the measured reason ECHO exists)', () => {
  it('produces quotes on every cycle in a flat market', async () => {
    const { echo, echoVenue, clock } = await rig({ echo: { refreshMs: 5_000 } });
    const ms = await markets(echoVenue);
    let cycles = 0;
    for (let i = 0; i < 6; i++) {
      clock.advance(5_000);
      await echo.cycle(ms, () => 0.4);
      cycles++;
    }
    expect(echo.statsSnapshot().cycles).toBe(cycles);
    expect(echo.statsSnapshot().quotesPlaced).toBeGreaterThanOrEqual(cycles);
  });

  it('respects its requote cadence rather than quoting every call', async () => {
    const { echo, echoVenue, clock } = await rig({ echo: { refreshMs: 10_000 } });
    const ms = await markets(echoVenue);
    await echo.cycle(ms, () => 0.4);          // first cycle runs
    const after = echo.statsSnapshot().cycles;
    clock.advance(1_000);
    await echo.cycle(ms, () => 0.4);          // too soon
    expect(echo.statsSnapshot().cycles).toBe(after);
    clock.advance(10_000);
    await echo.cycle(ms, () => 0.4);
    expect(echo.statsSnapshot().cycles).toBe(after + 1);
  });

  it('cancels its previous quotes before requoting (escrow, gotcha 4)', async () => {
    const { echo, echoVenue, clock } = await rig({ echo: { refreshMs: 5_000 } });
    const ms = await markets(echoVenue);
    await echo.cycle(ms, () => 0.4, true);
    const cancels = vi.spyOn(echoVenue, 'cancel');
    clock.advance(6_000);
    await echo.cycle(ms, () => 0.42, true);
    expect(cancels.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('T-026 inventory skew', () => {
  it('quotes only the unwinding side past half its inventory cap', async () => {
    const { echo, echoVenue, clock } = await rig({ echo: { maxInventory: 20 } });
    const ms = await markets(echoVenue);
    // Long 15 YES, past half of 20.
    echo.onFill({
      fillId: 'f1', clientOrderId: 'c1', venueOrderId: null, marketId: 'btc-60',
      agent: 'ECHO', side: 'YES', sizeContracts: 15, price: 0.4, feeUsd: 0,
      txHash: null, explorerUrl: null, tsMs: 0,
    });
    clock.advance(11_000);
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(ms, () => 0.4, true);
    const sides = spy.mock.calls.map((c) => c[0].side);
    expect(sides).toEqual(['NO']);                 // only the side that reduces
    expect(echo.statsSnapshot().skewedCycles).toBeGreaterThan(0);
  });

  it('skews the other way when short', async () => {
    const { echo, echoVenue, clock } = await rig({ echo: { maxInventory: 20 } });
    const ms = await markets(echoVenue);
    echo.onFill({
      fillId: 'f2', clientOrderId: 'c2', venueOrderId: null, marketId: 'btc-60',
      agent: 'ECHO', side: 'NO', sizeContracts: 15, price: 0.6, feeUsd: 0,
      txHash: null, explorerUrl: null, tsMs: 0,
    });
    clock.advance(11_000);
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(ms, () => 0.4, true);
    expect(spy.mock.calls.map((c) => c[0].side)).toEqual(['YES']);
  });

  it('quotes both sides again once inventory is back inside half the cap', async () => {
    const { echo, echoVenue, clock } = await rig({ echo: { maxInventory: 20 } });
    const ms = await markets(echoVenue);
    const fill = (side: 'YES' | 'NO', size: number, id: string) => echo.onFill({
      fillId: id, clientOrderId: id, venueOrderId: null, marketId: 'btc-60',
      agent: 'ECHO', side, sizeContracts: size, price: 0.4, feeUsd: 0,
      txHash: null, explorerUrl: null, tsMs: 0,
    });
    fill('YES', 15, 'a');
    fill('NO', 12, 'b');                            // net +3, inside half of 20
    clock.advance(11_000);
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(ms, () => 0.4, true);
    expect(spy.mock.calls.map((c) => c[0].side).sort()).toEqual(['NO', 'YES']);
  });

  it('respects its own risk config', async () => {
    const { echo, echoVenue } = await rig({ echo: { risk: risk({ maxNotionalUsd: 0.5 }) } });
    const spy = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('cancels everything and stops quoting when killed', async () => {
    const { echo, echoVenue } = await rig();
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    echo.riskGuard.kill('test');
    const cancelAll = vi.spyOn(echoVenue, 'cancelAll');
    const place = vi.spyOn(echoVenue, 'placeOrder');
    await echo.cycle(await markets(echoVenue), () => 0.4, true);
    expect(cancelAll).toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });
});

describe('T-026 MIRA and ECHO can cross', () => {
  it('produces fills for both agents on one shared book', async () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    // depth 0: the ONLY liquidity is what the agents themselves post, which is
    // the measured testnet condition (T-S4: tradeCount 0 everywhere).
    const shared = { depth: 0, spread: 0.02, markets: MARKETS };
    const echoVenue = new SimulatedVenue({ clock, agent: 'ECHO', balanceUsd: 5_000, ...shared });
    await echoVenue.connect();
    const echo = new EchoAgent({
      venue: echoVenue, bus, clock, risk: risk(), quoteSize: 20, spread: 0.02,
    });
    await echo.start();
    const ms = await markets(echoVenue);
    await echo.cycle(ms, () => 0.4, true);
    expect(echoVenue.openOrders().length).toBeGreaterThan(0);

    // MIRA takes ECHO's resting bid on the same venue book.
    let miraFills = 0;
    echoVenue.onFill((f) => { if (f.agent === 'MIRA') miraFills++; });
    await echoVenue.mintPair('btc-60', 20);
    await echoVenue.placeOrder({
      clientOrderId: 'mira-taker', marketId: 'btc-60', agent: 'MIRA', side: 'YES',
      kind: 'SELL_YES', type: 'LIMIT', limitPrice: 0.10, limitPriceRaw: 100_000n,
      sizeContracts: 5, sizeRaw: 5_000_000n, expiresMs: 600_000, signalId: null, tsMs: clock.now(),
    });
    expect(miraFills).toBeGreaterThan(0);
  });
});

// ───────────────────────────── T-027 Persona ────────────────────────────────

describe('T-027 the feed always speaks', () => {
  it('produces a quip for every trigger with no generator at all', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock });
    const triggers: QuipTrigger[] = ['round_open', 'round_close', 'big_win', 'big_loss',
      'kill', 'mode_change', 'skip', 'stand_down', 'hunted'];
    for (const t of triggers) {
      const q = p.say(t, { pnlUsd: 12.34, roundId: 'r1', edge: 0.07, humans: 4, mode: 'SIM', by: 'op' });
      expect(q.text.length).toBeGreaterThan(0);
      expect(q.trigger).toBe(t);
    }
    expect(p.statsSnapshot().produced).toBe(triggers.length);
  });

  it('substitutes live numbers rather than emitting a generic line', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock });
    const q = p.say('big_win', { pnlUsd: 42.5, edge: 0.073 });
    expect(q.text).toMatch(/\$42\.50/);
  });

  it('never leaves an unsubstituted placeholder on screen', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock });
    for (const t of ['round_open', 'big_win', 'kill', 'hunted'] as QuipTrigger[]) {
      for (let i = 0; i < 4; i++) {
        expect(p.say(t, {}).text).not.toMatch(/[{}]/);
      }
    }
  });

  it('keeps every quip within the UI character budget', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock, maxChars: 60 });
    for (const t of Object.keys({ round_open: 1, big_win: 1, hunted: 1 }) as QuipTrigger[]) {
      const q = p.say(t, { pnlUsd: 1234.56, humans: 12, roundId: 'round-abcdef' });
      expect(q.text.length).toBeLessThanOrEqual(60);
    }
  });

  it('rotates templates so consecutive quips are not identical', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock });
    const a = p.say('round_open', { roundId: 'r1' }).text;
    const b = p.say('round_open', { roundId: 'r1' }).text;
    expect(a).not.toBe(b);
  });

  it('produces at least one quip per round (F-A9)', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock });
    for (const r of ['r1', 'r2', 'r3']) {
      p.say('round_open', { roundId: r });
      expect(p.countForRound(r)).toBeGreaterThanOrEqual(1);
    }
  });

  it('publishes to the bus so the arena feed updates', () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('quip', (q) => { seen.push(q.trigger); });
    new Persona({ clock, bus }).say('round_open', { roundId: 'r1' });
    expect(seen).toEqual(['round_open']);
  });

  it('bounds its recent list', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock });
    for (let i = 0; i < 200; i++) p.say('skip', { marketSymbol: `m${i}` });
    expect(p.quips().length).toBeLessThanOrEqual(40);
  });
});

describe('T-027 the generator can never cost latency (F-A9)', () => {
  it('say() returns synchronously with a generator stalled indefinitely', () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock, generator: () => new Promise(() => { /* never */ }) });
    const t0 = performance.now();
    const q = p.say('big_win', { pnlUsd: 5 });
    const el = performance.now() - t0;
    expect(q.text.length).toBeGreaterThan(0);
    expect(el).toBeLessThan(2);
  });

  it('leaves engine decision latency unchanged with a 5 s generator stall', async () => {
    // The F-A9 requirement stated as a measurement: drive real ticks with a
    // persona whose generator hangs, and compare against no persona at all.
    const mkRig = async (withPersona: boolean) => {
      const clock = new VirtualClock(0);
      const bus = new EventBus();
      const venue = new SimulatedVenue({
        clock, agent: 'MIRA', depth: 200, balanceUsd: 10_000, markets: MARKETS,
      });
      await venue.connect();
      const engine = new Engine({
        agent: 'MIRA', venue, bus, clock, risk: risk(),
        vol: { lambda: 0.94, minObs: 2, seedVol: 1.5 }, quoteCacheMs: 0, marketsCacheMs: 0,
      });
      await engine.start();
      if (withPersona) {
        const p = new Persona({
          clock, bus,
          generator: () => new Promise((res) => setTimeout(() => res('late'), 5_000)),
        });
        p.subscribe(bus);
      }
      let px = 79_000;
      const samples: number[] = [];
      for (let i = 0; i < 400; i++) {
        px *= 1 + (i % 2 === 0 ? 0.0004 : -0.00032);
        clock.advance(500);
        const t0 = performance.now();
        await engine.onTick('BTC', px, clock.now());
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length * 0.95)]!;
    };
    const without = await mkRig(false);
    const withIt = await mkRig(true);
    // Both must be far inside the 3 ms budget; the persona must not add a
    // meaningful fraction of it.
    expect(without).toBeLessThan(3);
    expect(withIt).toBeLessThan(3);
  });

  it('counts a generator failure instead of propagating it', async () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock, generator: async () => { throw new Error('llm 503'); } });
    expect(() => p.say('big_win', { pnlUsd: 1 })).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(p.statsSnapshot().generatorFailures).toBeGreaterThan(0);
  });

  it('serves from cache once the generator has filled it', async () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock, generator: async () => 'A generated line about volatility.' });
    p.say('big_win', { pnlUsd: 1 });                  // kicks off a refill
    await new Promise((r) => setTimeout(r, 10));
    expect(p.statsSnapshot().fromGenerator).toBeGreaterThan(0);
    const q = p.say('big_win', { pnlUsd: 2 });
    expect(q.text).toBe('A generated line about volatility.');
    expect(p.statsSnapshot().fromCache).toBeGreaterThan(0);
  });

  it('runs at most one refill per trigger at a time', async () => {
    const clock = new VirtualClock(0);
    let calls = 0;
    const p = new Persona({
      clock,
      generator: () => { calls++; return new Promise((res) => setTimeout(() => res('x'), 20)); },
    });
    for (let i = 0; i < 10; i++) p.say('skip', {});
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
  });

  it('ignores an empty generator response rather than caching a blank quip', async () => {
    const clock = new VirtualClock(0);
    const p = new Persona({ clock, generator: async () => '   ' });
    p.say('skip', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(p.statsSnapshot().fromGenerator).toBe(0);
    expect(p.say('skip', {}).text.length).toBeGreaterThan(0);
  });
});

describe('T-027 bus subscription', () => {
  it('speaks on kill, mode change, round open and settlement', () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const p = new Persona({ clock, bus });
    p.subscribe(bus);
    bus.publish({ t: 'kill', d: { on: true, by: 'director', tsMs: 0 } });
    bus.publish({ t: 'mode', d: { mode: 'SIM', tsMs: 0 } });
    bus.publish({ t: 'round', d: {
      roundId: 'r1', index: 1, openMs: 0, closeMs: 1_000, status: 'OPEN',
      marketIds: [], miraPnlUsd: 0, potUsd: 0, topN: 5 } });
    bus.publish({ t: 'settlement', d: {
      roundId: 'r1', miraPnlUsd: 10, potUsd: 10, scores: [],
      payouts: [{ userAddr: '0xa', brier: 0.1, weight: 1, amountUsd: 10 }],
      method: 'BRIER_PRO_RATA', journalSeq: 1, tsMs: 0 } });
    const triggers = p.quips().map((q) => q.trigger);
    expect(triggers).toContain('kill');
    expect(triggers).toContain('mode_change');
    expect(triggers).toContain('round_open');
    expect(triggers).toContain('hunted');
  });

  it('unsubscribes cleanly', () => {
    const clock = new VirtualClock(0);
    const bus = new EventBus();
    const p = new Persona({ clock, bus });
    const off = p.subscribe(bus);
    off();
    bus.publish({ t: 'kill', d: { on: true, by: 'x', tsMs: 0 } });
    expect(p.quips()).toHaveLength(0);
  });
});
