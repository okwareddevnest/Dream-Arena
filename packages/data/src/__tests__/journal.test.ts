// T-011 — the journal is the "unrecoverable state" leg of the integrity quartet
// (WP §7). Its job is to make a run replayable, which means: strictly increasing
// seq, one valid JSON object per line, and — critically — writes that never
// block or break the trading path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, replay, replayFile } from '../journal.ts';
import { VirtualClock, type JournalEvent } from '@arena/shared';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'arena-journal-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const mk = (over: Partial<ConstructorParameters<typeof Journal>[0]> = {}) =>
  new Journal({ dir, runId: 'run-test', mode: 'SIM', clock: new VirtualClock(1_000), ...over });

describe('T-011 sequencing', () => {
  it('starts at 1 and increases by exactly 1 per event', async () => {
    const j = mk();
    const seqs = [j.append('tick', {}), j.append('fill', {}), j.append('signal', {})];
    expect(seqs).toEqual([1, 2, 3]);
    expect(j.seq).toBe(3);
    await j.close();
  });

  it('never reuses a seq across 10 000 appends', async () => {
    const j = mk();
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) seen.add(j.append('tick', { i }));
    expect(seen.size).toBe(10_000);
    await j.close();
  });
});

describe('T-011 file format', () => {
  it('writes one valid JSON object per line that round-trips to an equal object', async () => {
    const j = mk();
    const payload = { marketId: 'm1', edge: 0.07, nested: { a: [1, 2, 3] }, s: 'quote "x"\nline' };
    j.append('valuation', payload);
    await j.close();
    const lines = readFileSync(j.path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!) as JournalEvent<'valuation', typeof payload>;
    expect(ev).toEqual({ seq: 1, kind: 'valuation', tsMs: 1_000, mode: 'SIM', runId: 'run-test', payload });
  });

  it('names the file by runId so a run is findable', async () => {
    const j = mk({ runId: 'run-abc' });
    j.append('tick', {});
    await j.close();
    expect(j.path.endsWith('run-abc.jsonl')).toBe(true);
    expect(existsSync(j.path)).toBe(true);
  });

  it('serializes a bigint rather than throwing on it (raw prices are bigints)', async () => {
    const j = mk();
    j.append('order', { limitPriceRaw: 500_000n, sizeRaw: 1_000n });
    await j.close();
    const ev = JSON.parse(readFileSync(j.path, 'utf8').trim()) as JournalEvent<'order', { limitPriceRaw: string }>;
    expect(ev.payload.limitPriceRaw).toBe('500000');
  });

  it('never emits a newline inside a record (one record must be one line)', async () => {
    const j = mk();
    j.append('error', { where: 'x', msg: 'line1\nline2\r\nline3' });
    await j.close();
    expect(readFileSync(j.path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('T-011 non-blocking (the engine must never wait on disk)', () => {
  it('appends 1 000 events in under 1 ms each without awaiting', () => {
    const j = mk();
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i++) j.append('tick', { i });
    const el = performance.now() - t0;
    expect(el / 1_000).toBeLessThan(1);
    void j.close();
  });

  it('append returns a number, not a promise (a promise would invite an await)', () => {
    const j = mk();
    expect(typeof j.append('tick', {})).toBe('number');
    void j.close();
  });

  // A non-existent directory is NOT a failure — mkdir -p creates it. To get a
  // real EEXIST/ENOTDIR we make a parent path component a regular file.
  const unwritableDir = () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a file, not a directory');
    return join(blocker, 'journal');
  };

  it('a write failure does not throw to the caller and is reported once', async () => {
    const j = mk({ dir: unwritableDir() });
    const onError = vi.fn();
    j.onError(onError);
    expect(() => j.append('tick', {})).not.toThrow();
    await j.flush().catch(() => undefined);
    expect(onError).toHaveBeenCalled();
    await j.close().catch(() => undefined);
  });

  it('keeps accepting appends after a write failure (trading continues)', async () => {
    const j = mk({ dir: unwritableDir() });
    j.onError(() => {});
    j.append('tick', {});
    await j.flush().catch(() => undefined);
    expect(() => j.append('tick', {})).not.toThrow();
    expect(j.seq).toBe(2);
    await j.close().catch(() => undefined);
  });
});

describe('T-011 flush and durability', () => {
  it('flush fsyncs and a re-read sees every event', async () => {
    const j = mk();
    for (let i = 0; i < 500; i++) j.append('tick', { i });
    await j.flush();
    const lines = readFileSync(j.path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(500);
    expect(JSON.parse(lines[499]!).seq).toBe(500);
    await j.close();
  });

  it('close flushes anything still buffered', async () => {
    const j = mk();
    j.append('tick', { last: true });
    await j.close();
    expect(readFileSync(j.path, 'utf8')).toContain('"last":true');
  });

  it('batches writes rather than issuing one syscall per event', async () => {
    const j = mk();
    for (let i = 0; i < 200; i++) j.append('tick', { i });
    expect(j.stats().writes).toBeLessThan(200);
    await j.close();
    expect(j.stats().appended).toBe(200);
  });
});

describe('T-011 replay', () => {
  it('yields events in original order with identical seqs', async () => {
    const j = mk();
    const kinds = ['tick', 'model', 'signal', 'order', 'fill'] as const;
    for (const k of kinds) j.append(k, { k });
    await j.close();
    const out = [...replayFile(j.path)];
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(out.map((e) => e.kind)).toEqual([...kinds]);
  });

  it('skips a truncated final line with a warning instead of crashing', async () => {
    const j = mk();
    j.append('tick', { ok: 1 });
    await j.close();
    appendFileSync(j.path, '{"seq":2,"kind":"tick","tsMs":1,"mo');   // power-loss tail
    const warns: string[] = [];
    const out = [...replayFile(j.path, { onWarn: (w) => warns.push(w) })];
    expect(out).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/line 2/);
  });

  it('skips a blank line without warning', async () => {
    const j = mk();
    j.append('tick', {});
    await j.close();
    appendFileSync(j.path, '\n\n');
    const warns: string[] = [];
    expect([...replayFile(j.path, { onWarn: (w) => warns.push(w) })]).toHaveLength(1);
    expect(warns).toHaveLength(0);
  });

  it('detects a seq gap so a spliced journal cannot be replayed silently', async () => {
    const j = mk();
    j.append('tick', {});
    await j.close();
    appendFileSync(j.path, JSON.stringify({ seq: 7, kind: 'tick', tsMs: 2, mode: 'SIM', runId: 'run-test', payload: {} }) + '\n');
    const warns: string[] = [];
    const out = [...replayFile(j.path, { onWarn: (w) => warns.push(w) })];
    expect(out).toHaveLength(2);
    expect(warns.some((w) => /gap/i.test(w))).toBe(true);
  });

  it('replays a 100 000-event journal in under 10 s', async () => {
    const j = mk();
    for (let i = 0; i < 100_000; i++) j.append('tick', { i });
    await j.close();
    const t0 = performance.now();
    let n = 0;
    for (const _ of replayFile(j.path)) n++;
    expect(n).toBe(100_000);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it('is deterministic across two replays of the same file', async () => {
    const j = mk();
    for (let i = 0; i < 100; i++) j.append('tick', { i });
    await j.close();
    const a = JSON.stringify([...replayFile(j.path)]);
    const b = JSON.stringify([...replayFile(j.path)]);
    expect(a).toBe(b);
  });

  it('replay() re-publishes events onto a bus in order so any consumer can rebuild', async () => {
    const j = mk();
    j.append('tick', { symbol: 'BTC', price: 1, tsMs: 1, seq: 1, source: 'fixture' });
    j.append('fill', { fillId: 'f1' });
    await j.close();
    const seen: string[] = [];
    const n = replay(j.path, (e) => { seen.push(e.kind); });
    expect(n).toBe(2);
    expect(seen).toEqual(['tick', 'fill']);
  });

  it('returns nothing for a missing file rather than throwing', () => {
    expect([...replayFile(join(dir, 'nope.jsonl'))]).toEqual([]);
  });
});
