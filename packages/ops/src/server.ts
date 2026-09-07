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
import { Broadcaster, RestRouter, HuntService, MirrorService, parseUrl, type Socket } from '@arena/api';

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
  const forecasts: Forecast[] = [];
  const settlements: Settlement[] = [];
  let forecastSeq = 0;

  /** Accept a forecast from WS or REST. One shape, one validation path. */
  const takeForecast = (f: Omit<Forecast, 'forecastId'>): { status: number; body: unknown } => {
    if (!f?.marketId || typeof f.p !== 'number' || !(f.p > 0) || !(f.p < 1)) {
      return { status: 400, body: { error: 'p must be a probability in (0,1) and marketId is required' } };
    }
    const full: Forecast = { ...f, forecastId: `fc-${++forecastSeq}` };
    forecasts.push(full);
    o.journalForecast?.(full);
    return { status: 202, body: { forecastId: full.forecastId } };
  };

  const snapshot = () => store.snapshot(now());
  const broadcaster = new Broadcaster({
    bus, snapshot, now, runId: cfg.runId,
    onForecast: (f) => { takeForecast(f); },
    onError: (e, id) => log(`WS ERROR ${id}: ${e.message}`),
  });

  const router = new RestRouter({
    snapshot,
    health: () => store.health(now()),
    leaderboard: () => snapshot().leaderboard ?? [],
    rounds: () => ({ round: null, history: settlements }),
    agentProfile: o.agentProfile,
    mirror: (body) => buildMirror(body),
    forecast: takeForecast,
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

  /** Close the open round, score it, and keep the settlement for /rounds. */
  async function settleRound(): Promise<void> {
    const closed = hunt.closeForScoring();
    if (!closed) return;
    const snap = snapshot();
    const outcomes: Outcome[] = (o.outcomes?.() ?? []) as Outcome[];
    const s = hunt.settle({ roundId: closed.roundId, forecasts, outcomes });
    if (s) settlements.unshift(s);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {

      const raw: string = Buffer.concat(chunks).toString('utf8');
      // The router parses the body itself, so hand it the raw string.
      const url: string = req.url ?? '/';
      const { path, query } = parseUrl(url);
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
    });
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
      await new Promise<void>((resolve) => { wss.close(() => resolve()); });
      await new Promise<void>((resolve) => { http.close(() => resolve()); });
    },
  };
}
