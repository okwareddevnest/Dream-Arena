// T-002 — clientOrderId is the venue idempotency key (FR-X1). A collision means a
// duplicate position; an unsortable id means an unreadable journal.
import { describe, it, expect } from 'vitest';
import { newClientOrderId, newRunId, newId, VirtualClock } from '../index.ts';

describe('T-002 newClientOrderId', () => {
  it('is unique across 10 000 calls', () => {
    const s = new Set<string>();
    for (let i = 0; i < 10_000; i++) s.add(newClientOrderId('MIRA'));
    expect(s.size).toBe(10_000);
  });
  it('is at most 64 characters (venue key budget)', () => {
    for (let i = 0; i < 1_000; i++) expect(newClientOrderId('MIRA').length).toBeLessThanOrEqual(64);
  });
  it('is lexicographically sortable in creation order', () => {
    const ids = Array.from({ length: 2_000 }, () => newClientOrderId('MIRA'));
    expect([...ids].sort()).toEqual(ids);
  });
  it('stays sortable across a clock tick boundary', () => {
    const c = new VirtualClock(1_000);
    const a = newClientOrderId('MIRA', c);
    c.advance(5);
    const b = newClientOrderId('MIRA', c);
    expect(a < b).toBe(true);
  });
  it('embeds the agent so two agents never collide even at the same instant', () => {
    const c = new VirtualClock(1_000);
    const m = newClientOrderId('MIRA', c);
    const e = newClientOrderId('ECHO', c);
    expect(m).not.toBe(e);
    expect(m).toContain('MIRA');
    expect(e).toContain('ECHO');
  });
  it('contains only characters safe for a URL, a filename and a log line', () => {
    for (let i = 0; i < 500; i++) expect(newClientOrderId('MIRA')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('T-002 newRunId / newId', () => {
  it('newRunId is unique and filename-safe (journals are named by it)', () => {
    const s = new Set(Array.from({ length: 1_000 }, () => newRunId()));
    expect(s.size).toBe(1_000);
    for (const id of s) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('newId prefixes so a journal line says what an id refers to', () => {
    expect(newId('fill')).toMatch(/^fill-/);
    expect(newId('sig')).toMatch(/^sig-/);
  });
  it('newId is unique across 10 000 calls', () => {
    const s = new Set(Array.from({ length: 10_000 }, () => newId('fill')));
    expect(s.size).toBe(10_000);
  });
});
