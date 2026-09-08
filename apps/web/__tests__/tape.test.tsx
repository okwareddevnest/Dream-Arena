// T-053 acceptance — the trade tape.
// spec: 30-TASKS T-053 · PRD F-A1 · IF §5
// F-A1 requires that every fill links to the testnet explorer: that link is the
// difference between "the agent claims it traded" and a judge verifying it did.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('verifies a fill ON THE PAGE, then offers the explorer', async () => {
    // Reading the receipt in the browser is what turns "trust me" into evidence
    // the viewer can see without leaving the arena.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { status: '0x1', blockNumber: '0x10', gasUsed: '0x20', logs: [{}] } }),
    })));
    render(<Tape fills={[fill()]} />);
    await userEvent.click(screen.getByTestId('verify-f1'));
    await waitFor(() => expect(screen.getByTestId('receipt-f1').textContent).toMatch(/confirmed/i));
    const link = screen.getByRole('link', { name: /explorer/i });
    expect(link.getAttribute('href')).toBe('https://shannon-explorer.somnia.network/tx/0xabc');
    expect(link.getAttribute('rel')).toContain('noopener');
    vi.unstubAllGlobals();
  });

  it('does not call a reverted transaction confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ result: { status: '0x0', blockNumber: '0x10', gasUsed: '0x20', logs: [] } }),
    })));
    render(<Tape fills={[fill()]} />);
    await userEvent.click(screen.getByTestId('verify-f1'));
    await waitFor(() => expect(screen.getByTestId('receipt-f1').textContent).toMatch(/revert/i));
    vi.unstubAllGlobals();
  });

  it('marks a SIM fill and offers nothing to verify', () => {
    render(<Tape fills={[fill({ fillId: 'f2', explorerUrl: null, txHash: null })]} />);
    const row = screen.getByTestId('tape-row-f2');
    expect(row.textContent).toContain('SIM');
    expect(screen.queryByTestId('verify-f2')).toBeNull();
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
