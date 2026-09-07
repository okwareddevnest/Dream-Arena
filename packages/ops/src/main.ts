// MIRA agent entrypoint — wires DATA → CORE → VENUE into one running process.
//   npm run agent            # VENUE_MODE from .env (LIVE by default per RFC-003)
//   VENUE_MODE=SIM npm run agent
// LIVE-FIRST (RFC-003): SIM exists as a test rig; the demo path is the real chain.
// spec: ARCH §1,§2 · PRD §8 · RFC-003
import { loadConfig, SystemClock, VirtualClock, type Market, type Usd } from '@arena/shared';
import { EventBus, Journal, Ingester, Store, binanceSource } from '@arena/data';
import { Engine } from '@arena/core';
import { DreamDEXVenue, SimulatedVenue, TxQueue, NonceManager, createSdkClient, createBoundarySource } from '@arena/venue';

const cfg = loadConfig();
const clock = new SystemClock();
const bus = new EventBus();
const journal = new Journal({ dir: 'state/journal', runId: cfg.runId, mode: cfg.venueMode, clock });
const store = new Store({ runId: cfg.runId, mode: cfg.venueMode });
store.subscribe(bus);

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const fail = (s: string): never => { console.error(`\n  ✗ ${s}\n`); process.exit(1); };

log(`run ${cfg.runId} · mode ${cfg.venueMode}`);

// ── Venue ───────────────────────────────────────────────────────────────────
let venue: DreamDEXVenue | SimulatedVenue;
let queue: TxQueue | undefined;

if (cfg.venueMode === 'LIVE') {
  const key = cfg.keys.mira;
  const venueId = cfg.somnia.venueId;
  if (!key) fail('LIVE needs MIRA_PRIVATE_KEY — see docs/70-FUNDING.md, then `npm run fund`.');
  if (!venueId) fail('LIVE needs VENUE_ID — two venues run simultaneously and the ids move (T-S4).');
  const client = await createSdkClient({
    privateKey: key,
    venueId: venueId!,
    rpcUrl: cfg.somnia.rpcUrl,
    indexerUrl: cfg.somnia.indexerUrl,
    chainId: cfg.somnia.chainId,
  });
  // One key, one nonce stream: every write is serialised (T-033).
  const nonces = new NonceManager(client);
  queue = new TxQueue({ nonces, onError: (e, id) => log(`TXQUEUE ERROR ${id}: ${e.message}`) });
  venue = new DreamDEXVenue({
    client, agent: 'MIRA', venueId: venueId!,
    privateKey: key, queue, nonces,
    explorerBase: cfg.somnia.explorerBase,
    // Live markets are all `reference` mode with strike "0"; without this every
    // one of them skips as BOUNDARY_NOT_POSTED and MIRA never trades.
    boundary: createBoundarySource({ feedUrl: cfg.somnia.priceFeedUrl }),
    // 5m series roll continuously; without this MIRA draws markets with seconds
    // left and every order expires inside the write queue.
    minSecondsToExpiry: Number(process.env.MIN_SECONDS_TO_EXPIRY ?? 90),
    rpcMaxInFlight: cfg.throttle.rpcMaxInFlight,
    marketsCacheMs: cfg.throttle.marketsCacheMs,
    quoteCacheMs: cfg.throttle.quoteCacheMs,
    maxQuoteAgeMs: cfg.risk.maxQuoteAgeMs,
  });
} else {
  // The test rig (RFC-003): a virtual clock, never the demo path.
  venue = new SimulatedVenue({ agent: 'MIRA', clock: new VirtualClock() });
}

await venue.connect();
const health = await venue.health();
log(`venue ${venue.name} connected · ok=${health.ok} block=${health.blockNumber ?? '-'} ${health.latencyMs ?? '-'}ms`);
if (!health.ok) log(`WARN venue health: ${health.detail ?? 'unknown'}`);

const markets: Market[] = await venue.getMarkets();
log(`markets ${markets.length}${markets.length ? ` · e.g. ${markets[0]!.symbol} (${markets[0]!.asset})` : ''}`);
if (!markets.length) log('WARN no tradable markets — the agent will idle until one opens.');

// Underlyings actually needed, so the ingester never polls a symbol nobody trades.
const symbols = [...new Set(markets.map((m) => m.asset).filter((a) => a && a !== '?'))];
log(`underlyings ${symbols.join(', ') || '(none)'}`);

// ── Engine ──────────────────────────────────────────────────────────────────
// Bankroll is read per decision; refreshed off the hot path by the heartbeat.
let bankroll: Usd = 0;
const refreshBankroll = async () => {
  try { bankroll = await venue.balanceUsd('MIRA'); }
  catch (e) { log(`WARN balance read failed: ${(e as Error).message}`); }
};
await refreshBankroll();
log(`bankroll ${bankroll.toFixed(2)} USD`);

const engine = new Engine({
  agent: 'MIRA', venue, bus, clock, risk: cfg.risk, vol: cfg.vol,
  submitter: queue,
  balance: () => bankroll,
  marketsCacheMs: cfg.throttle.marketsCacheMs,
  quoteCacheMs: cfg.throttle.quoteCacheMs,
  onJournal: (kind, payload) => { journal.append(kind, payload); },
});
venue.onFill((f) => { engine.onFill(f); journal.append('fill', f); });

// ── Ingester ────────────────────────────────────────────────────────────────
// Binance spot is the reference underlying feed. It is NOT a simulation — these
// are real prices; they are simply not sourced from the venue. Logged by the
// source's own name so the banner can never claim a feed we are not using.
const source = binanceSource();
log(`spot feed ${source.name} (configured: ${cfg.spotFeed})`);
const ingester = new Ingester({
  bus, clock, source, symbols,
  pollMs: cfg.throttle.priceFeedPollMs,
  onTick: (t) => { journal.append('tick', t); },
  onError: (e) => log(`INGEST ERROR ${e.message}`),
});

bus.on('tick', (t) => {
  void engine.onTick(t.symbol, t.price, t.tsMs).catch((e) => log(`ENGINE ERROR ${e?.message ?? e}`));
});

if (symbols.length) { ingester.start(); log('ingester started'); }
else log('ingester not started — nothing to price.');

// ── Heartbeat ───────────────────────────────────────────────────────────────
const beat = setInterval(() => {
  void refreshBankroll();
  const s = engine.statsSnapshot();
  log(`ticks ${s.ticks} val ${s.valuations} skip ${s.skips} enter ${s.enters} ` +
      `orders ${s.ordersPlaced} err ${s.orderErrors}/${s.quoteErrors} ` +
      `bankroll ${bankroll.toFixed(2)}${engine.riskGuard.killed ? ' KILLED' : ''}`);
}, 10_000);

// ── Shutdown ────────────────────────────────────────────────────────────────
let closing = false;
const shutdown = async (why: string) => {
  if (closing) return;
  closing = true;
  clearInterval(beat);
  log(`shutting down (${why})`);
  try { ingester.stop(); } catch { /* already stopped */ }
  // Cancel resting orders before letting go of the key — an abandoned order is
  // a real position on a real chain.
  try { const acks = await venue.cancelAll('MIRA'); log(`cancelled ${acks.length} resting order(s)`); }
  catch (e) { log(`WARN cancelAll failed: ${(e as Error).message}`); }
  try { await venue.disconnect(); } catch { /* ignore */ }
  try { await journal.close(); } catch { /* ignore */ }
  log('stopped');
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
