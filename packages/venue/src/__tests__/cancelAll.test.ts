// cancelAll must not rely on the indexer alone.
// Observed LIVE: MIRA placed three real orders (19.90 tUSDC escrowed), then on
// shutdown logged "cancelled 0 resting order(s)" and exited — because
// `openOrders()` reads the indexer, which lags the chain and returned []. The
// collateral stayed locked in orders nobody was tracking any more. An agent
// must be able to clean up the orders it placed itself, from its own records.
import { describe, it, expect } from 'vitest';
import { DreamDEXVenue, type SdkClient, type SdkMarketRow, type SdkTxResult } from '../dreamdex.ts';

const MARKET = '0xmarket1';
const row = (): SdkMarketRow => ({
  marketId: MARKET, asset: 'BTC', strike: '7933525', intervalSec: 300,
  expiry: String(Math.floor(Date.now() / 1000) + 3600),
  tradingStart: String(Math.floor(Date.now() / 1000) - 60),
  status: 'Trading', poolAddress: '0xpool', nonce: 1, venueId: '0xvenue', operatorId: 2,
});

/** Indexer deliberately blind (the live behaviour); cancels are recorded. */
const mkClient = (cancelled: string[]): SdkClient => {
  let placed = 0;
  return ({
  listBinaryMarkets: async () => [row()],
  getMarketOnchain: async () => ({ status: 1, poolAddress: '0xpool', nonce: 1, winningOutcome: null }),
  fetchOrderBook: async () => ({ bids: [[0.48, 100]], asks: [[0.52, 100]] }),
  placeOrderRaw: async (): Promise<SdkTxResult> =>
    ({ hash: '0xabc', receipt: { status: 'success' }, orderId: `vo-${++placed}` }),
  cancelOrder: async ({ orderId }) => { cancelled.push(orderId); return { hash: '0xdef', receipt: { status: 'success' } }; },
  openOrders: async () => [],            // ← the lag that caused the bug
  outcomeBalances: async () => ({ yes: 0, no: 0 }),
  collateralBalance: async () => 1000,
  mintSet: async () => ({ hash: '0x1', receipt: { status: 'success' } }),
  redeem: async () => ({ hash: '0x2', receipt: { status: 'success' } }),
  blockNumber: async () => 1,
  getTransactionCount: async () => 0,
});
};

const mkVenue = (client: SdkClient) =>
  new DreamDEXVenue({ client, agent: 'MIRA', venueId: '0xvenue', privateKey: '0xkey' });

const order = (clientOrderId: string) => ({
  clientOrderId, marketId: MARKET, agent: 'MIRA' as const, side: 'YES' as const,
  kind: 'BUY_YES' as const, type: 'LIMIT' as const,
  limitPrice: 0.4, limitPriceRaw: 400_000n, sizeContracts: 10, sizeRaw: 10_000_000n,
  expiresMs: Date.now() + 60_000, signalId: 'sig-1', tsMs: Date.now(),
});

describe('cancelAll with a blind indexer', () => {
  it('cancels orders it placed itself even when openOrders() returns nothing', async () => {
    const cancelled: string[] = [];
    const venue = mkVenue(mkClient(cancelled));
    await venue.connect();
    const a = await venue.placeOrder(order('MIRA-1'));
    const b = await venue.placeOrder(order('MIRA-2'));
    expect([a.status, b.status]).toEqual(['ACCEPTED', 'ACCEPTED']);

    const acks = await venue.cancelAll('MIRA');
    // Both live orders must be cancelled from local records, not the indexer.
    expect(cancelled.sort()).toEqual(['vo-1', 'vo-2']);
    expect(acks).toHaveLength(2);
    expect(acks.every((x) => x.status === 'CANCELLED')).toBe(true);
  });

  it('does not re-cancel an order already cancelled individually', async () => {
    const cancelled: string[] = [];
    const venue = mkVenue(mkClient(cancelled));
    await venue.connect();
    await venue.placeOrder(order('MIRA-1'));
    await venue.cancel('MIRA-1');
    expect(cancelled).toEqual(['vo-1']);
    const acks = await venue.cancelAll('MIRA');
    expect(cancelled, 'no duplicate cancel').toEqual(['vo-1']);
    expect(acks).toHaveLength(0);
  });

  it('ignores a cancelAll aimed at a different agent', async () => {
    const cancelled: string[] = [];
    const venue = mkVenue(mkClient(cancelled));
    await venue.connect();
    await venue.placeOrder(order('MIRA-1'));
    expect(await venue.cancelAll('ECHO')).toEqual([]);
    expect(cancelled).toEqual([]);
  });
});
