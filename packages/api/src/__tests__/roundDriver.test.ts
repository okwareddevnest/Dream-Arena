// The round lifecycle.
//
// Every piece of the multi-user layer was built and tested, and none of it ran,
// because nothing ever called hunt.open(). No round meant no forecast was ever
// scored, the leaderboard was permanently empty, and every user scorecard
// returned "untested". These tests exist so that cannot silently recur.
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock } from '@arena/shared';
import { EventBus } from '@arena/data';
import { HuntService } from '../hunt.ts';
import { RoundDriver } from '../roundDriver.ts';

const market = (id: string, expiryMs: number, status = 'Trading') =>
  ({ id, symbol: `S-${id}`, asset: 'BTC', expiryMs, status }) as never;

const mk = (over: Partial<ConstructorParameters<typeof RoundDriver>[0]> = {}) => {
  const clock = new VirtualClock();
  const bus = new EventBus();
  const hunt = new HuntService({ clock, bus, roundDurationMs: 60_000 });
  const driver = new RoundDriver({
    hunt, clock,
    markets: () => [market('m1', clock.now() + 300_000)],
    outcomes: () => [],
    forecasts: () => [],
    miraPnlUsd: () => 0,
    ...over,
  });
  return { clock, bus, hunt, driver };
};

describe('RoundDriver', () => {
  it('opens a round when there is something to forecast', async () => {
    const { hunt, driver } = mk();
    expect(hunt.round).toBeNull();
    await driver.tick();
    expect(hunt.round, 'a round is open').not.toBeNull();
    expect(hunt.round!.marketIds).toContain('m1');
  });

  it('does NOT open a round when there is nothing to forecast', async () => {
    const { hunt, driver } = mk({ markets: () => [] });
    await driver.tick();
    expect(hunt.round, 'no markets, no round').toBeNull();
  });

  it('leaves an open round alone until it is due', async () => {
    const { hunt, driver, clock } = mk();
    await driver.tick();
    const first = hunt.round!.roundId;
    clock.advance(10_000);
    await driver.tick();
    expect(hunt.round!.roundId, 'the same round continues').toBe(first);
  });

  it('closes and settles once the clock passes the close time', async () => {
    const settled: unknown[] = [];
    const { hunt, driver, clock } = mk({
      forecasts: () => [
        { forecastId: 'f1', roundId: '', marketId: 'm1', userAddr: '0xa', p: 0.9, tsMs: 1 },
        { forecastId: 'f2', roundId: '', marketId: 'm1', userAddr: '0xb', p: 0.2, tsMs: 1 },
      ],
      outcomes: () => [{ marketId: 'm1', roundId: '', resolved: true, outcome: 0, resolvedTsMs: 2 }],
      miraPnlUsd: () => 20,
      onSettle: (s) => { settled.push(s); },
    });
    await driver.tick();
    clock.advance(61_000);
    await driver.tick();
    expect(settled.length, 'the round settled').toBe(1);
  });

  it('opens a fresh round after settling, so the game continues', async () => {
    const { hunt, driver, clock } = mk({
      outcomes: () => [{ marketId: 'm1', roundId: '', resolved: true, outcome: 0, resolvedTsMs: 2 }],
    });
    await driver.tick();
    const first = hunt.round!.roundId;
    clock.advance(61_000);
    await driver.tick();          // closes + settles
    await driver.tick();          // opens the next
    expect(hunt.round, 'a new round is open').not.toBeNull();
    expect(hunt.round!.roundId).not.toBe(first);
  });

  it('never throws into the caller — a settlement failure must not stop trading', async () => {
    const { driver, clock } = mk({
      outcomes: () => { throw new Error('chain unreachable'); },
    });
    await driver.tick();
    clock.advance(61_000);
    await expect(driver.tick()).resolves.toBeUndefined();
  });

  it('scores against REAL outcomes only — an unresolved market scores nobody', async () => {
    const onSettle = vi.fn();
    const { driver, clock } = mk({
      forecasts: () => [{ forecastId: 'f1', roundId: '', marketId: 'm1', userAddr: '0xa', p: 0.9, tsMs: 1 }],
      outcomes: () => [{ marketId: 'm1', roundId: '', resolved: false, outcome: null, resolvedTsMs: null }],
      onSettle,
    });
    await driver.tick();
    clock.advance(61_000);
    await driver.tick();
    const s = onSettle.mock.calls[0]?.[0] as { payouts: unknown[] } | undefined;
    if (s) expect(s.payouts, 'nobody is paid on an unresolved market').toHaveLength(0);
  });
});
