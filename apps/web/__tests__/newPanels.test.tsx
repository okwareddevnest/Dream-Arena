// New arena panels. Every one is driven by data the running system actually
// produces — no placeholder series, no invented categories.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { SpotChart } from '../components/SpotChart';
import { SkipReasons, tallySkips } from '../components/SkipReasons';
import { SessionStrip } from '../components/SessionStrip';

afterEach(cleanup);

describe('SpotChart', () => {
  const series = [
    { tsMs: 1, price: 100 }, { tsMs: 2, price: 104 }, { tsMs: 3, price: 101 }, { tsMs: 4, price: 108 },
  ];
  it('draws the underlying as a smooth curve', () => {
    const { container } = render(<SpotChart symbol="BTC" series={series} />);
    const d = container.querySelector('svg path[stroke]')!.getAttribute('d')!;
    expect(d).toContain('C');
  });
  it('states the latest price and the move across the window', () => {
    render(<SpotChart symbol="BTC" series={series} />);
    expect(screen.getByTestId('spot-last').textContent).toContain('108');
    expect(screen.getByTestId('spot-change').textContent).toContain('8');
  });
  it('says it is still collecting rather than drawing one point as a trend', () => {
    render(<SpotChart symbol="BTC" series={[{ tsMs: 1, price: 100 }]} />);
    expect(screen.getByTestId('spot-collecting')).toBeTruthy();
  });
  it('renders nothing misleading with no data at all', () => {
    render(<SpotChart symbol="BTC" series={[]} />);
    expect(screen.getByTestId('spot-collecting')).toBeTruthy();
  });
});

describe('tallySkips', () => {
  it('counts real skip reasons, commonest first', () => {
    const out = tallySkips([
      { skipReason: 'BOUNDARY_NOT_POSTED' }, { skipReason: 'EXPIRED' },
      { skipReason: 'BOUNDARY_NOT_POSTED' }, { skipReason: null },
    ] as never);
    expect(out[0]).toEqual({ reason: 'BOUNDARY_NOT_POSTED', count: 2 });
    expect(out.find((r) => r.reason === 'EXPIRED')?.count).toBe(1);
  });
  it('ignores markets that were priced', () => {
    expect(tallySkips([{ skipReason: null }] as never)).toEqual([]);
  });
});

describe('SkipReasons', () => {
  it('explains WHY the agent is not trading a market', () => {
    render(<SkipReasons valuations={[{ skipReason: 'BOUNDARY_NOT_POSTED' }] as never} />);
    const row = screen.getByTestId('skip-BOUNDARY_NOT_POSTED');
    // The code is shown, and translated — a reader should not need the source.
    expect(row.textContent).toMatch(/opening price/i);
  });
  it('says so plainly when everything is priceable', () => {
    render(<SkipReasons valuations={[{ skipReason: null }] as never} />);
    expect(screen.getByTestId('skip-none')).toBeTruthy();
  });
});

describe('SessionStrip', () => {
  it('summarises the session from real counters', () => {
    render(<SessionStrip stats={{ ticks: 120, valuations: 400, enters: 11, ordersPlaced: 6 } as never} tape={[{ fillId: 'a' }] as never} positions={[]} />);
    expect(screen.getByTestId('sess-fills').textContent).toContain('1');
    expect(screen.getByTestId('sess-priced').textContent).toContain('400');
  });
  it('renders before the agent reports anything', () => {
    render(<SessionStrip stats={null} tape={[]} positions={[]} />);
    expect(screen.getByTestId('sess-fills').textContent).toContain('0');
  });
});
