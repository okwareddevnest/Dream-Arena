// (T-001) shared is the root of the dependency graph: it must resolve standalone.
import { describe, it, expect } from 'vitest';
import { LANES, LANE_OWNS, type LaneId } from '../index.ts';

describe('@arena/shared wiring', () => {
  it('declares the six lanes from ARCH §5', () => {
    expect([...LANES]).toEqual(['CORE', 'VENUE', 'DATA', 'API', 'FRONT', 'OPS']);
  });
  it('gives every lane an ownership description', () => {
    for (const l of LANES) expect(LANE_OWNS[l as LaneId]?.length ?? 0).toBeGreaterThan(0);
  });
});
