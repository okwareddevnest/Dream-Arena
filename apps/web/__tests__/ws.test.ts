// T-051 acceptance — the WS client's connection behaviour.
// spec: 30-TASKS T-051 · IF §13
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createArenaClient, backoffMs } from '../lib/ws';
import { createArenaStore } from '../lib/store';

/** Minimal stand-in for the browser WebSocket, driven by the test. */
class FakeSocket {
  static made: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string) { FakeSocket.made.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

afterEach(() => { FakeSocket.made = []; vi.useRealTimers(); });

const snap = { runId: 'r1', mode: 'LIVE', markets: [], model: null, valuations: [], positions: [],
  tape: [], pnlCurve: [], round: null, leaderboard: [], health: null, quips: [] };

describe('reconnect backoff', () => {
  it('grows with each consecutive failure and then holds a ceiling', () => {
    const seq = [0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n));
    for (let i = 1; i < 5; i++) expect(seq[i]!).toBeGreaterThan(seq[i - 1]!);
    expect(seq.at(-1)!).toBeLessThanOrEqual(30_000);
    expect(seq[0]!).toBeGreaterThan(0);
  });
});

describe('client lifecycle', () => {
  it('hydrates the store from the snapshot frame', () => {
    const store = createArenaStore();
    const c = createArenaClient({ url: 'ws://x/ws', store, socketFactory: (u) => new FakeSocket(u) as never });
    c.start();
    const s = FakeSocket.made[0]!;
    s.open();
    s.deliver({ t: 'snapshot', d: snap });
    expect(store.get().hydrated).toBe(true);
    expect(store.get().connected).toBe(true);
    c.stop();
  });

  it('marks the store disconnected when the socket closes', () => {
    const store = createArenaStore();
    const c = createArenaClient({ url: 'ws://x/ws', store, socketFactory: (u) => new FakeSocket(u) as never });
    c.start();
    const s = FakeSocket.made[0]!;
    s.open();
    s.deliver({ t: 'snapshot', d: snap });
    s.close();
    expect(store.get().connected).toBe(false);
    // …and keeps what it knew: the page shows stale values, not blanks.
    expect(store.get().hydrated).toBe(true);
    c.stop();
  });

  it('reconnects after a drop and rebuilds from the NEW snapshot', () => {
    vi.useFakeTimers();
    const store = createArenaStore();
    const c = createArenaClient({ url: 'ws://x/ws', store, socketFactory: (u) => new FakeSocket(u) as never });
    c.start();
    const first = FakeSocket.made[0]!;
    first.open();
    first.deliver({ t: 'snapshot', d: { ...snap, tape: [{ fillId: 'old' }] } });
    expect(store.get().tape).toHaveLength(1);

    first.close();
    vi.advanceTimersByTime(40_000);
    expect(FakeSocket.made.length, 'a new socket was opened').toBeGreaterThan(1);

    const second = FakeSocket.made.at(-1)!;
    second.open();
    second.deliver({ t: 'snapshot', d: { ...snap, tape: [] } });
    expect(store.get().tape, 'rebuilt, not merged').toHaveLength(0);
    c.stop();
  });

  it('survives a malformed frame without dropping the connection', () => {
    const store = createArenaStore();
    const c = createArenaClient({ url: 'ws://x/ws', store, socketFactory: (u) => new FakeSocket(u) as never });
    c.start();
    const s = FakeSocket.made[0]!;
    s.open();
    s.deliver({ t: 'snapshot', d: snap });
    expect(() => s.onmessage?.({ data: 'not json{' })).not.toThrow();
    expect(store.get().connected).toBe(true);
    c.stop();
  });

  it('stop() closes the socket and schedules no further reconnect', () => {
    vi.useFakeTimers();
    const store = createArenaStore();
    const c = createArenaClient({ url: 'ws://x/ws', store, socketFactory: (u) => new FakeSocket(u) as never });
    c.start();
    FakeSocket.made[0]!.open();
    c.stop();
    const made = FakeSocket.made.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.made.length, 'no zombie reconnect after stop').toBe(made);
  });
});
