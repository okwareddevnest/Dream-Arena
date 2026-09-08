// Arena API server — binds the transport-agnostic API lane (Broadcaster,
// RestRouter, HuntService, MirrorService) to a real HTTP + WebSocket server.
//
// It runs INSIDE the MIRA agent process on purpose: the event bus is in-process
// (ARCH §1), so the API reads the same live bus and Store the engine is writing.
// A separate process would need Redis, which is the documented upgrade path and
// not something the demo needs.
// spec: ARCH §1 · IF §13 · T-040..T-045
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AppConfig, Bus, Clock, Forecast, Ms, Mode, Outcome, ScenarioName, Settlement, Venue,
} from '@arena/shared';
import type { Store } from '@arena/data';
import {
  Broadcaster, RestRouter, HuntService, MirrorService, parseUrl,
  userRecord, calibrationBuckets, headToHead, RoundDriver, AuthService, type Socket,
} from '@arena/api';

export interface ArenaServerOptions {
  cfg: AppConfig;
  bus: Bus;
  clock: Clock;
  store: Store;
  /** Resolved outcomes for scoring a closed round. */
  outcomes?: () => Outcome[];
  /** Console actions are the agent's to perform; the API only routes them. */
  kill: (by: string) => void;
  unkill: (by: string) => void;
  setMode: (m: Mode) => void;
  triggerScenario: (n: ScenarioName) => void;
  agentProfile: () => unknown;
  /** Needed to price a MIRROR intent against the live venue. */
  venue?: Venue;
  journalForecast?: (f: Forecast) => void;
  onSettle?: (s: Settlement) => number;
  log?: (s: string) => void;
}

export interface ArenaServer {
  port: number;
  hunt: HuntService;
  broadcaster: Broadcaster;
  stop(): Promise<void>;
}

export async function startArenaServer(o: ArenaServerOptions): Promise<ArenaServer> {
  const { cfg, bus, clock, store } = o;
  const log = o.log ?? (() => {});
  const now = (): Ms => clock.now();

  const hunt = new HuntService({ clock, bus, onSettle: (s) => o.onSettle?.(s) ?? 0 });
  const mirror = new MirrorService({
    clock,
    balanceFraction: cfg.serve.mirrorBalanceFraction,
    intentTtlMs: cfg.serve.mirrorIntentTtlMs,
    chainId: cfg.somnia.chainId,
  });

  // HuntService scores forecasts but does not store them, and settlements are
  // history the REST layer serves. Both live here, with the server as the only
  // writer.
  // Identity. Connecting a wallet reveals an address; signing proves it. Without
  // this, anyone could post a forecast under anyone else's address — which is
  // exactly what happened during the build, against MIRA's own wallet.
  const auth = new AuthService({
    domain: new URL(cfg.serve.webOrigin).host,
    uri: cfg.serve.webOrigin,
    chainId: cfg.somnia.chainId,
  });

  const forecasts: Forecast[] = [];
  const settlements: Settlement[] = [];
  let forecastSeq = 0;
  /** The authenticated address for the request being handled, or null. */
  let pendingAuthAddr: string | null = null;

  /** Accept a forecast from WS or REST. One shape, one validation path. */
  const takeForecast = (
    f: Omit<Forecast, 'forecastId'>,
    authedAddr: string | null,
  ): { status: number; body: unknown } => {
    // A forecast is a claim about YOUR judgement. It has to be yours.
    if (!authedAddr) {
      return { status: 401, body: { error: 'sign in with your wallet to make a call' } };
    }
    if (f.userAddr && f.userAddr.toLowerCase() !== authedAddr) {
      return { status: 403, body: { error: 'you can only forecast as yourself' } };
    }
    if (!f?.marketId || typeof f.p !== 'number' || !(f.p > 0) || !(f.p < 1)) {
      return { status: 400, body: { error: 'p must be a probability in (0,1) and marketId is required' } };
    }
    const open = hunt.round;
    if (!open || open.status !== 'OPEN') {
      return { status: 409, body: { error: 'no round is open right now' } };
    }
    if (!open.marketIds.includes(f.marketId)) {
      return { status: 400, body: { error: 'that market is not in the open round' } };
    }
    // Stamp the CURRENT round: a client-supplied roundId could score a forecast
    // against a round it was never made in.
    const full: Forecast = {
      ...f, userAddr: authedAddr, roundId: open.roundId, forecastId: `fc-${++forecastSeq}`,
    };
    forecasts.push(full);
    o.journalForecast?.(full);
    return { status: 202, body: { forecastId: full.forecastId } };
  };

  const snapshot = () => store.snapshot(now());
  const broadcaster = new Broadcaster({
    bus, snapshot, now, runId: cfg.runId,
    // The socket carries no session, so a forecast over WS is rejected the same
    // way an unsigned REST call is. One rule, one path.
    onForecast: (f) => { takeForecast(f, null); },
    onError: (e, id) => log(`WS ERROR ${id}: ${e.message}`),
  });

  const router = new RestRouter({
    snapshot,
    health: () => store.health(now()),
    leaderboard: () => snapshot().leaderboard ?? [],
    rounds: () => ({ round: null, history: settlements }),
    agentProfile: o.agentProfile,
    mirror: (body) => buildMirror(body),
    forecast: (f) => takeForecast(f, pendingAuthAddr),
    console: {
      kill: (by) => o.kill(by),
      unkill: (by) => o.unkill(by),
      setMode: (m) => o.setMode(m),
      triggerScenario: (n) => o.triggerScenario(n),
      forceRoundClose: () => { void settleRound(); },
    },
    operatorToken: cfg.serve.operatorToken,
    webOrigin: cfg.serve.webOrigin,
  });

  /**
   * Resolved outcomes, read from the VENUE. A market the chain has not settled
   * scores nobody — which is why an open round simply waits rather than paying
   * out on a guess.
   */
  async function chainOutcomes(): Promise<Outcome[]> {
    if (o.outcomes) return o.outcomes();
    const venue = o.venue;
    if (!venue) return [];
    const settledMarkets = await venue.settledMarkets(40).catch(() => [] as { id: string; status: string; winningOutcome?: number | null }[]);
    return (settledMarkets as { id: string; winningOutcome?: number | null }[])
      .filter((m) => m.winningOutcome === 0 || m.winningOutcome === 1)
      .map((m) => ({
        marketId: m.id, roundId: '', resolved: true,
        outcome: (m.winningOutcome === 0 ? 0 : 1) as 0 | 1,
        resolvedTsMs: now(),
      }));
  }

  // The loop that makes the arena multi-player. Without it HuntService never
  // opens a round, so no forecast is ever scored and every scorecard reads
  // "untested" — which is exactly how this shipped until now.
  const driver = new RoundDriver({
    hunt, clock,
    markets: () => snapshot().markets,
    outcomes: chainOutcomes,
    forecasts: () => forecasts,
    miraPnlUsd: () => {
      const curve = snapshot().pnlCurve;
      return curve.length ? curve[curve.length - 1]!.pnlUsd : 0;
    },
    onSettle: (s) => { settlements.unshift(s); o.onSettle?.(s); },
    onError: (e) => log(`ROUND ERROR ${e.message}`),
  });
  const stopDriver = driver.start(5_000);

  /**
   * MIRROR: turn "copy MIRA's last trade" into an unsigned intent the user signs
   * themselves. Non-custodial — the server never holds a key for the user.
   */
  function buildMirror(body: unknown): { status: number; body: unknown } {
    const b = (body ?? {}) as { userAddr?: string; userBalanceUsd?: number; fillId?: string; balanceFraction?: number };
    if (!b.userAddr) return { status: 400, body: { error: 'userAddr is required' } };
    const snap = snapshot();
    const sourceFill = b.fillId ? snap.tape.find((f) => f.fillId === b.fillId) : snap.tape[0];
    if (!sourceFill) return { status: 409, body: { error: 'no trade to mirror yet' } };
    const market = snap.markets.find((m) => m.id === sourceFill.marketId);
    if (!market) return { status: 409, body: { error: 'market for that fill is no longer live' } };
    // The REAL book the fill was priced against — never a synthesised quote:
    // this price is shown to a user who is about to sign a transaction.
    const quote = store.quote(market.id);
    if (!quote) return { status: 409, body: { error: 'no quote for that market yet' } };
    const r = mirror.build({
      sourceFill, market, quote, userAddr: b.userAddr,
      userBalanceUsd: Number(b.userBalanceUsd ?? 0),
      ...(b.balanceFraction === undefined ? {} : { balanceFraction: b.balanceFraction }),
    });
    return r.ok ? { status: 200, body: r.intent } : { status: 422, body: { error: r.reason } };
  }

  /** Force the open round closed, from the console. Uses the same path as the
   *  driver so a manual close cannot behave differently from a timed one. */
  async function settleRound(): Promise<void> {
    const closed = hunt.closeForScoring();
    if (!closed) return;
    const s = hunt.settle({
      roundId: closed.roundId,
      forecasts: forecasts.filter((f) => f.roundId === closed.roundId),
      outcomes: await chainOutcomes(),
    });
    if (s) { settlements.unshift(s); o.onSettle?.(s); }
  }

  /**
   * One person's record. This is the only genuinely per-user thing the arena can
   * offer: MIRA's probability is identical for everyone, but what YOU said, and
   * how it turned out, is yours alone.
   */
  function scorecardFor(addr: string): unknown {
    const snap = snapshot();
    const outcomes = (o.outcomes?.() ?? []) as never[];
    const views = snap.valuations.map((v) => ({ marketId: v.marketId, pModel: v.pModel }));
    const mine = forecasts.filter((f) => f.userAddr?.toLowerCase() === addr.toLowerCase());
    return {
      userAddr: addr,
      record: userRecord(addr, forecasts, outcomes),
      calibration: calibrationBuckets(mine, outcomes, 5),
      versusMira: headToHead(addr, forecasts, views, outcomes),
      forecasts: mine.length,
      // Open calls have no score yet; saying so beats implying a zero.
      pending: mine.filter((f) => !outcomes.some((x: { marketId: string; resolved: boolean }) =>
        x.marketId === f.marketId && x.resolved)).length,
    };
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { void (async () => {

      const raw: string = Buffer.concat(chunks).toString('utf8');
      // The router parses the body itself, so hand it the raw string.
      const url: string = req.url ?? '/';
      const { path, query } = parseUrl(url);

      // ── Sign-In With Ethereum ────────────────────────────────────────────
      if (path === '/api/auth/nonce' && req.method === 'POST') {
        let addr = '';
        try { addr = String(JSON.parse(raw || '{}').address ?? ''); } catch { /* bad body */ }
        const ok = /^0x[0-9a-fA-F]{40}$/.test(addr);
        res.writeHead(ok ? 200 : 400, {
          'content-type': 'application/json',
          'access-control-allow-origin': cfg.serve.webOrigin,
        });
        res.end(JSON.stringify(ok ? auth.challenge(addr) : { error: 'a valid address is required' }));
        return;
      }
      if (path === '/api/auth/verify' && req.method === 'POST') {
        let body: { message?: string; signature?: string } = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* bad body */ }
        const session = await auth.verify(String(body.message ?? ''), String(body.signature ?? ''));
        res.writeHead(session ? 200 : 401, {
          'content-type': 'application/json',
          'access-control-allow-origin': cfg.serve.webOrigin,
        });
        res.end(JSON.stringify(session
          ? { token: session.token, address: session.address, expiresAt: session.expiresAt }
          : { error: 'signature did not verify' }));
        return;
      }

      // Resolve the caller's session for the routes that need it.
      const bearer = String(req.headers['authorization'] ?? '').replace(/^Bearer /i, '');
      pendingAuthAddr = auth.addressFor(bearer);

      // Per-user scorecard. Added after IF §13 was frozen, so it lives beside the
      // router rather than inside it — the frozen surface stays untouched.
      const you = /^\/api\/you\/(0x[0-9a-fA-F]{40})$/.exec(path);
      if (you) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': cfg.serve.webOrigin,
        });
        res.end(JSON.stringify(scorecardFor(you[1]!)));
        return;
      }

      void router
        .handle({
          method: (req.method ?? 'GET').toUpperCase() as never,
          path, query, body: raw.length ? raw : null,
          headers: req.headers as Record<string, string>,
        })
        .then((out) => {
          res.writeHead(out.status, {
            'content-type': 'application/json',
            // The arena page is served from a different origin in dev.
            'access-control-allow-origin': cfg.serve.webOrigin,
            'access-control-allow-headers': 'content-type, authorization, x-operator-token',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            ...(out.headers ?? {}),
          });
          res.end(JSON.stringify(out.body ?? null));
        })
        .catch((e: Error) => {
          log(`REST ERROR ${path}: ${e.message}`);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal' }));
        });
    })(); });
  });

  // ── WebSocket (IF §13) ────────────────────────────────────────────────────
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  let seq = 0;
  wss.on('connection', (ws: WebSocket) => {
    const id = `sock-${++seq}`;
    const socket: Socket = {
      id,
      send: (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
      close: () => ws.close(),
    };
    broadcaster.connect(socket);
    ws.on('message', (raw: Buffer) => broadcaster.receive(id, raw.toString('utf8')));
    ws.on('close', () => broadcaster.disconnect(id));
    ws.on('error', () => broadcaster.disconnect(id));
  });

  const port = cfg.serve.apiPort;
  await new Promise<void>((resolve, reject) => {
    // The WebSocketServer is attached to this http server and RE-EMITS its
    // listen errors on itself, so a handler on `http` alone misses EADDRINUSE
    // and node kills the process with an unhandled 'error' event.
    const onError = (e: NodeJS.ErrnoException) => {
      // A port clash is the commonest way to start a SECOND agent by accident,
      // and a raw stack trace hides it. Worse, the old process keeps answering,
      // so /api/health reports the stale agent's mode and everything looks fine.
      if (e.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use — an arena agent is probably still running.\n` +
          `  Check:  lsof -ti:${port}\n` +
          `  Stop it: lsof -ti:${port} | xargs kill\n` +
          `  Or run this one on another port: API_PORT=8081 npm run agent`,
        ));
        return;
      }
      reject(e);
    };
    http.once('error', onError);
    wss.once('error', onError);
    http.listen(port, () => resolve());
  });
  log(`api on :${port} · ws ://:${port}/ws · cors ${cfg.serve.webOrigin}`);

  return {
    port, hunt, broadcaster,
    async stop() {
      stopDriver();
      await new Promise<void>((resolve) => { wss.close(() => resolve()); });
      await new Promise<void>((resolve) => { http.close(() => resolve()); });
    },
  };
}
