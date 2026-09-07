// T-058 acceptance — the MIRA profile.
// spec: 30-TASKS T-058 · PRD §6 P1 · WP §4
// The explainer must stand on its own with the API down: this page is how a judge
// understands the strategy, and it cannot depend on the agent being up.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import MiraPage from '../app/mira/page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const profile = {
  agent: 'MIRA', mode: 'LIVE',
  strategy: 'EWMV volatility forecast (F4) → F1 expiry probability → quarter-Kelly',
  risk: { edgeIn: 0.06, edgeOut: 0.02, kellyFraction: 0.25, maxNotionalUsd: 250, maxNetContractsPerMarket: 50 },
  stats: { ticks: 100, valuations: 300, enters: 9, ordersPlaced: 5 },
};

describe('MIRA profile', () => {
  it('explains the strategy with the API unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    render(<MiraPage />);
    const main = screen.getByRole('main');
    expect(main.textContent).toMatch(/volatility/i);
    expect(main.textContent).toMatch(/Kelly/i);
    // The formulas are documented, not fetched.
    expect(screen.getByTestId('formula-f1')).toBeTruthy();
    expect(screen.getByTestId('formula-f2')).toBeTruthy();
  });

  it('shows the live risk configuration once the API answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => profile })));
    render(<MiraPage />);
    await waitFor(() => expect(screen.getByTestId('risk-edgeIn').textContent).toContain('6'));
    expect(screen.getByTestId('risk-kelly').textContent).toContain('0.25');
  });

  it('substitutes the live numbers into the explanation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => profile })));
    render(<MiraPage />);
    await waitFor(() => expect(screen.getByTestId('live-thresholds').textContent).toMatch(/6(\.0)?%/));
  });

  it('does not invent a risk config when the API is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    render(<MiraPage />);
    await waitFor(() => expect(screen.getByTestId('risk-offline')).toBeTruthy());
    expect(screen.queryByTestId('risk-edgeIn')).toBeNull();
  });
});
