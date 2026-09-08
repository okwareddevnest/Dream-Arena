// T-063 — health and the tick-lag alarm.
//
// Health here is not "the process is up" but "the system is fit to trade": a
// stalled feed is unhealthy even though nothing crashed, and a killed agent is
// unhealthy even though everything is responding. That distinction is what a
// director watches during a demo, so it is asserted rather than assumed.
import { describe, it, expect } from 'vitest';
import { VirtualClock, loadConfig, type HealthSnapshot } from '@arena/shared';
import { EventBus, Store } from '@arena/data';
import { RestRouter } from '@arena/api';

const cfg = loadConfig({ VENUE_MODE: 'SIM', SPOT_FEED: 'fixture' } as never);
const ALARM = 5_000;

const router = (health: () => HealthSnapshot) => new RestRouter({
  snapshot: () => ({}) as never,
  health,
  leaderboard: () => [],
  rounds: () => ({ round: null, history: [] }),
  agentProfile: () => ({}),
  mirror: () => ({ status: 200, body: {} }),
  forecast: () => ({ status: 202, body: {} }),
  console: { kill: () => {}, unkill: () => {}, setMode: () => {}, triggerScenario: () => {} },
  operatorToken: 't', webOrigin: '*', tickLagAlarmMs: ALARM,
});

const ask = async (h: () => HealthSnapshot) => {
  const res = await router(h).handle({ method: 'GET', path: '/api/health', query: {}, body: null, headers: {} });
  return res.body as Record<string, unknown>;
};

/** A real Store, driven by the bus, is the health source in production. */
const storeHealth = (advanceMs: number, opts: { kill?: boolean } = {}) => {
  const clock = new VirtualClock();
  const bus = new EventBus();
  const store = new Store({ runId: cfg.runId, mode: 'SIM' });
  store.subscribe(bus);
  bus.publish({ t: 'tick', d: { symbol: 'BTC', price: 100, tsMs: clock.now(), seq: 1, source: 'fixture' } as never });
  if (opts.kill) bus.publish({ t: 'kill', d: { on: true, by: 'test', tsMs: clock.now() } as never });
  clock.advance(advanceMs);
  return () => store.health(clock.now());
};

describe('tick-lag alarm', () => {
  it('is quiet while the feed is fresh', async () => {
    const b = await ask(storeHealth(500));
    expect(b.tickLagAlarm).toBe(false);
    expect(b.ok).toBe(true);
    expect(b.tickLagAlarmMs).toBe(ALARM);
  });

  it('fires once the feed goes quiet past the threshold', async () => {
    const b = await ask(storeHealth(ALARM + 1_000));
    expect(b.tickLagMs as number).toBeGreaterThan(ALARM);
    expect(b.tickLagAlarm, 'the alarm is raised').toBe(true);
    expect(b.ok, 'and a stalled feed is NOT fit to trade').toBe(false);
  });

  it('reports a killed agent as unhealthy even with a live feed', async () => {
    const b = await ask(storeHealth(200, { kill: true }));
    expect(b.killSwitch).toBe(true);
    expect(b.ok).toBe(false);
  });

  it('always carries what an operator needs to act', async () => {
    const b = await ask(storeHealth(200));
    for (const k of ['ok', 'tickLagMs', 'tickLagAlarmMs', 'tickLagAlarm', 'mode', 'runId', 'venue', 'components']) {
      expect(b, `health reports ${k}`).toHaveProperty(k);
    }
  });
});
