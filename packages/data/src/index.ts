// @arena/data — ingester, bus, journal, store
// lane: DATA (ARCH §2, §5). Exports are added by this lane's cards.
import { LANES, type LaneId } from '@arena/shared';

export { EventBus } from './bus.ts';
export { Ingester, binanceSource, fixtureSource, gbmFixture, somniaFeedSource,
  type SpotSource, type IngesterOptions, type IngesterStats, type FixtureOptions } from './ingester.ts';
export { Store, type StoreOptions } from './store.ts';
export { Journal, replay, replayFile, type JournalOptions, type JournalStats, type ReplayOptions } from './journal.ts';

export const LANE: LaneId = 'DATA';
export const PACKAGE = '@arena/data' as const;
export const RESPONSIBILITY = 'ingester, bus, journal, store' as const;

/** Registered so every component appears in the health snapshot (PRD §8, T-063). */
export const COMPONENTS: readonly string[] = ['bus', 'journal', 'store', 'ingester'];

if (!LANES.includes(LANE)) throw new Error(`@arena/data declares unknown lane ${LANE}`);
