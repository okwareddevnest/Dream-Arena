// REST router, health and the director's console (FR-S2, F-A7; GWT-7, GWT-8).
//
// Hand-rolled rather than framework-backed, for one reason: there are nine
// routes and the latency budget is measured in milliseconds. A framework's
// middleware chain is not worth its weight here, and the routing table below is
// shorter than the config a framework would need.
//
// ── The console is the reason this file has a token check ──────────────────
// `POST /api/console/kill` halts an autonomous trader. `/console/mode` swaps
// the venue mid-session. These are operator powers, and the arena is public, so
// they are gated on a bearer token that is compared in CONSTANT TIME. Not
// because a hackathon demo is under attack, but because a timing-comparable
// token check is the kind of thing that ships to mainnet unchanged.
import type {
  ArenaSnapshot, Forecast, HealthSnapshot, Mode, Outcome, ScenarioName, Score, Settlement,
} from '@arena/shared';
import { SCENARIO_NAMES } from '@arena/shared';

export interface RestRequest {
  method: string;
  /** Path only, no query string. */
  path: string;
  query: Record<string, string>;
  /** Raw body, parsed by the router. */
  body: string | null;
  headers: Record<string, string>;
  origin?: string;
}

export interface RestResponse {
  status: number;
  /** Always JSON: an HTML error page from an API is a debugging dead end. */
  body: unknown;
  headers: Record<string, string>;
}

export interface ConsoleActions {
  kill(by: string): Promise<void> | void;
  unkill(by: string): Promise<void> | void;
  setMode(mode: Mode): Promise<void> | void;
  triggerScenario(name: ScenarioName): Promise<void> | void;
  forceRoundClose?(): Promise<void> | void;
}

export interface RestOptions {
  snapshot: () => ArenaSnapshot;
  health: () => HealthSnapshot;
  leaderboard: () => Score[];
  rounds: () => { round: Settlement[] | null; history: Settlement[] };
  agentProfile: () => unknown;
  mirror: (body: unknown) => { status: number; body: unknown };
  forecast: (f: Omit<Forecast, 'forecastId'>) => { status: number; body: unknown };
  console: ConsoleActions;
  operatorToken: string;
  webOrigin: string;
  /** Tick-lag threshold past which health reports not-ok. */
  tickLagAlarmMs?: number;
  outcomes?: () => Outcome[];
}

/**
 * Constant-time string comparison.
 *
 * `a === b` on a secret short-circuits at the first differing byte, which leaks
 * the length of the matching prefix. Irrelevant at hackathon scale and correct
 * everywhere, so it costs nothing to do properly.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export class RestRouter {
  private readonly o: RestOptions;
  private readonly tickLagAlarmMs: number;

  constructor(o: RestOptions) {
    this.o = o;
    this.tickLagAlarmMs = o.tickLagAlarmMs ?? 5_000;
  }

  private cors(origin?: string): Record<string, string> {
    // Only the configured web origin is allowed. A reflected `*` on an API that
    // carries an operator token is not a CORS policy.
    if (origin && origin === this.o.webOrigin) {
      return {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      };
    }
    return {};
  }

  private ok(body: unknown, origin?: string): RestResponse {
    return { status: 200, body, headers: { ...JSON_HEADERS, ...this.cors(origin) } };
  }

  private err(status: number, message: string, origin?: string): RestResponse {
    return { status, body: { error: message }, headers: { ...JSON_HEADERS, ...this.cors(origin) } };
  }

  /** Operator gate. Accepts `Authorization: Bearer <token>`. */
  private authorized(req: RestRequest): boolean {
    const raw = req.headers['authorization'] ?? req.headers['Authorization'] ?? '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    return token.length > 0 && safeEqual(token, this.o.operatorToken);
  }

  private parseBody(req: RestRequest): { ok: true; value: unknown } | { ok: false; reason: string } {
    if (req.body === null || req.body === '') return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(req.body) };
    } catch {
      return { ok: false, reason: 'body is not valid JSON' };
    }
  }

  async handle(req: RestRequest): Promise<RestResponse> {
    const { method, path } = req;
    const origin = req.origin;

    if (method === 'OPTIONS') {
      return { status: 204, body: null, headers: this.cors(origin) };
    }

    // ── GET ──
    if (method === 'GET') {
      switch (path) {
        case '/api/health': {
          const h = this.o.health();
          // Health is not "the process is up" — it is "the system is fit to
          // trade". A stalled feed is unhealthy even though nothing crashed.
          const lagOk = h.tickLagMs <= this.tickLagAlarmMs;
          const componentsOk = Object.values(h.components).every((c) => c.ok);
          const ok = lagOk && componentsOk && h.venue.ok && !h.killSwitch;
          return {
            status: 200,
            body: {
              ok,
              tickLagMs: h.tickLagMs,
              tickLagAlarmMs: this.tickLagAlarmMs,
              tickLagAlarm: !lagOk,
              ticksPerSec: h.ticksPerSec,
              journalSeq: h.journalSeq,
              killSwitch: h.killSwitch,
              mode: h.mode,
              runId: h.runId,
              venue: h.venue,
              components: h.components,
              tsMs: h.tsMs,
            },
            headers: { ...JSON_HEADERS, ...this.cors(origin) },
          };
        }
        case '/api/snapshot':
          return this.ok(this.o.snapshot(), origin);
        case '/api/leaderboard':
          return this.ok({ leaderboard: this.o.leaderboard() }, origin);
        case '/api/rounds':
          return this.ok(this.o.rounds(), origin);
        case '/api/agent/mira':
          return this.ok(this.o.agentProfile(), origin);
        case '/api/console/scenarios':
          // Listed from the frozen union so the console cannot offer a
          // scenario that does not exist.
          return this.ok({ scenarios: [...SCENARIO_NAMES] }, origin);
        default:
          break;
      }
      // /api/rounds/:id
      const m = /^\/api\/rounds\/([A-Za-z0-9_-]+)$/.exec(path);
      if (m) {
        const { history } = this.o.rounds();
        const found = history.find((s) => s.roundId === m[1]);
        return found ? this.ok(found, origin) : this.err(404, `round ${m[1]} not found`, origin);
      }
      return this.err(404, `no route for GET ${path}`, origin);
    }

    // ── POST ──
    if (method === 'POST') {
      const parsed = this.parseBody(req);
      if (!parsed.ok) return this.err(400, parsed.reason, origin);
      const body = parsed.value as Record<string, unknown>;

      switch (path) {
        case '/api/mirror': {
          const r = this.o.mirror(body);
          return { status: r.status, body: r.body, headers: { ...JSON_HEADERS, ...this.cors(origin) } };
        }
        case '/api/forecast': {
          const p = typeof body['p'] === 'number' ? body['p'] : Number.NaN;
          if (typeof body['roundId'] !== 'string' || typeof body['marketId'] !== 'string'
              || typeof body['userAddr'] !== 'string') {
            return this.err(400, 'roundId, marketId and userAddr are required', origin);
          }
          if (!Number.isFinite(p) || p < 0 || p > 1) {
            return this.err(400, 'p must be a probability in [0,1]', origin);
          }
          const r = this.o.forecast({
            roundId: body['roundId'], marketId: body['marketId'],
            userAddr: body['userAddr'], p, tsMs: this.o.health().tsMs,
          });
          return { status: r.status, body: r.body, headers: { ...JSON_HEADERS, ...this.cors(origin) } };
        }
        // ── Operator-only from here down ──
        case '/api/console/kill': {
          if (!this.authorized(req)) return this.err(401, 'operator token required', origin);
          const on = body['on'] === undefined ? true : Boolean(body['on']);
          const by = typeof body['by'] === 'string' ? body['by'] : 'console';
          if (on) await this.o.console.kill(by); else await this.o.console.unkill(by);
          return this.ok({ killSwitch: on, by }, origin);
        }
        case '/api/console/mode': {
          if (!this.authorized(req)) return this.err(401, 'operator token required', origin);
          const mode = body['mode'];
          if (mode !== 'LIVE' && mode !== 'SIM') {
            return this.err(400, 'mode must be LIVE or SIM', origin);
          }
          await this.o.console.setMode(mode);
          return this.ok({ mode }, origin);
        }
        case '/api/console/scenario': {
          if (!this.authorized(req)) return this.err(401, 'operator token required', origin);
          const name = body['name'];
          if (typeof name !== 'string' || !(SCENARIO_NAMES as readonly string[]).includes(name)) {
            return this.err(400, `name must be one of ${SCENARIO_NAMES.join(', ')}`, origin);
          }
          await this.o.console.triggerScenario(name as ScenarioName);
          return this.ok({ scenario: name }, origin);
        }
        case '/api/console/round/close': {
          if (!this.authorized(req)) return this.err(401, 'operator token required', origin);
          if (!this.o.console.forceRoundClose) return this.err(404, 'not supported', origin);
          await this.o.console.forceRoundClose();
          return this.ok({ closed: true }, origin);
        }
        default:
          return this.err(404, `no route for POST ${path}`, origin);
      }
    }

    return this.err(405, `${method} not allowed`, origin);
  }
}

/** Split a raw URL into a path and a query map, so `handle` never sees a query
 *  string glued to a path (which is how a route silently stops matching). */
export function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const [rawPath, rawQuery] = url.split('?', 2);
  const query: Record<string, string> = {};
  if (rawQuery) {
    for (const pair of rawQuery.split('&')) {
      const [k, v = ''] = pair.split('=', 2);
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  return { path: rawPath ?? '/', query };
}
