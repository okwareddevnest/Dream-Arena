// A market you cannot round-trip in is not tradable.
// Observed LIVE: the 5m series rolls continuously, so getMarkets returned markets
// with ~6s left. MIRA valued them, found edge, and fired orders whose expiry had
// already passed by the time the serialized TxQueue submitted them — 8 orders,
// 1 rejection ("order expiry is not in the future"), 7 queue timeouts, 0 fills.
import { describe, it, expect } from 'vitest';
import { tradableByTime } from '../boundary.ts';

const mk = (expiryMs: number) => ({ expiryMs }) as { expiryMs: number };

describe('minimum time-to-expiry guard', () => {
  const now = 1_000_000;

  it('keeps a market with comfortable time left', () => {
    expect(tradableByTime(mk(now + 300_000), now, 60_000)).toBe(true);
  });

  it('drops a market that expires inside the guard window', () => {
    // the exact live failure: 6s of life, 30s queue timeout
    expect(tradableByTime(mk(now + 6_000), now, 60_000)).toBe(false);
  });

  it('drops an already-expired market', () => {
    expect(tradableByTime(mk(now - 1), now, 60_000)).toBe(false);
  });

  it('is inclusive at the boundary so the threshold is not off by one', () => {
    expect(tradableByTime(mk(now + 60_000), now, 60_000)).toBe(true);
    expect(tradableByTime(mk(now + 59_999), now, 60_000)).toBe(false);
  });

  it('disables cleanly when the guard is zero (preserves prior behaviour)', () => {
    expect(tradableByTime(mk(now + 1), now, 0)).toBe(true);
    expect(tradableByTime(mk(now - 1), now, 0)).toBe(false);
  });

  it('treats a missing expiry as untradable rather than infinite', () => {
    expect(tradableByTime(mk(Number.NaN), now, 60_000)).toBe(false);
  });
});
