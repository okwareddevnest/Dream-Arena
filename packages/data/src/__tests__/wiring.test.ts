// Guards cross-workspace resolution: a broken alias or manifest fails here, not
// three cards later inside an unrelated test. (T-001)
import { describe, it, expect } from 'vitest';
import { LANE, PACKAGE, RESPONSIBILITY, COMPONENTS } from '../index.ts';
import { LANES } from '@arena/shared';

describe('@arena/data wiring', () => {
  it('declares a lane that @arena/shared recognises', () => {
    expect(LANES).toContain(LANE);
  });
  it('identifies itself and its responsibility', () => {
    expect(PACKAGE).toBe('@arena/data');
    expect(RESPONSIBILITY.length).toBeGreaterThan(0);
  });
  it('exposes a component registry for the health snapshot', () => {
    expect(Array.isArray(COMPONENTS)).toBe(true);
  });
});
