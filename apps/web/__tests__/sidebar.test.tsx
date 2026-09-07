// Sidebar content: agent vitals, open positions, the market rail.
// These are what turn the arena from one board into a system you can read.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Vitals } from '../components/Vitals';
import { Positions } from '../components/Positions';
import { MarketRail, timeLeft } from '../components/MarketRail';

afterEach(cleanup);

describe('Vitals', () => {
  const stats = { ticks: 120, valuations: 400, skips: 90, enters: 11, ordersPlaced: 6, orderErrors: 0, quoteErrors: 1, holds: 3, standDowns: 0, vetoes: 5 };

  it('reports what the agent has done', () => {
    render(<Vitals stats={stats} health={{ ok: true, tickLagMs: 340, killSwitch: false }} />);
    expect(screen.getByTestId('vital-ticks').textContent).toContain('120');
    expect(screen.getByTestId('vital-orders').textContent).toContain('6');
  });

  it('shows how much the risk guard is holding back', () => {
    // enters 11 vs orders 6 — the gap IS the guard working, and it is the number
    // that was unreadable while `enters` was a dead counter.
    render(<Vitals stats={stats} health={{ ok: true, tickLagMs: 10, killSwitch: false }} />);
    expect(screen.getByTestId('vital-held').textContent).toContain('5');
  });

  it('shouts when the kill switch is down', () => {
    render(<Vitals stats={stats} health={{ ok: false, tickLagMs: 10, killSwitch: true }} />);
    expect(screen.getByTestId('vital-kill').textContent).toMatch(/stopped|killed/i);
  });

  it('renders before any stats arrive without inventing zeros', () => {
    render(<Vitals stats={null} health={null} />);
    expect(screen.getByTestId('vitals-empty')).toBeTruthy();
    expect(screen.queryByTestId('vital-ticks')).toBeNull();
  });
});

describe('Positions', () => {
  it('lists an open position with its side and size', () => {
    render(<Positions positions={[{ marketId: '0xabcdef1234', agent: 'MIRA', netContracts: 150, avgPrice: 0.42, unrealizedPnlUsd: 3.2 } as never]} />);
    const row = screen.getByTestId('pos-0xabcdef1234');
    expect(row.textContent).toContain('150');
    expect(row.dataset.side).toBe('YES');
  });

  it('shows a short position as NO', () => {
    render(<Positions positions={[{ marketId: 'm2', agent: 'MIRA', netContracts: -40, avgPrice: 0.6, unrealizedPnlUsd: -1 } as never]} />);
    expect(screen.getByTestId('pos-m2').dataset.side).toBe('NO');
  });

  it('says it is flat rather than showing an empty box', () => {
    render(<Positions positions={[]} />);
    expect(screen.getByTestId('pos-empty').textContent).toMatch(/flat|no position/i);
  });
});

describe('MarketRail', () => {
  const now = 1_000_000;
  const m = (id: string, expiry: number) => ({ id, symbol: `S-${id}`, asset: 'BTC', expiryMs: expiry } as never);

  it('counts down to expiry', () => {
    expect(timeLeft(now + 65_000, now)).toBe('1m 05s');
    expect(timeLeft(now + 9_000, now)).toBe('9s');
    expect(timeLeft(now - 1, now)).toBe('expired');
  });

  it('orders markets by how soon they expire', () => {
    render(<MarketRail markets={[m('late', now + 900_000), m('soon', now + 30_000)]} nowMs={now} />);
    const ids = screen.getAllByTestId(/^rail-/).map((e) => e.dataset.id);
    expect(ids).toEqual(['soon', 'late']);
  });

  it('flags a market about to expire', () => {
    render(<MarketRail markets={[m('a', now + 20_000)]} nowMs={now} />);
    expect(screen.getByTestId('rail-a').dataset.urgent).toBe('true');
  });
});
