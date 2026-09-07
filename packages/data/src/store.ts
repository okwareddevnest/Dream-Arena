// In-memory projections (ARCH §2 C4, IF §13).
//
// Everything the arena renders comes from here: positions, PnL, tape,
// leaderboard, health. Three properties matter more than they look:
//
//   1. EVERY COLLECTION IS BOUNDED. A session runs for hours at hundreds of
//      events a second; an unbounded tape or PnL array is a memory leak that
//      ends the demo. The tape is a ring buffer and the curve is down-sampled
//      in place.
//   2. FILL APPLICATION IS IDEMPOTENT, keyed on `fillId`. The journal replays
//      into a fresh store (T-064) and the reconciler re-reads chain state
//      (T-035); double-counting a fill would show a position that never existed.
//   3. `snapshot()` IS JSON-SAFE. It crosses a WebSocket, and `Market` carries
//      bigints (RFC-001 A8) that `JSON.stringify` throws on. Converting here
//      rather than in the broadcaster keeps the one rule in one place.
//
// ── The YES-price convention ────────────────────────────────────────────────
// Positions are held in signed YES contracts: +10 means long 10 YES, -10 means
// long 10 NO. A NO fill at price q is therefore recorded as a YES basis of
// (1 - q), which is what no-arbitrage says it is. Keeping one convention is
// what lets a single mark price value the whole book.
import type {
  AgentId, ArenaSnapshot, Bus, Fill, HealthSnapshot, Market, Mode, Ms, Position, Prob,
  Quip, Quote, Round, Score, Tick, Usd, Valuation,
} from '@arena/shared';

export interface StoreOptions {
  runId: string;
  mode: Mode;
  /** Maximum fills retained for the tape. */
  tapeCap?: number;
  /** Maximum points retained for the PnL curve. */
  pnlCurveCap?: number;
}

interface Book {
  marketId: string;
  agent: AgentId;
  net: number;            // signed YES contracts
  avg: Prob;              // YES-convention average entry
  realized: Usd;
  mark: Prob;
  tsMs: Ms;
}

const key = (marketId: string, agent: AgentId): string => `${agent}::${marketId}`;

/** JSON-safe deep clone: bigints become decimal strings. */
const jsonSafe = <T>(v: T): T =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as T;

export class Store {
  readonly runId: string;
  readonly mode: Mode;
  private readonly tapeCap: number;
  private readonly curveCap: number;

  private readonly books = new Map<string, Book>();
  private readonly seenFills = new Set<string>();
  private readonly markets = new Map<string, Market>();
  private readonly valuations = new Map<string, Valuation>();
  private readonly quotes = new Map<string, Quote>();
  /** Newest-first ring of fills. */
  private tapeBuf: Fill[] = [];
  private curve: { tsMs: Ms; pnlUsd: Usd }[] = [];
  /** Down-sampling stride: keep every Nth point once the cap has been hit. */
  private curveStride = 1;
  private curveSeen = 0;

  private lastTick: Tick | null = null;
  private tickCount = 0;
  private firstTickMs: Ms | null = null;
  private round: Round | null = null;
  private leaderboard: Score[] = [];
  private quips: Quip[] = [];
  private components: Record<string, { ok: boolean; detail: string | null }> = {};
  private killSwitch = false;
  private journalSeq = 0;

  constructor(opts: StoreOptions) {
    this.runId = opts.runId;
    this.mode = opts.mode;
    this.tapeCap = opts.tapeCap ?? 500;
    this.curveCap = opts.pnlCurveCap ?? 600;
  }

  /** Wire the store to a bus so it stays current without the engine pushing. */
  subscribe(bus: Bus): () => void {
    const offs = [
      bus.on('fill', (f) => this.applyFill(f)),
      bus.on('tick', (t) => this.applyTick(t)),
      bus.on('valuation', (v) => this.applyValuation(v)),
      bus.on('round', (r) => { this.round = r; }),
      bus.on('quip', (q) => this.applyQuip(q)),
      bus.on('kill', (d) => { this.killSwitch = d.on; }),
      bus.on('settlement', (s) => { this.leaderboard = s.scores; }),
      bus.on('health', (h) => { this.components = h.components; }),
    ];
    return () => { for (const off of offs) off(); };
  }

  // ── Fills ────────────────────────────────────────────────────────────────
  applyFill(f: Fill): void {
    if (this.seenFills.has(f.fillId)) return;      // idempotent (replay safety)
    this.seenFills.add(f.fillId);

    // Normalize into the signed-YES convention.
    const signed = f.side === 'YES' ? f.sizeContracts : -f.sizeContracts;
    const yesPrice = f.side === 'YES' ? f.price : 1 - f.price;

    const k = key(f.marketId, f.agent);
    const b = this.books.get(k) ?? {
      marketId: f.marketId, agent: f.agent, net: 0, avg: 0, realized: 0, mark: yesPrice, tsMs: f.tsMs,
    };

    const opening = b.net === 0 || Math.sign(signed) === Math.sign(b.net);
    if (opening) {
      // Size-weight the basis.
      const total = b.net + signed;
      b.avg = total === 0 ? 0 : (b.avg * b.net + yesPrice * signed) / total;
      b.net = total;
    } else {
      // Closing, wholly or partly. Realize on the closed quantity only.
      const closing = Math.min(Math.abs(signed), Math.abs(b.net));
      const dir = Math.sign(b.net);                 // +1 long YES, -1 long NO
      b.realized += dir * (yesPrice - b.avg) * closing;
      const remainder = Math.abs(signed) - closing;
      b.net = b.net + signed;
      if (remainder > 0) {
        // Flipped through zero: the new leg starts at this fill's price.
        b.avg = yesPrice;
      } else if (b.net === 0) {
        b.avg = 0;
      }
      // A partial close leaves `avg` untouched, which is correct: the basis of
      // the remaining contracts has not changed.
    }

    b.realized -= f.feeUsd;
    b.mark = yesPrice;
    b.tsMs = f.tsMs;
    this.books.set(k, b);

    // Tape: newest first, bounded.
    this.tapeBuf.unshift(f);
    if (this.tapeBuf.length > this.tapeCap) this.tapeBuf.length = this.tapeCap;

    this.pushCurve(f.tsMs);
  }

  applyQuote(q: Quote): void {
    this.quotes.set(q.marketId, q);
    for (const b of this.books.values()) {
      if (b.marketId === q.marketId) { b.mark = q.mid; b.tsMs = q.tsMs; }
    }
  }

  applyMarkets(ms: Market[]): void {
    for (const m of ms) this.markets.set(m.id, m);
  }

  applyValuation(v: Valuation): void {
    this.valuations.set(v.marketId, v);
  }

  applyTick(t: Tick): void {
    this.lastTick = t;
    this.tickCount++;
    if (this.firstTickMs === null) this.firstTickMs = t.tsMs;
  }

  applyQuip(q: Quip): void {
    this.quips.unshift(q);
    if (this.quips.length > 20) this.quips.length = 20;
  }

  setRound(r: Round | null): void { this.round = r; }
  setLeaderboard(s: Score[]): void { this.leaderboard = s; }
  setComponent(name: string, ok: boolean, detail: string | null = null): void {
    this.components[name] = { ok, detail };
  }
  setJournalSeq(n: number): void { this.journalSeq = n; }

  // ── Reads ────────────────────────────────────────────────────────────────
  position(marketId: string, agent: AgentId): Position | null {
    const b = this.books.get(key(marketId, agent));
    return b ? this.toPosition(b) : null;
  }

  positions(agent?: AgentId): Position[] {
    const out: Position[] = [];
    for (const b of this.books.values()) {
      if (agent === undefined || b.agent === agent) out.push(this.toPosition(b));
    }
    return out;
  }

  totalPnlUsd(agent?: AgentId): Usd {
    let t = 0;
    for (const b of this.books.values()) {
      if (agent !== undefined && b.agent !== agent) continue;
      t += b.realized + this.unrealized(b);
    }
    return t;
  }

  tape(): Fill[] { return [...this.tapeBuf]; }
  pnlCurve(): { tsMs: Ms; pnlUsd: Usd }[] { return [...this.curve]; }

  health(nowMs: Ms): HealthSnapshot {
    const elapsedSec = this.firstTickMs === null ? 0 : Math.max(1e-3, (nowMs - this.firstTickMs) / 1_000);
    return {
      tsMs: nowMs,
      mode: this.mode,
      runId: this.runId,
      components: { ...this.components },
      tickLagMs: this.lastTick === null ? 0 : Math.max(0, nowMs - this.lastTick.tsMs),
      ticksPerSec: this.firstTickMs === null ? 0 : this.tickCount / elapsedSec,
      journalSeq: this.journalSeq,
      killSwitch: this.killSwitch,
      venue: {
        ok: true, mode: this.mode,
        name: this.mode === 'SIM' ? 'SimulatedVenue' : 'DreamDEXVenue',
        blockNumber: null, latencyMs: null, lastErrorMs: null, detail: null,
      },
    };
  }

  /** The full arena view (IF §13). JSON-safe: bigints become strings. */
  snapshot(nowMs: Ms): ArenaSnapshot {
    return jsonSafe({
      runId: this.runId,
      mode: this.mode,
      markets: [...this.markets.values()],
      model: null,                        // owned by the engine, injected there
      valuations: [...this.valuations.values()],
      positions: this.positions(),
      tape: this.tape(),
      pnlCurve: this.pnlCurve(),
      round: this.round,
      leaderboard: this.leaderboard,
      health: this.health(nowMs),
      quips: [...this.quips],
    });
  }

  private toPosition(b: Book): Position {
    return {
      marketId: b.marketId, agent: b.agent,
      netContracts: b.net, avgPrice: b.avg, markPrice: b.mark,
      realizedPnlUsd: b.realized, unrealizedPnlUsd: this.unrealized(b), tsMs: b.tsMs,
    };
  }

  /** The signed-YES convention makes this one expression for both directions. */
  private unrealized(b: Book): Usd {
    if (b.net === 0) return 0;
    return (b.mark - b.avg) * b.net;
  }

  /**
   * Append to the PnL curve, down-sampling in place once the cap is reached.
   *
   * Doubling the stride and re-decimating keeps the array bounded at O(cap) for
   * any number of fills while preserving the shape of the curve and always
   * keeping the first and the latest points, which are the two a viewer looks
   * at first.
   */
  private pushCurve(tsMs: Ms): void {
    this.curveSeen++;
    if (this.curveSeen % this.curveStride !== 0 && this.curve.length > 0) {
      // Not a sampled point: still keep the newest value current.
      const last = this.curve[this.curve.length - 1]!;
      if (last.tsMs === tsMs) { last.pnlUsd = this.totalPnlUsd(); return; }
    }
    this.curve.push({ tsMs, pnlUsd: this.totalPnlUsd() });
    if (this.curve.length > this.curveCap) {
      const kept: { tsMs: Ms; pnlUsd: Usd }[] = [];
      for (let i = 0; i < this.curve.length; i += 2) kept.push(this.curve[i]!);
      const last = this.curve[this.curve.length - 1]!;
      if (kept[kept.length - 1]!.tsMs !== last.tsMs) kept.push(last);
      this.curve = kept;
      this.curveStride *= 2;
    }
  }
}
