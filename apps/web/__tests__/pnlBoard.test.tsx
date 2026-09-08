// T-054 acceptance — MIRA's PnL curve and the human leaderboard.
// spec: 30-TASKS T-054 · PRD F-A1,F-A5 · IF §11
// Brier is a LOSS: lower is better, so rank 1 is the smallest score. Sorting it
// the familiar "big number wins" way would crown the worst forecaster.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { PnlChart } from '../components/PnlChart';
import { Leaderboard } from '../components/Leaderboard';

afterEach(cleanup);

const pt = (tsMs: number, pnlUsd: number) => ({ tsMs, pnlUsd });

describe('PnlChart', () => {
  it('draws a real, measured path through the series', () => {
    const { container } = render(<PnlChart series={[pt(1, 0), pt(2, 5), pt(3, -2)]} />);
    const path = container.querySelector('svg path[stroke]')!;
    const d = path.getAttribute('d')!;
    expect(d).toMatch(/^M/);
    // The series is drawn as a SMOOTH curve now: cubic segments, not a polyline.
    expect(d).toContain('C');
    expect(d.split('C').length).toBeGreaterThan(1);
    // Sharpness: the stroke must not scale with the box.
    expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
  });

  it('sizes its viewBox to the measured pixels, so nothing is stretched', () => {
    const { container } = render(<PnlChart series={[pt(1, 1), pt(2, 2)]} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 320 104');
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull();
  });

  it('states the latest value', () => {
    render(<PnlChart series={[pt(1, 0), pt(2, 12.5)]} />);
    expect(screen.getByTestId('pnl-latest').textContent).toContain('12.5');
  });

  it('survives a single point without collapsing', () => {
    const { container } = render(<PnlChart series={[pt(1, 3)]} />);
    expect(container.querySelector('svg path[stroke]')!.getAttribute('d')).toBeTruthy();
  });

  it('says so when there is no series yet, and invents no zero line', () => {
    const { container } = render(<PnlChart series={[]} />);
    expect(screen.getByTestId('pnl-empty')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('maps a flat series to a straight line rather than dividing by zero', () => {
    const { container } = render(<PnlChart series={[pt(1, 4), pt(2, 4), pt(3, 4)]} />);
    const d = container.querySelector('svg path[stroke]')!.getAttribute('d')!;
    expect(d).toMatch(/^M/);
    expect(d).not.toContain('NaN');
  });
});

describe('Leaderboard', () => {
  const scores = [
    { userAddr: '0xbbb', brier: 0.31, rank: 0, payoutUsd: 0 },
    { userAddr: '0xaaa', brier: 0.12, rank: 0, payoutUsd: 0 },
    { userAddr: '0xccc', brier: 0.44, rank: 0, payoutUsd: 0 },
  ];

  it('ranks ascending by Brier — lower is better', () => {
    render(<Leaderboard scores={scores} />);
    const rows = screen.getAllByTestId(/^lb-row-/);
    expect(rows.map((r) => r.dataset.addr)).toEqual(['0xaaa', '0xbbb', '0xccc']);
    expect(rows[0]!.textContent).toContain('1');
  });

  it('marks the viewer\'s own row when their address is known', () => {
    render(<Leaderboard scores={scores} userAddr="0xbbb" />);
    expect(screen.getByTestId('lb-row-0xbbb').dataset.you).toBe('true');
    expect(screen.getByTestId('lb-row-0xaaa').dataset.you).toBeUndefined();
  });

  it('invites the first forecast when nobody has played', () => {
    render(<Leaderboard scores={[]} />);
    expect(screen.getByTestId('lb-empty').textContent).toMatch(/forecast/i);
  });

  it('shortens addresses but keeps them identifiable', () => {
    render(<Leaderboard scores={[{ userAddr: '0x1234567890abcdef1234567890abcdef12345678', brier: 0.1, rank: 1, payoutUsd: 0 }]} />);
    const t = screen.getByTestId(/^lb-row-/).textContent!;
    expect(t).toContain('0x1234');
    expect(t).toContain('5678');
  });
});
