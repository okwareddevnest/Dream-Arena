// MIRA agent entrypoint — wires DATA → CORE → VENUE into one running process.
//   npm run agent            # VENUE_MODE from .env (LIVE by default per RFC-003)
//   VENUE_MODE=SIM npm run agent
// LIVE-FIRST (RFC-003): SIM exists as a test rig; the demo path is the real chain.
// spec: ARCH §1,§2 · PRD §8 · RFC-003
import { loadConfig, SystemClock, VirtualClock, type Market, type Usd } from '@arena/shared';
import { EventBus, Journal, Ingester, Store, binanceSource } from '@arena/data';
import { Engine } from '@arena/core';
import { DreamDEXVenue, SimulatedVenue, TxQueue, NonceManager, createSdkClient, createBoundarySource, Reconciler, ClaimLoop } from '@arena/venue';
import { startArenaServer } from './server.ts';

const cfg = loadConfig();
const clock = new SystemClock();
const bus = new EventBus();
const journal = new Journal({ dir: 'state/journal', runId: cfg.runId, mode: cfg.venueMode, clock });
const store = new Store({ runId: cfg.runId, mode: cfg.venueMode });
store.subscribe(bus);

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const fail = (s: string): never => { console.error(`\n  ✗ ${s}\n`); process.exit(1); };

// Say the mode LOUDLY. A run that is quietly SIM when the operator expected LIVE
// looks identical on every screen until someone checks a transaction — and the
// arena badge will faithfully report SIM while everyone assumes otherwise.
if (cfg.venueMode === 'LIVE') {
  log(`run ${cfg.runId}`);
  console.log('\n  \x1b[32m● LIVE\x1b[0m — Somnia testnet, real orders, real collateral.\n');
} else {
  log(`run ${cfg.runId}`);
  console.log(
    '\n  \x1b[33m● SIM\x1b[0m — SimulatedVenue. Nothing here touches the chain.\n' +
    '    RFC-003 makes LIVE the demo path. Set VENUE_MODE=LIVE in .env,\n' +
    '    or run: VENUE_MODE=LIVE npm run agent\n',
  );
}

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
  // NOT `submitter: queue`. DreamDEXVenue already routes every write through
  // this exact TxQueue (T-033), so handing the Engine the same queue made each
  // order submit itself twice: the outer task's `run` called venue.placeOrder,
  // which re-submitted the SAME clientOrderId and got the outer task's own
  // pending promise back. Every order then deadlocked for 30s and no
  // transaction was ever signed. One write, one queue.
  balance: () => bankroll,
  marketsCacheMs: cfg.throttle.marketsCacheMs,
  quoteCacheMs: cfg.throttle.quoteCacheMs,
  onJournal: (kind, payload) => { journal.append(kind, payload); },
});
venue.onFill((f) => { engine.onFill(f); journal.append('fill', f); });

// ── Position reconciliation (chain wins) ────────────────────────────────────
// WITHOUT THIS THE RISK CAPS ARE INERT. The engine only learns its net position
// from onFill, and nothing on DreamDEXVenue emits fills yet — so
// maxNetContractsPerMarket was never enforced and MIRA accumulated 250 contracts
// against a cap of 50, holding real positions it did not know about.
// The reconciler reads the chain and pushes the truth into the engine.
const known = new Map<string, import('@arena/shared').Position>();
const reconciler = new Reconciler({
  venue, agent: 'MIRA',
  local: {
    positions: () => [...known.values()],
    adopt: (p) => { known.set(p.marketId, p); engine.adoptNet(p.marketId, p.netContracts); },
    drop: (marketId) => { known.delete(marketId); engine.dropNet(marketId); },
  },
  bus,
  onReport: (r) => { journal.append('reconcile', r); },
  onError: (e) => log(`RECONCILE ERROR ${e.message}`),
});
const stopReconciler = reconciler.start(
  cfg.throttle.reconcilePollMs,
  (fn, ms) => setInterval(fn, ms) as unknown as number,
  (h) => clearInterval(h),
);

// Markets reach the UI through Store.applyMarkets, not the bus: there is no
// 'markets' bus topic and IF §13 is frozen. getMarkets is cached, so this is
// cheap; without it the arena page has valuations for markets it cannot name.
const pushMarkets = async () => {
  try { store.applyMarkets(await venue.getMarkets()); }
  catch (e) { log(`WARN markets refresh: ${(e as Error).message}`); }
};
await pushMarkets();
const marketsTimer = setInterval(() => { void pushMarkets(); }, cfg.throttle.marketsCacheMs);

// ── API + WebSocket ─────────────────────────────────────────────────────────
// Served from THIS process: the bus is in-process (ARCH §1), so the API reads
// the same live bus and Store the engine writes. A separate process would need
// Redis — the documented upgrade path, not something the demo needs.
const server = await startArenaServer({
  cfg, bus, clock, store, venue,
  agentProfile: () => ({
    agent: 'MIRA', mode: cfg.venueMode, runId: cfg.runId,
    strategy: 'EWMV volatility forecast (F4) → F1 expiry probability → quarter-Kelly',
    risk: cfg.risk, stats: engine.statsSnapshot(),
  }),
  kill: (by) => { engine.riskGuard.kill(by); journal.append('kill', { by, tsMs: clock.now() }); },
  unkill: (by) => { engine.riskGuard.unkill(by); journal.append('kill', { by, unkill: true, tsMs: clock.now() }); },
  setMode: (m) => { log(`console: setMode ${m} (RFC-003 keeps the demo on LIVE)`); },
  triggerScenario: (n) => { log(`console: scenario ${n} is a SIM-only facility`); },
  journalForecast: (f) => { journal.append('forecast', f); },
  onSettle: (st) => journal.append('settlement', st),
  log,
}).catch((e: Error) => fail(e.message));

// ── Maker-side fills ────────────────────────────────────────────────────────
// Fills WE cause come back in the placeOrder result. A fill where someone hits a
// quote we are resting exists only on the chain's live tail — which is exactly
// what happens once ECHO is quoting against MIRA.
// SimulatedVenue matches inline and emits its own fills, so it has no tail.
const tail = venue instanceof DreamDEXVenue ? venue : null;
const makerFillTimer = setInterval(() => {
  void tail?.pollMakerFills().then((n: number) => { if (n) log(`maker fills: ${n}`); });
}, cfg.throttle.reconcilePollMs);
const stopMakerFills = () => clearInterval(makerFillTimer);

// ── Claim loop (RFC-001 A5: winnings are CLAIMED, not received) ─────────────
// Without this, every market MIRA wins settles and the payout simply stays on
// the contract. Built as T-036 and, until now, never started.
const claims = new ClaimLoop({
  venue, bus,
  onClaim: (r) => {
    journal.append('claim', r);
    if (r.claimed) log(`CLAIMED ${r.amountUsd.toFixed(2)} USD from ${r.marketId.slice(-6)} ${r.txHash ?? ''}`);
  },
  onError: (e) => log(`CLAIM ERROR ${e.message}`),
});
// ClaimLoop is caller-driven by design (`due()` + `sweep()`), so the timer lives
// here. `sweep()` never throws — a claim failure must not stall trading.
const claimTimer = setInterval(() => { void claims.sweep(); }, cfg.throttle.reconcilePollMs * 5);
const stopClaims = () => clearInterval(claimTimer);

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
      `bankroll ${bankroll.toFixed(2)} claimed ${claims.statsSnapshot().claimed}` +
      `${engine.riskGuard.killed ? ' KILLED' : ''}`);
}, 10_000);

// ── Shutdown ────────────────────────────────────────────────────────────────
let closing = false;
const shutdown = async (why: string) => {
  if (closing) return;
  closing = true;
  clearInterval(beat);
  log(`shutting down (${why})`);
  try { ingester.stop(); } catch { /* already stopped */ }
  try { stopReconciler(); } catch { /* already stopped */ }
  try { stopClaims(); } catch { /* already stopped */ }
  try { stopMakerFills(); } catch { /* already stopped */ }
  try { clearInterval(marketsTimer); } catch { /* already stopped */ }
  try { await server.stop(); } catch { /* already stopped */ }
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
