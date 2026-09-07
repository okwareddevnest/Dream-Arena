// T-002 — config must fail LOUD at startup. A silently-wrong threshold is the
// difference between an agent that trades and one that spams (FR-E4).
import { describe, it, expect } from 'vitest';
import { loadConfig, THROTTLE } from '../index.ts';

/** A complete, valid SIM environment. Tests mutate copies of this. */
const SIM = {
  VENUE_MODE: 'SIM', SPOT_FEED: 'fixture', EDGE_IN: '0.06', EDGE_OUT: '0.02',
  MIN_EDGE_FLOOR: '0.015', KELLY_FRACTION: '0.25',
} as const;

const load = (over: Record<string, string | undefined> = {}) =>
  loadConfig({ ...SIM, ...over } as Record<string, string | undefined>);

describe('T-002 loadConfig validation', () => {
  it('loads a valid SIM environment', () => {
    const c = load();
    expect(c.venueMode).toBe('SIM');
    expect(c.risk.edgeIn).toBe(0.06);
    expect(c.risk.edgeOut).toBe(0.02);
  });

  it('throws when edgeIn <= edgeOut (hysteresis would be meaningless)', () => {
    expect(() => load({ EDGE_IN: '0.02', EDGE_OUT: '0.02' })).toThrow(/EDGE_IN/);
    expect(() => load({ EDGE_IN: '0.01', EDGE_OUT: '0.02' })).toThrow(/EDGE_IN/);
  });

  it('throws when SOMNIA_RPC_URL is missing in LIVE mode', () => {
    expect(() => load({ VENUE_MODE: 'LIVE', SOMNIA_RPC_URL: undefined })).toThrow(/SOMNIA_RPC_URL/);
  });

  it('throws when MIRA_PRIVATE_KEY is missing in LIVE mode (RFC-001 A7)', () => {
    expect(() => load({
      VENUE_MODE: 'LIVE', SOMNIA_RPC_URL: 'https://rpc', SOMNIA_INDEXER_URL: 'https://ix',
      VENUE_ID: '0xabc', MIRA_PRIVATE_KEY: undefined,
    })).toThrow(/MIRA_PRIVATE_KEY/);
  });

  it('throws when ECHO is enabled on LIVE with the same key as MIRA (self-matching is blocked)', () => {
    expect(() => load({
      VENUE_MODE: 'LIVE', SOMNIA_RPC_URL: 'https://rpc', SOMNIA_INDEXER_URL: 'https://ix',
      VENUE_ID: '0xabc', MIRA_PRIVATE_KEY: '0xaa', ECHO_ENABLED: 'true', ECHO_PRIVATE_KEY: '0xaa',
    })).toThrow(/same key|self-match/i);
  });

  it('accepts LIVE with two distinct keys', () => {
    const c = load({
      VENUE_MODE: 'LIVE', SOMNIA_RPC_URL: 'https://rpc', SOMNIA_INDEXER_URL: 'https://ix',
      VENUE_ID: '0xabc', MIRA_PRIVATE_KEY: '0xaa', ECHO_ENABLED: 'true', ECHO_PRIVATE_KEY: '0xbb',
    });
    expect(c.venueMode).toBe('LIVE');
    expect(c.keys.mira).toBe('0xaa');
    expect(c.keys.echo).toBe('0xbb');
  });

  it('rejects a non-numeric numeric var instead of silently using NaN', () => {
    expect(() => load({ KELLY_FRACTION: 'abc' })).toThrow(/KELLY_FRACTION/);
  });

  it('rejects kellyFraction outside (0,1]', () => {
    expect(() => load({ KELLY_FRACTION: '0' })).toThrow(/KELLY_FRACTION/);
    expect(() => load({ KELLY_FRACTION: '1.5' })).toThrow(/KELLY_FRACTION/);
  });

  it('rejects an unknown VENUE_MODE or SPOT_FEED rather than defaulting', () => {
    expect(() => load({ VENUE_MODE: 'PROD' })).toThrow(/VENUE_MODE/);
    expect(() => load({ SPOT_FEED: 'kraken' })).toThrow(/SPOT_FEED/);
  });

  it('rejects minEdgeFloor above edgeIn (no order could ever pass both)', () => {
    expect(() => load({ MIN_EDGE_FLOOR: '0.5' })).toThrow(/MIN_EDGE_FLOOR/);
  });

  it('defaults settlement style to the T-S1 verdict', () => {
    expect(load().settlementStyleDefault).toBe('EXPIRY');
  });

  it('exposes the measured throttles, not env-overridable below the safe floor', () => {
    expect(load().throttle.indexerMaxInFlight).toBe(1);
    expect(() => load({ INDEXER_MAX_IN_FLIGHT: '30' })).toThrow(/INDEXER_MAX_IN_FLIGHT/);
    expect(THROTTLE.indexerMaxInFlight).toBe(1);
  });

  it('generates a runId when none is supplied, and honours one when given', () => {
    expect(load().runId.length).toBeGreaterThan(0);
    expect(load({ RUN_ID: 'fixed-run' }).runId).toBe('fixed-run');
  });

  it('reports every problem at once rather than one per run', () => {
    try {
      load({ EDGE_IN: '0.01', KELLY_FRACTION: '9', SPOT_FEED: 'nope' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/EDGE_IN/);
      expect(msg).toMatch(/KELLY_FRACTION/);
      expect(msg).toMatch(/SPOT_FEED/);
    }
  });
});
