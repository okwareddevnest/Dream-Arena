// @arena/venue — Venue impls, tx queue, reconciler, claim
// lane: VENUE (ARCH §2, §5). Exports are added by this lane's cards.
import { LANES, type LaneId } from '@arena/shared';

export { SimulatedVenue, mulberry32, type SimulatedVenueOptions, type SimMarketSpec } from './simulated.ts';
export { DreamDEXVenue, assertTxOk, decodeStrike, resolutionMode, STRIKE_SCALE,
  type SdkClient, type SdkMarketRow, type SdkOnchainMarket, type SdkOrderBook, type SdkTxResult,
  type DreamDEXVenueOptions } from './dreamdex.ts';
export { Reconciler, type LocalPositions, type ReconcilerOptions } from './reconciler.ts';
export { ClaimLoop, type ClaimLoopOptions, type ClaimStats } from './claim.ts';
export { SCENARIOS, ScenarioRunner, ScenarioSpotDriver, type ScenarioTarget, type ScenarioContext, type RunningScenario } from './scenarios.ts';
export { TxQueue, NonceManager, type NonceSource, type TxTask, type TxQueueOptions, type TxQueueStats } from './txqueue.ts';

export const LANE: LaneId = 'VENUE';
export const PACKAGE = '@arena/venue' as const;
export const RESPONSIBILITY = 'Venue impls, tx queue, reconciler, claim' as const;

/** Registered so every component appears in the health snapshot (PRD §8, T-063). */
export const COMPONENTS: readonly string[] = ['simulated-venue', 'txqueue', 'nonce-manager', 'scenarios', 'reconciler', 'claim-loop', 'dreamdex-venue'];

if (!LANES.includes(LANE)) throw new Error(`@arena/venue declares unknown lane ${LANE}`);
