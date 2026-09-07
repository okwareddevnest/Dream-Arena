// Spot-price ingester (FR-D1, IF §2 Tick).
//
// ── Three sources, one Tick stream ──────────────────────────────────────────
//   somnia-feed  the SDK's bundled testnet price feed. T-S4 measured it at
//                241 ms sequential, 0/30 errors under concurrency — the
//                best-behaved surface in the whole stack, and the SAME oracle
//                the venue settles against, which matters more than latency:
//                forecasting one series and settling on another is a hidden
//                basis risk.
//   binance      a public reference, for SIM and as a fallback.
//   fixture      a recorded or generated series, for deterministic tests.
//
// ── Why the LIVE cadence is 500 ms and not faster ──────────────────────────
// The feed is a GraphQL poll, not a socket. ARCH §4 was amended (RFC-001 A9)
// to say so: 2 Hz is the honest ceiling on LIVE, and the <5 ms budget applies
// to the bus hop, not to acquisition. Polling harder does not get fresher data,
// it just gets rate-limited.
//
// ── What this component refuses to pass on ─────────────────────────────────
// A bad tick is worse than no tick: a non-positive price makes ln(S/S') either
// -Infinity or NaN and poisons the EWMV recurrence permanently (T-020 guards
// too, but defence in depth is cheap here). Out-of-order and duplicate
// timestamps are dropped so `seq` stays monotonic and a replay reproduces the
// same series.
import {
  SystemClock,
  type Bus, type Clock, type Ms, type Tick, type TickSource,
} from '@arena/shared';

/** Fetches one spot price. Any transport; the ingester only needs this. */
export interface SpotSource {
  readonly name: TickSource;
  /** Resolve the current price, or reject. */
  read(symbol: string): Promise<{ price: number; tsMs: Ms }>;
}

export interface IngesterOptions {
  bus: Bus;
  clock?: Clock;
  source: SpotSource;
  symbols: string[];
  /** Poll cadence. 500 ms on LIVE (T-S4). */
  pollMs?: number;
  /** Exponential backoff floor / ceiling on failure. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Journal hook, fire-and-forget. */
  onTick?: (t: Tick) => void;
  onError?: (e: Error) => void;
}

export interface IngesterStats {
  published: number;
  dropped: number;
  malformed: number;
  outOfOrder: number;
  duplicates: number;
  errors: number;
  reconnects: number;
  currentBackoffMs: number;
}

export class Ingester {
  private readonly bus: Bus;
  private readonly clock: Clock;
  private readonly source: SpotSource;
  private readonly symbols: string[];
  private readonly pollMs: number;
  private readonly backoffBase: number;
  private readonly backoffMax: number;
  private readonly onTick: ((t: Tick) => void) | undefined;
  private readonly onError: ((e: Error) => void) | undefined;

  private seq = 0;
  private readonly lastTsMs = new Map<string, Ms>();
  private timer: number | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private stats: IngesterStats = {
    published: 0, dropped: 0, malformed: 0, outOfOrder: 0,
    duplicates: 0, errors: 0, reconnects: 0, currentBackoffMs: 0,
  };

  constructor(o: IngesterOptions) {
    this.bus = o.bus;
    this.clock = o.clock ?? new SystemClock();
    this.source = o.source;
    this.symbols = o.symbols;
    this.pollMs = o.pollMs ?? 500;
    this.backoffBase = o.backoffBaseMs ?? 400;
    this.backoffMax = o.backoffMaxMs ?? 10_000;
    this.onTick = o.onTick;
    this.onError = o.onError;
  }

  statsSnapshot(): IngesterStats { return { ...this.stats }; }
  get isRunning(): boolean { return this.running; }

  /**
   * Ingest one observation.
   *
   * Synchronous and allocation-light: this is the hop ARCH §4 budgets at under
   * 5 ms, so it does no I/O and never awaits. Returns the published tick, or
   * null if the observation was rejected.
   */
  ingest(symbol: string, price: number, tsMs: Ms): Tick | null {
    // A price that is not a finite positive number cannot produce a log return.
    if (!Number.isFinite(price) || price <= 0) {
      this.stats.malformed++;
      this.stats.dropped++;
      return null;
    }
    if (!Number.isFinite(tsMs)) {
      this.stats.malformed++;
      this.stats.dropped++;
      return null;
    }

    const last = this.lastTsMs.get(symbol);
    if (last !== undefined) {
      if (tsMs === last) { this.stats.duplicates++; this.stats.dropped++; return null; }
      if (tsMs < last) { this.stats.outOfOrder++; this.stats.dropped++; return null; }
    }
    this.lastTsMs.set(symbol, tsMs);

    const tick: Tick = { symbol, price, tsMs, seq: ++this.seq, source: this.source.name };
    // Publish first, journal second: the bus is the trading path and the
    // journal is not.
    this.bus.publish({ t: 'tick', d: tick });
    this.stats.published++;
    if (this.onTick) { try { this.onTick(tick); } catch { /* journal must not break ingest */ } }
    return tick;
  }

  /** Parse an arbitrary frame. Never throws: a malformed frame is counted. */
  ingestFrame(raw: unknown, symbolHint?: string): Tick | null {
    try {
      if (typeof raw === 'string') {
        const o = JSON.parse(raw) as Record<string, unknown>;
        return this.fromObject(o, symbolHint);
      }
      if (raw && typeof raw === 'object') return this.fromObject(raw as Record<string, unknown>, symbolHint);
      this.stats.malformed++; this.stats.dropped++;
      return null;
    } catch {
      this.stats.malformed++;
      this.stats.dropped++;
      return null;
    }
  }

  private fromObject(o: Record<string, unknown>, symbolHint?: string): Tick | null {
    const symbol = typeof o['symbol'] === 'string' ? o['symbol']
      : typeof o['s'] === 'string' ? o['s'] : symbolHint;
    const priceRaw = o['price'] ?? o['p'] ?? o['c'];
    const price = typeof priceRaw === 'number' ? priceRaw
      : typeof priceRaw === 'string' ? Number(priceRaw) : Number.NaN;
    const tsRaw = o['tsMs'] ?? o['timestamp'] ?? o['E'] ?? o['T'];
    const tsMs = typeof tsRaw === 'number' ? tsRaw
      : typeof tsRaw === 'string' ? Number(tsRaw) : this.clock.now();
    if (typeof symbol !== 'string' || symbol.length === 0) {
      this.stats.malformed++; this.stats.dropped++;
      return null;
    }
    return this.ingest(symbol, price, tsMs);
  }

  /** Start polling. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
  }

  /**
   * One poll of every symbol.
   *
   * Symbols are read SEQUENTIALLY, not with `Promise.all`. That is deliberate:
   * T-S4 measured the indexer returning 20 % errors and a 29 s p99 under a
   * 30-way fan-out, and a fan-out here is exactly how a well-meaning agent
   * discovers that limit during a demo.
   */
  async poll(): Promise<void> {
    let anyFailure = false;
    for (const symbol of this.symbols) {
      try {
        const { price, tsMs } = await this.source.read(symbol);
        this.ingest(symbol, price, tsMs);
      } catch (e) {
        anyFailure = true;
        this.stats.errors++;
        const err = e instanceof Error ? e : new Error(String(e));
        this.onError?.(err);
        this.bus.publish({
          t: 'error',
          d: { where: `ingester.${symbol}`, msg: err.message, tsMs: this.clock.now() },
        });
      }
    }
    if (anyFailure) this.consecutiveFailures++;
    else if (this.consecutiveFailures > 0) {
      // Recovered.
      this.consecutiveFailures = 0;
      this.stats.reconnects++;
      this.stats.currentBackoffMs = 0;
    }
  }

  /**
   * Delay before the next poll: the cadence when healthy, exponential backoff
   * with jitter when not, capped so a long outage still retries at a
   * predictable rate rather than never.
   *
   * Jitter is not decoration — without it every restarted instance retries in
   * lockstep and the recovering endpoint gets a thundering herd.
   */
  nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.pollMs;
    const raw = this.backoffBase * 2 ** (this.consecutiveFailures - 1);
    const capped = Math.min(raw, this.backoffMax);
    const jittered = capped * (0.5 + Math.random() * 0.5);
    this.stats.currentBackoffMs = Math.round(jittered);
    return this.stats.currentBackoffMs;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = this.clock.setTimeout(() => {
      void this.poll().finally(() => {
        if (this.running) this.schedule(this.nextDelayMs());
      });
    }, delayMs);
  }
}

// ── Sources ─────────────────────────────────────────────────────────────────

/** The SDK's bundled testnet price feed (T-S2). The same oracle the venue
 *  settles against, which is why it is the LIVE default. */
export function somniaFeedSource(read: (symbol: string) => Promise<{ price: number; tsMs: Ms }>): SpotSource {
  return { name: 'somnia-feed', read };
}

/** Binance spot REST. Verified reachable in the environment probe. */
export function binanceSource(fetchImpl: typeof fetch = fetch): SpotSource {
  const MAP: Record<string, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };
  return {
    name: 'binance',
    read: async (symbol) => {
      const pair = MAP[symbol] ?? `${symbol}USDT`;
      const res = await fetchImpl(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
      if (!res.ok) throw new Error(`binance ${pair}: HTTP ${res.status}`);
      const body = (await res.json()) as { price?: string };
      const price = Number(body.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`binance ${pair}: bad price ${body.price}`);
      return { price, tsMs: Date.now() };
    },
  };
}

export interface FixtureOptions {
  /** Prices to replay, in order. Loops when exhausted unless `once`. */
  prices: number[];
  /** Virtual ms between observations. */
  stepMs?: number;
  once?: boolean;
  startMs?: Ms;
}

/**
 * A deterministic source for tests and for the demo's fallback replay.
 *
 * Deterministic in the strong sense required by 40-TESTPLAN §6 rule 3: two runs
 * over the same fixture produce byte-identical tick streams, so a recorded
 * session can be replayed to the same final PnL.
 */
export function fixtureSource(o: FixtureOptions): SpotSource & { reset(): void; exhausted: boolean } {
  const step = o.stepMs ?? 500;
  let i = 0;
  let t = o.startMs ?? 0;
  const src = {
    name: 'fixture' as const,
    read: async (_symbol: string) => {
      if (i >= o.prices.length) {
        if (o.once) throw new Error('fixture exhausted');
        i = 0;
      }
      const price = o.prices[i++]!;
      t += step;
      return { price, tsMs: t };
    },
    reset(): void { i = 0; t = o.startMs ?? 0; },
    get exhausted(): boolean { return o.once === true && i >= o.prices.length; },
  };
  return src;
}

/** A geometric-Brownian-motion fixture, so a test can ask for a given
 *  volatility rather than hand-writing a price list. */
export function gbmFixture(opts: {
  start: number; sigma: number; stepMs: number; n: number; seed?: number;
}): number[] {
  let a = (opts.seed ?? 1) >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const dtYears = opts.stepMs / (365 * 24 * 60 * 60 * 1000);
  const out: number[] = [opts.start];
  let p = opts.start;
  for (let k = 1; k < opts.n; k++) {
    const u1 = Math.max(1e-12, rnd());
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd());
    p *= Math.exp(opts.sigma * Math.sqrt(dtYears) * z);
    out.push(p);
  }
  return out;
}
