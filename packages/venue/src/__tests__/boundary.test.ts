// Acceptance for the reference-mode boundary resolver.
// Live venue markets ask "does X close at or above its OPENING price?" — they carry
// strike "0" (the reference sentinel), so MIRA skips them all with
// BOUNDARY_NOT_POSTED (observed: 214 skips in one LIVE run) until the opening
// price is sourced from the oracle price feed. spec: RFC-001 A4 · T-S1
import { describe, it, expect, vi } from 'vitest';
import { feedSymbolFor, scaleFeedPrice, bucketFor, createBoundarySource } from '../boundary.ts';

describe('asset → feed symbol', () => {
  it('maps a market asset onto the price feed pair', () => {
    expect(feedSymbolFor('ETH')).toBe('ETH/USDC');
    expect(feedSymbolFor('BTC')).toBe('BTC/USDC');
    expect(feedSymbolFor('eth')).toBe('ETH/USDC');
  });
  it('returns null for an asset the feed does not carry', () => {
    expect(feedSymbolFor('?')).toBeNull();
    expect(feedSymbolFor('')).toBeNull();
  });
});

describe('feed price scaling', () => {
  it('decodes the 18dp fixed-point the feed returns', () => {
    // observed live: ETH open 2488.935
    expect(scaleFeedPrice('2488935000000000000000')).toBeCloseTo(2488.935, 6);
    expect(scaleFeedPrice('103955000000000000000')).toBeCloseTo(103.955, 6);
  });
  it('rejects a value that is not a positive finite price', () => {
    expect(scaleFeedPrice('0')).toBeNull();
    expect(scaleFeedPrice('')).toBeNull();
    expect(scaleFeedPrice(null)).toBeNull();
  });
});

describe('bucket alignment', () => {
  it('snaps a timestamp down to its M1 bucket', () => {
    expect(bucketFor(1788812100)).toBe(1788812100); // already aligned
    expect(bucketFor(1788812137)).toBe(1788812100);
    expect(bucketFor(1788812159)).toBe(1788812100);
  });
});

describe('boundary source', () => {
  const candle = (bucketStart: number, open: string) => ({
    data: { Candle: [{ symbol: 'ETH/USDC', bucketStart: String(bucketStart), open, resolution: 'M1' }] },
  });

  it('resolves the OPEN of the bucket at tradingStart', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, json: async () => candle(1788812100, '2488935000000000000000'),
    });
    const src = createBoundarySource({ fetchImpl: fetchImpl as never });
    expect(await src.resolve('ETH', 1788812100)).toBeCloseTo(2488.935, 6);
  });

  it('caches per (asset, tradingStart) — a market is polled every cycle', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, json: async () => candle(1788812100, '2488935000000000000000'),
    });
    const src = createBoundarySource({ fetchImpl: fetchImpl as never });
    await src.resolve('ETH', 1788812100);
    await src.resolve('ETH', 1788812100);
    await src.resolve('ETH', 1788812100);
    // The feed is rate-limited (T-S4); one lookup per market, not one per tick.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null (never a guess) when the feed has no candle yet', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { Candle: [] } }) });
    const src = createBoundarySource({ fetchImpl: fetchImpl as never });
    expect(await src.resolve('ETH', 1788812100)).toBeNull();
  });

  it('never throws into the trading path — a feed error is a null boundary', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('feed down'));
    const src = createBoundarySource({ fetchImpl: fetchImpl as never });
    await expect(src.resolve('ETH', 1788812100)).resolves.toBeNull();
  });

  it('does not cache a failure, so a transient outage self-heals', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('feed down'))
      .mockResolvedValue({ ok: true, json: async () => candle(1788812100, '2488935000000000000000') });
    const src = createBoundarySource({ fetchImpl: fetchImpl as never });
    expect(await src.resolve('ETH', 1788812100)).toBeNull();
    expect(await src.resolve('ETH', 1788812100)).toBeCloseTo(2488.935, 6);
  });

  it('returns null for an unknown asset without calling the feed', async () => {
    const fetchImpl = vi.fn();
    const src = createBoundarySource({ fetchImpl: fetchImpl as never });
    expect(await src.resolve('?', 1788812100)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
