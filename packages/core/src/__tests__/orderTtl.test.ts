// Order TTL must outlive the write path.
// Observed LIVE: TTL was quoteCacheMs*4 = 6s, but a serialized on-chain write
// takes 25-35s under load, so EVERY order was rejected with
// "order expiry is not in the future" before it could be submitted.
// The TTL is a race between quote staleness and settlement latency; on a real
// chain settlement wins, so it has to be configurable.
import { describe, it, expect } from 'vitest';
import { orderExpiryMs, DEFAULT_ORDER_TTL_MS } from '../engine.ts';

describe('order expiry', () => {
  const now = 1_000_000;
  const farExpiry = now + 3_600_000; // a 1h market

  it('uses the configured TTL rather than the quote-cache heuristic', () => {
    expect(orderExpiryMs(now, farExpiry, 45_000)).toBe(now + 45_000);
  });

  it('never outlives the market itself (RFC-001 A2)', () => {
    const soon = now + 10_000;
    expect(orderExpiryMs(now, soon, 45_000)).toBe(soon);
  });

  it('the LIVE default comfortably exceeds an observed 35s queue latency', () => {
    // the exact failure: 6s TTL vs 25-35s to reach the chain
    expect(DEFAULT_ORDER_TTL_MS).toBeGreaterThan(35_000);
  });

  it('falls back to a positive TTL when given a nonsense value', () => {
    expect(orderExpiryMs(now, farExpiry, 0)).toBeGreaterThan(now);
    expect(orderExpiryMs(now, farExpiry, -1)).toBeGreaterThan(now);
    expect(orderExpiryMs(now, farExpiry, Number.NaN)).toBeGreaterThan(now);
  });
});
