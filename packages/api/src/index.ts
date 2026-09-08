// @arena/api — WS broadcaster, REST, hunt, mirror, console
// lane: API (ARCH §2, §5). Exports are added by this lane's cards.
import { LANES, type LaneId } from '@arena/shared';

export { brierScore, rankRound, scorableForecasts, eligibleCount, UNINFORMED_BRIER,
  type ScoreInput } from './brier.ts';
export { Broadcaster, type Socket, type BroadcasterOptions, type BroadcasterStats } from './ws.ts';
export { MirrorService, type MirrorOptions, type MirrorResult, type MirrorStats } from './mirror.ts';
export { RestRouter, parseUrl, safeEqual, type RestRequest, type RestResponse, type RestOptions,
  type ConsoleActions } from './rest.ts';
export { HuntService, proRataWeights, type HuntOptions, type HuntStats } from './hunt.ts';
export { AuthService, type AuthOptions, type Session } from './auth.ts';
export { RoundDriver, type RoundDriverOptions } from './roundDriver.ts';
export { murphy, calibrationBuckets, userRecord, headToHead,
  type Murphy, type Bucket, type HeadToHead } from './calibration.ts';

export const LANE: LaneId = 'API';
export const PACKAGE = '@arena/api' as const;
export const RESPONSIBILITY = 'WS broadcaster, REST, hunt, mirror, console' as const;

/** Registered so every component appears in the health snapshot (PRD §8, T-063). */
export const COMPONENTS: readonly string[] = ['brier', 'hunt', 'ws', 'rest', 'mirror', 'console'];

if (!LANES.includes(LANE)) throw new Error(`@arena/api declares unknown lane ${LANE}`);
