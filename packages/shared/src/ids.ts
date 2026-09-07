// Identifiers.
//
// `clientOrderId` is the venue's idempotency key (FR-X1): if two orders ever
// share one, the tx queue's dedupe collapses them and a position goes missing;
// if it is not sortable, a journal cannot be read in causal order. So the id is
// built as `<agent>-<time base36, zero-padded>-<counter base36>-<random>`:
//   • time first  → lexicographic order == chronological order
//   • agent in it → MIRA and ECHO cannot collide at the same instant (RFC-001 A7)
//   • counter     → uniqueness within a single millisecond
//   • random      → uniqueness across processes sharing a clock
import type { AgentId } from './types.ts';
import type { Clock } from './clock.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return s;
};

// 11 base-36 digits covers epoch millis until well past year 5000, so the
// zero-padding never changes width and sorting never breaks.
const TIME_WIDTH = 11;
const stamp = (ms: number): string => Math.floor(ms).toString(36).padStart(TIME_WIDTH, '0');

let counter = 0;
const nextCount = (): string => {
  counter = (counter + 1) % 1_679_616;      // 36^4
  return counter.toString(36).padStart(4, '0');
};

/** Sanitize an agent id into the id charset, bounded so the total stays ≤64. */
const tag = (agent: AgentId): string => String(agent).replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'ANON';

/** Venue idempotency key. ≤64 chars, URL/filename/log safe, sortable. */
export function newClientOrderId(agent: AgentId, clock?: Clock): string {
  return `${tag(agent)}-${stamp(clock ? clock.now() : Date.now())}-${nextCount()}-${rand(6)}`;
}

/** Run identifier — also the journal filename, so it must be filesystem-safe. */
export function newRunId(clock?: Clock): string {
  return `run-${stamp(clock ? clock.now() : Date.now())}-${nextCount()}-${rand(4)}`;
}

/** Prefixed id, so a bare id in a log line says what it refers to. */
export function newId(prefix: string, clock?: Clock): string {
  const p = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'id';
  return `${p}-${stamp(clock ? clock.now() : Date.now())}-${nextCount()}-${rand(5)}`;
}
