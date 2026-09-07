// T-040 WS broadcaster, T-041 REST + health, T-044 MIRROR, T-045 console.
import { describe, it, expect, vi } from 'vitest';
import {
  SCENARIO_NAMES, VirtualClock,
  type ArenaSnapshot, type Fill, type Forecast, type HealthSnapshot, type Market,
  type Quote, type ServerMsg, type Settlement,
} from '@arena/shared';
import { EventBus } from '@arena/data';
import { Broadcaster, type Socket } from '../ws.ts';
import { MirrorService } from '../mirror.ts';
import { RestRouter, parseUrl, safeEqual, type RestRequest } from '../rest.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────
const market = (over: Partial<Market> = {}): Market => ({
  id: 'm1', symbol: 'BTC-79100', yesSymbol: 'y', noSymbol: 'n', asset: 'BTC',
  strike: 79_100, mode: 'fixed', boundaryPosted: true, intervalSec: 60,
  tradingStartMs: 0, expiryMs: 600_000, style: 'EXPIRY',
  tickRaw: 1_000n, lotRaw: 1n, priceDecimals: 6, minSize: 1, feeBps: 0,
  poolAddress: null, nonce: null, venue: 'SIM', status: 'Trading', ...over,
});

const fill = (over: Partial<Fill> = {}): Fill => ({
  fillId: 'f1', clientOrderId: 'c1', venueOrderId: 'v1', marketId: 'm1', agent: 'MIRA',
  side: 'YES', sizeContracts: 10, price: 0.4, feeUsd: 0, txHash: null,
  explorerUrl: null, tsMs: 1_000, ...over,
});

const quote = (over: Partial<Quote> = {}): Quote => ({
  marketId: 'm1', bid: 0.39, ask: 0.41, mid: 0.40,
  depthBid: 500, depthAsk: 500, stale: false, tsMs: 1_000, ...over,
});

const health = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  tsMs: 1_000, mode: 'SIM', runId: 'run-1', components: { engine: { ok: true, detail: null } },
  tickLagMs: 100, ticksPerSec: 2, journalSeq: 42, killSwitch: false,
  venue: { ok: true, mode: 'SIM', name: 'SimulatedVenue', blockNumber: 1,
    latencyMs: 1, lastErrorMs: null, detail: null },
  ...over,
});

const snapshot = (over: Partial<ArenaSnapshot> = {}): ArenaSnapshot => ({
  runId: 'run-1', mode: 'SIM', markets: [market()], model: null, valuations: [],
  positions: [], tape: [], pnlCurve: [], round: null, leaderboard: [],
  health: health(), quips: [], ...over,
});

/** A recording socket. `failOnSend` simulates a wedged client. */
const sock = (id: string, opts: { failOnSend?: boolean } = {}) => {
  const sent: ServerMsg[] = [];
  let closed = false;
  const s: Socket = {
    id,
    send: (d) => {
      if (opts.failOnSend) throw new Error('EPIPE');
      sent.push(JSON.parse(d) as ServerMsg);
    },
    close: () => { closed = true; },
  };
  return { socket: s, sent, get closed() { return closed; } };
};

// ─────────────────────────────── T-040 WS ───────────────────────────────────

const bc = (over: Partial<ConstructorParameters<typeof Broadcaster>[0]> = {}) => {
  const bus = new EventBus();
  const b = new Broadcaster({
    bus, snapshot: () => snapshot(), now: () => 1_000, runId: 'run-1', ...over,
  });
  return { bus, b };
};

describe('T-040 snapshot-then-stream', () => {
  it('sends hello, then snapshot, before any event', () => {
    const { b } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    expect(c.sent.map((m) => m.t)).toEqual(['hello', 'snapshot']);
  });

  it('hello carries the runId, mode and protocol version', () => {
    const { b } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    const hello = c.sent[0]!;
    expect(hello.t).toBe('hello');
    if (hello.t === 'hello') {
      expect(hello.d.runId).toBe('run-1');
      expect(hello.d.mode).toBe('SIM');
      expect(hello.d.protocol).toBe(1);
    }
  });

  it('streams events after the snapshot, in bus order', () => {
    const { b, bus } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    bus.publish({ t: 'fill', d: fill() });
    bus.publish({ t: 'kill', d: { on: true, by: 'x', tsMs: 1 } });
    expect(c.sent.map((m) => m.t)).toEqual(['hello', 'snapshot', 'ev', 'ev']);
    const evs = c.sent.filter((m) => m.t === 'ev');
    expect(evs.map((m) => (m.t === 'ev' ? m.d.t : ''))).toEqual(['fill', 'kill']);
  });

  it('loses no event that arrives while the snapshot is being sent', () => {
    // The gap this closes: subscribe-after-snapshot drops events, and
    // subscribe-before-snapshot double-applies them unless they are buffered.
    const bus = new EventBus();
    let taken = 0;
    const b = new Broadcaster({
      bus,
      snapshot: () => {
        taken++;
        // An event lands DURING the snapshot call, which is exactly the race.
        if (taken === 1) bus.publish({ t: 'fill', d: fill({ fillId: 'during' }) });
        return snapshot();
      },
      now: () => 1_000, runId: 'run-1',
    });
    const c = sock('c1');
    b.connect(c.socket);
    const evs = c.sent.filter((m) => m.t === 'ev');
    expect(evs).toHaveLength(1);
    expect(c.sent.map((m) => m.t)).toEqual(['hello', 'snapshot', 'ev']);
  });

  it('serializes a snapshot carrying bigints instead of dropping the client', () => {
    // Market.tickRaw is a bigint (RFC-001 A8) and JSON.stringify throws on
    // those. Before the bigint-aware replacer this dropped every client on
    // connect, and the failure was indistinguishable from a broken socket.
    const { b } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    expect(c.sent.map((m) => m.t)).toEqual(['hello', 'snapshot']);
    expect(b.clientCount).toBe(1);
    expect(b.statsSnapshot().serializeFailures).toBe(0);
    const snap = c.sent[1]!;
    expect(snap.t === 'snapshot' && String(snap.d.markets[0]!.tickRaw)).toBe('1000');
  });

  it('counts a genuinely unserializable frame without dropping the client', () => {
    const bus = new EventBus();
    const onError = vi.fn();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const b = new Broadcaster({
      bus,
      snapshot: () => ({ ...snapshot(), quips: cyclic as never }),
      now: () => 1, runId: 'r', onError,
    });
    const c = sock('c1');
    b.connect(c.socket);
    expect(b.clientCount).toBe(1);                    // still connected
    expect(b.statsSnapshot().serializeFailures).toBe(1);
    expect(onError).toHaveBeenCalled();
  });

  it('takes exactly ONE fresh snapshot per connecting client', () => {
    // Not two: a snapshot walks every position, the whole tape and the PnL
    // curve, so taking a second one just to read `.mode` doubles the cost of
    // every connection for one field.
    let n = 0;
    const b = new Broadcaster({
      bus: new EventBus(), snapshot: () => { n++; return snapshot(); },
      now: () => 1, runId: 'r',
    });
    b.connect(sock('a').socket);
    expect(n).toBe(1);
    b.connect(sock('b').socket);
    expect(n).toBe(2);
  });
});

describe('T-040 subscription filtering', () => {
  it('delivers only subscribed topics', () => {
    const { b, bus } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    b.receive('c1', JSON.stringify({ t: 'subscribe', d: { topics: ['fill'] } }));
    bus.publish({ t: 'fill', d: fill() });
    bus.publish({ t: 'tick', d: { symbol: 'BTC', price: 1, tsMs: 1, seq: 1, source: 'fixture' } });
    const evs = c.sent.filter((m) => m.t === 'ev');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.t === 'ev' && evs[0]!.d.t).toBe('fill');
  });

  it('an empty topic list means everything', () => {
    const { b, bus } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    b.receive('c1', JSON.stringify({ t: 'subscribe', d: { topics: [] } }));
    bus.publish({ t: 'fill', d: fill() });
    expect(c.sent.filter((m) => m.t === 'ev')).toHaveLength(1);
  });
});

describe('T-040 ping and inbound messages', () => {
  it('answers ping with pong carrying both clocks', () => {
    const { b } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    b.receive('c1', JSON.stringify({ t: 'ping', d: { clientMs: 555 } }));
    const pong = c.sent.find((m) => m.t === 'pong');
    expect(pong).toBeDefined();
    if (pong?.t === 'pong') {
      expect(pong.d.clientMs).toBe(555);
      expect(pong.d.serverMs).toBe(1_000);
    }
  });

  it('forwards a valid forecast', () => {
    const onForecast = vi.fn();
    const { b } = bc({ onForecast });
    b.connect(sock('c1').socket);
    b.receive('c1', JSON.stringify({
      t: 'forecast', d: { roundId: 'r1', marketId: 'm1', userAddr: '0xa', p: 0.7 },
    }));
    expect(onForecast).toHaveBeenCalledWith(
      expect.objectContaining({ roundId: 'r1', marketId: 'm1', userAddr: '0xa', p: 0.7 }),
    );
  });

  it('rejects a forecast outside [0,1] at the boundary', () => {
    const onForecast = vi.fn();
    const { b } = bc({ onForecast });
    b.connect(sock('c1').socket);
    for (const p of [1.5, -0.1, Number.NaN, 'x']) {
      b.receive('c1', JSON.stringify({ t: 'forecast', d: { roundId: 'r1', marketId: 'm1', userAddr: '0xa', p } }));
    }
    expect(onForecast).not.toHaveBeenCalled();
    expect(b.statsSnapshot().badMessages).toBe(4);
  });

  it('rejects a forecast missing required fields', () => {
    const onForecast = vi.fn();
    const { b } = bc({ onForecast });
    b.connect(sock('c1').socket);
    b.receive('c1', JSON.stringify({ t: 'forecast', d: { p: 0.5 } }));
    expect(onForecast).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON and unknown message types without crashing', () => {
    const { b } = bc();
    b.connect(sock('c1').socket);
    for (const raw of ['{not json', '', 'null', '42', '{"t":"nope"}', '{"noT":1}']) {
      expect(() => b.receive('c1', raw)).not.toThrow();
    }
    expect(b.statsSnapshot().badMessages).toBeGreaterThanOrEqual(5);
  });

  it('ignores a message from an unknown socket', () => {
    const { b } = bc();
    expect(() => b.receive('ghost', JSON.stringify({ t: 'ping', d: { clientMs: 1 } }))).not.toThrow();
  });
});

describe('T-040 a slow client cannot slow the engine', () => {
  it('drops a client whose send throws', () => {
    const onError = vi.fn();
    const { b, bus } = bc({ onError });
    const c = sock('wedged', { failOnSend: true });
    b.connect(c.socket);
    expect(c.closed).toBe(true);
    expect(b.clientCount).toBe(0);
    expect(onError).toHaveBeenCalled();
    // And the bus keeps working for everyone else.
    const good = sock('good');
    b.connect(good.socket);
    bus.publish({ t: 'fill', d: fill() });
    expect(good.sent.filter((m) => m.t === 'ev')).toHaveLength(1);
  });

  it('drops rather than buffering past its budget', () => {
    const bus = new EventBus();
    // A socket that never returns from send simulates a stalled write; here we
    // approximate it by exceeding the frame budget.
    let depth = 0;
    const s: Socket = {
      id: 'slow',
      send: () => { depth++; if (depth > 2) throw new Error('would block'); },
      close: () => {},
    };
    const b = new Broadcaster({
      bus, snapshot: () => snapshot(), now: () => 1, runId: 'r', maxBufferedFrames: 1,
    });
    b.connect(s);
    for (let i = 0; i < 20; i++) bus.publish({ t: 'fill', d: fill({ fillId: `f${i}` }) });
    expect(b.clientCount).toBe(0);
    expect(b.statsSnapshot().slowClientsDropped + b.statsSnapshot().framesDropped).toBeGreaterThan(0);
  });

  it('fan-out to 50 clients stays far inside the bus budget', () => {
    const { b, bus } = bc();
    for (let i = 0; i < 50; i++) b.connect(sock(`c${i}`).socket);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) bus.publish({ t: 'fill', d: fill({ fillId: `f${i}` }) });
    const perPublish = (performance.now() - t0) / 200;
    expect(perPublish).toBeLessThan(5);
    expect(b.clientCount).toBe(50);
  });
});

describe('T-040 no subscriber leak', () => {
  it('unsubscribes on disconnect across 1 000 cycles', () => {
    const bus = new EventBus();
    const b = new Broadcaster({ bus, snapshot: () => snapshot(), now: () => 1, runId: 'r' });
    for (let i = 0; i < 1_000; i++) {
      b.connect(sock(`c${i}`).socket);
      b.disconnect(`c${i}`);
    }
    expect(b.clientCount).toBe(0);
    expect(bus.totalSubscribers()).toBe(0);
    expect(b.statsSnapshot().disconnected).toBe(1_000);
  });

  it('disconnecting an unknown socket is harmless', () => {
    const { b } = bc();
    expect(() => b.disconnect('ghost')).not.toThrow();
  });

  it('a dropped client receives nothing further', () => {
    const { b, bus } = bc();
    const c = sock('c1');
    b.connect(c.socket);
    const before = c.sent.length;
    b.disconnect('c1');
    bus.publish({ t: 'fill', d: fill() });
    expect(c.sent).toHaveLength(before);
  });
});

// ─────────────────────────────── T-044 MIRROR ───────────────────────────────

const mirror = (over: Partial<ConstructorParameters<typeof MirrorService>[0]> = {}) => {
  const clock = new VirtualClock(1_000);
  return { clock, svc: new MirrorService({ clock, balanceFraction: 0.05, intentTtlMs: 60_000, ...over }) };
};

describe('T-044 MIRROR is never custodial (GWT-4)', () => {
  it('the built intent contains no key and no signature', () => {
    const { svc } = mirror();
    const r = svc.build({
      sourceFill: fill(), market: market(), quote: quote(),
      userAddr: '0xuser', userBalanceUsd: 1_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const json = JSON.stringify(r.intent);
    expect(json).not.toMatch(/privateKey|signature|secret|mnemonic/i);
    expect(Object.keys(r.intent)).not.toContain('signature');
    expect(r.intent.userAddr).toBe('0xuser');
  });

  it('leaves tx null in SIM, so a SIM intent cannot masquerade as signable', () => {
    const { svc } = mirror();
    const r = svc.build({
      sourceFill: fill(), market: market(), quote: quote(),
      userAddr: '0xuser', userBalanceUsd: 1_000,
    });
    expect(r.ok && r.intent.tx).toBeNull();
  });

  it('carries an UnsignedTx with the configured chainId in LIVE', () => {
    const { svc } = mirror({
      chainId: 50_312,
      buildTx: () => ({ to: '0xpool', data: '0xabcd', value: '0', chainId: 50_312 }),
    });
    const r = svc.build({
      sourceFill: fill(), market: market(), quote: quote(),
      userAddr: '0xuser', userBalanceUsd: 1_000,
    });
    expect(r.ok && r.intent.tx?.chainId).toBe(50_312);
    expect(r.ok && r.intent.tx?.data).toBe('0xabcd');
  });
});

describe('T-044 mirroring the right trade', () => {
  it('mirrors the source fill’s market and side exactly', () => {
    const { svc } = mirror();
    for (const side of ['YES', 'NO'] as const) {
      const r = svc.build({
        sourceFill: fill({ side }), market: market(), quote: quote(),
        userAddr: '0xu', userBalanceUsd: 1_000,
      });
      expect(r.ok && r.intent.side).toBe(side);
      expect(r.ok && r.intent.marketId).toBe('m1');
      expect(r.ok && r.intent.sourceFillId).toBe('f1');
    }
  });

  it('sizes as fraction x balance / price, floored to minSize', () => {
    const { svc } = mirror();
    // 0.05 x 1000 = $50 at the 0.41 ask = 121.95 -> 121 contracts
    const r = svc.build({
      sourceFill: fill({ side: 'YES' }), market: market(), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000,
    });
    expect(r.ok && r.intent.sizeContracts).toBe(121);
    expect(r.ok && r.intent.limitPrice).toBeCloseTo(0.41, 12);
  });

  it('prices a NO mirror at 1 - bid', () => {
    const { svc } = mirror();
    const r = svc.build({
      sourceFill: fill({ side: 'NO' }), market: market(), quote: quote({ bid: 0.39 }),
      userAddr: '0xu', userBalanceUsd: 1_000,
    });
    expect(r.ok && r.intent.limitPrice).toBeCloseTo(0.61, 12);
  });

  it('honours a caller-supplied fraction', () => {
    const { svc } = mirror();
    const a = svc.build({ sourceFill: fill(), market: market(), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000, balanceFraction: 0.10 });
    const b = svc.build({ sourceFill: fill(), market: market(), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000, balanceFraction: 0.05 });
    expect(a.ok && b.ok && a.intent.sizeContracts).toBeGreaterThan(b.ok ? b.intent.sizeContracts : 0);
  });

  it('floors to the venue grid and never rounds a user’s size UP', () => {
    const { svc } = mirror();
    const r = svc.build({
      sourceFill: fill(), market: market({ minSize: 10 }), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000,
    });
    expect(r.ok && r.intent.sizeContracts).toBe(120);      // not 121, not 130
  });

  it('caps at available depth rather than promising an unfillable order', () => {
    const { svc } = mirror();
    const r = svc.build({
      sourceFill: fill({ side: 'YES' }), market: market(), quote: quote({ depthAsk: 7 }),
      userAddr: '0xu', userBalanceUsd: 1_000,
    });
    expect(r.ok && r.intent.sizeContracts).toBe(7);
  });

  it('completes well inside the GWT-4 two-second budget', () => {
    const { svc } = mirror();
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i++) {
      svc.build({ sourceFill: fill(), market: market(), quote: quote(),
        userAddr: '0xu', userBalanceUsd: 1_000 });
    }
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(svc.statsSnapshot().lastBuildMs).toBeLessThan(2_000);
  });
});

describe('T-044 refusals are readable sentences', () => {
  const cases: [string, () => ReturnType<MirrorService['build']>, RegExp][] = [
    ['no wallet', () => mirror().svc.build({
      sourceFill: fill(), market: market(), quote: quote(), userAddr: '', userBalanceUsd: 1_000,
    }), /connect a wallet/i],
    ['halted market', () => mirror().svc.build({
      sourceFill: fill(), market: market({ status: 'Locked' }), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000,
    }), /locked/i],
    ['settled market', () => mirror().svc.build({
      sourceFill: fill(), market: market({ status: 'Resolved' }), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000,
    }), /resolved/i],
    ['expired market', () => mirror().svc.build({
      sourceFill: fill(), market: market({ expiryMs: 500 }), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000,
    }), /expired/i],
    ['zero balance', () => mirror().svc.build({
      sourceFill: fill(), market: market(), quote: quote(), userAddr: '0xu', userBalanceUsd: 0,
    }), /balance is zero/i],
    ['below minimum', () => mirror().svc.build({
      sourceFill: fill(), market: market({ minSize: 100 }), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 10,
    }), /minimum/i],
    ['no depth', () => mirror().svc.build({
      sourceFill: fill({ side: 'YES' }), market: market(), quote: quote({ depthAsk: 0 }),
      userAddr: '0xu', userBalanceUsd: 1_000,
    }), /depth/i],
  ];

  for (const [name, run, pattern] of cases) {
    it(`refuses on ${name}, with a reason a spectator can read`, () => {
      const r = run();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(pattern);
        expect(r.reason.length).toBeGreaterThan(10);
        expect(r.reason).not.toMatch(/undefined|NaN|\[object/);
      }
    });
  }

  it('rejects a stale source fill with its age', () => {
    const { clock, svc } = mirror({ maxSourceAgeMs: 10_000 });
    clock.advance(30_000);
    const r = svc.build({
      sourceFill: fill({ tsMs: 1_000 }), market: market(), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stale/i);
  });

  it('rejects a construction-time bad fraction', () => {
    const clock = new VirtualClock(0);
    expect(() => new MirrorService({ clock, balanceFraction: 0 })).toThrow();
    expect(() => new MirrorService({ clock, balanceFraction: 1.5 })).toThrow();
  });

  it('counts rejections', () => {
    const { svc } = mirror();
    svc.build({ sourceFill: fill(), market: market(), quote: quote(), userAddr: '', userBalanceUsd: 1 });
    expect(svc.statsSnapshot().rejected).toBe(1);
  });
});

describe('T-044 intent expiry', () => {
  it('expires after its TTL', () => {
    const { clock, svc } = mirror({ intentTtlMs: 30_000 });
    const r = svc.build({ sourceFill: fill(), market: market(), quote: quote(),
      userAddr: '0xu', userBalanceUsd: 1_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(svc.isExpired(r.intent)).toBe(false);
    clock.advance(30_001);
    expect(svc.isExpired(r.intent)).toBe(true);
  });
});

// ────────────────────────── T-041 REST + T-045 console ──────────────────────

const TOKEN = 'operator-secret-token';

const router = (over: Partial<ConstructorParameters<typeof RestRouter>[0]> = {}) => {
  const actions = {
    kill: vi.fn(), unkill: vi.fn(), setMode: vi.fn(),
    triggerScenario: vi.fn(), forceRoundClose: vi.fn(),
  };
  const settlement: Settlement = {
    roundId: 'r1', miraPnlUsd: 10, potUsd: 10, scores: [], payouts: [],
    method: 'BRIER_PRO_RATA', journalSeq: 1, tsMs: 1,
  };
  const r = new RestRouter({
    snapshot: () => snapshot(),
    health: () => health(),
    leaderboard: () => [{ userAddr: '0xa', roundId: 'r1', brier: 0.1, nForecasts: 2, rank: 1 }],
    rounds: () => ({ round: null, history: [settlement] }),
    agentProfile: () => ({ agent: 'MIRA', model: 'F1/F2 barrier', kellyFraction: 0.25 }),
    mirror: () => ({ status: 200, body: { ok: true } }),
    forecast: () => ({ status: 202, body: { accepted: true } }),
    console: actions,
    operatorToken: TOKEN,
    webOrigin: 'http://localhost:3000',
    ...over,
  });
  return { r, actions };
};

const req = (over: Partial<RestRequest> = {}): RestRequest => ({
  method: 'GET', path: '/api/health', query: {}, body: null, headers: {}, ...over,
});

const authed = (over: Partial<RestRequest> = {}): RestRequest =>
  req({ ...over, headers: { authorization: `Bearer ${TOKEN}`, ...(over.headers ?? {}) } });

describe('T-041 every route responds with its shape', () => {
  it('serves all GET routes with 200 and JSON', async () => {
    const { r } = router();
    for (const path of ['/api/health', '/api/snapshot', '/api/leaderboard',
      '/api/rounds', '/api/agent/mira', '/api/console/scenarios']) {
      const res = await r.handle(req({ path }));
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toBeTruthy();
    }
  });

  it('serves a round by id and 404s an unknown one', async () => {
    const { r } = router();
    expect((await r.handle(req({ path: '/api/rounds/r1' }))).status).toBe(200);
    const miss = await r.handle(req({ path: '/api/rounds/nope' }));
    expect(miss.status).toBe(404);
    expect(miss.body).toEqual({ error: 'round nope not found' });
  });

  it('lists scenarios from the frozen union, so none can be invented', async () => {
    const { r } = router();
    const res = await r.handle(req({ path: '/api/console/scenarios' }));
    expect((res.body as { scenarios: string[] }).scenarios).toEqual([...SCENARIO_NAMES]);
  });

  it('returns JSON on 404, never an HTML error page', async () => {
    const { r } = router();
    const res = await r.handle(req({ path: '/api/nope' }));
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 405 for an unsupported method', async () => {
    const { r } = router();
    expect((await r.handle(req({ method: 'DELETE', path: '/api/health' }))).status).toBe(405);
  });

  it('returns 400 on a malformed JSON body', async () => {
    const { r } = router();
    const res = await r.handle(req({ method: 'POST', path: '/api/mirror', body: '{not json' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'body is not valid JSON' });
  });
});

describe('T-041 health is "fit to trade", not "process is up"', () => {
  it('includes tick lag, journal seq, kill switch and venue health', async () => {
    const { r } = router();
    const body = (await r.handle(req({ path: '/api/health' }))).body as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true, tickLagMs: 100, journalSeq: 42, killSwitch: false, mode: 'SIM', runId: 'run-1',
    });
    expect(body['venue']).toBeTruthy();
    expect(body['components']).toBeTruthy();
  });

  it('reports not-ok when tick lag exceeds the alarm threshold', async () => {
    const { r } = router({ health: () => health({ tickLagMs: 30_000 }), tickLagAlarmMs: 5_000 });
    const body = (await r.handle(req({ path: '/api/health' }))).body as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['tickLagAlarm']).toBe(true);
  });

  it('reports not-ok when any component is down', async () => {
    const { r } = router({
      health: () => health({ components: { engine: { ok: false, detail: 'stalled' } } }),
    });
    expect(((await r.handle(req({ path: '/api/health' }))).body as { ok: boolean }).ok).toBe(false);
  });

  it('reports not-ok when the venue is unhealthy', async () => {
    const { r } = router({
      health: () => health({ venue: { ok: false, mode: 'LIVE', name: 'DreamDEXVenue',
        blockNumber: null, latencyMs: null, lastErrorMs: 1, detail: 'rpc down' } }),
    });
    expect(((await r.handle(req({ path: '/api/health' }))).body as { ok: boolean }).ok).toBe(false);
  });

  it('reports not-ok while the kill switch is tripped', async () => {
    const { r } = router({ health: () => health({ killSwitch: true }) });
    expect(((await r.handle(req({ path: '/api/health' }))).body as { ok: boolean }).ok).toBe(false);
  });
});

describe('T-041 CORS allows only the web origin', () => {
  it('reflects the configured origin', async () => {
    const { r } = router();
    const res = await r.handle(req({ path: '/api/health', origin: 'http://localhost:3000' }));
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('sends no CORS header for any other origin', async () => {
    const { r } = router();
    const res = await r.handle(req({ path: '/api/health', origin: 'https://evil.example' }));
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight', async () => {
    const { r } = router();
    const res = await r.handle(req({ method: 'OPTIONS', path: '/api/health', origin: 'http://localhost:3000' }));
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('T-041 forecast validation at the boundary', () => {
  it('accepts a valid forecast', async () => {
    const forecast = vi.fn(() => ({ status: 202, body: { accepted: true } }));
    const { r } = router({ forecast });
    const res = await r.handle(req({
      method: 'POST', path: '/api/forecast',
      body: JSON.stringify({ roundId: 'r1', marketId: 'm1', userAddr: '0xa', p: 0.7 }),
    }));
    expect(res.status).toBe(202);
    expect(forecast).toHaveBeenCalled();
  });

  it('rejects a p outside [0,1] and missing fields', async () => {
    const forecast = vi.fn(() => ({ status: 202, body: {} }));
    const { r } = router({ forecast });
    for (const body of [
      { roundId: 'r1', marketId: 'm1', userAddr: '0xa', p: 1.5 },
      { roundId: 'r1', marketId: 'm1', userAddr: '0xa', p: -0.1 },
      { roundId: 'r1', marketId: 'm1', userAddr: '0xa' },
      { marketId: 'm1', userAddr: '0xa', p: 0.5 },
    ]) {
      const res = await r.handle(req({ method: 'POST', path: '/api/forecast', body: JSON.stringify(body) }));
      expect(res.status).toBe(400);
    }
    expect(forecast).not.toHaveBeenCalled();
  });
});

describe('T-045 the console is operator-gated (GWT-7, GWT-8)', () => {
  it('refuses every console route without a token', async () => {
    const { r, actions } = router();
    for (const [path, body] of [
      ['/api/console/kill', {}],
      ['/api/console/mode', { mode: 'SIM' }],
      ['/api/console/scenario', { name: 'VOL_SPIKE' }],
      ['/api/console/round/close', {}],
    ] as const) {
      const res = await r.handle(req({ method: 'POST', path, body: JSON.stringify(body) }));
      expect(res.status, path).toBe(401);
      expect(res.body).toEqual({ error: 'operator token required' });
    }
    expect(actions.kill).not.toHaveBeenCalled();
    expect(actions.setMode).not.toHaveBeenCalled();
    expect(actions.triggerScenario).not.toHaveBeenCalled();
  });

  it('refuses a wrong token', async () => {
    const { r } = router();
    const res = await r.handle(req({
      method: 'POST', path: '/api/console/kill', body: '{}',
      headers: { authorization: 'Bearer wrong-token-same-len!!' },
    }));
    expect(res.status).toBe(401);
  });

  it('compares the token in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('kills and unkills with a token (GWT-7)', async () => {
    const { r, actions } = router();
    const on = await r.handle(authed({ method: 'POST', path: '/api/console/kill', body: JSON.stringify({ by: 'director' }) }));
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ killSwitch: true, by: 'director' });
    expect(actions.kill).toHaveBeenCalledWith('director');

    const off = await r.handle(authed({ method: 'POST', path: '/api/console/kill', body: JSON.stringify({ on: false, by: 'director' }) }));
    expect(off.body).toEqual({ killSwitch: false, by: 'director' });
    expect(actions.unkill).toHaveBeenCalledWith('director');
  });

  it('swaps the mode with a token (GWT-8)', async () => {
    const { r, actions } = router();
    const res = await r.handle(authed({ method: 'POST', path: '/api/console/mode', body: JSON.stringify({ mode: 'SIM' }) }));
    expect(res.status).toBe(200);
    expect(actions.setMode).toHaveBeenCalledWith('SIM');
  });

  it('rejects an unknown mode', async () => {
    const { r, actions } = router();
    const res = await r.handle(authed({ method: 'POST', path: '/api/console/mode', body: JSON.stringify({ mode: 'PROD' }) }));
    expect(res.status).toBe(400);
    expect(actions.setMode).not.toHaveBeenCalled();
  });

  it('triggers a named scenario and rejects an invented one', async () => {
    const { r, actions } = router();
    const ok = await r.handle(authed({ method: 'POST', path: '/api/console/scenario', body: JSON.stringify({ name: 'VOL_SPIKE' }) }));
    expect(ok.status).toBe(200);
    expect(actions.triggerScenario).toHaveBeenCalledWith('VOL_SPIKE');

    const bad = await r.handle(authed({ method: 'POST', path: '/api/console/scenario', body: JSON.stringify({ name: 'MAKE_MONEY' }) }));
    expect(bad.status).toBe(400);
    expect(actions.triggerScenario).toHaveBeenCalledTimes(1);
  });

  it('force-closes a round for the HUNT beat', async () => {
    const { r, actions } = router();
    const res = await r.handle(authed({ method: 'POST', path: '/api/console/round/close', body: '{}' }));
    expect(res.status).toBe(200);
    expect(actions.forceRoundClose).toHaveBeenCalled();
  });

  it('404s force-close when the deployment does not support it', async () => {
    const { r } = router({
      console: { kill: vi.fn(), unkill: vi.fn(), setMode: vi.fn(), triggerScenario: vi.fn() },
    });
    expect((await r.handle(authed({ method: 'POST', path: '/api/console/round/close', body: '{}' }))).status).toBe(404);
  });
});

describe('T-041 parseUrl', () => {
  it('splits a path from a query string', () => {
    expect(parseUrl('/api/rounds?limit=5&since=abc'))
      .toEqual({ path: '/api/rounds', query: { limit: '5', since: 'abc' } });
  });
  it('handles a bare path and decodes values', () => {
    expect(parseUrl('/api/health')).toEqual({ path: '/api/health', query: {} });
    expect(parseUrl('/x?a=hello%20world').query['a']).toBe('hello world');
  });
  it('tolerates an empty or odd query', () => {
    expect(parseUrl('/x?').query).toEqual({});
    expect(parseUrl('/x?flag').query['flag']).toBe('');
  });
});
