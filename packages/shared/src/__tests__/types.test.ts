// T-002 — every 20-INTERFACES §1–§14 contract must exist and be usable.
// Types erase at runtime, so type presence is asserted at COMPILE time (each
// `satisfies` below fails `npm run typecheck` if its contract is missing or the
// wrong shape) and runtime values are asserted here.
import { describe, it, expect } from 'vitest';
import type {
  Ms, Usd, Prob, Vol, Side, Mode, SettlementStyle, AgentId, SkipReason,
  OrderKind, OrderType, MarketStatus, MarketMode,
  Market, Tick, Quote, ModelState, Valuation, SignalAction, Signal, HysteresisState,
  Order, OrderAck, CancelAck, Fill, Position,
  VenueHealth, Venue, Claimable, ClaimResult,
  RiskConfig, RiskVerdict, JournalKind, JournalEvent, BusEvent, Bus,
  ReconcileReport, DriftItem, Round, Forecast, Outcome, Score, Payout, Settlement,
  MirrorIntent, UnsignedTx, ServerMsg, ClientMsg, ArenaSnapshot,
  ScenarioName, ScenarioStep, ScenarioScript, HealthSnapshot, Quip,
} from '../index.ts';
import {
  SIDES, MODES, SETTLEMENT_STYLES, ORDER_KINDS, ORDER_TYPES, MARKET_STATUSES,
  MARKET_MODES, SKIP_REASONS, SIGNAL_ACTIONS, JOURNAL_KINDS, SCENARIO_NAMES,
  BUS_TOPICS, TRADABLE_STATUS, THROTTLE, sideOf, kindFor, oppositeSide,
} from '../index.ts';

describe('T-002 §1 primitives', () => {
  it('exposes every union as a runtime tuple so validation is possible', () => {
    expect([...SIDES]).toEqual(['YES', 'NO']);
    expect([...MODES]).toEqual(['LIVE', 'SIM']);
    expect([...SETTLEMENT_STYLES]).toEqual(['EXPIRY', 'TOUCH']);
    expect([...ORDER_KINDS]).toEqual(['BUY_YES', 'SELL_YES', 'BUY_NO', 'SELL_NO']);
    expect([...ORDER_TYPES]).toEqual(['LIMIT', 'MARKET', 'FILL_OR_KILL', 'POST_ONLY']);
    expect([...MARKET_MODES]).toEqual(['fixed', 'reference']);
  });

  it('MARKET_STATUSES matches the on-chain enum order exactly (RFC-001 A3)', () => {
    // Listed 0 · Trading 1 · Locked 2 · Settling 3 · Resolved 4 · Voided 5
    expect([...MARKET_STATUSES]).toEqual(['Listed', 'Trading', 'Locked', 'Settling', 'Resolved', 'Voided']);
    expect(MARKET_STATUSES.indexOf('Trading')).toBe(1);
    expect(TRADABLE_STATUS).toBe('Trading');
  });

  it('SKIP_REASONS includes the two reasons the spikes discovered (RFC-001 A4)', () => {
    expect(SKIP_REASONS).toContain('NEGATIVE_DISCRIMINANT');
    expect(SKIP_REASONS).toContain('BOUNDARY_NOT_POSTED');
    expect(SKIP_REASONS).toContain('NOT_TRADABLE');
  });

  it('BUS_TOPICS covers every BusEvent variant in IF §9', () => {
    for (const t of ['tick', 'model', 'valuation', 'signal', 'order', 'ack', 'fill', 'cancel',
      'position', 'reconcile', 'risk', 'kill', 'mode', 'scenario', 'round', 'settlement',
      'forecast', 'quip', 'health', 'error']) expect(BUS_TOPICS).toContain(t);
  });

  it('JOURNAL_KINDS and SCENARIO_NAMES match IF §8/§14', () => {
    expect(JOURNAL_KINDS).toContain('settlement');
    expect(JOURNAL_KINDS).toContain('reconcile');
    expect(SIGNAL_ACTIONS).toEqual(['ENTER', 'HOLD', 'STAND_DOWN', 'SKIP']);
    for (const s of ['VOL_SPIKE', 'NEWS_SHOCK', 'FLAT_DRIFT', 'DROPPED_TX', 'NONCE_CLASH',
      'STALE_QUOTE', 'THIN_BOOK']) expect(SCENARIO_NAMES).toContain(s);
  });
});

describe('T-002 side/kind mapping (RFC-001 A1)', () => {
  it('kindFor maps (side, buy|sell) onto the venue four kinds', () => {
    expect(kindFor('YES', 'BUY')).toBe('BUY_YES');
    expect(kindFor('YES', 'SELL')).toBe('SELL_YES');
    expect(kindFor('NO', 'BUY')).toBe('BUY_NO');
    expect(kindFor('NO', 'SELL')).toBe('SELL_NO');
  });
  it('sideOf recovers the side from any kind', () => {
    expect(ORDER_KINDS.map(sideOf)).toEqual(['YES', 'YES', 'NO', 'NO']);
  });
  it('buying NO is a distinct kind from selling YES (they differ in escrow)', () => {
    expect(kindFor('NO', 'BUY')).not.toBe(kindFor('YES', 'SELL'));
  });
  it('oppositeSide is an involution', () => {
    for (const s of SIDES) expect(oppositeSide(oppositeSide(s))).toBe(s);
  });
});

describe('T-002 THROTTLE constants are the MEASURED values (docs/spikes/S4-limits.md)', () => {
  it('serializes indexer reads — concurrency is what broke it', () => {
    expect(THROTTLE.indexerMaxInFlight).toBe(1);
  });
  it('carries every measured constant', () => {
    expect(THROTTLE).toMatchObject({
      indexerMaxInFlight: 1, marketsCacheMs: 15_000, quoteCacheMs: 1_500,
      priceFeedPollMs: 500, reconcilePollMs: 3_000, rpcMaxInFlight: 4,
      indexerTimeoutMs: 12_000, indexerRetries: 2, backoffBaseMs: 400, backoffMaxMs: 10_000,
    });
  });
  it('reconcile poll leaves headroom under the GWT-6 10 s self-correct budget', () => {
    expect(THROTTLE.reconcilePollMs * 3).toBeLessThan(10_000);
  });
});

// ─── Compile-time contract presence. A missing/renamed type fails typecheck. ───
describe('T-002 contract shapes compile', () => {
  it('constructs a value of every IF contract', () => {
    const ms: Ms = 1; const usd: Usd = 1; const p: Prob = 0.5; const v: Vol = 0.5;
    const side: Side = 'YES'; const mode: Mode = 'SIM'; const style: SettlementStyle = 'EXPIRY';
    const agent: AgentId = 'MIRA'; const skip: SkipReason = 'BOUNDARY_NOT_POSTED';
    const kind: OrderKind = 'BUY_YES'; const otype: OrderType = 'POST_ONLY';
    const status: MarketStatus = 'Trading'; const mmode: MarketMode = 'reference';
    const action: SignalAction = 'ENTER'; const jk: JournalKind = 'fill';
    const sn: ScenarioName = 'VOL_SPIKE';

    const market: Market = { id: '0x1', symbol: 'BTC/tUSDC', yesSymbol: 'y', noSymbol: 'n',
      asset: 'BTC', strike: 79335.25, mode: 'fixed', boundaryPosted: true, intervalSec: 60,
      tradingStartMs: ms, expiryMs: ms + 60_000, style, tickRaw: 1000n, lotRaw: 1n,
      priceDecimals: 6, minSize: 1, feeBps: 0, poolAddress: null, nonce: null,
      venue: 'SIM', status };
    const tick: Tick = { symbol: 'BTC', price: 1, tsMs: ms, seq: 1, source: 'somnia-feed' };
    const quote: Quote = { marketId: '0x1', bid: 0.4, ask: 0.6, mid: 0.5, depthBid: 1, depthAsk: 1, stale: false, tsMs: ms };
    const model: ModelState = { symbol: 'BTC', spot: 1, sigmaForecast: v, variance: 1, lambda: 0.97, nObs: 1, tsMs: ms };
    const val: Valuation = { marketId: '0x1', style, spot: 1, strike: 1, tauYears: 1e-6,
      pModel: p, pMarket: p, sigmaForecast: v, sigmaImplied: v, edge: 0, skipReason: null, tsMs: ms };
    const sig: Signal = { id: 's', marketId: '0x1', agent, action, side, edge: 0, pModel: p,
      pMarket: p, sizeContracts: 0, kellyFull: 0, kellyApplied: 0, reason: '', valuation: val, tsMs: ms };
    const hyst: HysteresisState = { marketId: '0x1', engaged: false, lastActionTsMs: ms, cooldownUntilMs: ms };
    const order: Order = { clientOrderId: 'c', marketId: '0x1', agent, side, kind, type: otype,
      limitPrice: p, limitPriceRaw: 1n, sizeContracts: 1, sizeRaw: 1n, expiresMs: ms, signalId: null, tsMs: ms };
    const ack: OrderAck = { clientOrderId: 'c', venueOrderId: null, status: 'ACCEPTED', txHash: null, reason: null, tsMs: ms };
    const cack: CancelAck = { clientOrderId: 'c', status: 'CANCELLED', txHash: null, tsMs: ms };
    const fill: Fill = { fillId: 'f', clientOrderId: 'c', venueOrderId: null, marketId: '0x1',
      agent, side, sizeContracts: 1, price: p, feeUsd: 0, txHash: null, explorerUrl: null, tsMs: ms };
    const pos: Position = { marketId: '0x1', agent, netContracts: 0, avgPrice: p, markPrice: p,
      realizedPnlUsd: 0, unrealizedPnlUsd: 0, tsMs: ms };
    const vh: VenueHealth = { ok: true, mode, name: 'SimulatedVenue', blockNumber: null,
      latencyMs: null, lastErrorMs: null, detail: null };
    const claimable: Claimable = { marketId: '0x1', symbol: 's', expiryMs: ms, outcomeIdx: 0, sizeContracts: 1, estPayoutUsd: 1 };
    const cres: ClaimResult = { marketId: '0x1', claimed: true, amountUsd: 1, txHash: null, reason: null, tsMs: ms };
    const risk: RiskConfig = { maxNetContractsPerMarket: 1, maxGrossContracts: 1, maxNotionalUsd: 1,
      maxSessionLossUsd: 1, maxOrdersPerMinute: 1, cooldownMs: 1, edgeIn: 0.06, edgeOut: 0.02,
      kellyFraction: 0.25, minEdgeFloor: 0.015, maxQuoteAgeMs: 4000, killSwitch: false };
    const verdict: RiskVerdict = { ok: false, rule: 'r', detail: 'd' };
    const je: JournalEvent = { seq: 1, kind: jk, tsMs: ms, mode, runId: 'r', payload: {} };
    const be: BusEvent = { t: 'tick', d: tick };
    const drift: DriftItem = { marketId: '0x1', localNet: 0, chainNet: 1, localAvg: p, chainAvg: p, action: 'ADOPT_CHAIN' };
    const rr: ReconcileReport = { tsMs: ms, checked: 1, drifted: [drift], correctedFrom: 'chain', durationMs: 1 };
    const round: Round = { roundId: 'r', index: 1, openMs: ms, closeMs: ms, status: 'OPEN',
      marketIds: [], miraPnlUsd: 0, potUsd: 0, topN: 5 };
    const fc: Forecast = { forecastId: 'f', roundId: 'r', marketId: '0x1', userAddr: '0xu', p, tsMs: ms };
    const oc: Outcome = { marketId: '0x1', roundId: 'r', resolved: false, outcome: null, resolvedTsMs: null };
    const score: Score = { userAddr: '0xu', roundId: 'r', brier: 0.1, nForecasts: 1, rank: 1 };
    const payout: Payout = { userAddr: '0xu', brier: 0.1, weight: 1, amountUsd: 1 };
    const settle: Settlement = { roundId: 'r', miraPnlUsd: 1, potUsd: 1, scores: [score],
      payouts: [payout], method: 'BRIER_PRO_RATA', journalSeq: 1, tsMs: ms };
    const utx: UnsignedTx = { to: '0x0', data: '0x', value: '0', chainId: 50312 };
    const intent: MirrorIntent = { intentId: 'i', sourceFillId: 'f', marketId: '0x1', side,
      sizeContracts: 1, limitPrice: p, userAddr: '0xu', balanceFraction: 0.05, tx: utx, expiresMs: ms };
    const step: ScenarioStep = { atMs: ms, op: 'setVol', value: 1 };
    const script: ScenarioScript = { name: sn, durationMs: 1, steps: [step] };
    const quip: Quip = { quipId: 'q', text: 't', roundId: null, trigger: 'x', tsMs: ms };
    const health: HealthSnapshot = { tsMs: ms, mode, runId: 'r', components: {}, tickLagMs: 0,
      ticksPerSec: 0, journalSeq: 1, killSwitch: false, venue: vh };
    const snap: ArenaSnapshot = { runId: 'r', mode, markets: [market], model, valuations: [val],
      positions: [pos], tape: [fill], pnlCurve: [{ tsMs: ms, pnlUsd: 0 }], round, leaderboard: [score],
      health, quips: [quip] };
    const smsg: ServerMsg = { t: 'snapshot', d: snap };
    const cmsg: ClientMsg = { t: 'forecast', d: { roundId: 'r', marketId: '0x1', userAddr: '0xu', p } };

    // Venue is structural: this object must satisfy the full interface (RFC-001 A5/A6/A7).
    const venue: Venue = {
      name: 'SimulatedVenue', mode: 'SIM', agent: 'MIRA',
      connect: async () => {}, disconnect: async () => {}, now: () => ms,
      getMarkets: async () => [market], getQuote: async () => quote,
      placeOrder: async () => ack, cancel: async () => cack, cancelAll: async () => [cack],
      positions: async () => [pos], balanceUsd: async () => usd, health: async () => vh,
      onFill: () => () => {},
      settledMarkets: async () => [market], claimable: async () => [claimable],
      claim: async () => cres, mintPair: async () => ack,
    };

    // Every binding is used, so tsc cannot elide the checks above.
    expect([ms, usd, p, v, side, mode, style, agent, skip, kind, otype, status, mmode, action, jk, sn,
      market, tick, quote, model, val, sig, hyst, order, ack, cack, fill, pos, vh, claimable, cres,
      risk, verdict, je, be, drift, rr, round, fc, oc, score, payout, settle, utx, intent, step,
      script, quip, health, snap, smsg, cmsg, venue].every((x) => x !== undefined)).toBe(true);
  });
});
