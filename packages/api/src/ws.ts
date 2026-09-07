// WebSocket broadcaster (FR-S1, IF §13).
//
// ── Snapshot-then-stream, and why the order is load-bearing ────────────────
// A client gets `hello`, then `snapshot`, then a live `ev` stream — in that
// order, with no gap. If an event could slip between the snapshot being TAKEN
// and it being SENT, the client would apply an event it already had baked into
// the snapshot, or miss one entirely, and its PnL would silently diverge from
// the server's for the rest of the session. So a new client is subscribed to
// the bus FIRST, its early events are buffered, and the buffer is flushed
// immediately after the snapshot goes out.
//
// ── A slow client must never slow the engine ───────────────────────────────
// The bus is the trading path. `publish` is synchronous, so anything this
// component does on a fan-out is time the engine is not deciding. Therefore:
//   • no awaits in the fan-out path,
//   • a client whose buffer exceeds its budget is DROPPED rather than allowed
//     to grow (a wedged socket is a memory leak with a countdown), and
//   • every disconnect unsubscribes, checked by a 1000-cycle leak test.
import type {
  ArenaSnapshot, Bus, BusEvent, BusTopic, ClientMsg, Forecast, Ms, Prob, ServerMsg,
} from '@arena/shared';

/** The transport, narrowed to what the broadcaster needs. Any `ws`-like socket
 *  satisfies it, which is what lets the tests run with no server at all. */
export interface Socket {
  send(data: string): void;
  close(): void;
  readonly id: string;
}

export interface BroadcasterOptions {
  bus: Bus;
  /** The current arena view, taken fresh per connecting client. */
  snapshot: () => ArenaSnapshot;
  now: () => Ms;
  runId: string;
  /** Queued frames before a client is judged wedged and dropped. */
  maxBufferedFrames?: number;
  /** Called when a client submits a forecast (IF §13 ClientMsg). */
  onForecast?: (f: Omit<Forecast, 'forecastId'>) => void;
  onError?: (e: Error, socketId: string) => void;
}

/**
 * Bigint-aware JSON replacer.
 *
 * `Market` carries `tickRaw`/`lotRaw` as bigints (RFC-001 A8) and
 * `JSON.stringify` THROWS on a bigint. Without this, serializing a snapshot
 * fails, the failure looks exactly like a broken socket, and every connecting
 * client is dropped on the spot — silently. `Store.snapshot()` already
 * converts, but the broadcaster must not depend on its caller having done so.
 */
const jsonReplacer = (_k: string, v: unknown): unknown =>
  (typeof v === 'bigint' ? v.toString() : v);

export interface BroadcasterStats {
  clients: number;
  connected: number;
  disconnected: number;
  framesSent: number;
  framesDropped: number;
  slowClientsDropped: number;
  badMessages: number;
  forecastsReceived: number;
  /** Frames that could not be serialized. Non-zero here is a programming
   *  error, not a network condition, so it is counted separately. */
  serializeFailures: number;
}

interface Client {
  socket: Socket;
  /** Topic filter. `null` means everything. */
  topics: Set<BusTopic> | null;
  /** Events that arrived before the snapshot was sent. */
  preSnapshot: BusEvent[];
  ready: boolean;
  buffered: number;
  unsubscribe: (() => void) | null;
}

export class Broadcaster {
  private readonly bus: Bus;
  private readonly snapshotFn: () => ArenaSnapshot;
  private readonly nowFn: () => Ms;
  private readonly runId: string;
  private readonly maxBuffered: number;
  private readonly onForecast: BroadcasterOptions['onForecast'];
  private readonly onError: BroadcasterOptions['onError'];

  private readonly clients = new Map<string, Client>();
  private stats: BroadcasterStats = {
    clients: 0, connected: 0, disconnected: 0, framesSent: 0, framesDropped: 0,
    slowClientsDropped: 0, badMessages: 0, forecastsReceived: 0, serializeFailures: 0,
  };

  constructor(o: BroadcasterOptions) {
    this.bus = o.bus;
    this.snapshotFn = o.snapshot;
    this.nowFn = o.now;
    this.runId = o.runId;
    this.maxBuffered = o.maxBufferedFrames ?? 512;
    this.onForecast = o.onForecast;
    this.onError = o.onError;
  }

  statsSnapshot(): BroadcasterStats {
    return { ...this.stats, clients: this.clients.size };
  }

  /**
   * Accept a client.
   *
   * Subscription happens BEFORE the snapshot is taken, and events arriving in
   * between are buffered and flushed after it. That closes the gap where a
   * client could double-apply or miss an event.
   */
  connect(socket: Socket): void {
    const client: Client = {
      socket, topics: null, preSnapshot: [], ready: false, buffered: 0, unsubscribe: null,
    };
    this.clients.set(socket.id, client);
    this.stats.connected++;

    // 1. Subscribe first, so nothing can be lost.
    client.unsubscribe = this.bus.onAny((e) => {
      if (!client.ready) { client.preSnapshot.push(e); return; }
      this.deliver(client, { t: 'ev', d: e });
    });

    // 2 & 3. ONE snapshot, used for both frames. Taking a second one just to
    // read `.mode` would walk every position, the whole tape and the PnL curve
    // and JSON-clone the result — twice per connecting client, for one field.
    const snap = this.snapshotFn();
    this.deliver(client, {
      t: 'hello',
      d: { runId: this.runId, mode: snap.mode, serverMs: this.nowFn(), protocol: 1 },
    });
    this.deliver(client, { t: 'snapshot', d: snap });

    // 4. Flush anything that arrived while we were doing 2 and 3, then go live.
    client.ready = true;
    const pending = client.preSnapshot;
    client.preSnapshot = [];
    for (const e of pending) this.deliver(client, { t: 'ev', d: e });
  }

  disconnect(socketId: string): void {
    const c = this.clients.get(socketId);
    if (!c) return;
    // Unsubscribe FIRST: a bus that still holds a reference to a dead client is
    // the leak the 1000-cycle test looks for.
    c.unsubscribe?.();
    c.unsubscribe = null;
    this.clients.delete(socketId);
    this.stats.disconnected++;
  }

  /** Handle an inbound client message. Never throws on bad input. */
  receive(socketId: string, raw: string): void {
    const c = this.clients.get(socketId);
    if (!c) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      this.stats.badMessages++;
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
      this.stats.badMessages++;
      return;
    }
    switch (msg.t) {
      case 'ping':
        this.deliver(c, { t: 'pong', d: { clientMs: msg.d?.clientMs ?? 0, serverMs: this.nowFn() } });
        break;
      case 'subscribe':
        c.topics = Array.isArray(msg.d?.topics) && msg.d.topics.length > 0
          ? new Set(msg.d.topics)
          : null;
        break;
      case 'forecast': {
        const d = msg.d;
        const p: Prob = typeof d?.p === 'number' ? d.p : Number.NaN;
        // Validate at the boundary: a forecast outside [0,1] is not a
        // probability and must not reach the scorer.
        if (!d || typeof d.roundId !== 'string' || typeof d.marketId !== 'string'
            || typeof d.userAddr !== 'string' || !Number.isFinite(p) || p < 0 || p > 1) {
          this.stats.badMessages++;
          return;
        }
        this.stats.forecastsReceived++;
        this.onForecast?.({
          roundId: d.roundId, marketId: d.marketId, userAddr: d.userAddr, p, tsMs: this.nowFn(),
        });
        break;
      }
      default:
        this.stats.badMessages++;
    }
  }

  /** Number of live clients, for health. */
  get clientCount(): number { return this.clients.size; }

  /**
   * Send one frame to one client.
   *
   * Synchronous and never throws. A send failure or an over-budget buffer drops
   * the client: the alternative is an unbounded queue behind a wedged socket,
   * which ends the session for everyone.
   */
  private deliver(c: Client, msg: ServerMsg): void {
    if (msg.t === 'ev' && c.topics && !c.topics.has(msg.d.t)) return;

    if (c.buffered >= this.maxBuffered) {
      this.stats.slowClientsDropped++;
      this.stats.framesDropped++;
      this.drop(c, 'slow client: buffer budget exceeded');
      return;
    }

    // Serialization is separated from sending on purpose. A frame that cannot
    // be serialized is OUR bug and must be loud; it must not be mistaken for a
    // broken socket and cost the client its connection.
    let frame: string;
    try {
      frame = JSON.stringify(msg, jsonReplacer);
    } catch (e) {
      this.stats.serializeFailures++;
      this.stats.framesDropped++;
      this.onError?.(
        new Error(`broadcaster: could not serialize a '${msg.t}' frame: ` +
          `${e instanceof Error ? e.message : String(e)}`),
        c.socket.id,
      );
      return;                                    // the client stays connected
    }

    try {
      c.buffered++;
      c.socket.send(frame);
      c.buffered--;
      this.stats.framesSent++;
    } catch (e) {
      c.buffered--;
      this.stats.framesDropped++;
      this.onError?.(e instanceof Error ? e : new Error(String(e)), c.socket.id);
      this.drop(c, 'send failed');
    }
  }

  private drop(c: Client, _why: string): void {
    const id = c.socket.id;
    try { c.socket.close(); } catch { /* already gone */ }
    this.disconnect(id);
  }
}
