// A post-only maker must never cross the resting book.
// Observed LIVE: ECHO's model fair sat near 0.5 while the venue's synthetic book
// quoted YES asks at 0.05-0.24. Its bid at fair - spread/2 was far ABOVE the best
// ask, so every quote reverted with PostOnlyWouldCross() — 7 rejects, 0 quotes
// resting, and an empty tape. ECHO must clamp to just inside the book.
import { describe, it, expect } from 'vitest';
import { clampToBook } from '../echo.ts';

const TICK = 0.001;

describe('clampToBook', () => {
  it('leaves a bid that already rests below the ask untouched', () => {
    expect(clampToBook('YES', 0.30, { bid: 0.28, ask: 0.52 }, TICK)).toBeCloseTo(0.30, 9);
  });

  it('pulls a crossing YES bid to one tick under the best ask', () => {
    // the live failure: fair 0.5, book ask 0.052
    expect(clampToBook('YES', 0.49, { bid: 0.02, ask: 0.052 }, TICK)).toBeCloseTo(0.051, 9);
  });

  it('clamps a NO bid against the mirrored side of the YES book', () => {
    // buying NO at q means selling YES at 1-q, so it must not cross the YES bid
    expect(clampToBook('NO', 0.99, { bid: 0.30, ask: 0.52 }, TICK)).toBeCloseTo(0.699, 9);
  });

  it('returns null when there is no room to rest without crossing', () => {
    // best ask one tick above zero leaves nowhere for a bid to sit
    expect(clampToBook('YES', 0.4, { bid: 0, ask: 0.001 }, TICK)).toBeNull();
    expect(clampToBook('NO', 0.4, { bid: 0.999, ask: 1 }, TICK)).toBeNull();
  });

  it('quotes freely when that side of the book is empty', () => {
    expect(clampToBook('YES', 0.42, { bid: 0.1, ask: null }, TICK)).toBeCloseTo(0.42, 9);
    expect(clampToBook('NO', 0.42, { bid: null, ask: 0.9 }, TICK)).toBeCloseTo(0.42, 9);
  });

  it('never returns a price outside (0,1)', () => {
    for (const [side, p] of [['YES', 0.9999], ['NO', 0.9999]] as const) {
      const out = clampToBook(side, p, { bid: 0.001, ask: 0.999 }, TICK);
      if (out !== null) { expect(out).toBeGreaterThan(0); expect(out).toBeLessThan(1); }
    }
  });
});
