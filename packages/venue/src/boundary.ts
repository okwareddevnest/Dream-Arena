// Reference-mode boundary resolver.
//
// Live DreamDEX markets ask "does ETH close at or above its OPENING price?".
// They are `mode: reference` with `strike: "0"` — the sentinel meaning "no
// boundary in the row". RFC-001 A4 makes MIRA refuse to price such a market
// (skip BOUNDARY_NOT_POSTED), which is correct but leaves it unable to trade:
// a LIVE run logged 214 of those skips and placed zero orders.
//
// The boundary is knowable: it is the opening price of the underlying at the
// market's `tradingStart`, which the Somnia oracle price feed publishes as the
// `open` of the M1 candle for that bucket. This resolves exactly that, and
// returns null rather than a guess whenever the feed cannot answer.
// spec: RFC-001 A4 · T-S1 · docs/70-FUNDING.md endpoints

/** The price feed publishes 18dp fixed-point (SDK: PRICE_FEED_DECIMALS). */
export const FEED_DECIMALS = 18;
/** Candles are bucketed at M1 (SDK: PRICE_RESOLUTION_SECONDS.M1). */
export const BUCKET_SECONDS = 60;

export const DEFAULT_FEED_URL = 'https://price-feed.dev.oracle.somnia.host/v1/graphql';

/** Assets the feed carries, quoted in USDC. */
const FEED_ASSETS = new Set(['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'BNB', 'DOGE']);

/** Market asset (e.g. `ETH`) → feed pair (`ETH/USDC`); null if not carried. */
export function feedSymbolFor(asset: string | null | undefined): string | null {
  const a = (asset ?? '').trim().toUpperCase();
  if (!a || !FEED_ASSETS.has(a)) return null;
  return `${a}/USDC`;
}

/** Decode 18dp fixed-point. Null unless it is a positive finite price. */
export function scaleFeedPrice(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let v: number;
  try { v = Number(BigInt(String(raw))) / 10 ** FEED_DECIMALS; }
  catch { return null; }
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Snap a unix-seconds timestamp down to its M1 candle bucket. */
export function bucketFor(tsSec: number): number {
  return Math.floor(tsSec / BUCKET_SECONDS) * BUCKET_SECONDS;
}

export interface BoundarySource {
  /** Opening price at `tradingStartSec`, or null if not knowable yet. */
  resolve(asset: string, tradingStartSec: number): Promise<number | null>;
  size(): number;
}

export interface BoundarySourceOptions {
  feedUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const QUERY =
  'query($sym:String!,$b:numeric!){' +
  ' Candle(where:{symbol:{_eq:$sym},bucketStart:{_eq:$b},resolution:{_eq:"M1"}},limit:1)' +
  ' { open bucketStart symbol } }';

export function createBoundarySource(o: BoundarySourceOptions = {}): BoundarySource {
  const feedUrl = o.feedUrl ?? DEFAULT_FEED_URL;
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 8_000;
  // A market's opening price never changes once posted, so this is cached for
  // the life of the process. The feed is rate-limited (T-S4) and getMarkets runs
  // every cycle — without this we would re-query every market on every poll.
  const cache = new Map<string, number>();

  return {
    size: () => cache.size,
    async resolve(asset, tradingStartSec) {
      const sym = feedSymbolFor(asset);
      if (!sym || !Number.isFinite(tradingStartSec) || tradingStartSec <= 0) return null;
      const bucket = bucketFor(tradingStartSec);
      const key = `${sym}@${bucket}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;

      try {
        const res = await doFetch(feedUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: QUERY, variables: { sym, b: bucket } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const json: any = await res.json();
        const price = scaleFeedPrice(json?.data?.Candle?.[0]?.open);
        // Only a real answer is cached — a miss or an outage must be retried, or
        // a market that opens a second late would stay unpriceable forever.
        if (price !== null) cache.set(key, price);
        return price;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Is a market still round-trippable? Writes are serialised through one nonce
 * stream (T-033) and an SDK write takes seconds, so an order on a market with
 * only moments left expires before it can be submitted. Observed LIVE: the 5m
 * series rolls continuously, MIRA drew markets with ~6s of life, and every
 * resulting order either was rejected for a past expiry or timed out in the
 * queue. Quoting into a market you cannot round-trip in is not a strategy.
 */
export function tradableByTime(m: { expiryMs: number }, nowMs: number, minMs: number): boolean {
  if (!Number.isFinite(m.expiryMs)) return false;
  return m.expiryMs - nowMs >= (minMs > 0 ? minMs : 1);
}
