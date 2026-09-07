// Serialized transaction queue and nonce manager (FR-X1).
//
// The "nonce collisions and duplicates" leg of the integrity quartet (WP §7).
// Two independent failures live here, and they need different mechanisms:
//
//   1. CONCURRENCY. Two signers racing on one key produce two transactions with
//      the same nonce; one is dropped, silently. The bot kit documents exactly
//      this ("two senders on one key race each other's nonce") and solves it the
//      same way: one key, one queue, strictly one in flight. So `submit` does
//      not run its task immediately — it appends to a chain and awaits its turn.
//
//   2. DUPLICATES. A retry, a reconnect, or an engine that re-evaluates the same
//      edge can submit the same intent twice. Serialization does not help: both
//      would execute, in order, giving a double position. So every submission
//      carries a `clientOrderId` and the queue returns the FIRST result for a
//      repeated id without re-running the task.
//
// A failed transaction must also RELEASE its nonce. Holding it would leave a
// permanent gap and every later transaction would sit unmined behind it.
import type { Ms } from '@arena/shared';

export interface NonceSource {
  /** Current on-chain transaction count for the signer. */
  getTransactionCount(): Promise<number>;
}

/**
 * Hands out strictly increasing nonces, and takes them back on failure.
 *
 * The local counter is authoritative while transactions are in flight — the
 * chain's count lags until they are mined, so re-reading it per transaction
 * would hand out the same nonce twice. `resync` is the escape hatch for a
 * detected clash, where the chain has become the better source of truth.
 */
export class NonceManager {
  private next: number | null = null;
  /**
   * Memoized first chain read.
   *
   * Without this, N concurrent `reserve()` calls all observe `next === null`,
   * all await the chain, and all then assign `next = start` before reading it —
   * so every caller walks away with the SAME nonce. Measured: 100 concurrent
   * reservations returned nonce 0 one hundred times. Memoizing the promise
   * makes the read happen once and the increment happen in one synchronous
   * block per caller.
   */
  private init: Promise<number> | null = null;
  /** Nonces handed out and not yet confirmed or released. */
  private readonly pending = new Set<number>();
  private resyncs = 0;

  constructor(private readonly source: NonceSource) {}

  get resyncCount(): number { return this.resyncs; }
  get pendingCount(): number { return this.pending.size; }

  async reserve(): Promise<number> {
    if (this.next === null) {
      this.init ??= this.source.getTransactionCount();
      const start = await this.init;
      // Only the first caller through assigns; the rest fall through to the
      // increment below and so cannot clobber a counter already in use.
      if (this.next === null) this.next = start;
    }
    const n = this.next!++;
    this.pending.add(n);
    return n;
  }

  /** A transaction landed. */
  confirm(n: number): void { this.pending.delete(n); }

  /**
   * A transaction failed. Return its nonce to the pool if it was the newest, so
   * the sequence stays gapless; if later ones are already out, the gap has to
   * be filled by whatever is in flight and we only drop the reservation.
   */
  release(n: number): void {
    this.pending.delete(n);
    if (this.next !== null && n === this.next - 1) this.next = n;
  }

  /** Re-read the chain. Used after a detected clash. */
  async resync(): Promise<number> {
    this.resyncs++;
    this.init = null;                 // force a fresh read
    this.next = await this.source.getTransactionCount();
    this.pending.clear();
    return this.next;
  }

  reset(): void { this.next = null; this.init = null; this.pending.clear(); }
}

export interface TxTask<T> {
  /** Idempotency key. A repeat returns the first result without re-running. */
  clientOrderId: string;
  /** The work. Receives its reserved nonce. */
  run: (nonce: number) => Promise<T>;
  /** Optional: classify an error as a nonce clash worth one retry. */
  isNonceClash?: (e: unknown) => boolean;
}

export interface TxQueueOptions {
  nonces: NonceManager;
  /** Abandon an item that has not settled within this long. */
  timeoutMs?: number;
  /** Called when an item times out or fails terminally. */
  onError?: (e: Error, clientOrderId: string) => void;
  /** Clock, so timeouts are testable on a virtual clock. */
  now?: () => Ms;
}

export interface TxQueueStats {
  depth: number;
  inFlight: number;
  submitted: number;
  completed: number;
  failed: number;
  deduped: number;
  retried: number;
  timedOut: number;
}

const DEFAULT_NONCE_CLASH = (e: unknown): boolean =>
  /nonce|replacement transaction underpriced|already known/i.test(
    e instanceof Error ? e.message : String(e),
  );

export class TxQueue {
  private readonly nonces: NonceManager;
  private readonly timeoutMs: number;
  private readonly onError: ((e: Error, id: string) => void) | undefined;
  /** The serialization point: every submission chains onto this. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly results = new Map<string, Promise<unknown>>();
  private depthCount = 0;
  private inFlightCount = 0;
  private stats = { submitted: 0, completed: 0, failed: 0, deduped: 0, retried: 0, timedOut: 0 };

  constructor(opts: TxQueueOptions) {
    this.nonces = opts.nonces;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.onError = opts.onError;
  }

  statsSnapshot(): TxQueueStats {
    return { depth: this.depthCount, inFlight: this.inFlightCount, ...this.stats };
  }

  /**
   * Enqueue a task. Resolves with its result once every earlier task has
   * settled — never before, and never concurrently.
   */
  submit<T>(task: TxTask<T>): Promise<T> {
    const existing = this.results.get(task.clientOrderId);
    if (existing) {
      this.stats.deduped++;
      return existing as Promise<T>;
    }

    this.stats.submitted++;
    this.depthCount++;

    // Chain onto the tail. `.then(settle, settle)` rather than `.then` alone:
    // a rejected predecessor must not break the chain for everyone behind it.
    const settled = this.tail.then(() => undefined, () => undefined);
    const run = settled.then(() => this.execute(task));

    // The tail swallows rejections so one failure cannot poison the queue.
    this.tail = run.then(() => undefined, () => undefined);
    this.results.set(task.clientOrderId, run);
    return run;
  }

  private async execute<T>(task: TxTask<T>): Promise<T> {
    this.depthCount--;
    this.inFlightCount++;
    const isClash = task.isNonceClash ?? DEFAULT_NONCE_CLASH;
    try {
      return await this.attempt(task, isClash, false);
    } finally {
      this.inFlightCount--;
    }
  }

  private async attempt<T>(task: TxTask<T>, isClash: (e: unknown) => boolean, isRetry: boolean): Promise<T> {
    const nonce = await this.nonces.reserve();
    try {
      const out = await this.withTimeout(task.run(nonce), task.clientOrderId);
      this.nonces.confirm(nonce);
      this.stats.completed++;
      return out;
    } catch (e) {
      // Release before deciding what to do: an unreleased nonce strands every
      // later transaction behind a gap that will never be filled.
      this.nonces.release(nonce);

      if (!isRetry && isClash(e)) {
        // The chain disagrees with our local counter. Re-read it and try once.
        // Once only: a clash that survives a resync is a real error, and an
        // unbounded retry on a signing key is how you double-spend an intent.
        this.stats.retried++;
        await this.nonces.resync();
        return this.attempt(task, isClash, true);
      }

      this.stats.failed++;
      const err = e instanceof Error ? e : new Error(String(e));
      this.onError?.(err, task.clientOrderId);
      throw err;
    }
  }

  private withTimeout<T>(p: Promise<T>, id: string): Promise<T> {
    if (!(this.timeoutMs > 0)) return p;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.timedOut++;
        reject(new Error(`TxQueue: ${id} did not settle within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref?.();
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /** Resolve once everything currently queued has settled. */
  async drain(): Promise<void> {
    // Re-await until the tail stops changing: tasks may enqueue more work.
    for (let i = 0; i < 100; i++) {
      const before = this.tail;
      await before.then(() => undefined, () => undefined);
      if (this.tail === before && this.depthCount === 0 && this.inFlightCount === 0) return;
    }
  }

  /** Forget dedupe history. Between runs only — never mid-session. */
  reset(): void {
    this.results.clear();
    this.tail = Promise.resolve();
    this.depthCount = 0;
    this.inFlightCount = 0;
    this.stats = { submitted: 0, completed: 0, failed: 0, deduped: 0, retried: 0, timedOut: 0 };
  }
}
