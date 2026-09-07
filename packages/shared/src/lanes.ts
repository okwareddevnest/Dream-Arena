// Lane identity — the ownership boundary from ARCH §2/§5 and prompt §5.
// Every component registers under a lane so health (PRD §8) can report by owner.
export const LANES = ['CORE', 'VENUE', 'DATA', 'API', 'FRONT', 'OPS'] as const;
export type LaneId = (typeof LANES)[number];

export const LANE_OWNS: Record<LaneId, string> = {
  CORE: 'engine, pricer, signals, sizing, risk guard, hysteresis, echo, persona',
  VENUE: 'Venue impls, tx queue, nonce manager, reconciler, claim loop',
  DATA: 'ingester, bus, journal, store',
  API: 'WS broadcaster, REST, hunt settlement, mirror',
  FRONT: 'arena page, gauge, tape, leaderboard, mirror, console, badge',
  OPS: 'docker, scripts, seeds, health, fixtures, drill, bench',
};
