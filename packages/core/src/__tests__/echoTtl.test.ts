// An ECHO quote must outlive the write that places it.
// Observed LIVE: expiry was refreshMs*2 (20s at the default), and a serialized
// on-chain write outran it — the pool rejected the quote with
// OrderAlreadyExpired() before it could ever rest.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_ORDER_TTL_MS } from '../engine.ts';

const src = readFileSync(resolve(import.meta.dirname, '../echo.ts'), 'utf8');

describe('ECHO quote lifetime', () => {
  it('never expires sooner than the engine-wide order TTL', () => {
    expect(src).toMatch(/expiresMs:\s*Math\.min\(\s*mk\.expiryMs,\s*nowMs \+ Math\.max\([^)]*DEFAULT_ORDER_TTL_MS/);
  });
  it('and that floor comfortably exceeds an on-chain write', () => {
    expect(DEFAULT_ORDER_TTL_MS).toBeGreaterThan(35_000);
  });
});
