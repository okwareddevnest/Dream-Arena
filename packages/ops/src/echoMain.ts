// ECHO agent entrypoint — the adversarial market maker (F-A4, WP §5).
//   npm run echo
// Runs as its OWN PROCESS with its OWN KEY. That is not a style choice:
// self-matching is blocked on the venue (RFC-001 A7), so ECHO must sign with a
// key that is not MIRA's or the two can never trade with each other. Separate
// processes also give each agent its own nonce stream, so neither can stall the
// other's writes.
//
// Why it exists at all: T-S4 measured `tradeCount: 0` on every live market.
// There is no organic counterparty, so without ECHO the tape is always empty.
// spec: PRD F-A4 · WP §5 · RFC-001 A6,A7 · RFC-003
import { loadConfig, SystemClock, tauYears, type Market } from '@arena/shared';
import { EventBus, Journal, Ingester, binanceSource } from '@arena/data';
import { EchoAgent, Ewmv, f1ExpiryProb } from '@arena/core';
import { DreamDEXVenue, TxQueue, NonceManager, createSdkClient, createBoundarySource } from '@arena/venue';

const cfg = loadConfig();
const clock = new SystemClock();
const bus = new EventBus();
const journal = new Journal({ dir: 'state/journal', runId: `echo-${cfg.runId}`, mode: cfg.venueMode, clock });

const log = (s: string) => console.log(`${new Date().toISOString()} [ECHO] ${s}`);
const fail = (s: string): never => { console.error(`\n  ✗ ${s}\n`); process.exit(1); };

if (cfg.venueMode !== 'LIVE') fail('ECHO is a LIVE counterparty (RFC-003). SimulatedVenue makes its own liquidity.');
const key = cfg.keys.echo;
const venueId = cfg.somnia.venueId;
if (!key) fail('ECHO_PRIVATE_KEY missing — see docs/70-FUNDING.md, then `npm run fund -- --faucet`.');
if (!venueId) fail('VENUE_ID missing.');
if (key === cfg.keys.mira) fail('ECHO_PRIVATE_KEY must DIFFER from MIRA_PRIVATE_KEY: the venue blocks self-matching (RFC-001 A7), so identical keys mean the two agents can never trade.');

log(`run ${cfg.runId} · mode ${cfg.venueMode}`);

const client = await createSdkClient({
  privateKey: key, venueId: venueId!,
  rpcUrl: cfg.somnia.rpcUrl, indexerUrl: cfg.somnia.indexerUrl, chainId: cfg.somnia.chainId,
});
const nonces = new NonceManager(client);
const queue = new TxQueue({ nonces, onError: (e, id) => log(`TXQUEUE ERROR ${id}: ${e.message}`) });
const venue = new DreamDEXVenue({
  client, agent: 'ECHO', venueId: venueId!, privateKey: key, queue, nonces,
  explorerBase: cfg.somnia.explorerBase,
  boundary: createBoundarySource({ feedUrl: cfg.somnia.priceFeedUrl }),
  minSecondsToExpiry: Number(process.env.MIN_SECONDS_TO_EXPIRY ?? 90),
  rpcMaxInFlight: cfg.throttle.rpcMaxInFlight,
  marketsCacheMs: cfg.throttle.marketsCacheMs,
  quoteCacheMs: cfg.throttle.quoteCacheMs,
  maxQuoteAgeMs: cfg.risk.maxQuoteAgeMs,
});

await venue.connect();
const health = await venue.health();
log(`venue connected · ok=${health.ok} block=${health.blockNumber ?? '-'}`);
log(`balance ${(await venue.balanceUsd('ECHO')).toFixed(2)} USD`);

const echo = new EchoAgent({
  venue, bus, clock, risk: cfg.risk,
  spread: cfg.echo.spread, quoteSize: cfg.echo.quoteSize,
  refreshMs: cfg.echo.refreshMs, maxInventory: cfg.echo.maxInventory,
  // Construction fails loudly if these collide (RFC-001 A7).
  ownKey: key, peerKey: cfg.keys.mira,
});
venue.onFill((f) => { echo.onFill(f); journal.append('fill', f); });
await echo.start();

// ── Fair value ──────────────────────────────────────────────────────────────
// ECHO quotes around its OWN estimate, computed with the same maths MIRA uses
// (EWMV volatility → F1 expiry probability) but from an independent model. It
// deliberately does not read MIRA's view: two agents sharing one opinion cannot
// disagree, and disagreement is what produces a trade.
const vols = new Map<string, Ewmv>();
const volFor = (asset: string): Ewmv => {
  let v = vols.get(asset);
  if (!v) { v = new Ewmv({ symbol: asset, ...cfg.vol }); vols.set(asset, v); }
  return v;
};
const fair = (m: Market): number | null => {
  // A reference market with no boundary posted cannot be priced (RFC-001 A4).
  if (!m.boundaryPosted || m.strike === null) return null;
  const st = volFor(m.asset).state(clock.now());
  if (!(st.spot > 0)) return null;
  const tau = tauYears(clock.now(), m.expiryMs);
  if (!(tau > 0)) return null;
  return f1ExpiryProb(st.spot, m.strike, st.sigmaForecast, tau);
};

const markets: Market[] = await venue.getMarkets();
const symbols = [...new Set(markets.map((m) => m.asset).filter((a) => a && a !== '?'))];
log(`markets ${markets.length} · underlyings ${symbols.join(', ') || '(none)'}`);

const source = binanceSource();
const ingester = new Ingester({
  bus, clock, source, symbols, pollMs: cfg.throttle.priceFeedPollMs,
  onTick: (t) => { volFor(t.symbol).update(t.price, t.tsMs); journal.append('tick', t); },
  onError: (e) => log(`INGEST ERROR ${e.message}`),
});
if (symbols.length) { ingester.start(); log('ingester started'); }

// ── Quote loop ──────────────────────────────────────────────────────────────
let cycling = false;
const quoteTimer = setInterval(() => {
  if (cycling) return;                       // never overlap a requote
  cycling = true;
  void (async () => {
    try {
      const live = await venue.getMarkets();
      await echo.cycle(live, fair);
    } catch (e) {
      log(`CYCLE ERROR ${(e as Error).message}`);
    } finally { cycling = false; }
  })();
}, cfg.echo.refreshMs);

const fillTimer = setInterval(() => {
  void venue.pollMakerFills().then((n) => { if (n) log(`filled ${n} (someone hit our quote)`); });
}, cfg.throttle.reconcilePollMs);

const beat = setInterval(() => {
  const s = echo.statsSnapshot();
  log(`cycles ${s.cycles} quotes ${s.quotesPlaced} rejected ${s.quotesRejected} ` +
      `mints ${s.mints} cancels ${s.cancels} skewed ${s.skewedCycles} fills ${s.fills}` +
      `${echo.riskGuard.killed ? ' KILLED' : ''}`);
}, 10_000);

// ── Shutdown ────────────────────────────────────────────────────────────────
let closing = false;
const shutdown = async (why: string) => {
  if (closing) return;
  closing = true;
  clearInterval(quoteTimer); clearInterval(fillTimer); clearInterval(beat);
  log(`shutting down (${why})`);
  try { ingester.stop(); } catch { /* already stopped */ }
  // Resting quotes are real orders with real collateral behind them.
  try { await echo.cancelAll(); } catch (e) { log(`WARN echo.cancelAll: ${(e as Error).message}`); }
  try { const acks = await venue.cancelAll('ECHO'); log(`cancelled ${acks.length} resting order(s)`); }
  catch (e) { log(`WARN venue.cancelAll: ${(e as Error).message}`); }
  try { await echo.stop(); } catch { /* ignore */ }
  try { await venue.disconnect(); } catch { /* ignore */ }
  try { await journal.close(); } catch { /* ignore */ }
  log('stopped');
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
