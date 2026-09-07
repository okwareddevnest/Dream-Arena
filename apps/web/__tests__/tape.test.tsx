// T-053 acceptance — the trade tape.
// spec: 30-TASKS T-053 · PRD F-A1 · IF §5
// F-A1 requires that every fill links to the testnet explorer: that link is the
// difference between "the agent claims it traded" and a judge verifying it did.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Tape, TAPE_ROWS } from '../components/Tape';

afterEach(cleanup);

const fill = (over: Record<string, unknown> = {}) => ({
  fillId: 'f1', clientOrderId: 'MIRA-1', venueOrderId: 'vo-1', marketId: 'm1',
  agent: 'MIRA', side: 'YES', sizeContracts: 50, price: 0.422, feeUsd: 0,
  txHash: '0xabc', explorerUrl: 'https://shannon-explorer.somnia.network/tx/0xabc',
  tsMs: 1_700_000_000_000, ...over,
});

describe('Tape', () => {
  it('shows side, size, price and the agent for each fill', () => {
    render(<Tape fills={[fill()]} />);
    const row = screen.getByTestId('tape-row-f1');
    expect(row.textContent).toContain('YES');
    expect(row.textContent).toContain('50');
    expect(row.textContent).toContain('42.2');
    expect(row.textContent).toContain('MIRA');
  });

  it('links a real fill to the explorer', () => {
    render(<Tape fills={[fill()]} />);
    const link = screen.getByRole('link', { name: /verify|explorer|0xabc/i });
    expect(link.getAttribute('href')).toBe('https://shannon-explorer.somnia.network/tx/0xabc');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('marks a SIM fill and offers no dead link', () => {
    render(<Tape fills={[fill({ fillId: 'f2', explorerUrl: null, txHash: null })]} />);
    const row = screen.getByTestId('tape-row-f2');
    expect(row.textContent).toContain('SIM');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('distinguishes the two agents', () => {
    render(<Tape fills={[fill({ fillId: 'a', agent: 'MIRA' }), fill({ fillId: 'b', agent: 'ECHO' })]} />);
    expect(screen.getByTestId('tape-row-a').dataset.agent).toBe('MIRA');
    expect(screen.getByTestId('tape-row-b').dataset.agent).toBe('ECHO');
  });

  it('caps rendered rows however many fills arrive', () => {
    const many = Array.from({ length: 5000 }, (_, i) => fill({ fillId: `f${i}` }));
    render(<Tape fills={many} />);
    expect(screen.getAllByTestId(/^tape-row-/).length).toBeLessThanOrEqual(TAPE_ROWS);
  });

  it('invites the first trade rather than showing an empty box', () => {
    render(<Tape fills={[]} />);
    expect(screen.getByTestId('tape-empty').textContent).toMatch(/no trades yet|waiting/i);
  });

  it('never renders a price outside a probability', () => {
    render(<Tape fills={[fill({ price: 0.999 }), fill({ fillId: 'f9', price: 0.001 })]} />);
    for (const el of screen.getAllByTestId(/^tape-price-/)) {
      const v = Number(el.textContent!.replace('%', ''));
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(100);
    }
  });
});
