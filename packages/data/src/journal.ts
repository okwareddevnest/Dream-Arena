// Append-only JSONL decision journal (FR-D3, IF §8, WP §7).
//
// This is the "unrecoverable state" leg of the integrity quartet: every signal,
// order, fill and model state is written so a run can be replayed and audited.
// Three constraints shape the implementation:
//
//   1. `append` MUST NOT block or await. The engine calls it inside the tick
//      path, so it returns a seq synchronously and the bytes go out later. A
//      journal that made the engine wait on a disk would turn an I/O hiccup
//      into a missed trade.
//   2. `append` MUST NOT throw. A full disk is not a reason to stop trading —
//      it is a reason to raise an error event and keep going. Failures surface
//      through `onError`, never through the call site.
//   3. One record is one line, always. A newline inside a record would split it
//      in two and make the file unreplayable, so JSON.stringify's output is
//      escaped by construction (it already escapes \n inside strings) and the
//      result is asserted to be single-line.
import { appendFileSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SystemClock, type Clock, type JournalEvent, type JournalKind, type Mode } from '@arena/shared';

export interface JournalOptions {
  dir: string;
  runId: string;
  mode: Mode;
  clock?: Clock;
  /** Flush when this many records are buffered. */
  batchSize?: number;
  /** Flush at most this long after the first buffered record. */
  batchMs?: number;
}

export interface JournalStats {
  appended: number; written: number; writes: number; failures: number; buffered: number;
}

/** JSON replacer: bigints are real in this system (raw tick/lot prices, RFC-001
 *  A8) and `JSON.stringify` throws on them by default. Stringify rather than
 *  Number() so no precision is lost. */
const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

export class Journal {
  readonly path: string;
  readonly runId: string;
  readonly mode: Mode;
  private readonly clock: Clock;
  private readonly batchSize: number;
  private readonly batchMs: number;
  private buf: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _seq = 0;
  private counters = { appended: 0, written: 0, writes: 0, failures: 0 };
  private errCbs: ((e: Error) => void)[] = [];
  private dirReady = false;
  private closed = false;
  private readonly dir: string;

  constructor(opts: JournalOptions) {
    this.dir = opts.dir;
    this.runId = opts.runId;
    this.mode = opts.mode;
    this.clock = opts.clock ?? new SystemClock();
    this.batchSize = opts.batchSize ?? 64;
    this.batchMs = opts.batchMs ?? 50;
    this.path = join(opts.dir, `${opts.runId}.jsonl`);
  }

  get seq(): number { return this._seq; }

  onError(cb: (e: Error) => void): () => void {
    this.errCbs.push(cb);
    return () => { const i = this.errCbs.indexOf(cb); if (i >= 0) this.errCbs.splice(i, 1); };
  }

  /**
   * Record an event. Returns its seq immediately; bytes are flushed in a batch.
   * Never throws, never blocks.
   */
  append<K extends JournalKind>(kind: K, payload: unknown): number {
    const seq = ++this._seq;
    this.counters.appended++;
    if (this.closed) return seq;
    const ev: JournalEvent<K> = { seq, kind, tsMs: this.clock.now(), mode: this.mode, runId: this.runId, payload };
    try {
      // JSON.stringify escapes control characters inside strings, so the result
      // U+2028/U+2029 are legal inside a JSON string but act as line terminators
      // for some parsers, so they are neutralised explicitly.
      const line = JSON.stringify(ev, replacer).replace(/[\u2028\u2029]/g, ' ');
      this.buf.push(line);
    } catch (e) {
      // An unserializable payload (a cycle, a function) must not lose the seq.
      this.buf.push(JSON.stringify({
        seq, kind, tsMs: this.clock.now(), mode: this.mode, runId: this.runId,
        payload: { unserializable: e instanceof Error ? e.message : String(e) },
      }));
    }
    if (this.buf.length >= this.batchSize) {
      this.writeNow();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => { this.timer = null; this.writeNow(); }, this.batchMs);
      this.timer.unref?.();
    }
    return seq;
  }

  /** Force buffered records to disk and fsync. Awaitable — for shutdown, tests
   *  and the pre-demo checklist, never for the tick path. */
  async flush(): Promise<void> {
    this.writeNow();
    if (this.counters.written === 0) return;
    try {
      const fd = openSync(this.path, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch (e) {
      this.fail(e);
    }
  }

  async close(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
    this.closed = true;
  }

  stats(): JournalStats {
    return { ...this.counters, buffered: this.buf.length };
  }

  private writeNow(): void {
    if (this.buf.length === 0) return;
    const chunk = this.buf.join('\n') + '\n';
    const n = this.buf.length;
    this.buf = [];
    try {
      if (!this.dirReady) { mkdirSync(this.dir, { recursive: true }); this.dirReady = true; }
      appendFileSync(this.path, chunk);
      this.counters.writes++;
      this.counters.written += n;
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.counters.failures++;
    const err = e instanceof Error ? e : new Error(String(e));
    for (const cb of [...this.errCbs]) { try { cb(err); } catch { /* nothing left to tell */ } }
  }
}

export interface ReplayOptions {
  /** Called for a line that could not be used, with a reason. Warnings are
   *  surfaced rather than swallowed: a silently-skipped line means a replay
   *  that quietly disagrees with the run it claims to reproduce. */
  onWarn?: (msg: string) => void;
}

/**
 * Stream a journal file back as events.
 *
 * Tolerant in exactly two ways, both deliberate: a truncated final line (the
 * normal shape of a power loss) is skipped with a warning, and blank lines are
 * ignored silently. A `seq` gap is reported — a spliced or partially-copied
 * journal must not replay as if it were whole.
 */
export function* replayFile(path: string, opts: ReplayOptions = {}): Generator<JournalEvent> {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  let expected = 1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    let ev: JournalEvent;
    try {
      ev = JSON.parse(raw) as JournalEvent;
    } catch {
      opts.onWarn?.(`journal ${path}: line ${i + 1} is not valid JSON (truncated?) — skipped`);
      continue;
    }
    if (typeof ev?.seq !== 'number' || typeof ev?.kind !== 'string') {
      opts.onWarn?.(`journal ${path}: line ${i + 1} is not a JournalEvent — skipped`);
      continue;
    }
    if (ev.seq !== expected) {
      opts.onWarn?.(`journal ${path}: seq gap at line ${i + 1} — expected ${expected}, got ${ev.seq}`);
    }
    expected = ev.seq + 1;
    yield ev;
  }
}

/** Replay a file through a consumer. Returns the number of events delivered. */
export function replay(path: string, onEvent: (e: JournalEvent) => void, opts: ReplayOptions = {}): number {
  let n = 0;
  for (const ev of replayFile(path, opts)) { onEvent(ev); n++; }
  return n;
}
