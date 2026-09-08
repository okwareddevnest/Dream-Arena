// A human-facing feed must not print internal identifiers.
// Observed live: "Standing down on 0x0000000000000000000000000000000000000000000
// 000000000000000166ef" — the bus carries marketIds, and MIRA was reading one out.
import { describe, it, expect } from 'vitest';
import { EventBus } from '@arena/data';
import { SystemClock } from '@arena/shared';
import { Persona } from '../persona.ts';

const ID = '0x' + '0'.repeat(60) + '166ef';

const signal = (action: string) => ({
  id: 's1', marketId: ID, action, side: null, edge: 0, reason: null, tsMs: Date.now(),
});

describe('persona symbol rendering', () => {
  it('says the market symbol, not its id', () => {
    const bus = new EventBus();
    const p = new Persona({ bus, clock: new SystemClock(), symbolFor: () => 'BTC-REF-300s' });
    p.subscribe(bus);
    bus.publish({ t: 'signal', d: signal('STAND_DOWN') as never });
    const said = p.quips().map((q) => q.text).join(' ');
    expect(said).toContain('BTC-REF-300s');
    expect(said, 'no raw id leaks into the feed').not.toContain(ID);
  });

  it('falls back to the id rather than saying nothing when unresolved', () => {
    const bus = new EventBus();
    const p = new Persona({ bus, clock: new SystemClock() });
    p.subscribe(bus);
    bus.publish({ t: 'signal', d: signal('SKIP') as never });
    expect(p.quips().length).toBeGreaterThan(0);
  });
});
