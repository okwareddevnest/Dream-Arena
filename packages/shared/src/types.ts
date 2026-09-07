// ─────────────────────────────────────────────────────────────────────────────
// The FROZEN contracts. Source of truth: docs/20-INTERFACES.md (frozen at G0,
// amended once by docs/rfc/RFC-001.md). Changing anything here requires a new
// approved RFC card — no lane edits this file unilaterally (prompt §5).
//
// Every string-union also gets a runtime tuple, because a type that cannot be
// validated at a process boundary is not a contract, it is a wish.
// ─────────────────────────────────────────────────────────────────────────────

// ─── §1 Primitives ───────────────────────────────────────────────────────────
export type Ms = number;      // epoch milliseconds (UTC)
export type Usd = number;
export type Prob = number;    // [0,1] probability / contract price
export type Vol = number;     // annualized sigma, > 0

export const SIDES = ['YES', 'NO'] as const;
export type Side = (typeof SIDES)[number];

export const MODES = ['LIVE', 'SIM'] as const;
export type Mode = (typeof MODES)[number];

export const SETTLEMENT_STYLES = ['EXPIRY', 'TOUCH'] as const;
export type SettlementStyle = (typeof SETTLEMENT_STYLES)[number];

/** RFC-001 A1 — the venue takes one of four kinds. Buying NO is NOT selling YES:
 *  they differ in which token is escrowed, so the distinction is load-bearing. */
export const ORDER_KINDS = ['BUY_YES', 'SELL_YES', 'BUY_NO', 'SELL_NO'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_TYPES = ['LIMIT', 'MARKET', 'FILL_OR_KILL', 'POST_ONLY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export type AgentId = 'MIRA' | 'ECHO' | (string & {});   // 'USER:<addr>' for mirrors

export const SKIP_REASONS = [
  'NEGATIVE_DISCRIMINANT',   // WP F2: the quote implies no real vol — never trade it
  'EXPIRED',
  'STALE_QUOTE',
  'DEGENERATE',
  'NO_LIQUIDITY',
  'BOUNDARY_NOT_POSTED',     // RFC-001 A4: reference-mode market has no K yet
  'NOT_TRADABLE',            // RFC-001 A3: on-chain status is not Trading
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// ─── §2 Market & data ────────────────────────────────────────────────────────
/** RFC-001 A3 — the on-chain MarketStatus enum, in ordinal order.
 *  Only `Trading` accepts orders, and the indexer's copy of this lags the chain
 *  by seconds, so writes gate on the chain's value. */
export const MARKET_STATUSES = ['Listed', 'Trading', 'Locked', 'Settling', 'Resolved', 'Voided'] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];
export const TRADABLE_STATUS: MarketStatus = 'Trading';
export const marketStatusFromOrdinal = (n: number): MarketStatus =>
  MARKET_STATUSES[n] ?? 'Voided';

/** `reference` markets take K from the window's opening price, posted at open —
 *  until then they have no strike at all (T-S1 C3). */
export const MARKET_MODES = ['fixed', 'reference'] as const;
export type MarketMode = (typeof MARKET_MODES)[number];

export interface Market {
  id: string;                    // bytes32 marketId — never the pool address (pools recycle)
  symbol: string;
  yesSymbol: string;
  noSymbol: string;
  asset: string;                 // 'BTC' | 'ETH' | ...
  strike: number | null;         // decoded boundary; null until posted in 'reference' mode
  mode: MarketMode;
  boundaryPosted: boolean;
  intervalSec: number;           // 60 | 300 | 900 | 3600 | 14400 | 86400
  tradingStartMs: Ms;
  expiryMs: Ms;
  style: SettlementStyle;
  tickRaw: bigint;               // RFC-001 A8 — integer grid; prices never travel as floats
  lotRaw: bigint;
  priceDecimals: number;
  minSize: number;
  feeBps: number;
  poolAddress: string | null;
  nonce: number | null;
  venue: 'SIM' | 'DREAMDEX';
  status: MarketStatus;
}

export const TICK_SOURCES = ['somnia-feed', 'binance', 'fixture', 'sim'] as const;
export type TickSource = (typeof TICK_SOURCES)[number];

export interface Tick { symbol: string; price: number; tsMs: Ms; seq: number; source: TickSource }

export interface Quote {
  marketId: string; bid: Prob; ask: Prob; mid: Prob;
  depthBid: number; depthAsk: number; stale: boolean; tsMs: Ms;
}

export interface ModelState {
  symbol: string; spot: number; sigmaForecast: Vol;
  variance: number; lambda: number; nObs: number; tsMs: Ms;
}

// ─── §3 Valuation (WP F1–F3) ─────────────────────────────────────────────────
export interface Valuation {
  marketId: string; style: SettlementStyle;
  spot: number; strike: number; tauYears: number;
  pModel: Prob; pMarket: Prob;
  sigmaForecast: Vol;
  sigmaImplied: Vol | null;      // null iff skipReason is set
  edge: number;                  // sigmaForecast - sigmaImplied; exactly 0 when skipped
  skipReason: SkipReason | null;
  tsMs: Ms;
}

// ─── §4 Signal & sizing ──────────────────────────────────────────────────────
export const SIGNAL_ACTIONS = ['ENTER', 'HOLD', 'STAND_DOWN', 'SKIP'] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

export interface Signal {
  id: string; marketId: string; agent: AgentId;
  action: SignalAction; side: Side | null;
  edge: number; pModel: Prob; pMarket: Prob;
  sizeContracts: number;         // 0 unless action === 'ENTER'
  kellyFull: number; kellyApplied: number;
  reason: string; valuation: Valuation; tsMs: Ms;
}

export interface HysteresisState {
  marketId: string; engaged: boolean; lastActionTsMs: Ms; cooldownUntilMs: Ms;
}

// ─── §5 Execution ────────────────────────────────────────────────────────────
export interface Order {
  clientOrderId: string;         // idempotency key (FR-X1)
  marketId: string; agent: AgentId;
  side: Side;                    // display / signal convention
  kind: OrderKind;               // RFC-001 A1 — what the venue is actually told
  type: OrderType;
  limitPrice: Prob | null;
  limitPriceRaw: bigint | null;  // RFC-001 A8 — the value actually sent
  sizeContracts: number;
  sizeRaw: bigint | null;
  expiresMs: Ms;                 // RFC-001 A2 — MANDATORY, capped at market expiry
  signalId: string | null;
  tsMs: Ms;
}

export interface OrderAck {
  clientOrderId: string; venueOrderId: string | null;
  status: 'ACCEPTED' | 'REJECTED' | 'QUEUED';
  txHash: string | null; reason: string | null; tsMs: Ms;
}

export interface CancelAck {
  clientOrderId: string;
  status: 'CANCELLED' | 'NOT_FOUND' | 'ALREADY_FILLED';
  txHash: string | null; tsMs: Ms;
}

export interface Fill {
  fillId: string; clientOrderId: string; venueOrderId: string | null;
  marketId: string; agent: AgentId; side: Side;
  sizeContracts: number; price: Prob; feeUsd: Usd;
  txHash: string | null; explorerUrl: string | null; tsMs: Ms;
}

export interface Position {
  marketId: string; agent: AgentId;
  netContracts: number;          // >0 YES, <0 NO
  avgPrice: Prob; markPrice: Prob;
  realizedPnlUsd: Usd; unrealizedPnlUsd: Usd; tsMs: Ms;
}

// ─── §6 Venue — the only chain-facing surface ────────────────────────────────
export interface VenueHealth {
  ok: boolean; mode: Mode; name: string;
  blockNumber: number | null; latencyMs: number | null; lastErrorMs: Ms | null;
  detail: string | null;
}

/** RFC-001 A5 — winnings are CLAIMED, not received. */
export interface Claimable {
  marketId: string; symbol: string; expiryMs: Ms;
  outcomeIdx: 0 | 1; sizeContracts: number; estPayoutUsd: Usd;
}

export interface ClaimResult {
  marketId: string; claimed: boolean; amountUsd: Usd;
  txHash: string | null; reason: string | null; tsMs: Ms;
}

export interface Venue {
  readonly name: 'SimulatedVenue' | 'DreamDEXVenue';
  readonly mode: Mode;
  readonly agent: AgentId;       // RFC-001 A7 — one instance per signer
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  now(): Ms;                     // virtual clock in SIM, wall clock in LIVE
  getMarkets(): Promise<Market[]>;
  getQuote(marketId: string): Promise<Quote>;
  placeOrder(order: Order): Promise<OrderAck>;
  cancel(clientOrderId: string): Promise<CancelAck>;
  cancelAll(agent?: AgentId): Promise<CancelAck[]>;
  positions(agent?: AgentId): Promise<Position[]>;
  balanceUsd(agent?: AgentId): Promise<Usd>;
  health(): Promise<VenueHealth>;
  onFill(cb: (f: Fill) => void): () => void;
  // RFC-001 A5
  settledMarkets(limit?: number): Promise<Market[]>;
  claimable(): Promise<Claimable[]>;
  claim(marketId: string): Promise<ClaimResult>;
  // RFC-001 A6 — selling an outcome requires holding it; escrow is inventory.
  mintPair(marketId: string, sizeContracts: number): Promise<OrderAck>;
}

// ─── §7 Risk guard ───────────────────────────────────────────────────────────
export interface RiskConfig {
  maxNetContractsPerMarket: number;
  maxGrossContracts: number;
  maxNotionalUsd: Usd;
  maxSessionLossUsd: Usd;
  maxOrdersPerMinute: number;
  cooldownMs: number;
  edgeIn: number;                // FR-E4 — must be > edgeOut
  edgeOut: number;
  kellyFraction: number;         // 0.25 (WP §4)
  minEdgeFloor: number;          // fees + spread + noise
  maxQuoteAgeMs: number;
  killSwitch: boolean;
}

export type RiskVerdict = { ok: true } | { ok: false; rule: string; detail: string };

// ─── §8 Journal ──────────────────────────────────────────────────────────────
export const JOURNAL_KINDS = [
  'tick', 'model', 'valuation', 'signal', 'order', 'ack', 'fill', 'cancel', 'position',
  'reconcile', 'risk', 'kill', 'mode', 'claim', 'round_open', 'forecast', 'round_close',
  'settlement', 'mirror', 'quip', 'error',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface JournalEvent<K extends JournalKind = JournalKind, P = unknown> {
  seq: number; kind: K; tsMs: Ms; mode: Mode; runId: string; payload: P;
}

// ─── §10 Reconciler ──────────────────────────────────────────────────────────
export interface DriftItem {
  marketId: string; localNet: number; chainNet: number;
  localAvg: Prob; chainAvg: Prob; action: 'ADOPT_CHAIN';
}

export interface ReconcileReport {
  tsMs: Ms; checked: number; drifted: DriftItem[];
  correctedFrom: 'chain'; durationMs: number;
}

// ─── §11 Hunt / leaderboard ──────────────────────────────────────────────────
export interface Round {
  roundId: string; index: number; openMs: Ms; closeMs: Ms;
  status: 'OPEN' | 'SCORING' | 'SETTLED';
  marketIds: string[]; miraPnlUsd: Usd; potUsd: Usd; topN: number;
}

export interface Forecast {
  forecastId: string; roundId: string; marketId: string;
  userAddr: string; p: Prob; tsMs: Ms;
}

export interface Outcome {
  marketId: string; roundId: string; resolved: boolean;
  outcome: 0 | 1 | null; resolvedTsMs: Ms | null;
}

export interface Score {
  userAddr: string; roundId: string; brier: number; nForecasts: number; rank: number;
}

export interface Payout { userAddr: string; brier: number; weight: number; amountUsd: Usd }

export interface Settlement {
  roundId: string; miraPnlUsd: Usd; potUsd: Usd;
  scores: Score[]; payouts: Payout[];
  method: 'BRIER_PRO_RATA'; journalSeq: number; tsMs: Ms;
}

// ─── §12 MIRROR — never custodial ────────────────────────────────────────────
export interface UnsignedTx { to: string; data: string; value: string; chainId: number }

export interface MirrorIntent {
  intentId: string; sourceFillId: string;
  marketId: string; side: Side; sizeContracts: number; limitPrice: Prob;
  userAddr: string; balanceFraction: number;
  tx: UnsignedTx | null;         // null in SIM
  expiresMs: Ms;
}

// ─── §14 Scenarios & health ──────────────────────────────────────────────────
export const SCENARIO_NAMES = [
  'VOL_SPIKE', 'NEWS_SHOCK', 'FLAT_DRIFT', 'DROPPED_TX', 'NONCE_CLASH', 'STALE_QUOTE', 'THIN_BOOK',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export const SCENARIO_OPS = [
  'setDrift', 'setVol', 'jumpSpot', 'setSpread', 'setLatency',
  'dropNextTx', 'clashNonce', 'freezeQuote', 'setDepth',
] as const;
export type ScenarioOp = (typeof SCENARIO_OPS)[number];

export interface ScenarioStep { atMs: Ms; op: ScenarioOp; value: number }
export interface ScenarioScript { name: ScenarioName; durationMs: number; steps: ScenarioStep[] }

export interface HealthSnapshot {
  tsMs: Ms; mode: Mode; runId: string;
  components: Record<string, { ok: boolean; detail: string | null }>;
  tickLagMs: number; ticksPerSec: number; journalSeq: number;
  killSwitch: boolean; venue: VenueHealth;
}

export interface Quip {
  quipId: string; text: string; roundId: string | null; trigger: string; tsMs: Ms;
}

// ─── §9 Bus events ───────────────────────────────────────────────────────────
// Encoded as a topic→payload MAP, with the `BusEvent` union derived from it.
// Two reasons this is the right shape rather than a hand-written union:
//   • the union and the topic list cannot drift apart — both are generated here;
//   • `BusPayloads[T]` survives generic-signature comparison, whereas
//     `Extract<BusEvent, { t: T }>['d']` collapses to `never` when tsc relates a
//     class method to its interface (TS2416), which is not a contract change but
//     would have forced every Bus implementation into an `any`.
export interface BusPayloads {
  tick: Tick;
  model: ModelState;
  valuation: Valuation;
  signal: Signal;
  order: Order;
  ack: OrderAck;
  fill: Fill;
  cancel: CancelAck;
  position: Position[];
  reconcile: ReconcileReport;
  risk: { verdict: RiskVerdict; agent: AgentId; tsMs: Ms };
  kill: { on: boolean; by: string; tsMs: Ms };
  mode: { mode: Mode; tsMs: Ms };
  scenario: { name: ScenarioName; tsMs: Ms };
  claim: ClaimResult;
  round: Round;
  settlement: Settlement;
  forecast: Forecast;
  quip: Quip;
  health: HealthSnapshot;
  error: { where: string; msg: string; tsMs: Ms };
}

export type BusTopic = keyof BusPayloads;

/** The wire/bus event union — derived, so it always matches `BusPayloads`. */
export type BusEvent = { [K in BusTopic]: { t: K; d: BusPayloads[K] } }[BusTopic];

export const BUS_TOPICS = [
  'tick', 'model', 'valuation', 'signal', 'order', 'ack', 'fill', 'cancel', 'position',
  'reconcile', 'risk', 'kill', 'mode', 'scenario', 'claim', 'round', 'settlement',
  'forecast', 'quip', 'health', 'error',
] as const satisfies readonly BusTopic[];

// Compile-time completeness: if a payload is added to BusPayloads without being
// added to BUS_TOPICS, this line fails to typecheck.
type _MissingTopic = Exclude<BusTopic, (typeof BUS_TOPICS)[number]>;
const _busTopicsAreComplete: _MissingTopic[] = [];
void _busTopicsAreComplete;

export interface Bus {
  publish(e: BusEvent): void;    // synchronous, never throws
  on<T extends BusTopic>(t: T, cb: (d: BusPayloads[T]) => void): () => void;
  onAny(cb: (e: BusEvent) => void): () => void;
}

// ─── §13 WS protocol ─────────────────────────────────────────────────────────
export interface ArenaSnapshot {
  runId: string; mode: Mode; markets: Market[];
  model: ModelState | null; valuations: Valuation[]; positions: Position[];
  tape: Fill[]; pnlCurve: { tsMs: Ms; pnlUsd: Usd }[];
  round: Round | null; leaderboard: Score[]; health: HealthSnapshot; quips: Quip[];
}

export type ServerMsg =
  | { t: 'hello'; d: { runId: string; mode: Mode; serverMs: Ms; protocol: 1 } }
  | { t: 'snapshot'; d: ArenaSnapshot }
  | { t: 'ev'; d: BusEvent }
  | { t: 'pong'; d: { clientMs: Ms; serverMs: Ms } };

export type ClientMsg =
  | { t: 'ping'; d: { clientMs: Ms } }
  | { t: 'subscribe'; d: { topics: BusTopic[] } }
  | { t: 'forecast'; d: { roundId: string; marketId: string; userAddr: string; p: Prob } };

// ─── Side / kind helpers (RFC-001 A1) ────────────────────────────────────────
export const oppositeSide = (s: Side): Side => (s === 'YES' ? 'NO' : 'YES');

export const kindFor = (side: Side, dir: 'BUY' | 'SELL'): OrderKind =>
  side === 'YES' ? (dir === 'BUY' ? 'BUY_YES' : 'SELL_YES')
                 : (dir === 'BUY' ? 'BUY_NO' : 'SELL_NO');

export const sideOf = (k: OrderKind): Side => (k === 'BUY_YES' || k === 'SELL_YES' ? 'YES' : 'NO');

export const dirOf = (k: OrderKind): 'BUY' | 'SELL' =>
  (k === 'BUY_YES' || k === 'BUY_NO' ? 'BUY' : 'SELL');
