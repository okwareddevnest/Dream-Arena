// Fills must reach the engine the moment they happen.
// Observed LIVE: MIRA placed LIMIT orders ABOVE the best ask, so they crossed and
// executed immediately — 1 227 YES + 100 NO contracts across 8 markets. But
// `onFill` never fired (nothing called emitFill), so the engine's netByMarket
// stayed 0 and `maxNetContractsPerMarket: 50` was never enforced: MIRA reached
// 250 contracts, 5x its own cap, while every risk test passed.
// The SDK hands the fills back in the placeOrder RESULT — no indexer, no socket.
import { describe, it, expect } from 'vitest';
import { DreamDEXVenue, type SdkClient, type SdkMarketRow, type SdkTxResult } from '../dreamdex.ts';
import type { Fill } from '@arena/shared';

const MARKET = '0xmarket1';
const row = (): SdkMarketRow => ({
  marketId: MARKET, asset: 'BTC', strike: '7933525', intervalSec: 300,
  expiry: String(Math.floor(Date.now() / 1000) + 3600),
  tradingStart: String(Math.floor(Date.now() / 1000) - 60),
  status: 'Trading', poolAddress: '0xpool', nonce: 1, venueId: '0xvenue', operatorId: 2,
});

const mkClient = (place: SdkTxResult): SdkClient => ({
  listBinaryMarkets: async () => [row()],
  getMarketOnchain: async () => ({ status: 1, poolAddress: '0xpool', nonce: 1, winningOutcome: null }),
  fetchOrderBook: async () => ({ bids: [[0.48, 100]], asks: [[0.52, 100]] }),
  placeOrderRaw: async () => place,
  cancelOrder: async () => ({ hash: '0xdef', receipt: { status: 'success' } }),
  openOrders: async () => [],
  outcomeBalances: async () => ({ yes: 0, no: 0 }),
  collateralBalance: async () => 1000,
  mintSet: async () => ({ hash: '0x1', receipt: { status: 'success' } }),
  redeem: async () => ({ hash: '0x2', receipt: { status: 'success' } }),
  blockNumber: async () => 1,
  getTransactionCount: async () => 0,
});

const mkVenue = (client: SdkClient) => new DreamDEXVenue({
  client, agent: 'MIRA', venueId: '0xvenue', privateKey: '0xkey',
  explorerBase: 'https://explorer.test/tx/',
});

const order = (over: Partial<{ side: 'YES' | 'NO'; kind: string }> = {}) => ({
  clientOrderId: 'MIRA-1', marketId: MARKET, agent: 'MIRA' as const,
  side: (over.side ?? 'YES') as 'YES' | 'NO',
  kind: (over.kind ?? 'BUY_YES') as 'BUY_YES', type: 'LIMIT' as const,
  limitPrice: 0.4, limitPriceRaw: 400_000n, sizeContracts: 50, sizeRaw: 50_000_000n,
  expiresMs: Date.now() + 60_000, signalId: 'sig-1', tsMs: Date.now(),
});

/** 6dp raw, exactly the shape the SDK returns. */
const RESULT = (fills: { quantityFilled: bigint; fillPrice: bigint }[]): SdkTxResult => ({
  hash: '0xfeed', receipt: { status: 'success' }, orderId: 'vo-1', fills,
});

describe('fills from the placeOrder result', () => {
  it('emits a Fill for each match, in contracts and probability', async () => {
    const seen: Fill[] = [];
    const venue = mkVenue(mkClient(RESULT([
      { quantityFilled: 30_000_000n, fillPrice: 337_500n },
      { quantityFilled: 20_000_000n, fillPrice: 340_000n },
    ])));
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    const ack = await venue.placeOrder(order());

    expect(ack.status).toBe('ACCEPTED');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.sizeContracts).toBe(30);
    expect(seen[0]!.price).toBeCloseTo(0.3375, 9);
    expect(seen[1]!.sizeContracts).toBe(20);
    expect(seen.every((f) => f.marketId === MARKET && f.agent === 'MIRA')).toBe(true);
  });

  it('carries the tx hash and an explorer link — the demo clicks it', async () => {
    const seen: Fill[] = [];
    const venue = mkVenue(mkClient(RESULT([{ quantityFilled: 10_000_000n, fillPrice: 500_000n }])));
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    await venue.placeOrder(order());
    expect(seen[0]!.txHash).toBe('0xfeed');
    expect(seen[0]!.explorerUrl).toBe('https://explorer.test/tx/0xfeed');
    expect(seen[0]!.clientOrderId).toBe('MIRA-1');
    expect(seen[0]!.venueOrderId).toBe('vo-1');
  });

  it('keeps the order side, so a NO fill is not booked as YES', async () => {
    const seen: Fill[] = [];
    const venue = mkVenue(mkClient(RESULT([{ quantityFilled: 5_000_000n, fillPrice: 600_000n }])));
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    await venue.placeOrder(order({ side: 'NO', kind: 'BUY_NO' }));
    expect(seen[0]!.side).toBe('NO');
  });

  it('emits nothing when the order rests unfilled', async () => {
    const seen: Fill[] = [];
    const venue = mkVenue(mkClient(RESULT([])));
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    await venue.placeOrder(order());
    expect(seen).toHaveLength(0);
  });

  it('ignores a zero-quantity fill rather than emitting a phantom trade', async () => {
    const seen: Fill[] = [];
    const venue = mkVenue(mkClient(RESULT([{ quantityFilled: 0n, fillPrice: 400_000n }])));
    venue.onFill((f) => seen.push(f));
    await venue.connect();
    await venue.placeOrder(order());
    expect(seen).toHaveLength(0);
  });

  it('a throwing subscriber cannot break the order path', async () => {
    const venue = mkVenue(mkClient(RESULT([{ quantityFilled: 1_000_000n, fillPrice: 400_000n }])));
    venue.onFill(() => { throw new Error('subscriber blew up'); });
    await venue.connect();
    await expect(venue.placeOrder(order())).resolves.toMatchObject({ status: 'ACCEPTED' });
  });
});
