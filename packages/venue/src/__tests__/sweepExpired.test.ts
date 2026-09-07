// Expired orders must have their escrow reclaimed, not abandoned.
// Observed LIVE: MIRA's 45s order TTL elapsed before shutdown, so every
// cancelOrder reverted with IncorrectSender(caller, 0x0) — the pool no longer
// has an owner for an expired order. cancelAll logged "cancelled 0" and exited
// while ~200 tUSDC stayed locked across runs. The pool exposes
// cancelExpiredOrders(pool, orderIds) precisely to reclaim that escrow.
import { describe, it, expect } from 'vitest';
import { DreamDEXVenue, type SdkClient, type SdkMarketRow, type SdkTxResult } from '../dreamdex.ts';

const MARKET = '0xmarket1';
const row = (): SdkMarketRow => ({
  marketId: MARKET, asset: 'BTC', strike: '7933525', intervalSec: 300,
  expiry: String(Math.floor(Date.now() / 1000) + 3600),
  tradingStart: String(Math.floor(Date.now() / 1000) - 60),
  status: 'Trading', poolAddress: '0xpool', nonce: 1, venueId: '0xvenue', operatorId: 2,
});

interface Spy { swept: string[][]; cancelAttempts: string[] }

const mkClient = (spy: Spy, opts: { cancelError?: string; sweepSupported?: boolean } = {}): SdkClient => {
  let placed = 0;
  const c: SdkClient = {
    listBinaryMarkets: async () => [row()],
    getMarketOnchain: async () => ({ status: 1, poolAddress: '0xpool', nonce: 1, winningOutcome: null }),
    fetchOrderBook: async () => ({ bids: [[0.48, 100]], asks: [[0.52, 100]] }),
    placeOrderRaw: async (): Promise<SdkTxResult> =>
      ({ hash: '0xabc', receipt: { status: 'success' }, orderId: `vo-${++placed}` }),
    cancelOrder: async ({ orderId }) => {
      spy.cancelAttempts.push(orderId);
      if (opts.cancelError) throw new Error(opts.cancelError);
      return { hash: '0xdef', receipt: { status: 'success' } };
    },
    openOrders: async () => [],
    outcomeBalances: async () => ({ yes: 0, no: 0 }),
    collateralBalance: async () => 1000,
    mintSet: async () => ({ hash: '0x1', receipt: { status: 'success' } }),
    redeem: async () => ({ hash: '0x2', receipt: { status: 'success' } }),
    blockNumber: async () => 1,
    getTransactionCount: async () => 0,
  };
  if (opts.sweepSupported !== false) {
    c.cancelExpiredOrders = async ({ orderIds }) => {
      spy.swept.push([...orderIds]);
      return { hash: '0xsweep', receipt: { status: 'success' } };
    };
  }
  return c;
};

const mkVenue = (client: SdkClient) =>
  new DreamDEXVenue({ client, agent: 'MIRA', venueId: '0xvenue', privateKey: '0xkey' });

const order = (clientOrderId: string) => ({
  clientOrderId, marketId: MARKET, agent: 'MIRA' as const, side: 'YES' as const,
  kind: 'BUY_YES' as const, type: 'LIMIT' as const,
  limitPrice: 0.4, limitPriceRaw: 400_000n, sizeContracts: 10, sizeRaw: 10_000_000n,
  expiresMs: Date.now() + 60_000, signalId: 'sig-1', tsMs: Date.now(),
});

const EXPIRED = 'cancelOrder reverted: IncorrectSender(0xabc, 0x0000000000000000000000000000000000000000)';

describe('reclaiming escrow from expired orders', () => {
  it('sweeps orders whose cancel reverts as already-expired', async () => {
    const spy: Spy = { swept: [], cancelAttempts: [] };
    const venue = mkVenue(mkClient(spy, { cancelError: EXPIRED }));
    await venue.connect();
    await venue.placeOrder(order('MIRA-1'));
    await venue.placeOrder(order('MIRA-2'));

    const acks = await venue.cancelAll('MIRA');
    expect(spy.cancelAttempts, 'a normal cancel is tried first').toHaveLength(2);
    expect(spy.swept.flat().sort(), 'both were swept to reclaim escrow').toEqual(['vo-1', 'vo-2']);
    // Reported honestly: the order was gone, and we reclaimed rather than cancelled.
    expect(acks.map((a) => a.status)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    expect(acks.every((a) => a.txHash === '0xsweep')).toBe(true);
  });

  it('does not sweep when the ordinary cancel succeeds', async () => {
    const spy: Spy = { swept: [], cancelAttempts: [] };
    const venue = mkVenue(mkClient(spy));
    await venue.connect();
    await venue.placeOrder(order('MIRA-1'));
    const acks = await venue.cancelAll('MIRA');
    expect(spy.swept).toHaveLength(0);
    expect(acks[0]!.status).toBe('CANCELLED');
  });

  it('degrades safely when the client cannot sweep', async () => {
    const spy: Spy = { swept: [], cancelAttempts: [] };
    const venue = mkVenue(mkClient(spy, { cancelError: EXPIRED, sweepSupported: false }));
    await venue.connect();
    await venue.placeOrder(order('MIRA-1'));
    await expect(venue.cancelAll('MIRA')).resolves.toEqual([]);
  });
});
