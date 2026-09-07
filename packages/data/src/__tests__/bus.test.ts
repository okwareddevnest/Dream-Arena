// T-010 — the bus is on the engine's critical path (ARCH §3). Two properties are
// non-negotiable: publish is SYNCHRONOUS (an await here would blow the latency
// budget) and it NEVER throws (one bad subscriber must not stop trading).
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../bus.ts';
import { BUS_TOPICS, type BusEvent, type Tick, type Fill } from '@arena/shared';

const tick = (seq = 1): Tick => ({ symbol: 'BTC', price: 100, tsMs: seq, seq, source: 'fixture' });
const fill = (): Fill => ({ fillId: 'f1', clientOrderId: 'c1', venueOrderId: null, marketId: 'm1',
  agent: 'MIRA', side: 'YES', sizeContracts: 1, price: 0.5, feeUsd: 0, txHash: null,
  explorerUrl: null, tsMs: 1 });

describe('T-010 EventBus delivery', () => {
  it('delivers only the subscribed topic, typed', () => {
    const bus = new EventBus();
    const ticks: Tick[] = [];
    bus.on('tick', (d) => { ticks.push(d); });
    bus.publish({ t: 'tick', d: tick(1) });
    bus.publish({ t: 'fill', d: fill() });
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.seq).toBe(1);
  });

  it('publish is synchronous — the subscriber has run before publish returns', () => {
    const bus = new EventBus();
    let seen = 0;
    bus.on('tick', () => { seen = 1; });
    bus.publish({ t: 'tick', d: tick() });
    expect(seen).toBe(1);          // no await, no microtask
  });

  it('delivers to every subscriber of a topic, in subscription order', () => {
    const bus = new EventBus();
    const order: number[] = [];
    for (const i of [0, 1, 2]) bus.on('tick', () => order.push(i));
    bus.publish({ t: 'tick', d: tick() });
    expect(order).toEqual([0, 1, 2]);
  });

  it('a throwing subscriber does not prevent later subscribers from receiving', () => {
    const bus = new EventBus();
    const after = vi.fn();
    bus.on('tick', () => { throw new Error('boom'); });
    bus.on('tick', after);
    bus.publish({ t: 'tick', d: tick() });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('publish never throws when a subscriber throws', () => {
    const bus = new EventBus();
    bus.on('tick', () => { throw new Error('boom'); });
    expect(() => bus.publish({ t: 'tick', d: tick() })).not.toThrow();
  });

  it('surfaces subscriber failures as error events rather than swallowing them', () => {
    const bus = new EventBus();
    const errs: { where: string; msg: string }[] = [];
    bus.on('error', (d) => { errs.push(d); });
    bus.on('tick', () => { throw new Error('boom'); });
    bus.publish({ t: 'tick', d: tick() });
    expect(errs).toHaveLength(1);
    expect(errs[0]!.msg).toContain('boom');
    expect(errs[0]!.where).toContain('tick');
  });

  it('a throwing error-subscriber cannot cause infinite recursion', () => {
    const bus = new EventBus();
    bus.on('error', () => { throw new Error('error handler also fails'); });
    bus.on('tick', () => { throw new Error('boom'); });
    expect(() => bus.publish({ t: 'tick', d: tick() })).not.toThrow();
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('tick', fn);
    bus.publish({ t: 'tick', d: tick() });
    off();
    bus.publish({ t: 'tick', d: tick(2) });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing twice is harmless', () => {
    const bus = new EventBus();
    const off = bus.on('tick', () => {});
    off();
    expect(() => off()).not.toThrow();
  });

  it('unsubscribing during dispatch does not skip the next subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const offA = bus.on('tick', () => { seen.push('a'); offA(); });
    bus.on('tick', () => { seen.push('b'); });
    bus.publish({ t: 'tick', d: tick() });
    expect(seen).toEqual(['a', 'b']);
    bus.publish({ t: 'tick', d: tick(2) });
    expect(seen).toEqual(['a', 'b', 'b']);
  });

  it('onAny sees every event in publish order', () => {
    const bus = new EventBus();
    const seen: BusEvent['t'][] = [];
    bus.onAny((e) => { seen.push(e.t); });
    bus.publish({ t: 'tick', d: tick() });
    bus.publish({ t: 'fill', d: fill() });
    bus.publish({ t: 'kill', d: { on: true, by: 'test', tsMs: 1 } });
    expect(seen).toEqual(['tick', 'fill', 'kill']);
  });

  it('accepts a subscriber for every topic in BUS_TOPICS', () => {
    const bus = new EventBus();
    for (const t of BUS_TOPICS) expect(typeof bus.on(t, () => {})).toBe('function');
  });

  it('publishing a topic with no subscribers is a no-op, not an error', () => {
    const bus = new EventBus();
    expect(() => bus.publish({ t: 'tick', d: tick() })).not.toThrow();
  });

  it('counts published events per topic for the health snapshot', () => {
    const bus = new EventBus();
    bus.publish({ t: 'tick', d: tick() });
    bus.publish({ t: 'tick', d: tick(2) });
    bus.publish({ t: 'fill', d: fill() });
    expect(bus.stats().tick).toBe(2);
    expect(bus.stats().fill).toBe(1);
  });
});

describe('T-010 EventBus performance (ARCH §4: bus hop < 5 ms)', () => {
  it('publishes 100 000 events to 3 subscribers well inside budget', () => {
    const bus = new EventBus();
    let n = 0;
    for (let i = 0; i < 3; i++) bus.on('tick', () => { n++; });
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) bus.publish({ t: 'tick', d: tick(i) });
    const el = performance.now() - t0;
    expect(n).toBe(300_000);
    expect(el / 100_000).toBeLessThan(0.05);   // per-publish, far under the 5 ms hop
  });

  it('does not leak subscribers across 10 000 subscribe/unsubscribe cycles', () => {
    const bus = new EventBus();
    for (let i = 0; i < 10_000; i++) bus.on('tick', () => {})();
    expect(bus.subscriberCount('tick')).toBe(0);
  });
});
