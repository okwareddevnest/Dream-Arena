// T-052 acceptance — the divergence board.
// spec: 30-TASKS T-052 · PRD F-A1 · GWT-1 · GWT-3 · IF §3
// The gap between what MIRA's model believes and what the market prices IS the
// product, so it is the page's hero: one shared 0->1 probability axis, model and
// market as two marks, the span between them filled.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Gauge, markPercent } from '../components/Gauge';

afterEach(cleanup);

const val = (over: Record<string, unknown> = {}) => ({
  marketId: 'm1', pModel: 0.62, pMarket: 0.41, edge: 0.21,
  skipReason: null, sigmaForecast: 0.8, sigmaImplied: 0.6, tsMs: 1, ...over,
});
const mkt = { id: 'm1', symbol: 'BTC-REF-300s', asset: 'BTC', expiryMs: Date.now() + 300_000 };

describe('mark placement', () => {
  it('maps a probability onto the axis as a percentage', () => {
    expect(markPercent(0)).toBe(0);
    expect(markPercent(0.5)).toBe(50);
    expect(markPercent(1)).toBe(100);
    expect(markPercent(0.413)).toBeCloseTo(41.3, 6);
  });
  it('clamps anything outside [0,1] rather than painting off the axis', () => {
    expect(markPercent(-0.2)).toBe(0);
    expect(markPercent(1.4)).toBe(100);
    expect(markPercent(Number.NaN)).toBe(0);
  });
});

describe('Gauge', () => {
  it('places the model and market marks at their own probabilities', () => {
    render(<Gauge market={mkt} valuation={val()} edgeIn={0.06} />);
    const model = screen.getByTestId('mark-model');
    const market = screen.getByTestId('mark-market');
    expect(model.style.left).toBe('62%');
    expect(market.style.left).toBe('41%');
  });

  it('states both probabilities as readable numbers', () => {
    render(<Gauge market={mkt} valuation={val()} edgeIn={0.06} />);
    expect(screen.getByTestId('gauge-row').textContent).toContain('BTC-REF-300s');
    expect(screen.getByTestId('p-model').textContent).toContain('62');
    expect(screen.getByTestId('p-market').textContent).toContain('41');
  });

  it('highlights divergence at or above edgeIn (GWT-1)', () => {
    render(<Gauge market={mkt} valuation={val({ edge: 0.21 })} edgeIn={0.06} />);
    expect(screen.getByTestId('gauge-row').dataset.state).toBe('diverged');
  });

  it('does not highlight divergence below edgeIn', () => {
    render(<Gauge market={mkt} valuation={val({ pModel: 0.44, pMarket: 0.41, edge: 0.03 })} edgeIn={0.06} />);
    expect(screen.getByTestId('gauge-row').dataset.state).toBe('quiet');
  });

  it('shows a SKIP as skipped, never as an edge (GWT-3)', () => {
    render(<Gauge market={mkt} valuation={val({ skipReason: 'BOUNDARY_NOT_POSTED', edge: 0 })} edgeIn={0.06} />);
    const row = screen.getByTestId('gauge-row');
    expect(row.dataset.state).toBe('skipped');
    expect(row.textContent).toContain('BOUNDARY_NOT_POSTED');
    // A skipped market must not render a divergence span at all.
    expect(screen.queryByTestId('gap')).toBeNull();
  });

  it('renders before the first tick without inventing a number', () => {
    render(<Gauge market={mkt} valuation={null} edgeIn={0.06} />);
    const row = screen.getByTestId('gauge-row');
    expect(row.dataset.state).toBe('waiting');
    expect(row.textContent).toContain('BTC-REF-300s');
    expect(row.textContent).not.toMatch(/\d+(\.\d+)?%/);
    expect(screen.queryByTestId('mark-model')).toBeNull();
  });

  it('keeps the axis present with no data, so arriving values cause no layout shift', () => {
    const { container } = render(<Gauge market={mkt} valuation={null} edgeIn={0.06} />);
    expect(container.querySelector('[data-testid="axis"]')).not.toBeNull();
  });
});
