// Configuration, validated once at startup and never re-read.
//
// The design rule here is FAIL LOUD AND FAIL COMPLETE. Two specific failures
// motivated it:
//   • A typo'd numeric var becomes NaN, and NaN silently disables a cap — the
//     bot kit hit this and documents it. So numbers are parsed, not coerced.
//   • edgeIn <= edgeOut turns hysteresis (FR-E4) into a no-op, which does not
//     crash: it just makes the agent spam orders on camera. So it is rejected.
// Every problem is reported in ONE error, because fixing config one restart at
// a time is how a pre-demo checklist runs out of time.
import {
  MODES, TICK_SOURCES, SETTLEMENT_STYLES,
  type Mode, type TickSource, type SettlementStyle, type RiskConfig,
} from './types.ts';
import { newRunId } from './ids.ts';

/** Measured throttles — docs/spikes/S4-limits.md. NOT guesses; the indexer
 *  returned 20 % errors and a 29 s p99 at 30-way concurrency. */
export interface Throttle {
  /** Measured: concurrency is what breaks the indexer, so this stays at 1. */
  indexerMaxInFlight: number;
  marketsCacheMs: number;
  quoteCacheMs: number;
  priceFeedPollMs: number;
  reconcilePollMs: number;
  rpcMaxInFlight: number;
  indexerTimeoutMs: number;
  indexerRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const THROTTLE: Throttle = {
  indexerMaxInFlight: 1,
  marketsCacheMs: 15_000,
  quoteCacheMs: 1_500,
  priceFeedPollMs: 500,
  reconcilePollMs: 3_000,
  rpcMaxInFlight: 4,
  indexerTimeoutMs: 12_000,
  indexerRetries: 2,
  backoffBaseMs: 400,
  backoffMaxMs: 10_000,
};

export interface SomniaConfig {
  network: string; chainId: number;
  rpcUrl: string; wsUrl: string; indexerUrl: string;
  priceFeedUrl: string; priceFeedQuote: string;
  explorerBase: string; collateralDecimals: number;
  venueId: string | null;
}

export interface EchoConfig {
  enabled: boolean; spread: number; quoteSize: number;
  refreshMs: number; maxInventory: number;
}

export interface HuntConfig { roundDurationMs: number; topN: number }

export interface ServeConfig {
  apiPort: number; webOrigin: string; operatorToken: string;
  mirrorBalanceFraction: number; mirrorIntentTtlMs: number;
}

export interface VolConfig { lambda: number; minObs: number; seedVol: number }

export interface AppConfig {
  runId: string;
  venueMode: Mode;
  busMode: 'inproc' | 'redis';
  spotFeed: TickSource;
  settlementStyleDefault: SettlementStyle;
  risk: RiskConfig;
  vol: VolConfig;
  somnia: SomniaConfig;
  keys: { mira: string | null; echo: string | null };
  echo: EchoConfig;
  hunt: HuntConfig;
  serve: ServeConfig;
  throttle: Throttle;
}

type Env = Record<string, string | undefined>;

/** Collects problems instead of throwing on the first one. */
class Problems {
  private readonly list: string[] = [];
  add(msg: string): void { this.list.push(msg); }
  throwIfAny(): void {
    if (this.list.length === 0) return;
    throw new Error(
      `Invalid configuration (${this.list.length} problem${this.list.length > 1 ? 's' : ''}):\n` +
      this.list.map((p) => `  • ${p}`).join('\n'),
    );
  }
}

const str = (env: Env, key: string, def: string): string => {
  const v = env[key];
  return v === undefined || v.trim() === '' ? def : v.trim();
};

const num = (env: Env, key: string, def: number, p: Problems): number => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    p.add(`${key}="${raw}" is not a number. Unset it to use the default (${def}).`);
    return def;
  }
  return n;
};

const bool = (env: Env, key: string, def: boolean): boolean => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
};

const oneOf = <T extends string>(
  env: Env, key: string, allowed: readonly T[], def: T, p: Problems,
): T => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  p.add(`${key}="${v}" is not one of ${allowed.join(' | ')}.`);
  return def;
};

/**
 * Read and validate the environment. Pass an explicit `env` in tests so no test
 * depends on the ambient process (40-TESTPLAN §6).
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const p = new Problems();

  const venueMode = oneOf(env, 'VENUE_MODE', MODES, 'SIM', p);
  const busMode = oneOf(env, 'BUS_MODE', ['inproc', 'redis'] as const, 'inproc', p);
  const settlementStyleDefault = oneOf(env, 'SETTLEMENT_STYLE_DEFAULT', SETTLEMENT_STYLES, 'EXPIRY', p);
  // 'somnia' in .env maps to the SDK feed; the union name is 'somnia-feed'.
  const feedRaw = str(env, 'SPOT_FEED', venueMode === 'LIVE' ? 'somnia-feed' : 'fixture');
  const spotFeed = oneOf(
    { SPOT_FEED: feedRaw === 'somnia' ? 'somnia-feed' : feedRaw }, 'SPOT_FEED',
    TICK_SOURCES, 'fixture', p,
  );

  // ── Engine thresholds (FR-E4/E5) ──
  const edgeIn = num(env, 'EDGE_IN', 0.06, p);
  const edgeOut = num(env, 'EDGE_OUT', 0.02, p);
  const minEdgeFloor = num(env, 'MIN_EDGE_FLOOR', 0.015, p);
  const kellyFraction = num(env, 'KELLY_FRACTION', 0.25, p);

  if (edgeIn <= edgeOut) {
    p.add(`EDGE_IN (${edgeIn}) must be strictly greater than EDGE_OUT (${edgeOut}) — ` +
          `otherwise hysteresis (FR-E4) is a no-op and the agent spams orders.`);
  }
  if (minEdgeFloor > edgeIn) {
    p.add(`MIN_EDGE_FLOOR (${minEdgeFloor}) exceeds EDGE_IN (${edgeIn}) — no order could ever pass both gates.`);
  }
  if (!(kellyFraction > 0 && kellyFraction <= 1)) {
    p.add(`KELLY_FRACTION (${kellyFraction}) must be in (0,1]. WP §4 specifies 0.25 (quarter-Kelly).`);
  }

  const risk: RiskConfig = {
    maxNetContractsPerMarket: num(env, 'MAX_NET_CONTRACTS_PER_MARKET', 50, p),
    maxGrossContracts: num(env, 'MAX_GROSS_CONTRACTS', 200, p),
    maxNotionalUsd: num(env, 'MAX_NOTIONAL_USD', 250, p),
    maxSessionLossUsd: num(env, 'MAX_SESSION_LOSS_USD', 100, p),
    maxOrdersPerMinute: num(env, 'MAX_ORDERS_PER_MINUTE', 12, p),
    cooldownMs: num(env, 'COOLDOWN_MS', 15_000, p),
    edgeIn, edgeOut, kellyFraction, minEdgeFloor,
    maxQuoteAgeMs: num(env, 'MAX_QUOTE_AGE_MS', 4_000, p),
    killSwitch: bool(env, 'KILL_SWITCH', false),
  };

  const vol: VolConfig = {
    lambda: num(env, 'EWMV_LAMBDA', 0.97, p),
    minObs: num(env, 'EWMV_MIN_OBS', 20, p),
    seedVol: num(env, 'EWMV_SEED_VOL', 0.6, p),
  };
  if (!(vol.lambda > 0 && vol.lambda < 1)) {
    p.add(`EWMV_LAMBDA (${vol.lambda}) must be in (0,1) — it is the decay of an exponential recurrence.`);
  }

  // ── Chain (verified live, docs/spikes/S2-sdk.md) ──
  const somnia: SomniaConfig = {
    network: str(env, 'NETWORK', 'testnet'),
    chainId: num(env, 'SOMNIA_CHAIN_ID', 50_312, p),
    rpcUrl: str(env, 'SOMNIA_RPC_URL', ''),
    wsUrl: str(env, 'SOMNIA_WS_URL', ''),
    indexerUrl: str(env, 'SOMNIA_INDEXER_URL', ''),
    priceFeedUrl: str(env, 'SOMNIA_PRICE_FEED_URL', ''),
    priceFeedQuote: str(env, 'SOMNIA_PRICE_FEED_QUOTE', 'USDC'),
    explorerBase: str(env, 'SOMNIA_EXPLORER_BASE', 'https://shannon-explorer.somnia.network/tx/'),
    collateralDecimals: num(env, 'COLLATERAL_DECIMALS', 6, p),
    venueId: env['VENUE_ID']?.trim() || null,
  };

  const keys = {
    mira: env['MIRA_PRIVATE_KEY']?.trim() || null,
    echo: env['ECHO_PRIVATE_KEY']?.trim() || null,
  };

  const echo: EchoConfig = {
    enabled: bool(env, 'ECHO_ENABLED', true),
    spread: num(env, 'ECHO_SPREAD', 0.02, p),
    quoteSize: num(env, 'ECHO_QUOTE_SIZE', 5, p),
    refreshMs: num(env, 'ECHO_REFRESH_MS', 10_000, p),
    maxInventory: num(env, 'ECHO_MAX_INVENTORY', 20, p),
  };

  // ── LIVE-only requirements ──
  if (venueMode === 'LIVE') {
    if (!somnia.rpcUrl) p.add('SOMNIA_RPC_URL is required when VENUE_MODE=LIVE.');
    if (!somnia.indexerUrl) p.add('SOMNIA_INDEXER_URL is required when VENUE_MODE=LIVE.');
    if (!somnia.venueId) {
      p.add('VENUE_ID is required when VENUE_MODE=LIVE — two venues are live simultaneously ' +
            'and the ids move (docs/spikes/S4-limits.md). Read it off a live market row.');
    }
    if (!keys.mira) p.add('MIRA_PRIVATE_KEY is required when VENUE_MODE=LIVE.');
    if (echo.enabled) {
      if (!keys.echo) {
        p.add('ECHO_PRIVATE_KEY is required when ECHO_ENABLED=true on LIVE — self-matching is ' +
              'blocked by the venue (RFC-001 A7), so ECHO must sign with a different key.');
      } else if (keys.echo === keys.mira) {
        p.add('ECHO_PRIVATE_KEY is the same key as MIRA_PRIVATE_KEY. The venue blocks ' +
              'self-matching, so the two agents would never trade with each other.');
      }
    }
  }

  // ── Throttles: env may only make them SAFER, never more aggressive ──
  const inFlight = num(env, 'INDEXER_MAX_IN_FLIGHT', THROTTLE.indexerMaxInFlight, p);
  if (inFlight > THROTTLE.indexerMaxInFlight) {
    p.add(`INDEXER_MAX_IN_FLIGHT (${inFlight}) exceeds the measured safe limit of ` +
          `${THROTTLE.indexerMaxInFlight}. At 30-way concurrency the indexer returned 20 % errors ` +
          `and a 29 s p99 (docs/spikes/S4-limits.md).`);
  }
  const throttle: Throttle = {
    ...THROTTLE,
    indexerMaxInFlight: Math.min(inFlight, THROTTLE.indexerMaxInFlight),
    marketsCacheMs: Math.max(num(env, 'MARKETS_CACHE_MS', THROTTLE.marketsCacheMs, p), 1_000),
    quoteCacheMs: Math.max(num(env, 'QUOTE_CACHE_MS', THROTTLE.quoteCacheMs, p), 250),
    priceFeedPollMs: Math.max(num(env, 'PRICE_FEED_POLL_MS', THROTTLE.priceFeedPollMs, p), 100),
    reconcilePollMs: Math.max(num(env, 'RECONCILE_POLL_MS', THROTTLE.reconcilePollMs, p), 500),
    rpcMaxInFlight: num(env, 'RPC_MAX_IN_FLIGHT', THROTTLE.rpcMaxInFlight, p),
    indexerTimeoutMs: num(env, 'INDEXER_TIMEOUT_MS', THROTTLE.indexerTimeoutMs, p),
    indexerRetries: num(env, 'INDEXER_RETRIES', THROTTLE.indexerRetries, p),
  };
  if (throttle.reconcilePollMs * 3 >= 10_000) {
    p.add(`RECONCILE_POLL_MS (${throttle.reconcilePollMs}) leaves no headroom under GWT-6's ` +
          `10 s self-correction budget (3 polls must fit).`);
  }

  const serve: ServeConfig = {
    apiPort: num(env, 'API_PORT', 8080, p),
    webOrigin: str(env, 'WEB_ORIGIN', 'http://localhost:3000'),
    operatorToken: str(env, 'OPERATOR_TOKEN', 'change-me-before-demo'),
    mirrorBalanceFraction: num(env, 'MIRROR_BALANCE_FRACTION', 0.05, p),
    mirrorIntentTtlMs: num(env, 'MIRROR_INTENT_TTL_MS', 60_000, p),
  };
  if (!(serve.mirrorBalanceFraction > 0 && serve.mirrorBalanceFraction <= 1)) {
    p.add(`MIRROR_BALANCE_FRACTION (${serve.mirrorBalanceFraction}) must be in (0,1].`);
  }

  const hunt: HuntConfig = {
    roundDurationMs: num(env, 'ROUND_DURATION_MS', 300_000, p),
    topN: num(env, 'HUNT_TOP_N', 5, p),
  };

  p.throwIfAny();

  return {
    runId: str(env, 'RUN_ID', '') || newRunId(),
    venueMode, busMode, spotFeed, settlementStyleDefault,
    risk, vol, somnia, keys, echo, hunt, serve, throttle,
  };
}
