// The in-process event bus (ARCH §2 C2, IF §9).
//
// Two invariants drive every design choice here, and both come from the engine
// sitting on the other side of it (ARCH §3):
//
//   1. `publish` is SYNCHRONOUS. No promise, no microtask, no queue. The tick
//      path budget is single-digit milliseconds end to end; handing control to
//      the event loop mid-decision would put unrelated I/O ahead of an order.
//
//   2. `publish` NEVER throws. Subscribers include the journal, the WS
//      broadcaster and the UI fan-out — all of them non-essential to trading. A
//      broken subscriber must degrade into an `error` event, never into a
//      missed trade. That is why the dispatch loop try/catches per subscriber
//      instead of once around the whole loop.
//
// Upgradeable to Redis behind the same `Bus` interface (ARCH §1); nothing here
// leaks the fact that it is in-process.
import { BUS_TOPICS, type Bus, type BusEvent, type BusPayloads, type BusTopic } from '@arena/shared';

// Erased subscriber shape. The public `on` keeps the discriminated-union
// narrowing; storage has to be uniform, so the cast is contained to this file.
type AnyCb = (d: unknown) => void;

export class EventBus implements Bus {
  /** Copy-on-write subscriber arrays: dispatch iterates a frozen snapshot, so a
   *  subscriber that unsubscribes (or subscribes) mid-dispatch cannot shift the
   *  array underneath the loop and skip its neighbour. */
  private readonly subs = new Map<BusTopic, readonly AnyCb[]>();
  private readonly anySubs: ((e: BusEvent) => void)[] = [];
  private readonly counts = new Map<BusTopic, number>();
  /** Guards against an `error` subscriber that itself throws recursing forever. */
  private inErrorDispatch = false;

  publish(e: BusEvent): void {
    this.counts.set(e.t, (this.counts.get(e.t) ?? 0) + 1);

    const list = this.subs.get(e.t);
    if (list) {
      for (const cb of list) {
        try {
          cb(e.d);
        } catch (err) {
          this.reportSubscriberFailure(e.t, err);
        }
      }
    }

    if (this.anySubs.length > 0) {
      for (const cb of [...this.anySubs]) {
        try {
          cb(e);
        } catch (err) {
          this.reportSubscriberFailure(`${e.t}:onAny`, err);
        }
      }
    }
  }

  on<T extends BusTopic>(t: T, cb: (d: BusPayloads[T]) => void): () => void {
    const erased = cb as unknown as AnyCb;
    const next = [...(this.subs.get(t) ?? []), erased];
    this.subs.set(t, next);
    let live = true;
    return () => {
      if (!live) return;                       // idempotent unsubscribe
      live = false;
      const cur = this.subs.get(t);
      if (!cur) return;
      const i = cur.indexOf(erased);
      if (i >= 0) this.subs.set(t, [...cur.slice(0, i), ...cur.slice(i + 1)]);
    };
  }

  onAny(cb: (e: BusEvent) => void): () => void {
    this.anySubs.push(cb);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = this.anySubs.indexOf(cb);
      if (i >= 0) this.anySubs.splice(i, 1);
    };
  }

  /** Per-topic publish counts, for the health snapshot (PRD §8, T-063). */
  stats(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  subscriberCount(t: BusTopic): number {
    return this.subs.get(t)?.length ?? 0;
  }

  /** Total live subscriptions — a leak detector for long sessions (T-040). */
  totalSubscribers(): number {
    let n = this.anySubs.length;
    for (const t of BUS_TOPICS) n += this.subscriberCount(t);
    return n;
  }

  private reportSubscriberFailure(where: string, err: unknown): void {
    if (this.inErrorDispatch) return;          // an error handler failed; stop here
    this.inErrorDispatch = true;
    try {
      this.publish({
        t: 'error',
        d: { where: `bus.${where}`, msg: err instanceof Error ? err.message : String(err), tsMs: Date.now() },
      });
    } catch {
      // Nothing left to report to. Dropping is correct: trading continues.
    } finally {
      this.inErrorDispatch = false;
    }
  }
}
