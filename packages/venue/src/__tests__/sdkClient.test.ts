// Acceptance for the REAL SdkClient adapter (SDK → the port DreamDEXVenue consumes).
// The pure mappings are tested here; the I/O path is proven by the live smoke
// (tests/live/somnia.test.ts) against the real chain.
// spec: 20-INTERFACES §6 · T-034 · RFC-003
import { describe, it, expect } from 'vitest';
import {
  parseOutcomeSymbol, bookToPort, sideFromKind, rawToNum,
} from '../sdkClient.ts';

describe('outcome symbol round-trip', () => {
  it('parses the synthetic `<marketId>#YES` symbol the venue mints', () => {
    // Live indexer rows carry no `outcomes[]`, so DreamDEXVenue.rowToMarket falls
    // back to `${marketId}#YES` / `#NO`. The adapter must invert exactly that.
    const id = '0x0000000000000000000000000000000000000000000000000000000000015779';
    expect(parseOutcomeSymbol(`${id}#YES`)).toEqual({ marketId: id, side: 'YES' });
    expect(parseOutcomeSymbol(`${id}#NO`)).toEqual({ marketId: id, side: 'NO' });
  });

  it('rejects a symbol it cannot resolve rather than guessing a side', () => {
    expect(() => parseOutcomeSymbol('BTC-REF-300s')).toThrow(/cannot resolve/i);
    expect(() => parseOutcomeSymbol('0xabc#MAYBE')).toThrow(/cannot resolve/i);
  });
});

describe('order kind → SDK side', () => {
  it('maps the numeric ordinal onto the STRING BinarySide the SDK demands', () => {
    // The SDK exports ORDER_KIND as numbers but `placeOrder({side})` wants the
    // string; passing the number dies with "cannot read properties of undefined
    // (reading 'kind')". This mapping is the whole defence.
    expect(sideFromKind(0)).toBe('BUY_YES');
    expect(sideFromKind(1)).toBe('SELL_YES');
    expect(sideFromKind(2)).toBe('BUY_NO');
    expect(sideFromKind(3)).toBe('SELL_NO');
  });
  it('throws on an unknown ordinal instead of silently buying YES', () => {
    expect(() => sideFromKind(9)).toThrow(/unknown order kind/i);
  });
});

describe('raw 6dp → human', () => {
  it('converts prices and sizes without float drift at the tick', () => {
    expect(rawToNum(10_000n)).toBeCloseTo(0.01, 12);
    expect(rawToNum(1_000_000n)).toBe(1);
    expect(rawToNum(73_000n)).toBeCloseTo(0.073, 12);
    expect(rawToNum(0n)).toBe(0);
  });
});

describe('book → port shape', () => {
  // Shape observed live: 6dp raw bigints, one array per outcome side.
  const book = {
    yesBids: [{ price: 21_000n, quantity: 460_000_000n }, { price: 45_000n, quantity: 10_000_000n }],
    yesAsks: [{ price: 93_000n, quantity: 10_000_000n }, { price: 57_000n, quantity: 200_000_000n }],
    noBids: [{ price: 907_000n, quantity: 10_000_000n }],
    noAsks: [{ price: 964_000n, quantity: 200_000_000n }],
  };

  it('picks the YES side and sorts bids high-first, asks low-first', () => {
    const ob = bookToPort(book, 'YES', 5);
    // best bid first, best ask first — DreamDEXVenue.getQuote reads index 0.
    expect(ob.bids[0]).toEqual([0.045, 10]);
    expect(ob.asks[0]).toEqual([0.057, 200]);
  });

  it('picks the NO side when asked', () => {
    const ob = bookToPort(book, 'NO', 5);
    expect(ob.bids[0]).toEqual([0.907, 10]);
    expect(ob.asks[0]).toEqual([0.964, 200]);
  });

  it('honours the requested depth', () => {
    expect(bookToPort(book, 'YES', 1).bids).toHaveLength(1);
    expect(bookToPort(book, 'YES', 5).bids).toHaveLength(2);
  });

  it('survives an empty or absent side without throwing', () => {
    expect(bookToPort({}, 'YES', 5)).toEqual({ bids: [], asks: [] });
    expect(bookToPort({ yesBids: [] }, 'YES', 5).asks).toEqual([]);
  });

  it('produces prices that are valid YES probabilities in (0,1)', () => {
    const ob = bookToPort(book, 'YES', 5);
    for (const [p] of [...ob.bids, ...ob.asks]) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });
});
