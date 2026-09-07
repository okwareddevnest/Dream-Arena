// `enters` must actually count. It was declared, initialised to 0 and never
// incremented, so every LIVE heartbeat read "enter 0" while orders were being
// placed — the one number that says "the model wanted to trade" was dead, and
// the gap between enters and ordersPlaced (how much the risk guard is holding
// back) was unreadable.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(import.meta.dirname, '../engine.ts'), 'utf8');

describe('engine stat counters', () => {
  it('increments enters on the ENTER verdict', () => {
    expect(src).toMatch(/case 'ENTER':[^\n]*this\.stats\.enters\+\+/);
  });

  it('every declared stat counter is incremented somewhere', () => {
    // Guards against another write-only counter being added.
    const declared = [...src.matchAll(/^\s{2}(\w+): number;$/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(5);
    for (const name of declared) {
      expect(src.includes(`this.stats.${name}++`), `${name} is never incremented`).toBe(true);
    }
  });
});
