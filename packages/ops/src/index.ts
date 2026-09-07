// @arena/ops — docker, seeds, health, replay, drill, bench
// lane: OPS (ARCH §2, §5). Exports are added by this lane's cards.
import { LANES, type LaneId } from '@arena/shared';

export const LANE: LaneId = 'OPS';
export const PACKAGE = '@arena/ops' as const;
export const RESPONSIBILITY = 'docker, seeds, health, replay, drill, bench' as const;

/** Registered so every component appears in the health snapshot (PRD §8, T-063). */
export const COMPONENTS: readonly string[] = [];

// G4 write-path smoke (T-S2 B1) — shared by the runnable script and the live tests.
export { runRoundTrip, qtyAt, assertTxOk, DEC, ONE } from './liveSmoke.ts';
export type { RoundTripOptions, RoundTripResult } from './liveSmoke.ts';

if (!LANES.includes(LANE)) throw new Error(`@arena/ops declares unknown lane ${LANE}`);
