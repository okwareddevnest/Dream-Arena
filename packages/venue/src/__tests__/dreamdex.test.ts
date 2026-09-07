// T-034 — DreamDEXVenue on the real SDK surface (FR-V3).
//
// Runs against a STUB transport, which is the only honest option here: T-S2 B1
// recorded that this environment has no funded testnet key, so the write path
// cannot be exercised end-to-end on chain. Everything except that is covered,
// including every documented gotcha, and the live-RPC assertions live in
// tests/live/ where they skip loudly rather than silently.
import { describe, it, expect, vi } from 'vitest';
import { NonceManager, TxQueue } from '../txqueue.ts';
import {
  DreamDEXVenue, assertTxOk, decodeStrike, resolutionMode,
  type SdkClient, type SdkMarketRow, type SdkTxResult,
} from '../dreamdex.ts';
import { runVenueContract, orderFor, type VenueHarness } from './venue.contract.ts';

const VENUE_ID = '0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c';

/** Rows shaped exactly like the ones observed live in T-S2. */
const row = (over: Partial<SdkMarketRow> = {}): SdkMarketRow => ({
  marketId: '0x0000000000000000000000000000000000000000000000000000000000015fdb',
  asset: 'BTC',
  strike: '7933525',                       // 79 335.25 — two implied decimals
  intervalSec: '60',
  expiry: '1788789180',
  tradingStart: '1788789120',
  status: 'Trading',
  poolAddress: '0xae5d2e6297d07c9fd1d10c2cf210375343c82d59',
  nonce: 1,
  venueId: VENUE_ID,
  operatorId: 2,
  outcomes: [
    { symbol: 'BTC-79335-07SEP26-1353/tUSDC#YES', label: 'YES', index: 0 },
    { symbol: 'BTC-79335-07SEP26-1353/tUSDC#NO', label: 'NO', index: 1 },
  ],
  symbol: 'BTC-79335-07SEP26-1353/tUSDC',
  ...over,
});

interface StubOpts {
  rows?: SdkMarketRow[];
  finalized?: SdkMarketRow[];
  onchainStatus?: number;
  winningOutcome?: number | null;
  book?: { bids: [number, number][]; asks: [number, number][] };
  balances?: { yes: number; no: number };
  collateral?: number;
  placeResult?: SdkTxResult | (() => SdkTxResult | Promise<SdkTxResult>);
  failOn?: Partial<Record<keyof SdkClient, string>>;
}

const stub = (o: StubOpts = {}) => {
  const calls: { fn: string; args: unknown[] }[] = [];
  const guard = (fn: keyof SdkClient) => {
    const msg = o.failOn?.[fn];
    if (msg) throw new Error(msg);
  };
  let txCount = 0;
  const client: SdkClient = {
    listBinaryMarkets: async (q) => {
      calls.push({ fn: 'listBinaryMarkets', args: [q] });
      guard('listBinaryMarkets');
      return q.status === 'Finalized' ? (o.finalized ?? []) : (o.rows ?? [row()]);
    },
    getMarketOnchain: async (id) => {
      calls.push({ fn: 'getMarketOnchain', args: [id] });
      guard('getMarketOnchain');
      const all = [...(o.rows ?? [row()]), ...(o.finalized ?? [])];
      const found = all.find((r) => r.marketId === id);
      if (!found) return null;
      // Derive from the row's own status so the stub is self-consistent: a row
      // the indexer calls Listed must not be reported as Trading on chain.
      // `onchainStatus` then means "make the chain DISAGREE with the indexer",
      // which is the lag the gotcha-1 tests are actually about.
      const ORD: Record<string, number> = {
        Listed: 0, Trading: 1, Locked: 2, Settling: 3, Resolved: 4, Finalized: 4, Voided: 5,
      };
      return {
        status: o.onchainStatus ?? ORD[found.status ?? 'Trading'] ?? 1,
        poolAddress: '0xpool', nonce: 1,
        winningOutcome: o.winningOutcome === undefined ? null : o.winningOutcome,
      };
    },
    fetchOrderBook: async (sym, depth) => {
      calls.push({ fn: 'fetchOrderBook', args: [sym, depth] });
      guard('fetchOrderBook');
      return o.book ?? { bids: [[0.48, 100], [0.47, 50]], asks: [[0.52, 100], [0.53, 50]] };
    },
    placeOrderRaw: async (a) => {
      calls.push({ fn: 'placeOrderRaw', args: [a] });
      guard('placeOrderRaw');
      if (typeof o.placeResult === 'function') return o.placeResult();
      return o.placeResult ?? { hash: '0xdeadbeef', receipt: { status: 'success' }, orderId: 'vo-1' };
    },
    cancelOrder: async (a) => {
      calls.push({ fn: 'cancelOrder', args: [a] });
      guard('cancelOrder');
      return { hash: '0xcancel', receipt: { status: 'success' } };
    },
    openOrders: async (a) => { calls.push({ fn: 'openOrders', args: [a] }); guard('openOrders'); return []; },
    outcomeBalances: async (id) => {
      calls.push({ fn: 'outcomeBalances', args: [id] });
      guard('outcomeBalances');
      return o.balances ?? { yes: 0, no: 0 };
    },
    collateralBalance: async () => { guard('collateralBalance'); return o.collateral ?? 1_000; },
    mintSet: async (a) => {
      calls.push({ fn: 'mintSet', args: [a] });
      guard('mintSet');
      return { hash: '0xmint', receipt: { status: 'success' } };
    },
    redeem: async (a) => {
      calls.push({ fn: 'redeem', args: [a] });
      guard('redeem');
      return { hash: '0xredeem', receipt: { status: 'success' }, amount: 10 };
    },
    blockNumber: async () => { guard('blockNumber'); return 482_485_939; },
    getTransactionCount: async () => txCount++,
  };
  return { client, calls };
};

const mk = (o: StubOpts = {}, over: Partial<ConstructorParameters<typeof DreamDEXVenue>[0]> = {}) => {
  const { client, calls } = stub(o);
  const nonces = new NonceManager(client);
  const queue = new TxQueue({ nonces, timeoutMs: 0 });
  const venue = new DreamDEXVenue({
    client, agent: 'MIRA', venueId: VENUE_ID, privateKey: '0xtestkey',
    queue, nonces, marketsCacheMs: 0, quoteCacheMs: 0, now: () => 1_788_789_130_000, ...over,
  });
  return { venue, client, calls, queue, nonces };
};

// ── The shared conformance oracle: the same suite SimulatedVenue passes. ────
runVenueContract({
  name: 'DreamDEXVenue (stub transport)',
  make: async (): Promise<VenueHarness> => {
    // Two markets so the "not Trading" branch has something to find, and a
    // reference-mode row so the boundary assertions have a subject.
    const { client } = stub({
      rows: [
        row(),
        row({ marketId: '0xref', strike: '0', status: 'Trading', symbol: 'BTC-REF' }),
        row({ marketId: '0xlisted', status: 'Listed', symbol: 'BTC-LISTED' }),
      ],
    });
    const nonces = new NonceManager(client);
    const queue = new TxQueue({ nonces, timeoutMs: 0 });
    const venue = new DreamDEXVenue({
      client, agent: 'MIRA', venueId: VENUE_ID, privateKey: '0xtestkey',
      queue, nonces, marketsCacheMs: 0, quoteCacheMs: 0, now: () => 1_788_789_130_000,
    });
    await venue.connect();
    return {
      venue,
      advance: async () => { await Promise.resolve(); },
      dispose: async () => { await venue.disconnect(); },
      // No funded key in this environment (T-S2 B1), so fills cannot be driven.
      canFill: false,
    };
  },
});

describe('T-034 construction fails loudly, not later', () => {
  it('requires a venueId — two venues are live and the ids move (T-S4)', () => {
    const { client } = stub();
    expect(() => new DreamDEXVenue({ client, agent: 'MIRA', venueId: '' }))
      .toThrow(/venueId is required/i);
  });

  it('is read-only without a key, and says so on the first write attempt', async () => {
    const { venue } = mk({}, { privateKey: null });
    await venue.connect();
    const mkt = (await venue.getMarkets())[0]!;
    const ack = await venue.placeOrder(orderFor(mkt));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/read-only/i);
  });
});

describe('T-034 row decoding matches the live shapes (T-S1, T-S2)', () => {
  it('decodes the measured BTC and ETH strikes', () => {
    expect(decodeStrike('7933525')).toBe(79_335.25);
    expect(decodeStrike('249730')).toBe(2_497.30);
  });

  it('treats strike 0 as reference mode with no boundary posted', () => {
    expect(resolutionMode('0')).toBe('reference');
    expect(resolutionMode(0)).toBe('reference');
    expect(resolutionMode(null)).toBe('reference');
    expect(resolutionMode('7933525')).toBe('fixed');
    expect(decodeStrike('0')).toBeNull();
  });

  it('maps a live row onto the frozen Market shape', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    expect(m.id).toBe(row().marketId);
    expect(m.asset).toBe('BTC');
    expect(m.strike).toBe(79_335.25);
    expect(m.mode).toBe('fixed');
    expect(m.boundaryPosted).toBe(true);
    expect(m.intervalSec).toBe(60);
    expect(m.style).toBe('EXPIRY');                       // T-S1 verdict
    expect(m.venue).toBe('DREAMDEX');
    expect(m.status).toBe('Trading');
    expect(m.yesSymbol).toContain('#YES');
    expect(m.noSymbol).toContain('#NO');
  });

  it('converts indexer SECONDS into millis', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    expect(m.expiryMs).toBe(1_788_789_180 * 1_000);
    expect(m.tradingStartMs).toBe(1_788_789_120 * 1_000);
  });

  it('reports a reference row as boundaryPosted false with a null strike', async () => {
    const { venue } = mk({ rows: [row({ marketId: '0xref', strike: '0' })] });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    expect(m.mode).toBe('reference');
    expect(m.strike).toBeNull();
    expect(m.boundaryPosted).toBe(false);
  });

  it('never uses the pool address as the market identity (gotcha 10)', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    expect(m.poolAddress).toBe('0xae5d2e6297d07c9fd1d10c2cf210375343c82d59');
    expect(m.id).not.toBe(m.poolAddress);
  });

  it('scopes every listing to the configured venueId', async () => {
    const { venue, calls } = mk();
    await venue.connect();
    await venue.getMarkets();
    const q = calls.find((c) => c.fn === 'listBinaryMarkets')!.args[0] as { venueId?: string };
    expect(q.venueId).toBe(VENUE_ID);
  });
});

describe('T-034 quotes decode from the YES book (T-S3)', () => {
  it('maps bids and asks onto the frozen Quote exactly', async () => {
    const { venue } = mk({ book: { bids: [[0.48, 120]], asks: [[0.52, 90]] } });
    await venue.connect();
    const q = await venue.getQuote(row().marketId);
    expect(q.bid).toBe(0.48);
    expect(q.ask).toBe(0.52);
    expect(q.mid).toBeCloseTo(0.5, 12);
    expect(q.depthBid).toBe(120);
    expect(q.depthAsk).toBe(90);
    expect(q.stale).toBe(false);
  });

  it('reads the YES outcome symbol, not the market symbol', async () => {
    const { venue, calls } = mk();
    await venue.connect();
    await venue.getQuote(row().marketId);
    const sym = calls.find((c) => c.fn === 'fetchOrderBook')!.args[0];
    expect(sym).toContain('#YES');
  });

  it('keeps bid <= mid <= ask on a one-sided book', async () => {
    for (const book of [
      { bids: [[0.4, 10]] as [number, number][], asks: [] as [number, number][] },
      { bids: [] as [number, number][], asks: [[0.6, 10]] as [number, number][] },
      { bids: [] as [number, number][], asks: [] as [number, number][] },
    ]) {
      const { venue } = mk({ book });
      await venue.connect();
      const q = await venue.getQuote(row().marketId);
      expect(q.bid).toBeLessThanOrEqual(q.mid);
      expect(q.mid).toBeLessThanOrEqual(q.ask);
    }
  });

  it('rejects an unknown market with a typed error', async () => {
    const { venue } = mk();
    await venue.connect();
    await expect(venue.getQuote('0xnope')).rejects.toThrow(/unknown market/i);
  });

  it('caches quotes for the configured window (rate-limit compliance, U5)', async () => {
    const { venue, calls } = mk({}, { quoteCacheMs: 1_500 });
    await venue.connect();
    for (let i = 0; i < 10; i++) await venue.getQuote(row().marketId);
    expect(calls.filter((c) => c.fn === 'fetchOrderBook')).toHaveLength(1);
  });
});

describe('T-034 the measured indexer limit is respected (T-S4)', () => {
  it('serializes indexer reads to one in flight under a 30-way fan-out', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = stub();
    const slow: SdkClient = {
      ...client,
      listBinaryMarkets: async (q) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return client.listBinaryMarkets(q);
      },
    };
    const venue = new DreamDEXVenue({
      client: slow, agent: 'MIRA', venueId: VENUE_ID, marketsCacheMs: 0,
    });
    await venue.connect();
    // The exact shape that returned 20 % errors and a 29 s p99 against the
    // real indexer.
    await Promise.all(Array.from({ length: 30 }, () => venue.getMarkets()));
    expect(maxInFlight).toBe(1);
  });

  it('caches market listings so a tick loop does not re-read them', async () => {
    const { venue, calls } = mk({}, { marketsCacheMs: 15_000 });
    await venue.connect();
    for (let i = 0; i < 50; i++) await venue.getMarkets();
    expect(calls.filter((c) => c.fn === 'listBinaryMarkets')).toHaveLength(1);
  });
});

describe('T-034 writes gate on CHAIN status, never the indexer (gotcha 1)', () => {
  it('re-reads on-chain status before every order', async () => {
    const { venue, calls } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m));
    expect(calls.some((c) => c.fn === 'getMarketOnchain')).toBe(true);
  });

  it('rejects when the chain says Locked even though the indexer said Trading', async () => {
    // This is the exact failure gotcha 1 describes: the indexer lags.
    const { venue } = mk({ onchainStatus: 2 });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    expect(m.status).toBe('Trading');                     // indexer's view
    const ack = await venue.placeOrder(orderFor(m));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/Locked/);
  });

  it('rejects when the on-chain read itself fails', async () => {
    const { venue } = mk({ failOn: { getMarketOnchain: 'rpc timeout' } });
    await venue.connect();
    const { venue: reader } = mk();
    await reader.connect();
    const m = (await reader.getMarkets())[0]!;
    const ack = await venue.placeOrder(orderFor(m));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/rpc timeout/);
  });
});

describe('T-034 a reverted write does not throw (gotcha 2)', () => {
  it('assertTxOk detects a reverted receipt on either shape', () => {
    expect(() => assertTxOk({ hash: '0x1', receipt: { status: 'success' } }, 'x')).not.toThrow();
    expect(() => assertTxOk({ hash: '0x1', receipt: { status: 'reverted' } }, 'x')).toThrow(/REVERTED/);
    // On the unified tier the receipt rides on `info`.
    expect(() => assertTxOk({ hash: '0x1', info: { receipt: { status: 'reverted' } } }, 'x')).toThrow(/REVERTED/);
    expect(() => assertTxOk({}, 'x')).not.toThrow();
  });

  it('surfaces a reverted placeOrder as REJECTED rather than ACCEPTED', async () => {
    const { venue } = mk({ placeResult: { hash: '0xbad', receipt: { status: 'reverted' } } });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const ack = await venue.placeOrder(orderFor(m));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/REVERTED/);
  });

  it('surfaces a reverted mint as REJECTED', async () => {
    const { client } = stub();
    const nonces = new NonceManager(client);
    const venue = new DreamDEXVenue({
      client: { ...client, mintSet: async () => ({ hash: '0x1', receipt: { status: 'reverted' } }) },
      agent: 'MIRA', venueId: VENUE_ID, privateKey: '0xk',
      queue: new TxQueue({ nonces, timeoutMs: 0 }), marketsCacheMs: 0,
    });
    await venue.connect();
    const ack = await venue.mintPair(row().marketId, 5);
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/REVERTED/);
  });
});

describe('T-034 prices travel as integers (gotcha 3, RFC-001 A8)', () => {
  it('rejects an off-grid price rather than letting the pool do it', async () => {
    const { venue } = mk({}, { tickRaw: 1_000n });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const ack = await venue.placeOrder(orderFor(m, { limitPriceRaw: 500_001n, limitPrice: 0.500001 }));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/tick grid|InvalidPrice/i);
  });

  it('sends the exact bigint it was given, with no float round-trip', async () => {
    const { venue, calls } = mk({}, { tickRaw: 1_000n });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m, { limitPriceRaw: 250_000n, limitPrice: 0.25 }));
    const sent = calls.find((c) => c.fn === 'placeOrderRaw')!.args[0] as { priceRaw: bigint };
    expect(sent.priceRaw).toBe(250_000n);
    expect(typeof sent.priceRaw).toBe('bigint');
  });

  it('never calls toFixed on a price anywhere in the adapter source', async () => {
    // gotcha 3 in assertion form: (0.05).toFixed(18) is three wei off the grid.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../dreamdex.ts', import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/\.toFixed\(/);
  });

  it('rejects a price of 0 or 1 (no finite payout)', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    for (const raw of [0n, 1_000_000n]) {
      const ack = await venue.placeOrder(orderFor(m, {
        clientOrderId: `p${raw}`, limitPriceRaw: raw, limitPrice: Number(raw) / 1e6,
      }));
      expect(ack.status).toBe('REJECTED');
    }
  });
});

describe('T-034 order expiry is mandatory and capped (gotcha 5, RFC-001 A2)', () => {
  it('rejects an order with no future expiry', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const ack = await venue.placeOrder(orderFor(m, { expiresMs: 0 }));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/expiry/i);
  });

  it('caps expiry at the market expiry and sends NANOSECONDS', async () => {
    const { venue, calls } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m, { expiresMs: m.expiryMs + 3_600_000 }));
    const sent = calls.find((c) => c.fn === 'placeOrderRaw')!.args[0] as { expireTimestampNs: bigint };
    expect(sent.expireTimestampNs).toBe(BigInt(m.expiryMs) * 1_000_000n);
  });
});

describe('T-034 every write goes through the queue (T-033)', () => {
  it('routes placeOrder through the queue rather than straight to the RPC', async () => {
    const { venue, queue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m));
    expect(queue.statsSnapshot().submitted).toBe(1);
    expect(queue.statsSnapshot().completed).toBe(1);
  });

  it('routes mint and claim through the queue too', async () => {
    const { venue, queue } = mk({ onchainStatus: 1 });
    await venue.connect();
    await venue.mintPair(row().marketId, 5);
    expect(queue.statsSnapshot().submitted).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent on a repeated clientOrderId', async () => {
    const { venue, calls } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const o = orderFor(m, { clientOrderId: 'same-id' });
    const a = await venue.placeOrder(o);
    const b = await venue.placeOrder(o);
    expect(b).toEqual(a);
    expect(calls.filter((c) => c.fn === 'placeOrderRaw')).toHaveLength(1);
  });

  it('assigns the nonce the queue reserved', async () => {
    const { venue, calls } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m, { clientOrderId: 'n1' }));
    await venue.placeOrder(orderFor(m, { clientOrderId: 'n2' }));
    const nonces = calls.filter((c) => c.fn === 'placeOrderRaw')
      .map((c) => (c.args[0] as { nonce: number }).nonce);
    expect(nonces).toEqual([0, 1]);
  });
});

describe('T-034 an RPC error is never an unhandled rejection', () => {
  it('turns a placeOrder failure into a REJECTED ack with a reason', async () => {
    const { venue } = mk({ failOn: { placeOrderRaw: 'insufficient funds for gas' } });
    await venue.connect();
    const { venue: reader } = mk();
    await reader.connect();
    const m = (await reader.getMarkets())[0]!;
    const ack = await venue.placeOrder(orderFor(m));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/insufficient funds/);
  });

  it('returns 0 balance rather than throwing when collateral cannot be read', async () => {
    const { venue } = mk({ failOn: { collateralBalance: 'indexer down' } });
    await venue.connect();
    await expect(venue.balanceUsd()).resolves.toBe(0);
  });

  it('returns an empty position list rather than throwing', async () => {
    const { venue } = mk({ failOn: { outcomeBalances: 'rpc 500' } });
    await venue.connect();
    await expect(venue.positions()).resolves.toEqual([]);
  });

  it('reports not-ok health with the error detail', async () => {
    const { venue } = mk({ failOn: { blockNumber: 'chain unreachable' } });
    await expect(venue.connect()).rejects.toThrow(/unreachable/);
    const h = await venue.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/disconnected|unreachable/);
  });

  it('cancelAll survives a failing openOrders read', async () => {
    const { venue } = mk({ failOn: { openOrders: 'indexer down' } });
    await venue.connect();
    await expect(venue.cancelAll()).resolves.toEqual([]);
  });
});

describe('T-034 fills carry explorer-verifiable links', () => {
  it('builds an explorer URL from the configured base', () => {
    const { venue } = mk({}, { explorerBase: 'https://explorer.test/tx/' });
    const f = venue.emitFill({
      clientOrderId: 'c1', venueOrderId: 'vo-1', marketId: row().marketId, agent: 'MIRA',
      side: 'YES', sizeContracts: 5, price: 0.52, feeUsd: 0,
      txHash: '0xabc', tsMs: 1,
    });
    expect(f.explorerUrl).toBe('https://explorer.test/tx/0xabc');
    expect(f.fillId.length).toBeGreaterThan(0);
  });

  it('leaves the link null when there is no tx hash', () => {
    const { venue } = mk();
    const f = venue.emitFill({
      clientOrderId: 'c1', venueOrderId: null, marketId: row().marketId, agent: 'MIRA',
      side: 'YES', sizeContracts: 5, price: 0.52, feeUsd: 0, txHash: null, tsMs: 1,
    });
    expect(f.explorerUrl).toBeNull();
  });

  it('delivers to subscribers and stops after unsubscribe', () => {
    const { venue } = mk();
    let n = 0;
    const off = venue.onFill(() => { n++; });
    const base = {
      clientOrderId: 'c', venueOrderId: null, marketId: row().marketId, agent: 'MIRA' as const,
      side: 'YES' as const, sizeContracts: 1, price: 0.5, feeUsd: 0, txHash: '0x1', tsMs: 1,
    };
    venue.emitFill(base);
    expect(n).toBe(1);
    off();
    venue.emitFill(base);
    expect(n).toBe(1);
  });
});

describe('T-034 claim finds what getMarkets cannot (gotcha 11, RFC-001 A5)', () => {
  it('queries the Finalized status for settled markets', async () => {
    const { venue, calls } = mk({ finalized: [row({ marketId: '0xdone', status: 'Finalized' })] });
    await venue.connect();
    const settled = await venue.settledMarkets();
    expect(settled.map((m) => m.id)).toContain('0xdone');
    const q = calls.filter((c) => c.fn === 'listBinaryMarkets')
      .map((c) => (c.args[0] as { status?: string }).status);
    expect(q).toContain('Finalized');
  });

  it('reports only the winning outcome the agent holds', async () => {
    const { venue } = mk({
      finalized: [row({ marketId: '0xdone', status: 'Finalized' })],
      onchainStatus: 4, winningOutcome: 0, balances: { yes: 10, no: 0 },
    });
    await venue.connect();
    const c = await venue.claimable();
    expect(c).toHaveLength(1);
    expect(c[0]!.outcomeIdx).toBe(0);
    expect(c[0]!.sizeContracts).toBe(10);
    expect(c[0]!.estPayoutUsd).toBe(10);
  });

  it('reports nothing when the held outcome lost', async () => {
    const { venue } = mk({
      finalized: [row({ marketId: '0xdone', status: 'Finalized' })],
      onchainStatus: 4, winningOutcome: 1, balances: { yes: 10, no: 0 },
    });
    await venue.connect();
    expect(await venue.claimable()).toHaveLength(0);
  });

  it('refuses to claim a market that is not Resolved, with a reason', async () => {
    const { venue } = mk({ onchainStatus: 1 });
    await venue.connect();
    const r = await venue.claim(row().marketId);
    expect(r.claimed).toBe(false);
    expect(r.reason).toMatch(/not Resolved/i);
  });

  it('claims a resolved market and returns the payout with a tx hash', async () => {
    const { venue } = mk({ onchainStatus: 4, winningOutcome: 0 });
    await venue.connect();
    const r = await venue.claim(row().marketId);
    expect(r.claimed).toBe(true);
    expect(r.amountUsd).toBe(10);
    expect(r.txHash).toBe('0xredeem');
  });

  it('reports a reason rather than throwing for an unknown market', async () => {
    const { venue } = mk();
    await venue.connect();
    const r = await venue.claim('0xnope');
    expect(r.claimed).toBe(false);
    expect(r.reason).toMatch(/unknown market/i);
  });
});

describe('T-034 mintPair (gotcha 7, RFC-001 A6)', () => {
  it('mints against a Trading market with an integer quantity', async () => {
    const { venue, calls } = mk({ onchainStatus: 1 });
    await venue.connect();
    const ack = await venue.mintPair(row().marketId, 5);
    expect(ack.status).toBe('ACCEPTED');
    const sent = calls.find((c) => c.fn === 'mintSet')!.args[0] as { quantityRaw: bigint };
    expect(typeof sent.quantityRaw).toBe('bigint');
    expect(sent.quantityRaw).toBe(5_000_000n);
  });

  it('refuses on a non-Trading market and on a non-positive size', async () => {
    const { venue } = mk({ onchainStatus: 2 });
    await venue.connect();
    expect((await venue.mintPair(row().marketId, 5)).reason).toMatch(/Locked/);
    const { venue: ok } = mk({ onchainStatus: 1 });
    await ok.connect();
    expect((await ok.mintPair(row().marketId, 0)).reason).toMatch(/positive/);
  });
});
