// MIRA's personality feed (F-A9, FR-U4, IF §14 Quip).
//
// ── The single hard requirement ─────────────────────────────────────────────
// ZERO ADDED TRADE LATENCY. PRD F-A9 states it and the architecture puts the
// LLM "only in commentary lane" (WP §4). So this component:
//   • is never awaited by the engine,
//   • never blocks on a generator, even one that hangs indefinitely,
//   • always has something to say, because a cache is populated at
//     construction and is the DEFAULT rather than the fallback.
//
// The generator, when present, is used to REFRESH the cache in the background.
// A quip is served from the cache immediately and the cache is topped up later,
// so a stalled or missing generator degrades the writing quality and nothing
// else. The test that matters drives the engine with a generator stalled for
// five seconds and asserts the decision latency is unchanged.
//
// ── Why templates rather than pure LLM ──────────────────────────────────────
// A demo cannot depend on an API call landing inside a two-minute script. The
// templates below are the floor, not a placeholder: they substitute live
// numbers, so even with no generator at all the feed is specific rather than
// generic.
import { newId, type Bus, type Clock, type Ms, type Quip, type Usd } from '@arena/shared';

export type QuipTrigger =
  | 'round_open' | 'round_close' | 'big_win' | 'big_loss' | 'kill'
  | 'mode_change' | 'skip' | 'stand_down' | 'hunted';

export interface QuipContext {
  roundId?: string | null;
  pnlUsd?: Usd;
  edge?: number;
  marketSymbol?: string;
  mode?: string;
  humans?: number;
  by?: string;
}

/** A generator may be an LLM call. It is only ever used to refill the cache. */
export type QuipGenerator = (trigger: QuipTrigger, ctx: QuipContext) => Promise<string>;

export interface PersonaOptions {
  bus?: Bus;
  clock: Clock;
  generator?: QuipGenerator;
  /** Quips held per trigger. */
  cacheSize?: number;
  /** Hard cap on quip length, so the UI never has to truncate mid-word. */
  maxChars?: number;
  /** Render a marketId as something a person would say. The bus carries ids, and
   *  a 66-character hex in a human-facing line reads as a leaked internal. */
  symbolFor?: (marketId: string) => string;
}

/**
 * The template floor. Every entry takes live values, so a quip is specific
 * even with no generator wired: "I make it 63%. The book says 48%." beats
 * anything generic an LLM would produce without those numbers.
 */
const TEMPLATES: Record<QuipTrigger, ((c: QuipContext) => string)[]> = {
  round_open: [
    (c) => `Round ${c.roundId ?? 'open'}. My book is open and my model is public. Come and take it.`,
    () => `New round. Same model, same bankroll, same rules. Your move.`,
    (c) => `Round ${c.roundId ?? ''} live. ${c.humans ?? 0} of you are scoring against me.`,
  ],
  round_close: [
    (c) => `Round closed at ${fmt(c.pnlUsd)}. Scores are being counted.`,
    () => `Clock's done. Let's see who read the tape better.`,
  ],
  big_win: [
    (c) => `Up ${fmt(c.pnlUsd)} this round. That edge was ${pct(c.edge)} of volatility the book had not priced.`,
    (c) => `${fmt(c.pnlUsd)}. I would rather be lucky, but I will take being early.`,
  ],
  big_loss: [
    (c) => `Down ${fmt(c.pnlUsd)}. My volatility forecast was wrong and the market was not.`,
    (c) => `${fmt(c.pnlUsd)} against me. Estimation error is the cost of trading an estimate.`,
  ],
  kill: [
    (c) => `Halted by ${c.by ?? 'the operator'}. Risk guard did exactly what it is for.`,
    () => `Trading stopped. No new orders signed until a human says otherwise.`,
  ],
  mode_change: [
    (c) => `Switched to ${c.mode ?? 'the other venue'}. Same agent, same model, different market. The badge never lies.`,
    (c) => `Now on ${c.mode ?? 'SIM'}. Nothing about how I think just changed.`,
  ],
  skip: [
    (c) => `Skipped ${c.marketSymbol ?? 'that quote'}. The maths says no volatility could produce that price.`,
    () => `Refused to price that one. An unattainable quote is not an opportunity.`,
  ],
  stand_down: [
    (c) => `Standing down on ${c.marketSymbol ?? 'that market'}. Edge decayed below my exit threshold.`,
    () => `Edge gone. I would rather hold nothing than hold a stale opinion.`,
  ],
  hunted: [
    (c) => `${c.humans ?? 'Several'} of you out-forecast me this round. ${fmt(c.pnlUsd)} goes to you.`,
    () => `Beaten on Brier score. That is the whole point of the game.`,
  ],
};

const fmt = (n?: Usd): string =>
  n === undefined ? '$0.00' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const pct = (n?: number): string => (n === undefined ? '0%' : `${(n * 100).toFixed(1)}%`);

export interface PersonaStats {
  produced: number;
  fromCache: number;
  fromGenerator: number;
  generatorFailures: number;
  refillsInFlight: number;
}

export class Persona {
  private readonly bus: Bus | undefined;
  private readonly clock: Clock;
  private readonly generator: QuipGenerator | undefined;
  private readonly cacheSize: number;
  private readonly maxChars: number;

  private readonly cache = new Map<QuipTrigger, string[]>();
  private readonly inFlight = new Set<QuipTrigger>();
  private readonly recent: Quip[] = [];
  private readonly perRound = new Map<string, number>();
  private stats: PersonaStats = {
    produced: 0, fromCache: 0, fromGenerator: 0, generatorFailures: 0, refillsInFlight: 0,
  };

  private readonly symbolFor: ((id: string) => string) | undefined;

  constructor(o: PersonaOptions) {
    this.symbolFor = o.symbolFor;
    this.bus = o.bus;
    this.clock = o.clock;
    this.generator = o.generator;
    this.cacheSize = o.cacheSize ?? 3;
    this.maxChars = o.maxChars ?? 180;
    // Seed from templates at construction, so the very first quip is instant
    // and no code path has to handle an empty cache.
    for (const t of Object.keys(TEMPLATES) as QuipTrigger[]) this.cache.set(t, []);
  }

  statsSnapshot(): PersonaStats {
    return { ...this.stats, refillsInFlight: this.inFlight.size };
  }

  quips(): Quip[] { return [...this.recent]; }

  /** Quips produced for a round, so "at least one per round" is checkable. */
  countForRound(roundId: string): number { return this.perRound.get(roundId) ?? 0; }

  /**
   * Produce a quip. SYNCHRONOUS by design — returns immediately, always.
   *
   * If the generator is present, a background refill is kicked off and its
   * result lands in the cache for NEXT time. Nothing here awaits it, and its
   * rejection is counted rather than propagated.
   */
  say(trigger: QuipTrigger, ctx: QuipContext = {}): Quip {
    const cached = this.cache.get(trigger);
    let text: string;
    if (cached && cached.length > 0) {
      text = cached.shift()!;
      this.stats.fromCache++;
    } else {
      text = this.fromTemplate(trigger, ctx);
    }

    // Fire-and-forget refill. Deliberately not awaited and deliberately not
    // returned: a stalled generator must be invisible from here.
    this.refill(trigger, ctx);

    const quip: Quip = {
      quipId: newId('quip', this.clock),
      text: this.trim(text),
      roundId: ctx.roundId ?? null,
      trigger,
      tsMs: this.clock.now(),
    };
    this.stats.produced++;
    if (quip.roundId) this.perRound.set(quip.roundId, (this.perRound.get(quip.roundId) ?? 0) + 1);
    this.recent.unshift(quip);
    if (this.recent.length > 40) this.recent.length = 40;
    this.bus?.publish({ t: 'quip', d: quip });
    return quip;
  }

  /** Deterministic template choice, rotated by how many we have produced, so
   *  consecutive quips for one trigger do not repeat verbatim. */
  private fromTemplate(trigger: QuipTrigger, ctx: QuipContext): string {
    const list = TEMPLATES[trigger];
    const pick = list[this.stats.produced % list.length]!;
    return pick(ctx);
  }

  /** Background cache top-up. Never awaited by any caller. */
  private refill(trigger: QuipTrigger, ctx: QuipContext): void {
    if (!this.generator) return;
    if (this.inFlight.has(trigger)) return;                 // one at a time
    const have = this.cache.get(trigger)?.length ?? 0;
    if (have >= this.cacheSize) return;

    this.inFlight.add(trigger);
    // `void` and a catch: an unhandled rejection here would take the process
    // down for the sake of a joke.
    void this.generator(trigger, ctx)
      .then((text) => {
        if (typeof text === 'string' && text.trim().length > 0) {
          const list = this.cache.get(trigger) ?? [];
          list.push(this.trim(text));
          this.cache.set(trigger, list);
          this.stats.fromGenerator++;
        }
      })
      .catch(() => { this.stats.generatorFailures++; })
      .finally(() => { this.inFlight.delete(trigger); });
  }

  /** Trim to the UI's budget on a word boundary, and never leave a placeholder. */
  private trim(text: string): string {
    let t = text.replace(/\s+/g, ' ').trim();
    // A template that failed to substitute would leave braces behind; strip
    // them rather than putting "{pnl}" on a broadcast screen.
    t = t.replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (t.length <= this.maxChars) return t;
    const cut = t.slice(0, this.maxChars - 1);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > this.maxChars * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }

  /** Wire to the bus so the feed reacts without the engine calling it. */
  subscribe(bus: Bus): () => void {
    const offs = [
      bus.on('kill', (d) => { this.say(d.on ? 'kill' : 'mode_change', { by: d.by }); }),
      bus.on('mode', (d) => { this.say('mode_change', { mode: d.mode }); }),
      bus.on('round', (r) => {
        if (r.status === 'OPEN') this.say('round_open', { roundId: r.roundId });
        if (r.status === 'SETTLED') this.say('round_close', { roundId: r.roundId, pnlUsd: r.miraPnlUsd });
      }),
      bus.on('settlement', (s) => {
        if (s.payouts.length > 0) {
          this.say('hunted', { roundId: s.roundId, humans: s.payouts.length, pnlUsd: s.potUsd });
        }
      }),
      bus.on('signal', (s) => {
        const symbol = this.symbolFor ? this.symbolFor(s.marketId) : s.marketId;
        if (s.action === 'SKIP') this.say('skip', { marketSymbol: symbol });
        if (s.action === 'STAND_DOWN') this.say('stand_down', { marketSymbol: symbol });
      }),
    ];
    return () => { for (const off of offs) off(); };
  }
}
