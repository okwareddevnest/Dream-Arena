// A cancel that can never succeed must not be retried for ever.
// Observed LIVE: ECHO requoted every cycle and each time re-attempted a cancel
// that reverted with IncorrectSender — once with 0x0 (the order had expired) and
// once with a DIFFERENT owner (pools recycle, so a stale order id can resolve to
// somebody else's order). The venue returned NOT_FOUND but kept the mapping, so
// the same doomed transaction was signed and burned gas on every cycle.
import { describe, it, expect } from 'vitest';
import { DreamDEXVenue, type SdkClient, type SdkMarketRow } from '../dreamdex.ts';

const MARKET = '0xmarket1';
const row = (): SdkMarketRow => ({
  marketId: MARKET, asset: 'BTC', strike: '7933525', intervalSec: 300,
  expiry: String(Math.floor(Date.now() / 1000) + 3600),
  tradingStart: String(Math.floor(Date.now() / 1000) - 60),
  status: 'Trading', poolAddress: '0xpool', nonce: 1, venueId: '0xvenue', operatorId: 2,
});

const mkClient = (attempts: string[], err: string): SdkClient => ({
  listBinaryMarkets: async () => [row()],
  getMarketOnchain: async () => ({ status: 1, poolAddress: '0xpool', nonce: 1, winningOutcome: null }),
  fetchOrderBook: async () => ({ bids: [[0.48, 100]], asks: [[0.52, 100]] }),
  placeOrderRaw: async () => ({ hash: '0x1', receipt: { status: 'success' }, orderId: 'vo-1' }),
  cancelOrder: async ({ orderId }) => { attempts.push(orderId); throw new Error(err); },
  openOrders: async () => [],
  outcomeBalances: async () => ({ yes: 0, no: 0 }),
  collateralBalance: async () => 1000,
  mintSet: async () => ({ hash: '0x2', receipt: { status: 'success' } }),
  redeem: async () => ({ hash: '0x3', receipt: { status: 'success' } }),
  blockNumber: async () => 1,
  getTransactionCount: async () => 0,
});

const order = () => ({
  clientOrderId: 'ECHO-1', marketId: MARKET, agent: 'ECHO' as const, side: 'YES' as const,
  kind: 'BUY_YES' as const, type: 'LIMIT' as const,
  limitPrice: 0.4, limitPriceRaw: 400_000n, sizeContracts: 10, sizeRaw: 10_000_000n,
  expiresMs: Date.now() + 60_000, signalId: 's', tsMs: Date.now(),
});

const cases: [string, string][] = [
  ['expired (no owner)', 'cancelOrder reverted: IncorrectSender(0xabc, 0x0000000000000000000000000000000000000000)'],
  ['owned by someone else', 'cancelOrder reverted: IncorrectSender(0xabc, 0xc4e1891e4D1568D44abe9a945958d0c24102b661)'],
];

describe.each(cases)('a cancel rejected as %s', (_label, err) => {
  it('is attempted once, then forgotten', async () => {
    const attempts: string[] = [];
    const venue = new DreamDEXVenue({
      client: mkClient(attempts, err), agent: 'ECHO', venueId: '0xvenue', privateKey: '0xkey',
    });
    await venue.connect();
    await venue.placeOrder(order());

    expect((await venue.cancel('ECHO-1')).status).toBe('NOT_FOUND');
    expect(attempts, 'tried once').toHaveLength(1);

    // Every later attempt must be answered from memory, never signed again.
    expect((await venue.cancel('ECHO-1')).status).toBe('NOT_FOUND');
    expect((await venue.cancel('ECHO-1')).status).toBe('NOT_FOUND');
    expect(attempts, 'never retried on-chain').toHaveLength(1);

    // And it must not reappear in a sweep.
    expect(await venue.cancelAll('ECHO')).toEqual([]);
    expect(attempts).toHaveLength(1);
  });
});

describe('an ordinary cancel failure', () => {
  it('is NOT forgotten — a transient RPC error deserves a retry', async () => {
    const attempts: string[] = [];
    const venue = new DreamDEXVenue({
      client: mkClient(attempts, 'network timeout'), agent: 'ECHO', venueId: '0xvenue', privateKey: '0xkey',
    });
    await venue.connect();
    await venue.placeOrder(order());
    await venue.cancel('ECHO-1');
    await venue.cancel('ECHO-1');
    expect(attempts.length, 'retried, because it might succeed').toBeGreaterThan(1);
  });
});
