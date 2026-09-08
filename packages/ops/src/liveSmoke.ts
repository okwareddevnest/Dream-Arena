// OPS — the G4 write-path smoke, as a reusable function so the runnable script and
// the live test suite exercise IDENTICAL code. spec: 30-TASKS T-S2 B1 · RFC-003
//
// It places a far-from-mid POST_ONLY bid, proves the size is resting ON-CHAIN,
// cancels, and proves it is gone. Verification reads the order book (one eth_call
// = chain truth); it deliberately does NOT trust `getOpenOrders`, which the SDK
// documents as lagging the chain and which returns empty right after a write.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Gas ceiling for a write.
 *
 * The SDK defaults to 10,000,000 and signs at a fixed 60 gwei, so EVERY
 * transaction reserves 0.6 STT of headroom whether it needs it or not — and when
 * the balance dips under that, the RPC rejects the send and the SDK reports
 * "Missing or invalid parameters", which sounds like a bug in the call. The real
 * message is buried in the cause: "insufficient balance".
 * Measured on-chain: a resting order costs ~327k, a crossing order ~2.52M. Four
 * million is comfortable headroom and reserves ~0.24 STT instead of 0.6.
 */
export const WRITE_GAS = 4_000_000n;

export const DEC = 6n;
export const ONE = 10n ** DEC;

export interface RoundTripOptions {
  privateKey: string;
  venueId?: string;
  rpcUrl?: string;
  wsRpcUrl?: string;
  indexerUrl?: string;
  chainId?: number;
  /** Far-from-mid bid price, raw 6dp. Default 0.01. */
  priceRaw?: bigint;
  /** Size in raw 6dp contracts. Default 1. */
  qtyRaw?: bigint;
  /** Skip markets expiring sooner than this (5m series roll fast). */
  minSecondsLeft?: number;
  /** Stop after the reads, before any write. */
  dry?: boolean;
  log?: (line: string) => void;
}

export interface RoundTripResult {
  marketId: string; asset: string; question: string; pool: string; secondsLeft: number;
  bookDepth: { yesBids: number; yesAsks: number; noBids: number; noAsks: number };
  bestAskRaw: bigint | null;
  restingBefore: bigint;
  restingAfterPlace: bigint | null;
  restingAfterCancel: bigint | null;
  placeTxHash: string | null;
  cancelTxHash: string | null;
  orderId: string | null;
  fills: number;
  dry: boolean;
  /** True only when place AND cancel were both proven against the book. */
  verified: boolean;
}

type Level = { price: bigint | string; quantity: bigint | string };
type Book = { yesBids?: Level[]; yesAsks?: Level[]; noBids?: Level[]; noAsks?: Level[] };

/** Total resting size at an exact price — summed because a level can repeat. */
export function qtyAt(levels: Level[] | undefined, price: bigint): bigint {
  return (levels ?? []).filter((l) => BigInt(l.price) === price)
    .reduce((a, l) => a + BigInt(l.quantity), 0n);
}

/** The SDK resolves even on a REVERTED receipt — never skip this. */
export function assertTxOk(res: { hash?: string; receipt?: { status?: string } }, label: string): void {
  if (res?.receipt?.status === 'reverted') {
    throw new Error(`${label} REVERTED on-chain (tx ${res.hash ?? '?'})`);
  }
}

export async function runRoundTrip(opts: RoundTripOptions): Promise<RoundTripResult> {
  const log = opts.log ?? (() => {});
  const rpcUrl = opts.rpcUrl ?? 'https://api.infra.testnet.somnia.network';
  const wsRpcUrl = opts.wsRpcUrl ?? 'wss://api.infra.testnet.somnia.network/ws';
  const indexerUrl = opts.indexerUrl ?? 'https://dev.smk.somnia.host/v1/graphql';
  const venueId = opts.venueId ?? '0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c';
  const priceRaw = opts.priceRaw ?? ONE / 100n;
  const qtyRaw = opts.qtyRaw ?? ONE;
  const minSecondsLeft = opts.minSecondsLeft ?? 60;
  const key = opts.privateKey.startsWith('0x') ? opts.privateKey : `0x${opts.privateKey}`;

  const sdk = await import('@somnia-chain/markets-sdk');
  const { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } = sdk as any;

  const chain = defineChain({
    id: opts.chainId ?? 50312, name: 'somnia',
    nativeCurrency: { name: 'Somnia Test Token', symbol: 'STT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl], webSocket: [wsRpcUrl] } },
  });
  // `addresses` is REQUIRED: v2 resolves markets by marketId through the module.
  const ex: any = new SomniaMarkets({
    indexerUrl, chain, wsRpcUrl, privateKey: key, addresses: SOMNIA_TESTNET_ADDRESSES,
  });
  const account = privateKeyToAccount(key as `0x${string}`);
  const owner = account.address;

  /**
   * Approve the pool to pull collateral, ourselves.
   *
   * The SDK's `autoApprove` reverts here with "approve reverted: Missing or
   * invalid parameters" even on a zero allowance and a funded wallet, so the
   * approval is done explicitly: read the allowance, and only send when short.
   * Doing it deliberately is better anyway — an approval is a real permission
   * grant and should not be a side effect of placing an order.
   */
  const erc20 = parseAbi([
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ]);
  const pub = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 12_000, retryCount: 2 }) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });

  const ensureAllowance = async (token: string, spender: string, need: bigint): Promise<void> => {
    const t = getAddress(token.toLowerCase()), sp = getAddress(spender.toLowerCase());
    const have = await pub.readContract({ address: t, abi: erc20, functionName: 'allowance', args: [owner, sp] });
    if ((have as bigint) >= need) return;
    log(`approving ${sp.slice(0, 10)}… to spend collateral`);
    const hash = await wallet.writeContract({
      address: t, abi: erc20, functionName: 'approve',
      args: [sp, 2n ** 96n],           // generous but not unbounded
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`approve reverted: ${hash}`);
  };

  let orderId: string | null = null;
  let pool = '';
  try {
    // ── discover ──────────────────────────────────────────────────────────
    // Venue-scoped raw tier only. The unified loadMarkets() sweeps every market
    // paged at 500 and times out against the dev indexer (T-S4 fan-out).
    const rows: any[] = await ex.client.listBinaryMarkets({ venueId, status: 'Trading', limit: 20 });
    const nowSec = Math.floor(Date.now() / 1000);
    const live = rows
      .map((m) => ({ m, left: Number(m.expiry) - nowSec }))
      .filter((x) => Number.isFinite(x.left) && x.left > minSecondsLeft)
      .sort((a, b) => b.left - a.left);
    log(`${rows.length} Trading rows, ${live.length} with >${minSecondsLeft}s left`);
    if (!live.length) throw new Error(`no Trading market has >${minSecondsLeft}s left`);

    const market = live[0]!.m;
    const secondsLeft = live[0]!.left;
    pool = market.poolAddress;
    log(`${market.asset} "${market.question}" pool ${pool} (${secondsLeft}s left)`);

    // ── read ──────────────────────────────────────────────────────────────
    const onchain: any = await ex.client.getMarketOnchain(market.marketId);
    const before: Book = await ex.client.getBinaryOrderBook(pool);
    const bookDepth = {
      yesBids: (before.yesBids ?? []).length, yesAsks: (before.yesAsks ?? []).length,
      noBids: (before.noBids ?? []).length, noAsks: (before.noAsks ?? []).length,
    };
    const asks = (before.yesAsks ?? []).map((l) => BigInt(l.price)).sort((a, b) => (a < b ? -1 : 1));
    const bestAskRaw = asks[0] ?? null;
    if (bestAskRaw !== null && priceRaw >= bestAskRaw) {
      throw new Error(`bid ${priceRaw} would cross best ask ${bestAskRaw}`);
    }
    const restingBefore = qtyAt(before.yesBids, priceRaw);
    log(`book ${JSON.stringify(bookDepth)} bestAsk ${bestAskRaw ?? 'none'} restingAtOurPrice ${restingBefore}`);

    const base: RoundTripResult = {
      marketId: market.marketId, asset: market.asset, question: market.question,
      pool, secondsLeft, bookDepth, bestAskRaw, restingBefore,
      restingAfterPlace: null, restingAfterCancel: null,
      placeTxHash: null, cancelTxHash: null, orderId: null, fills: 0,
      dry: Boolean(opts.dry), verified: false,
    };
    if (opts.dry) return base;

    // ── place ─────────────────────────────────────────────────────────────
    // GOTCHA: `side` is the STRING BinarySide, NOT the numeric ORDER_KIND ordinal
    // (that ordinal belongs to the raw contract tier). Passing the number fails
    // deep inside the SDK with "cannot read properties of undefined (reading 'kind')".
    // Permission first, explicitly, then the order with autoApprove OFF.
    await ensureAllowance(String(market.collateral), pool, priceRaw * qtyRaw);

    let placed: any;
    try {
      placed = await ex.trader.placeOrder({
      pool, side: 'BUY_YES', price: priceRaw, quantity: qtyRaw,
      outcomeToken: onchain.outcomeToken, yesId: onchain.yesId, noId: onchain.noId,
        collateral: market.collateral, orderType: 3 /* POST_ONLY */, autoApprove: false,
        gas: WRITE_GAS,
      });
    } catch (e) {
      // The SDK reports an unaffordable write as "Missing or invalid parameters",
      // which sends a reader to audit their arguments. Name the real cause.
      const cause = (e as { cause?: { details?: string } })?.cause?.details ?? '';
      const msg = e instanceof Error ? e.message : String(e);
      if (/insufficient balance/i.test(cause) || /insufficient balance/i.test(msg)) {
        throw new Error(
          `not enough STT for gas — a write reserves ${Number(WRITE_GAS) * 60 / 1e9} STT. ` +
          `Top up ${owner} (see docs/70-FUNDING.md).`,
        );
      }
      throw e;
    }
    assertTxOk(placed, 'placeOrder');
    orderId = placed.orderId != null ? String(placed.orderId) : null;
    const fills = placed.fills?.length ?? 0;
    log(`placed tx ${placed.hash} orderId ${orderId} fills ${fills}`);

    // ── prove it rests, from the book ─────────────────────────────────────
    const mid: Book = await ex.client.getBinaryOrderBook(pool);
    const restingAfterPlace = qtyAt(mid.yesBids, priceRaw);
    if (restingAfterPlace !== restingBefore + qtyRaw) {
      throw new Error(`book missing our size: expected ${restingBefore + qtyRaw}, saw ${restingAfterPlace}`);
    }
    log(`resting after place ${restingAfterPlace} ✓`);

    // ── cancel ────────────────────────────────────────────────────────────
    const cancelled: any = await ex.trader.cancelOrder({ pool, orderId: placed.orderId, gas: WRITE_GAS });
    assertTxOk(cancelled, 'cancelOrder');
    orderId = null;
    log(`cancelled tx ${cancelled.hash}`);

    const after: Book = await ex.client.getBinaryOrderBook(pool);
    const restingAfterCancel = qtyAt(after.yesBids, priceRaw);
    if (restingAfterCancel !== restingBefore) {
      throw new Error(`cancel left size behind: expected ${restingBefore}, saw ${restingAfterCancel}`);
    }
    log(`resting after cancel ${restingAfterCancel} ✓`);

    return {
      ...base, restingAfterPlace, restingAfterCancel,
      placeTxHash: placed.hash ?? null, cancelTxHash: cancelled.hash ?? null,
      orderId: placed.orderId != null ? String(placed.orderId) : null,
      fills, verified: true,
    };
  } finally {
    if (orderId) log(`! order ${orderId} may still be OPEN on pool ${pool} — cancel manually`);
    void owner;
    await Promise.race([
      Promise.resolve(ex.close?.()).catch(() => undefined),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  }
}
