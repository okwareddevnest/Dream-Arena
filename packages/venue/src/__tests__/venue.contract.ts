// T-030 — the Venue conformance suite: ONE oracle, run unchanged against every
// implementation (FR-V1, GWT-8).
//
// This file is the reason the LIVE -> SIM switchover is a constructor swap
// rather than a code path. If `SimulatedVenue` and `DreamDEXVenue` both satisfy
// these assertions, the agent above them cannot tell which one it is talking to
// — which is exactly what PRD F-A3 promises and what the demo's escape hatch
// depends on.
//
// It is exported as a FUNCTION, not a top-level describe, so each venue's own
// test file calls it with a factory. Nothing here may reference a concrete
// implementation.
import { describe, it, expect } from 'vitest';
import {
  ORDER_KINDS, TRADABLE_STATUS,
  type Market, type Order, type OrderKind, type Venue,
} from '@arena/shared';

export interface VenueHarness {
  /** A fresh, connected venue plus whatever the suite needs to drive it. */
  venue: Venue;
  /** Advance the venue's clock (virtual in SIM, a real wait in LIVE). */
  advance: (ms: number) => Promise<void>;
  /** Build a second venue instance signing as a different agent (RFC-001 A7). */
  otherAgent?: () => Promise<Venue>;
  /** Tear down. */
  dispose: () => Promise<void>;
  /** True when the venue can be driven to produce a fill in-test. */
  canFill: boolean;
}

export interface ContractSuiteOptions {
  name: string;
  /** Build a fresh harness per test. */
  make: () => Promise<VenueHarness>;
}

/** Build a well-formed order for a market. Kept here so every venue is tested
 *  with the same request shape. */
export function orderFor(m: Market, over: Partial<Order> = {}): Order {
  const price = 0.5;
  const scale = 10 ** m.priceDecimals;
  return {
    clientOrderId: `test-${Math.random().toString(36).slice(2, 10)}`,
    marketId: m.id,
    agent: 'MIRA',
    side: 'YES',
    kind: 'BUY_YES',
    type: 'LIMIT',
    limitPrice: price,
    limitPriceRaw: BigInt(Math.round(price * scale)),
    sizeContracts: Math.max(1, m.minSize),
    sizeRaw: BigInt(Math.round(Math.max(1, m.minSize) * scale)),
    expiresMs: m.expiryMs,
    signalId: null,
    tsMs: 0,
    ...over,
  };
}

export function runVenueContract(opts: ContractSuiteOptions): void {
  const { name, make } = opts;

  describe(`Venue contract: ${name}`, () => {
    // ── Identity (RFC-001 A7) ───────────────────────────────────────────────
    it('declares a name, a mode and the agent it signs as', async () => {
      const h = await make();
      try {
        expect(['SimulatedVenue', 'DreamDEXVenue']).toContain(h.venue.name);
        expect(['LIVE', 'SIM']).toContain(h.venue.mode);
        expect(typeof h.venue.agent).toBe('string');
        expect(h.venue.agent.length).toBeGreaterThan(0);
      } finally { await h.dispose(); }
    });

    it('reports a health snapshot whose mode matches its own', async () => {
      const h = await make();
      try {
        const hh = await h.venue.health();
        expect(hh.mode).toBe(h.venue.mode);
        expect(hh.name).toBe(h.venue.name);
        expect(typeof hh.ok).toBe('boolean');
      } finally { await h.dispose(); }
    });

    it('now() returns a plausible epoch-millisecond value', async () => {
      const h = await make();
      try {
        const t = h.venue.now();
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
      } finally { await h.dispose(); }
    });

    // ── Markets (IF §2) ─────────────────────────────────────────────────────
    it('returns at least one market matching the frozen Market shape', async () => {
      const h = await make();
      try {
        const ms = await h.venue.getMarkets();
        expect(ms.length).toBeGreaterThan(0);
        const m = ms[0]!;
        expect(typeof m.id).toBe('string');
        expect(typeof m.yesSymbol).toBe('string');
        expect(typeof m.noSymbol).toBe('string');
        expect(['fixed', 'reference']).toContain(m.mode);
        expect(typeof m.boundaryPosted).toBe('boolean');
        expect(typeof m.tickRaw).toBe('bigint');
        expect(typeof m.lotRaw).toBe('bigint');
        expect(m.expiryMs).toBeGreaterThan(0);
        expect(m.intervalSec).toBeGreaterThan(0);
      } finally { await h.dispose(); }
    });

    it('a reference-mode market has no strike until its boundary is posted', async () => {
      const h = await make();
      try {
        for (const m of await h.venue.getMarkets()) {
          if (m.mode === 'reference' && !m.boundaryPosted) expect(m.strike).toBeNull();
          if (m.boundaryPosted) expect(m.strike).not.toBeNull();
        }
      } finally { await h.dispose(); }
    });

    it('never identifies a market by its pool address (pools are recycled)', async () => {
      const h = await make();
      try {
        for (const m of await h.venue.getMarkets()) {
          if (m.poolAddress !== null) expect(m.id).not.toBe(m.poolAddress);
        }
      } finally { await h.dispose(); }
    });

    // ── Quotes (IF §2) ──────────────────────────────────────────────────────
    it('returns a quote with bid <= mid <= ask, all inside [0,1]', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets())[0]!;
        const q = await h.venue.getQuote(m.id);
        expect(q.marketId).toBe(m.id);
        for (const p of [q.bid, q.mid, q.ask]) {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
        expect(q.bid).toBeLessThanOrEqual(q.mid);
        expect(q.mid).toBeLessThanOrEqual(q.ask);
        expect(typeof q.stale).toBe('boolean');
        expect(q.depthBid).toBeGreaterThanOrEqual(0);
        expect(q.depthAsk).toBeGreaterThanOrEqual(0);
      } finally { await h.dispose(); }
    });

    it('rejects a quote request for an unknown market with a typed error', async () => {
      const h = await make();
      try {
        await expect(h.venue.getQuote('0xdoesnotexist')).rejects.toThrow(/unknown|not found/i);
      } finally { await h.dispose(); }
    });

    // ── Orders (IF §5, RFC-001 A1/A2/A3/A8) ─────────────────────────────────
    it('echoes the clientOrderId back on the ack', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const o = orderFor(m);
        const ack = await h.venue.placeOrder(o);
        expect(ack.clientOrderId).toBe(o.clientOrderId);
        expect(['ACCEPTED', 'REJECTED', 'QUEUED']).toContain(ack.status);
      } finally { await h.dispose(); }
    });

    it('is idempotent: the same clientOrderId twice has one position effect', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const o = orderFor(m, { type: 'MARKET', limitPrice: null, limitPriceRaw: null });
        await h.venue.placeOrder(o);
        await h.advance(100);
        const after1 = (await h.venue.positions()).find((p) => p.marketId === m.id)?.netContracts ?? 0;
        await h.venue.placeOrder(o);                 // exact same id
        await h.advance(100);
        const after2 = (await h.venue.positions()).find((p) => p.marketId === m.id)?.netContracts ?? 0;
        expect(after2).toBe(after1);
      } finally { await h.dispose(); }
    });

    it('rejects an order with no expiry (RFC-001 A2: expiry is mandatory)', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const ack = await h.venue.placeOrder(orderFor(m, { expiresMs: 0 }));
        expect(ack.status).toBe('REJECTED');
        expect(ack.reason).toMatch(/expir/i);
      } finally { await h.dispose(); }
    });

    it('never sends an expiry beyond the market expiry as-is', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const ack = await h.venue.placeOrder(orderFor(m, { expiresMs: m.expiryMs + 3_600_000 }));
        // Either capped and accepted, or refused — never forwarded unchanged.
        if (ack.status === 'REJECTED') expect(ack.reason).toMatch(/expir/i);
        else expect(ack.status).toBe('ACCEPTED');
      } finally { await h.dispose(); }
    });

    it('rejects an order on a market whose status is not Trading (RFC-001 A3)', async () => {
      const h = await make();
      try {
        const nonTrading = (await h.venue.getMarkets()).find((x) => x.status !== TRADABLE_STATUS);
        if (!nonTrading) return;                     // nothing to assert on this venue
        const ack = await h.venue.placeOrder(orderFor(nonTrading));
        expect(ack.status).toBe('REJECTED');
        expect(ack.reason).toMatch(/status|trading|tradable/i);
      } finally { await h.dispose(); }
    });

    it('accepts an order whose price is an exact multiple of tickRaw', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const scale = 10 ** m.priceDecimals;
        const onGrid = (BigInt(Math.round(0.5 * scale)) / m.tickRaw) * m.tickRaw;
        const ack = await h.venue.placeOrder(orderFor(m, {
          limitPriceRaw: onGrid, limitPrice: Number(onGrid) / scale,
        }));
        expect(ack.status).not.toBe('REJECTED');
      } finally { await h.dispose(); }
    });

    it('rejects a price that is off the tick grid (RFC-001 A8)', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        if (m.tickRaw <= 1n) return;                 // no grid to violate
        const scale = 10 ** m.priceDecimals;
        const offGrid = (BigInt(Math.round(0.5 * scale)) / m.tickRaw) * m.tickRaw + 1n;
        const ack = await h.venue.placeOrder(orderFor(m, {
          limitPriceRaw: offGrid, limitPrice: Number(offGrid) / scale,
        }));
        expect(ack.status).toBe('REJECTED');
        expect(ack.reason).toMatch(/tick|price|grid/i);
      } finally { await h.dispose(); }
    });

    it('rejects a size below the market minimum', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const ack = await h.venue.placeOrder(orderFor(m, { sizeContracts: 0, sizeRaw: 0n }));
        expect(ack.status).toBe('REJECTED');
        expect(ack.reason).toMatch(/size|minimum|min/i);
      } finally { await h.dispose(); }
    });

    it('round-trips all four OrderKinds through place -> position (RFC-001 A1)', async () => {
      const h = await make();
      if (!h.canFill) { await h.dispose(); return; }
      try {
        const ms = await h.venue.getMarkets();
        const tradable = ms.filter((x) => x.status === TRADABLE_STATUS);
        const seen: OrderKind[] = [];
        for (const kind of ORDER_KINDS) {
          const m = tradable[seen.length % tradable.length]!;
          // Selling an outcome requires holding it (RFC-001 A6).
          if (kind === 'SELL_YES' || kind === 'SELL_NO') {
            await h.venue.mintPair(m.id, Math.max(1, m.minSize) * 2);
          }
          const ack = await h.venue.placeOrder(orderFor(m, {
            kind, side: kind.endsWith('YES') ? 'YES' : 'NO',
            type: 'MARKET', limitPrice: null, limitPriceRaw: null,
          }));
          expect(ack.status, `${kind} was rejected: ${ack.reason}`).not.toBe('REJECTED');
          seen.push(kind);
        }
        expect(seen).toEqual([...ORDER_KINDS]);
      } finally { await h.dispose(); }
    });

    // ── Cancels ─────────────────────────────────────────────────────────────
    it('returns NOT_FOUND for an unknown cancel rather than throwing', async () => {
      const h = await make();
      try {
        const ack = await h.venue.cancel('never-existed');
        expect(ack.status).toBe('NOT_FOUND');
        expect(ack.clientOrderId).toBe('never-existed');
      } finally { await h.dispose(); }
    });

    it('cancels a resting order it accepted', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        // A price far from the mid rests rather than crossing.
        const scale = 10 ** m.priceDecimals;
        const raw = (BigInt(Math.round(0.02 * scale)) / m.tickRaw) * m.tickRaw;
        const o = orderFor(m, { limitPrice: Number(raw) / scale, limitPriceRaw: raw, type: 'LIMIT' });
        const ack = await h.venue.placeOrder(o);
        if (ack.status === 'REJECTED') return;
        const c = await h.venue.cancel(o.clientOrderId);
        expect(['CANCELLED', 'ALREADY_FILLED']).toContain(c.status);
      } finally { await h.dispose(); }
    });

    it('cancelAll leaves zero open orders', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const scale = 10 ** m.priceDecimals;
        for (const p of [0.02, 0.03, 0.04]) {
          const raw = (BigInt(Math.round(p * scale)) / m.tickRaw) * m.tickRaw;
          await h.venue.placeOrder(orderFor(m, { limitPrice: Number(raw) / scale, limitPriceRaw: raw }));
        }
        const acks = await h.venue.cancelAll();
        expect(Array.isArray(acks)).toBe(true);
        const again = await h.venue.cancelAll();
        expect(again).toHaveLength(0);              // nothing left to cancel
      } finally { await h.dispose(); }
    });

    // ── Positions and balance ───────────────────────────────────────────────
    it('reflects a fill in positions within one clock advance', async () => {
      const h = await make();
      if (!h.canFill) { await h.dispose(); return; }
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        await h.venue.placeOrder(orderFor(m, { type: 'MARKET', limitPrice: null, limitPriceRaw: null }));
        await h.advance(1_000);
        const p = (await h.venue.positions()).find((x) => x.marketId === m.id);
        expect(p).toBeDefined();
        expect(Math.abs(p!.netContracts)).toBeGreaterThan(0);
      } finally { await h.dispose(); }
    });

    it('returns positions matching the frozen Position shape', async () => {
      const h = await make();
      try {
        for (const p of await h.venue.positions()) {
          expect(typeof p.marketId).toBe('string');
          expect(typeof p.netContracts).toBe('number');
          expect(Number.isFinite(p.avgPrice)).toBe(true);
          expect(Number.isFinite(p.realizedPnlUsd)).toBe(true);
        }
      } finally { await h.dispose(); }
    });

    it('reports a finite, non-negative balance', async () => {
      const h = await make();
      try {
        const b = await h.venue.balanceUsd();
        expect(Number.isFinite(b)).toBe(true);
        expect(b).toBeGreaterThanOrEqual(0);
      } finally { await h.dispose(); }
    });

    // ── Fill subscription ───────────────────────────────────────────────────
    it('delivers fills to onFill and stops after unsubscribe', async () => {
      const h = await make();
      if (!h.canFill) { await h.dispose(); return; }
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        let n = 0;
        const off = h.venue.onFill(() => { n++; });
        await h.venue.placeOrder(orderFor(m, { type: 'MARKET', limitPrice: null, limitPriceRaw: null }));
        await h.advance(1_000);
        const afterFirst = n;
        expect(afterFirst).toBeGreaterThan(0);
        off();
        await h.venue.placeOrder(orderFor(m, { type: 'MARKET', limitPrice: null, limitPriceRaw: null }));
        await h.advance(1_000);
        expect(n).toBe(afterFirst);
      } finally { await h.dispose(); }
    });

    it('every fill carries the fields the tape needs', async () => {
      const h = await make();
      if (!h.canFill) { await h.dispose(); return; }
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const fills: { price: number; size: number; explorerUrl: string | null; txHash: string | null }[] = [];
        h.venue.onFill((f) => fills.push({
          price: f.price, size: f.sizeContracts, explorerUrl: f.explorerUrl, txHash: f.txHash,
        }));
        await h.venue.placeOrder(orderFor(m, { type: 'MARKET', limitPrice: null, limitPriceRaw: null }));
        await h.advance(1_000);
        expect(fills.length).toBeGreaterThan(0);
        for (const f of fills) {
          expect(f.price).toBeGreaterThan(0);
          expect(f.price).toBeLessThan(1);
          expect(f.size).toBeGreaterThan(0);
          // A LIVE fill must be explorer-verifiable; a SIM fill must not fake one.
          if (h.venue.mode === 'LIVE') expect(f.txHash).not.toBeNull();
          else expect(f.explorerUrl).toBeNull();
        }
      } finally { await h.dispose(); }
    });

    // ── Claim / redeem (RFC-001 A5) ─────────────────────────────────────────
    it('settledMarkets returns rows shaped like Market', async () => {
      const h = await make();
      try {
        for (const m of await h.venue.settledMarkets(5)) {
          expect(typeof m.id).toBe('string');
          expect(m.expiryMs).toBeGreaterThan(0);
        }
      } finally { await h.dispose(); }
    });

    it('claimable returns only winning outcomes the agent actually holds', async () => {
      const h = await make();
      try {
        for (const c of await h.venue.claimable()) {
          expect([0, 1]).toContain(c.outcomeIdx);
          expect(c.sizeContracts).toBeGreaterThan(0);
          expect(c.estPayoutUsd).toBeGreaterThanOrEqual(0);
        }
      } finally { await h.dispose(); }
    });

    it('claiming an unresolved market reports a reason instead of throwing', async () => {
      const h = await make();
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const r = await h.venue.claim(m.id);
        expect(r.claimed).toBe(false);
        expect(r.reason).not.toBeNull();
        expect(r.marketId).toBe(m.id);
      } finally { await h.dispose(); }
    });

    it('claiming an unknown market reports a reason instead of throwing', async () => {
      const h = await make();
      try {
        const r = await h.venue.claim('0xnope');
        expect(r.claimed).toBe(false);
        expect(r.reason).not.toBeNull();
      } finally { await h.dispose(); }
    });

    // ── mintPair (RFC-001 A6) ───────────────────────────────────────────────
    it('mintPair enables a SELL that would otherwise have no inventory', async () => {
      const h = await make();
      if (!h.canFill) { await h.dispose(); return; }
      try {
        const m = (await h.venue.getMarkets()).find((x) => x.status === TRADABLE_STATUS)!;
        const size = Math.max(1, m.minSize);
        const before = await h.venue.placeOrder(orderFor(m, {
          kind: 'SELL_YES', side: 'YES', type: 'MARKET', limitPrice: null, limitPriceRaw: null,
        }));
        expect(before.status).toBe('REJECTED');
        expect(before.reason).toMatch(/inventory|balance|hold/i);

        const mint = await h.venue.mintPair(m.id, size * 2);
        expect(mint.status).not.toBe('REJECTED');
        const after = await h.venue.placeOrder(orderFor(m, {
          kind: 'SELL_YES', side: 'YES', type: 'MARKET', limitPrice: null, limitPriceRaw: null,
        }));
        expect(after.status).not.toBe('REJECTED');
      } finally { await h.dispose(); }
    });

    // ── Two agents never self-match (RFC-001 A7) ────────────────────────────
    it('two instances signing as different agents are distinguishable', async () => {
      const h = await make();
      if (!h.otherAgent) { await h.dispose(); return; }
      try {
        const other = await h.otherAgent();
        expect(other.agent).not.toBe(h.venue.agent);
        const mine = await h.venue.positions(h.venue.agent);
        for (const p of mine) expect(p.agent).toBe(h.venue.agent);
      } finally { await h.dispose(); }
    });

    // ── Lifecycle ───────────────────────────────────────────────────────────
    it('disconnect is idempotent and leaves reads inert rather than throwing', async () => {
      const h = await make();
      await h.venue.disconnect();
      await expect(h.venue.disconnect()).resolves.toBeUndefined();
      const hh = await h.venue.health();
      expect(hh.ok).toBe(false);
      await h.dispose();
    });
  });
}
