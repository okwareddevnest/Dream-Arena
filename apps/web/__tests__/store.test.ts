// T-051 acceptance — the arena store.
// spec: 30-TASKS T-051 · IF §13 · PRD F-A1
// Stale policy (operator decision): on disconnect KEEP the last value, mark it
// stale, and show its age — blanking the arena on a one-second blip is worse
// than a visibly-old number. A value is only ever hidden if it never arrived.
import { describe, it, expect } from 'vitest';
import { createArenaStore, STALE_WARN_MS } from '../lib/store';

const snap = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1', mode: 'LIVE', markets: [{ id: 'm1', symbol: 'BTC-REF', asset: 'BTC' }],
  model: null, valuations: [], positions: [], tape: [], pnlCurve: [],
  round: null, leaderboard: [], health: { ok: true }, quips: [], ...over,
});

describe('snapshot hydration', () => {
  it('replaces state wholesale — a reconnect never merges onto stale data', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap({ tape: [{ fillId: 'f1' }] }) });
    expect(s.get().tape).toHaveLength(1);
    // A second snapshot is a NEW truth, not an update.
    s.apply({ t: 'snapshot', d: snap({ tape: [] }) });
    expect(s.get().tape, 'old fills must not survive a rehydrate').toHaveLength(0);
  });

  it('records the run and mode from hello', () => {
    const s = createArenaStore();
    s.apply({ t: 'hello', d: { runId: 'run-9', mode: 'LIVE', serverMs: 1, protocol: 1 } });
    expect(s.get().runId).toBe('run-9');
    expect(s.get().mode).toBe('LIVE');
  });
});

describe('event folding', () => {
  it('folds a fill onto the tape, newest first', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap() });
    s.apply({ t: 'ev', d: { t: 'fill', d: { fillId: 'f1', tsMs: 1 } } });
    s.apply({ t: 'ev', d: { t: 'fill', d: { fillId: 'f2', tsMs: 2 } } });
    expect(s.get().tape.map((f: any) => f.fillId)).toEqual(['f2', 'f1']);
  });

  it('bounds the tape so a long session cannot grow without limit', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap() });
    for (let i = 0; i < 500; i++) s.apply({ t: 'ev', d: { t: 'fill', d: { fillId: `f${i}`, tsMs: i } } });
    expect(s.get().tape.length).toBeLessThanOrEqual(200);
  });

  it('ignores an unknown event type instead of crashing', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap() });
    expect(() => s.apply({ t: 'ev', d: { t: 'not_a_real_topic', d: {} } })).not.toThrow();
    expect(() => s.apply({ t: 'wat', d: {} } as never)).not.toThrow();
    expect(() => s.apply(null as never)).not.toThrow();
    expect(() => s.apply({ t: 'ev' } as never)).not.toThrow();
  });

  it('drops an event that arrives before any snapshot', () => {
    const s = createArenaStore();
    s.apply({ t: 'ev', d: { t: 'fill', d: { fillId: 'f1' } } });
    expect(s.get().hydrated).toBe(false);
    expect(s.get().tape).toHaveLength(0);
  });

  it('commits an event in well under 5 ms so tick→paint stays inside 50 ms', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap() });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) s.apply({ t: 'ev', d: { t: 'fill', d: { fillId: `f${i}`, tsMs: i } } });
    expect((performance.now() - t0) / 100).toBeLessThan(5);
  });
});

describe('staleness', () => {
  it('is fresh right after an event', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap() }, 1_000);
    expect(s.staleness(1_200).stale).toBe(false);
  });

  it('turns stale past the warn threshold but KEEPS the last values', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap({ tape: [{ fillId: 'f1' }] }) }, 1_000);
    const st = s.staleness(1_000 + STALE_WARN_MS + 1);
    expect(st.stale).toBe(true);
    expect(st.ageMs).toBeGreaterThan(STALE_WARN_MS);
    expect(s.get().tape, 'data is marked old, never discarded').toHaveLength(1);
  });

  it('reports disconnection without throwing away what it knows', () => {
    const s = createArenaStore();
    s.apply({ t: 'snapshot', d: snap({ tape: [{ fillId: 'f1' }] }) });
    s.setConnected(false);
    expect(s.get().connected).toBe(false);
    expect(s.get().tape).toHaveLength(1);
  });
});
