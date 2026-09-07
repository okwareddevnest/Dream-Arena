// Maker-side fills must reach the engine too.
// Fills caused by OUR OWN order come back in the placeOrder result. But when MIRA
// rests a quote and someone else hits it (exactly what ECHO will do), that fill
// exists only on the chain's live tail. Without it the trade tape misses half the
// story and PnL is wrong until the reconciler's next poll.
import { describe, it, expect, vi } from 'vitest';
import { DreamDEXVenue, type SdkClient, type SdkMarketRow, type SdkLiveFill } from '../dreamdex.ts';
import type { Fill } from '@arena/shared';

const MARKET = '0xmarket1';
const row = (): SdkMarketRow => ({
  marketId: MARKET, asset: 'BTC', strike: '7933525', intervalSec: 300,
  expiry: String(Math.floor(Date.now() / 1000) + 3600),
  tradingStart: String(Math.floor(Date.now() / 1000) - 60),
  status: 'Trading', poolAddress: '0xpool', nonce: 1, venueId: '0xvenue', operatorId: 2,
});

const base: SdkClient = {
  listBinaryMarkets: async () => [row()],
  getMarketOnchain: async () => ({ status: 1, poolAddress: '0xpool', nonce: 1, winningOutcome: null }),
  fetchOrderBook: async () => ({ bids: [[0.48, 100]], asks: [[0.52, 100]] }),
  placeOrderRaw: async () => ({ hash: '0x1', receipt: { status: 'success' }, orderId: 'vo-1' }),
  cancelOrder: async () => ({ hash: '0x2', receipt: { status: 'success' } }),
  openOrders: async () => [],
  outcomeBalances: async () => ({ yes: 0, no: 0 }),
  collateralBalance: async () => 1000,
  mintSet: async () => ({ hash: '0x3', receipt: { status: 'success' } }),
  redeem: async () => ({ hash: '0x4', receipt: { status: 'success' } }),
  blockNumber: async () => 1,
  getTransactionCount: async () => 0,
};

const liveFill = (over: Partial<SdkLiveFill> = {}): SdkLiveFill => ({
  id: '100_1', marketId: MARKET, fillPrice: '420000', quantity: '25000000',
  side: 'YES', txHash: '0xmaker', tsMs: 1_000, ...over,
});

const mkVenue = (client: SdkClient) => new DreamDEXVenue({
  client, agent: 'MIRA', venueId: '0xvenue', privateKey: '0xkey',
  explorerBase: 'https://explorer.test/tx/',
});

describe('maker-side fills from the live tail', () => {
  it('emits a Fill for a match we did not initiate', async () => {
    const seen: Fill[] = [];
    const venue = mkVenue({ ...base, liveUserFills: async () => [liveFill()] });
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    await venue.pollMakerFills();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sizeContracts).toBe(25);
    expect(seen[0]!.price).toBeCloseTo(0.42, 9);
    expect(seen[0]!.side).toBe('YES');
    expect(seen[0]!.explorerUrl).toBe('https://explorer.test/tx/0xmaker');
  });

  it('never emits the same fill twice, however often it is polled', async () => {
    const seen: Fill[] = [];
    const venue = mkVenue({ ...base, liveUserFills: async () => [liveFill()] });
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    await venue.pollMakerFills();
    await venue.pollMakerFills();
    await venue.pollMakerFills();
    expect(seen, 'deduped by the chain fill id').toHaveLength(1);
  });

  it('does not re-emit a fill already published from a placeOrder result', async () => {
    const seen: Fill[] = [];
    // Same chain fill id the taker path would have used.
    const venue = mkVenue({
      ...base,
      placeOrderRaw: async () => ({
        hash: '0xtaker', receipt: { status: 'success' }, orderId: 'vo-1',
        fills: [{ quantityFilled: 25_000_000n, fillPrice: 420_000n, id: '100_1' }],
      }),
      liveUserFills: async () => [liveFill({ id: '100_1' })],
    });
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    await venue.placeOrder({
      clientOrderId: 'MIRA-1', marketId: MARKET, agent: 'MIRA', side: 'YES',
      kind: 'BUY_YES', type: 'LIMIT', limitPrice: 0.42, limitPriceRaw: 420_000n,
      sizeContracts: 25, sizeRaw: 25_000_000n, expiresMs: Date.now() + 60_000,
      signalId: 's', tsMs: Date.now(),
    });
    await venue.pollMakerFills();
    expect(seen, 'one trade, one fill event').toHaveLength(1);
  });

  it('is a no-op when the client cannot tail (stub transports)', async () => {
    const venue = mkVenue(base);
    await venue.connect();
    await expect(venue.pollMakerFills()).resolves.toBe(0);
  });

  it('a tail error never reaches the trading path', async () => {
    const venue = mkVenue({ ...base, liveUserFills: vi.fn().mockRejectedValue(new Error('socket down')) });
    await venue.connect();
    await expect(venue.pollMakerFills()).resolves.toBe(0);
  });
});
