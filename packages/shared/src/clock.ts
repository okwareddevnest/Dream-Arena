// Time is injected everywhere. Two reasons, both load-bearing:
//   1. SIM must run an hour of market in milliseconds (T-031), which is only
//      possible if nothing calls Date.now() directly.
//   2. 40-TESTPLAN §6 rule 1 forbids tests from reading the wall clock, so
//      determinism is enforced by construction rather than by discipline.
import type { Ms } from './types.ts';

export type TimerHandle = number;

export interface Clock {
  now(): Ms;
  setTimeout(fn: () => void, delayMs: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
  setInterval(fn: () => void, everyMs: number): TimerHandle;
}

export class SystemClock implements Clock {
  now(): Ms { return Date.now(); }
  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    return setTimeout(fn, delayMs) as unknown as TimerHandle;
  }
  clearTimeout(h: TimerHandle): void {
    clearTimeout(h as unknown as NodeJS.Timeout);
    clearInterval(h as unknown as NodeJS.Timeout);
  }
  setInterval(fn: () => void, everyMs: number): TimerHandle {
    return setInterval(fn, everyMs) as unknown as TimerHandle;
  }
}

interface VTimer {
  h: TimerHandle; dueMs: Ms; everyMs: number | null; fn: () => void; seq: number;
}

/**
 * Deterministic clock for SIM and for every test.
 *
 * `advance` runs due timers *at their own due time* — `now()` inside a callback
 * reports the deadline, not the end of the advance — so a scenario script that
 * schedules a jump at t+30s and reads the clock sees 30s, which is what makes
 * scripted scenarios reproducible.
 *
 * A throwing timer is collected in `errors` instead of aborting the advance:
 * one bad subscriber must not stop the simulated world, the same rule the bus
 * follows (T-010).
 */
export class VirtualClock implements Clock {
  private t: Ms;
  private timers: VTimer[] = [];
  private nextHandle = 1;
  private seq = 0;
  readonly errors: unknown[] = [];

  constructor(startMs: Ms = 0) { this.t = startMs; }

  now(): Ms { return this.t; }

  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const h = this.nextHandle++;
    this.timers.push({ h, dueMs: this.t + Math.max(0, delayMs), everyMs: null, fn, seq: this.seq++ });
    return h;
  }

  setInterval(fn: () => void, everyMs: number): TimerHandle {
    const every = Math.max(1, everyMs);
    const h = this.nextHandle++;
    this.timers.push({ h, dueMs: this.t + every, everyMs: every, fn, seq: this.seq++ });
    return h;
  }

  clearTimeout(h: TimerHandle): void {
    const i = this.timers.findIndex((x) => x.h === h);
    if (i >= 0) this.timers.splice(i, 1);
  }

  /** Move time forward by `deltaMs`, firing every timer that comes due, in order. */
  advance(deltaMs: number): void {
    if (deltaMs < 0) throw new RangeError(`VirtualClock.advance: time cannot go backwards (${deltaMs})`);
    const target = this.t + deltaMs;
    // Guard against a timer that reschedules itself at zero delay forever.
    let iterations = 0;
    const LIMIT = 5_000_000;
    for (;;) {
      // Earliest due timer at or before target; ties broken by insertion order.
      let next: VTimer | undefined;
      for (const x of this.timers) {
        if (x.dueMs > target) continue;
        if (!next || x.dueMs < next.dueMs || (x.dueMs === next.dueMs && x.seq < next.seq)) next = x;
      }
      if (!next) break;
      if (++iterations > LIMIT) throw new Error('VirtualClock.advance: timer storm — a timer is rescheduling without progress');
      this.t = next.dueMs;
      if (next.everyMs === null) {
        this.timers.splice(this.timers.indexOf(next), 1);
      } else {
        next.dueMs = next.dueMs + next.everyMs;
        next.seq = this.seq++;
      }
      try { next.fn(); } catch (e) { this.errors.push(e); }
    }
    this.t = target;
  }

  /** Advance to an absolute instant. */
  advanceTo(ms: Ms): void { this.advance(ms - this.t); }

  get pending(): number { return this.timers.length; }
}
