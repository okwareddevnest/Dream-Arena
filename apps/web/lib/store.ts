// Arena state: a snapshot the server sends on connect, then a stream of events
// folded onto it. spec: IF §13 · T-051
//
// STALE POLICY (operator decision). When the feed drops we KEEP the last values,
// mark them stale and show their age. Blanking the arena on a one-second blip
// reads as a broken page; a number that is visibly 8 seconds old is honest and
// still useful. Nothing is ever invented — a value that never arrived stays
// absent, and `hydrated` says whether we have heard from the server at all.

/** Past this age the UI paints the staleness in `warn`. */
export const STALE_WARN_MS = 5_000;
/** Tape is bounded: a broadcast page runs for hours. */
export const TAPE_CAP = 200;
const CURVE_CAP = 600;
/** Spot readings kept per symbol — a window, not a database. */
const SPOT_CAP = 180;

export interface ArenaState {
  runId: string | null;
  mode: 'LIVE' | 'SIM' | null;
  hydrated: boolean;
  connected: boolean;
  markets: any[];
  valuations: any[];
  positions: any[];
  tape: any[];
  pnlCurve: { tsMs: number; pnlUsd: number }[];
  round: any | null;
  leaderboard: any[];
  health: any | null;
  quips: any[];
  model: any | null;
  /** Spot readings accumulated from the live tick stream. There is no history
   *  endpoint, so a fresh page starts empty — which is the truth, and the chart
   *  says so rather than drawing one reading as a trend. */
  spot: Record<string, { tsMs: number; price: number }[]>;
  /** When the server last told us anything. */
  lastEventMs: number | null;
}

const empty = (): ArenaState => ({
  runId: null, mode: null, hydrated: false, connected: false,
  markets: [], valuations: [], positions: [], tape: [], pnlCurve: [],
  round: null, leaderboard: [], health: null, quips: [], model: null, spot: {},
  lastEventMs: null,
});

export interface Staleness { stale: boolean; ageMs: number }

export interface ArenaStore {
  get(): ArenaState;
  apply(msg: unknown, nowMs?: number): void;
  setConnected(v: boolean, nowMs?: number): void;
  staleness(nowMs?: number): Staleness;
  subscribe(fn: () => void): () => void;
}

/** Newest first, capped. */
const prepend = <T>(list: T[], item: T, cap: number): T[] => {
  const out = [item, ...list];
  return out.length > cap ? out.slice(0, cap) : out;
};

export function createArenaStore(): ArenaStore {
  let state = empty();
  const subs = new Set<() => void>();
  const notify = () => { for (const f of [...subs]) { try { f(); } catch { /* isolate */ } } };

  /** Fold one bus event. Unknown topics are ignored, never fatal: the server may
   *  ship a topic this build does not know about yet. */
  const foldEvent = (ev: any, nowMs: number): boolean => {
    const topic = ev?.t;
    const d = ev?.d;
    if (typeof topic !== 'string' || d === undefined || d === null) return false;
    switch (topic) {
      case 'fill': state = { ...state, tape: prepend(state.tape, d, TAPE_CAP) }; return true;
      case 'tick': {
        const sym = String(d.symbol ?? '');
        const prev = state.spot[sym] ?? [];
        const next = [...prev, { tsMs: d.tsMs, price: d.price }].slice(-SPOT_CAP);
        state = {
          ...state,
          model: { ...(state.model ?? {}), spot: d.price, tsMs: d.tsMs },
          spot: { ...state.spot, [sym]: next },
        };
        return true;
      }
      case 'model': state = { ...state, model: d }; return true;
      case 'valuation': {
        const rest = state.valuations.filter((v) => v.marketId !== d.marketId);
        state = { ...state, valuations: [d, ...rest].slice(0, 60) };
        return true;
      }
      case 'position': {
        const rest = state.positions.filter((p) => p.marketId !== d.marketId || p.agent !== d.agent);
        state = { ...state, positions: [d, ...rest] };
        return true;
      }
      case 'pnl': state = { ...state, pnlCurve: [...state.pnlCurve, d].slice(-CURVE_CAP) }; return true;
      case 'round': case 'round_open': state = { ...state, round: d }; return true;
      case 'settlement': state = { ...state, leaderboard: d.scores ?? state.leaderboard, round: null }; return true;
      case 'quip': state = { ...state, quips: prepend(state.quips, d, 20) }; return true;
      case 'health': state = { ...state, health: d }; return true;
      default: return false;   // unknown topic: ignored on purpose
    }
  };

  return {
    get: () => state,

    apply(msg: unknown, nowMs = Date.now()) {
      const m = msg as any;
      if (!m || typeof m.t !== 'string') return;
      switch (m.t) {
        case 'hello':
          if (!m.d) return;
          state = { ...state, runId: m.d.runId ?? null, mode: m.d.mode ?? null, lastEventMs: nowMs };
          break;
        case 'snapshot': {
          if (!m.d) return;
          const d = m.d;
          // Wholesale replacement. A reconnect must NOT merge onto what we had:
          // the server's view is the truth and ours may be arbitrarily old.
          state = {
            ...empty(),
            runId: d.runId ?? state.runId,
            mode: d.mode ?? state.mode,
            hydrated: true,
            connected: true,
            markets: d.markets ?? [],
            valuations: d.valuations ?? [],
            positions: d.positions ?? [],
            tape: (d.tape ?? []).slice(0, TAPE_CAP),
            pnlCurve: (d.pnlCurve ?? []).slice(-CURVE_CAP),
            round: d.round ?? null,
            leaderboard: d.leaderboard ?? [],
            health: d.health ?? null,
            quips: d.quips ?? [],
            model: d.model ?? null,
            // A snapshot carries no spot history; keep what we have collected.
            spot: state.spot,
            lastEventMs: nowMs,
          };
          break;
        }
        case 'ev': {
          // An event before hydration has nothing to fold onto and would
          // produce a page built from fragments.
          if (!state.hydrated) return;
          if (!foldEvent(m.d, nowMs)) return;
          state = { ...state, lastEventMs: nowMs };
          break;
        }
        case 'pong':
          state = { ...state, lastEventMs: nowMs };
          break;
        default:
          return;                        // unknown frame: ignored
      }
      notify();
    },

    setConnected(v: boolean, nowMs = Date.now()) {
      if (state.connected === v) return;
      // Note what we know, keep everything we knew.
      state = { ...state, connected: v, ...(v ? { lastEventMs: nowMs } : {}) };
      notify();
    },

    staleness(nowMs = Date.now()): Staleness {
      if (state.lastEventMs === null) return { stale: !state.hydrated, ageMs: 0 };
      const ageMs = Math.max(0, nowMs - state.lastEventMs);
      return { stale: ageMs > STALE_WARN_MS || !state.connected, ageMs };
    },

    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
