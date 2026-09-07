// The REAL SdkClient — binds the port DreamDEXVenue consumes to
// `@somnia-chain/markets-sdk`. Everything the venue needs to touch the chain
// crosses this file, so every SDK gotcha we found is neutralised here once.
// spec: 20-INTERFACES §6 · T-034 · RFC-003 · docs/submission/sdk-feedback.md
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SdkClient, SdkMarketRow, SdkOnchainMarket, SdkOrderBook, SdkTxResult } from './dreamdex.ts';

/** Collateral and outcome sizes are 6dp on testnet (verified on-chain). */
export const RAW_DECIMALS = 6;
const RAW_ONE = 10 ** RAW_DECIMALS;

export type OutcomeSide = 'YES' | 'NO';

/** Raw 6dp integer → human number. */
export function rawToNum(raw: bigint | string | number): number {
  return Number(BigInt(raw)) / RAW_ONE;
}

/**
 * Invert the synthetic symbol `rowToMarket` mints. Live indexer rows carry no
 * `outcomes[]`, so the venue names outcomes `<marketId>#YES` / `#NO`; this is
 * the only way back to a pool. Throws rather than defaulting to YES — silently
 * guessing a side would trade the wrong outcome.
 */
export function parseOutcomeSymbol(symbol: string): { marketId: string; side: OutcomeSide } {
  const m = /^(.+)#(YES|NO)$/.exec(symbol ?? '');
  if (!m) throw new Error(`SdkClient: cannot resolve outcome symbol ${JSON.stringify(symbol)}`);
  return { marketId: m[1]!, side: m[2] as OutcomeSide };
}

/**
 * GOTCHA (sdk-feedback F-01): `trader.placeOrder({ side })` wants the STRING
 * BinarySide, not the numeric `ORDER_KIND` ordinal the SDK also exports.
 * Passing the number fails deep inside with
 * "Cannot read properties of undefined (reading 'kind')".
 */
const SIDE_BY_KIND = ['BUY_YES', 'SELL_YES', 'BUY_NO', 'SELL_NO'] as const;
export function sideFromKind(kind: number): (typeof SIDE_BY_KIND)[number] {
  const s = SIDE_BY_KIND[kind];
  if (!s) throw new Error(`SdkClient: unknown order kind ${kind}`);
  return s;
}

type Level = { price: bigint | string | number; quantity: bigint | string | number };
type RawBook = { yesBids?: Level[]; yesAsks?: Level[]; noBids?: Level[]; noAsks?: Level[] };

/**
 * One outcome's side of the book, in the port's shape: `[price, size]` pairs
 * with prices already YES/NO probabilities in (0,1) (T-S3). Bids descend,
 * asks ascend, because `getQuote` reads index 0 as "best".
 */
export function bookToPort(book: RawBook, side: OutcomeSide, depth: number): SdkOrderBook {
  const bidsRaw = (side === 'YES' ? book.yesBids : book.noBids) ?? [];
  const asksRaw = (side === 'YES' ? book.yesAsks : book.noAsks) ?? [];
  const conv = (ls: Level[]): [number, number][] =>
    ls.map((l) => [rawToNum(l.price), rawToNum(l.quantity)] as [number, number]);
  const bids = conv(bidsRaw).sort((a, b) => b[0] - a[0]).slice(0, depth);
  const asks = conv(asksRaw).sort((a, b) => a[0] - b[0]).slice(0, depth);
  return { bids, asks };
}

/** Indexer status string → the on-chain enum ordinal the venue expects. */
const STATUS_ORDINAL: Record<string, number> = {
  Listed: 0, Trading: 1, Locked: 2, Settling: 3, Resolved: 4, Finalized: 4, Voided: 5,
};

/** Log any single SDK step slower than this. Writes have a 30s queue budget, so
 *  a step over ~3s is the thing worth seeing. */
const SLOW_MS = Number(process.env.SDK_SLOW_MS ?? 3000);
const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  try { return await fn(); }
  finally {
    const ms = Date.now() - t0;
    if (ms >= SLOW_MS) console.log(`${new Date().toISOString()} SDK SLOW ${label} ${ms}ms`);
  }
};

export interface RealSdkClientOptions {
  privateKey?: string | null;
  venueId: string;
  rpcUrl?: string;
  wsRpcUrl?: string;
  indexerUrl?: string;
  chainId?: number;
}

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

/**
 * Build the live client. Read-only without a private key; writes require one.
 * Deliberately never calls `loadMarkets()` — it sweeps every market paged at
 * 500 and times out on the dev indexer (sdk-feedback F-03).
 */
export async function createSdkClient(o: RealSdkClientOptions): Promise<SdkClient> {
  const rpcUrl = o.rpcUrl ?? 'https://api.infra.testnet.somnia.network';
  const wsRpcUrl = o.wsRpcUrl ?? 'wss://api.infra.testnet.somnia.network/ws';
  const indexerUrl = o.indexerUrl ?? 'https://dev.smk.somnia.host/v1/graphql';
  const chainId = o.chainId ?? 50312;

  const sdk: any = await import('@somnia-chain/markets-sdk');
  const { defineChain } = await import('viem');
  const chain = defineChain({
    id: chainId, name: `somnia-${chainId}`,
    nativeCurrency: { name: 'Somnia Test Token', symbol: 'STT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl], webSocket: [wsRpcUrl] } },
  });
  const key = o.privateKey
    ? (o.privateKey.startsWith('0x') ? o.privateKey : `0x${o.privateKey}`) as `0x${string}`
    : undefined;
  // GOTCHA (F-02): `addresses` is required or every on-chain read throws.
  const ex: any = new sdk.SomniaMarkets({
    indexerUrl, chain, wsRpcUrl,
    addresses: sdk.SOMNIA_TESTNET_ADDRESSES,
    ...(key ? { privateKey: key } : {}),
  });
  // GOTCHA (F-05): `ex.walletAddress` is undefined — derive the owner ourselves.
  const owner = key ? privateKeyToAccount(key).address : null;
  // An untimed transport is how a write path hangs forever: `getTransactionCount`
  // is the FIRST thing TxQueue awaits when reserving a nonce, and it sits outside
  // the queue's own timeout. A dropped request there stalls every write behind it
  // (observed: submit->queue logged, `run` never invoked, 30s timeout, no tx sent).
  const pub = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 8_000, retryCount: 2, retryDelay: 250 }),
  });

  /** marketId → its row, so a symbol can reach a pool without re-querying. */
  const rowCache = new Map<string, SdkMarketRow>();
  const remember = (rows: SdkMarketRow[]) => {
    for (const r of rows) if (r.marketId) rowCache.set(r.marketId, r);
    return rows;
  };
  const rowFor = async (marketId: string): Promise<SdkMarketRow> => {
    const hit = rowCache.get(marketId);
    if (hit) return hit;
    remember(await ex.client.listBinaryMarkets({ venueId: o.venueId, status: 'Trading', limit: 50 }));
    const got = rowCache.get(marketId);
    if (!got) throw new Error(`SdkClient: no market row for ${marketId}`);
    return got;
  };
  const poolFor = async (marketId: string): Promise<string> => {
    const pool = (await rowFor(marketId)).poolAddress;
    if (!pool) throw new Error(`SdkClient: market ${marketId} has no poolAddress`);
    return pool;
  };
  const requireSigner = (what: string) => {
    if (!key) throw new Error(`SdkClient: ${what} requires a signing key (read-only client)`);
  };

  return {
    async listBinaryMarkets(q) {
      // Venue-scoped only (F-03). `Finalized` is how settled markets are found.
      const rows: SdkMarketRow[] = await ex.client.listBinaryMarkets({
        venueId: q.venueId ?? o.venueId, status: q.status, limit: q.limit ?? 50,
      });
      return remember(rows);
    },

    async getMarketOnchain(marketId): Promise<SdkOnchainMarket | null> {
      const oc: any = await ex.client.getMarketOnchain(marketId);
      if (!oc) return null;
      // The venue wants the numeric enum; the SDK may hand back either.
      const status = typeof oc.status === 'number'
        ? oc.status
        : STATUS_ORDINAL[String(oc.status)] ?? 5;
      return {
        status,
        poolAddress: oc.poolAddress ?? oc.pool ?? null,
        nonce: oc.nonce === undefined || oc.nonce === null ? null : Number(oc.nonce),
        winningOutcome: oc.winningOutcome ?? null,
      };
    },

    async fetchOrderBook(outcomeSymbol, depth) {
      const { marketId, side } = parseOutcomeSymbol(outcomeSymbol);
      const book = await ex.client.getBinaryOrderBook(await poolFor(marketId));
      return bookToPort(book as RawBook, side, depth);
    },

    async placeOrderRaw(args): Promise<SdkTxResult> {
      requireSigner('placeOrderRaw');
      const { marketId } = parseOutcomeSymbol(args.outcomeSymbol);
      const row = await timed('placeOrder:rowFor', () => rowFor(marketId));
      const oc: any = await timed('placeOrder:getMarketOnchain', () => ex.client.getMarketOnchain(marketId));
      const res: any = await timed('placeOrder:trader.placeOrder', () => ex.trader.placeOrder({
        pool: row.poolAddress,
        side: sideFromKind(args.kind),          // F-01: string, never the ordinal
        price: args.priceRaw,
        quantity: args.quantityRaw,
        outcomeToken: oc.outcomeToken,
        yesId: oc.yesId,
        noId: oc.noId,
        collateral: (row as any).collateral,
        orderType: args.orderType,
        expireTimestampNs: args.expireTimestampNs,
        autoApprove: true,
      }));
      // Nonce is handled by the SDK's own tracker; the venue's TxQueue still
      // serialises submissions so one key never has two writes in flight.
      if (process.env.DEBUG_TX) {
        console.log(`${new Date().toISOString()} SDK place result hash=${res.hash} orderId=${res.orderId} keys=${Object.keys(res ?? {}).join(',')}`);
      }
      return { hash: res.hash, receipt: res.receipt, orderId: res.orderId != null ? String(res.orderId) : undefined };
    },

    async cancelOrder(args): Promise<SdkTxResult> {
      requireSigner('cancelOrder');
      const res: any = await ex.trader.cancelOrder({
        pool: await poolFor(args.marketId), orderId: args.orderId,
      });
      return { hash: res.hash, receipt: res.receipt };
    },

    async cancelExpiredOrders(args): Promise<SdkTxResult> {
      requireSigner('cancelExpiredOrders');
      // Reclaims escrow from orders the pool considers expired; a normal cancel
      // on one reverts with IncorrectSender(caller, 0x0) and leaves it locked.
      const res: any = await ex.trader.cancelExpiredOrders({
        pool: await poolFor(args.marketId), orderIds: args.orderIds,
      });
      return { hash: res.hash, receipt: res.receipt };
    },

    async openOrders(_args) {
      if (!owner) return [];
      // F-04: this lags the chain. The venue treats it as advisory; the book is
      // the oracle for whether an order is actually resting.
      const rows: any[] = await ex.client.getOpenOrders(owner).catch(() => []);
      return rows.map((r) => ({
        orderId: String(r.orderId),
        marketId: String(r.marketId ?? r.market ?? ''),
        clientTag: r.clientTag,
      }));
    },

    async outcomeBalances(marketId) {
      if (!owner) return { yes: 0, no: 0 };
      const oc: any = await ex.client.getMarketOnchain(marketId);
      const read = async (id: bigint) => {
        const b = await ex.client.getOutcomeBalance({ outcomeToken: oc.outcomeToken, account: owner, id });
        return rawToNum(b ?? 0n);
      };
      return { yes: await read(oc.yesId), no: await read(oc.noId) };
    },

    async collateralBalance() {
      if (!owner) return 0;
      const token = getAddress(String(sdk.SOMNIA_TESTNET_ADDRESSES.collateral).toLowerCase());
      const bal = await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [owner] });
      return rawToNum(bal as bigint);
    },

    async mintSet(args): Promise<SdkTxResult> {
      requireSigner('mintSet');
      const res: any = await ex.trader.mintSet({
        pool: await poolFor(args.marketId), quantity: args.quantityRaw, autoApprove: true,
      });
      return { hash: res.hash, receipt: res.receipt };
    },

    async redeem(args): Promise<SdkTxResult & { amount?: number }> {
      requireSigner('redeem');
      const res: any = await ex.trader.redeem({ pool: await poolFor(args.marketId) });
      return { hash: res.hash, receipt: res.receipt, amount: res.amount };
    },

    async blockNumber() {
      return Number(await pub.getBlockNumber());
    },

    async getTransactionCount() {
      if (!owner) return 0;
      return pub.getTransactionCount({ address: owner, blockTag: 'pending' });
    },
  };
}

/** Close the SDK's live-tail socket; safe to call on a read-only client. */
export async function closeSdkClient(c: unknown): Promise<void> {
  const ex = (c as any)?.__exchange;
  if (ex?.close) await Promise.race([ex.close().catch(() => undefined), new Promise((r) => setTimeout(r, 2500))]);
}
