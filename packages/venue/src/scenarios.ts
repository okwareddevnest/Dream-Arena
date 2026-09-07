// Scripted market scenarios (FR-V2, PRD §10 R3, IF §14).
//
// Two jobs, and the second is the one that saves the demo:
//
//   1. Make the simulated market do something specific and repeatable, so the
//      agent's behaviour under a vol spike or a flat drift is a test rather
//      than an anecdote.
//   2. Give the director a button. T-S4 measured ZERO trades on every live
//      testnet market, so "the tape is empty" is the expected state, not the
//      unlucky one. The runbook's answer is a scenario trigger (50-DEMO-RUNBOOK
//      §3 step 3), and it has to work mid-run without restarting the venue.
//
// Steps run on the VIRTUAL clock, so a 5-minute scenario executes in
// microseconds in a test and in real cadence during a demo — the same script
// either way.
import {
  SCENARIO_NAMES,
  type Bus, type Ms, type ScenarioName, type ScenarioScript, type ScenarioStep,
  type VirtualClock,
} from '@arena/shared';

/** What a scenario is allowed to do to the world. Implemented by SimulatedVenue
 *  and by the fault harness (T-062); nothing here touches a venue directly, so
 *  a scenario can drive a stub just as well. */
export interface ScenarioTarget {
  setSpot(asset: string, price: number): void;
  setFairProb(marketId: string, p: number): void;
  setSpread(halfSpread: number): void;
  setDepth(n: number | null): void;
  freezeQuotes(untilMs: Ms): void;
  /** Fault injection (T-062). Optional: a plain venue need not support these. */
  dropNextTx?(): void;
  clashNonce?(): void;
  setLatency?(ms: number): void;
}

export interface ScenarioContext {
  clock: VirtualClock;
  target: ScenarioTarget;
  /** Markets the scenario acts on. */
  marketIds: string[];
  /** Asset whose spot the scenario moves. */
  asset: string;
  /** Baseline spot, for jump/drift steps expressed as multipliers. */
  baseSpot: number;
  bus?: Bus;
}

// ── The library ─────────────────────────────────────────────────────────────
// `value` is interpreted per op, documented on each step. Scripts are data so
// the console can list them (IF §13 POST /api/console/scenario) without
// knowing what any of them do.

const s = (atMs: Ms, op: ScenarioStep['op'], value: number): ScenarioStep => ({ atMs, op, value });

export const SCENARIOS: Record<ScenarioName, ScenarioScript> = {
  // Realized volatility rises sharply, then settles. The agent should enter
  // once and stand down once — never oscillate (GWT-2).
  VOL_SPIKE: {
    name: 'VOL_SPIKE',
    durationMs: 60_000,
    steps: [
      s(0, 'setVol', 0.4),
      s(2_000, 'setVol', 3.0),          // >= 3x baseline, asserted by the test
      s(20_000, 'setVol', 2.4),
      s(40_000, 'setVol', 0.9),
      s(60_000, 'setVol', 0.4),
    ],
  },

  // One discontinuous jump, as a headline would produce. `value` is a
  // multiplier on the baseline spot.
  NEWS_SHOCK: {
    name: 'NEWS_SHOCK',
    durationMs: 30_000,
    steps: [
      s(0, 'setVol', 0.5),
      s(5_000, 'jumpSpot', 1.035),      // +3.5% in one step
      s(5_001, 'setVol', 2.0),          // vol follows the gap
      s(25_000, 'setVol', 0.7),
    ],
  },

  // A boring market: volatility below the entry threshold. MIRA should stand
  // aside entirely and ECHO should be the only thing on the tape (PRD §10 R3).
  FLAT_DRIFT: {
    name: 'FLAT_DRIFT',
    durationMs: 60_000,
    steps: [
      s(0, 'setVol', 0.02),
      s(0, 'setSpread', 0.004),
      s(30_000, 'setVol', 0.015),
    ],
  },

  // Quotes stop advancing, so the pricer sees their AGE grow and skips
  // (GWT-3 via STALE_QUOTE rather than via a flag).
  STALE_QUOTE: {
    name: 'STALE_QUOTE',
    durationMs: 30_000,
    steps: [
      s(0, 'setVol', 0.6),
      s(1_000, 'freezeQuote', 30_000),  // value = how long to stay frozen
    ],
  },

  // Depth collapses. Sizing must clamp to what is actually available rather
  // than to what Kelly asked for.
  THIN_BOOK: {
    name: 'THIN_BOOK',
    durationMs: 30_000,
    steps: [
      s(0, 'setVol', 0.6),
      s(1_000, 'setDepth', 1),
      s(15_000, 'setDepth', 0),         // no counterparty at all
      s(25_000, 'setDepth', 50),
    ],
  },

  // A transaction is accepted and then never lands. The reconciler must adopt
  // the chain and heal PnL within 10 s (GWT-6).
  DROPPED_TX: {
    name: 'DROPPED_TX',
    durationMs: 30_000,
    steps: [
      s(0, 'setVol', 0.8),
      s(2_000, 'dropNextTx', 1),
    ],
  },

  // The local nonce counter disagrees with the chain. The queue must resync
  // and retry exactly once, producing one position effect (T-033).
  NONCE_CLASH: {
    name: 'NONCE_CLASH',
    durationMs: 30_000,
    steps: [
      s(0, 'setVol', 0.8),
      s(2_000, 'clashNonce', 1),
    ],
  },
};

export interface RunningScenario {
  name: ScenarioName;
  startedMs: Ms;
  endsMs: Ms;
  /** Steps still to fire. */
  remaining: number;
  cancel(): void;
}

/**
 * Runs scenario scripts against a target.
 *
 * Mid-run triggering is the requirement that shapes this: the director presses
 * a button while the venue is live, so a scenario must be startable without
 * reconstructing anything, and starting a second one must supersede the first
 * rather than interleave with it (two scripts both writing `setVol` would
 * fight, and whichever fired last would win at random).
 */
export class ScenarioRunner {
  private running: RunningScenario | null = null;
  private timers: number[] = [];
  private readonly history: { name: ScenarioName; atMs: Ms }[] = [];

  private readonly ctx: ScenarioContext;
  // Explicit field — see the note in txqueue.ts: strip-only mode rejects
  // parameter properties.
  constructor(ctx: ScenarioContext) { this.ctx = ctx; }

  get active(): RunningScenario | null { return this.running; }
  get log(): readonly { name: ScenarioName; atMs: Ms }[] { return this.history; }

  /** Every scenario the console may offer (IF §14). */
  static names(): readonly ScenarioName[] { return SCENARIO_NAMES; }

  /**
   * Start a scenario. Supersedes any scenario already running.
   * Returns a handle; the bus (if wired) gets a `scenario` event so the badge
   * and the journal can show what the operator did.
   */
  start(name: ScenarioName): RunningScenario {
    const script = SCENARIOS[name];
    if (!script) throw new Error(`ScenarioRunner: unknown scenario ${name}`);
    this.cancel();

    const { clock } = this.ctx;
    const startedMs = clock.now();
    let remaining = script.steps.length;

    for (const step of script.steps) {
      const h = clock.setTimeout(() => {
        remaining--;
        this.apply(step);
      }, step.atMs);
      this.timers.push(h);
    }

    const handle: RunningScenario = {
      name,
      startedMs,
      endsMs: startedMs + script.durationMs,
      get remaining() { return remaining; },
      cancel: () => this.cancel(),
    };
    this.running = handle;
    this.history.push({ name, atMs: startedMs });
    this.ctx.bus?.publish({ t: 'scenario', d: { name, tsMs: startedMs } });
    return handle;
  }

  cancel(): void {
    for (const h of this.timers) this.ctx.clock.clearTimeout(h);
    this.timers = [];
    this.running = null;
  }

  /** Apply one step. Unknown ops are ignored rather than thrown: a script is
   *  data, and a venue that cannot inject faults should skip them, not crash. */
  private apply(step: ScenarioStep): void {
    const { target, marketIds, asset, baseSpot, clock } = this.ctx;
    switch (step.op) {
      case 'setVol':
        // Volatility is expressed through the book: a wider spread and a fair
        // price that moves further per tick. The venue has no vol parameter of
        // its own — vol is what the SPOT SERIES does, so the driver moves spot.
        this.volTarget = step.value;
        target.setSpread(Math.max(0.002, step.value * 0.03));
        break;
      case 'setSpread':
        target.setSpread(step.value);
        break;
      case 'jumpSpot':
        target.setSpot(asset, baseSpot * step.value);
        break;
      case 'setDrift':
        this.driftPerTick = step.value;
        break;
      case 'setDepth':
        target.setDepth(step.value);
        break;
      case 'setLatency':
        target.setLatency?.(step.value);
        break;
      case 'freezeQuote':
        target.freezeQuotes(clock.now() + step.value);
        break;
      case 'dropNextTx':
        target.dropNextTx?.();
        break;
      case 'clashNonce':
        target.clashNonce?.();
        break;
      default:
        break;
    }
    // Nudge every market's fair probability so the book reflects the new regime.
    if (step.op === 'setVol' || step.op === 'jumpSpot') {
      for (const id of marketIds) {
        const jitter = (this.volTarget ?? 0.4) * 0.08;
        const p = 0.5 + (step.op === 'jumpSpot' ? (step.value - 1) * 6 : 0) + jitter * 0.1;
        target.setFairProb(id, Math.min(0.97, Math.max(0.03, p)));
      }
    }
  }

  /** Current volatility target, for the spot driver below. */
  private volTarget: number | null = null;
  private driftPerTick = 0;

  /** The volatility the running scenario is asking the spot series to realize. */
  get currentVol(): number { return this.volTarget ?? 0.4; }
  get currentDrift(): number { return this.driftPerTick; }
}

/**
 * Generates a spot series whose REALIZED volatility matches whatever the
 * running scenario asks for.
 *
 * Kept separate from the runner because the venue does not have a volatility
 * dial: volatility is a property of the price path, so something has to
 * actually walk the price. This is that thing, and it is what makes
 * "VOL_SPIKE raises realized vol by >= 3x" an assertion rather than a hope.
 */
export class ScenarioSpotDriver {
  private price: number;
  private seq = 0;
  private rnd: () => number;

  private readonly runner: ScenarioRunner;
  private readonly ctx: ScenarioContext;

  // Explicit fields — see the note in txqueue.ts: Node's strip-only TypeScript
  // mode rejects parameter properties, and the agent runs straight off source.
  constructor(
    runner: ScenarioRunner,
    ctx: ScenarioContext,
    seed = 1,
  ) {
    this.runner = runner;
    this.ctx = ctx;
    this.price = ctx.baseSpot;
    let a = seed >>> 0;
    this.rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  get spot(): number { return this.price; }

  /**
   * Advance the price by one tick of `dtMs`.
   *
   * Uses a Box-Muller normal so the per-tick log return has standard deviation
   * sigma * sqrt(dt) — which is what makes the realized volatility of the
   * generated series equal the volatility the scenario asked for, rather than
   * merely "bigger".
   */
  tick(dtMs: number): number {
    const sigma = this.runner.currentVol;
    const dtYears = dtMs / (365 * 24 * 60 * 60 * 1000);
    const u1 = Math.max(1e-12, this.rnd());
    const u2 = this.rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const drift = this.runner.currentDrift * dtYears;
    this.price = this.price * Math.exp(drift + sigma * Math.sqrt(dtYears) * z);
    this.seq++;
    this.ctx.target.setSpot(this.ctx.asset, this.price);
    return this.price;
  }

  /** Realized annualized volatility of a series of prices, for assertions. */
  static realizedVol(prices: number[], dtMs: number): number {
    if (prices.length < 3) return 0;
    const rs: number[] = [];
    for (let i = 1; i < prices.length; i++) rs.push(Math.log(prices[i]! / prices[i - 1]!));
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const varr = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rs.length - 1);
    const perYear = (365 * 24 * 60 * 60 * 1000) / dtMs;
    return Math.sqrt(varr * perYear);
  }
}
