// @arena/core — engine, pricer, signals, sizing, risk, echo, persona
// lane: CORE (ARCH §2, §5). Exports are added by this lane's cards.
import { LANES, type LaneId } from '@arena/shared';

export { Ewmv, SECONDS_PER_YEAR, type EwmvOptions } from './ewmv.ts';
export { f1ExpiryProb, f2ImpliedVol, f3TouchProb, priceMarket, decodeStrike, maxAttainableProb, branchPointVol,
  STRIKE_SCALE, type ImpliedVolResult, type PriceMarketArgs } from './pricer.ts';
export { SignalEngine, type SignalEngineOptions } from './signal.ts';
export { fullKelly, sizeOrder, type SizeOrderArgs, type SizeResult } from './sizer.ts';
export { EchoAgent, type EchoOptions, type EchoStats } from './echo.ts';
export { Persona, type PersonaOptions, type PersonaStats, type QuipTrigger, type QuipContext, type QuipGenerator } from './persona.ts';
export { Engine, type EngineOptions, type EngineStats, type OrderSubmitter } from './engine.ts';
export { RiskGuard, type RiskGuardOptions, type RiskSnapshot } from './risk.ts';

export const LANE: LaneId = 'CORE';
export const PACKAGE = '@arena/core' as const;
export const RESPONSIBILITY = 'engine, pricer, signals, sizing, risk, echo, persona' as const;

/** Registered so every component appears in the health snapshot (PRD §8, T-063). */
export const COMPONENTS: readonly string[] = ['ewmv', 'pricer', 'signal', 'sizer', 'risk', 'engine', 'echo', 'persona'];

if (!LANES.includes(LANE)) throw new Error(`@arena/core declares unknown lane ${LANE}`);
