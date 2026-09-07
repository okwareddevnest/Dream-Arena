// T-056 acceptance — the hunt round panel.
// spec: 30-TASKS T-056 · PRD F-A5 · FR-U1 · IF §11
// The countdown must derive from the SERVER's clock. A browser whose clock is
// three minutes fast would otherwise show a round closing before it does, and
// forecasts submitted "after close" that the server happily accepts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HuntPanel, remainingMs } from '../components/HuntPanel';

afterEach(cleanup);

const round = (over: Record<string, unknown> = {}) => ({
  roundId: 'r1', marketIds: ['m1'], openedMs: 1_000, closeMs: 61_000, potUsd: 25, ...over,
});

describe('remainingMs', () => {
  it('uses the server clock, not the browser clock', () => {
    // browser is 3 minutes fast; the server says 30s remain
    const localNow = 1_000_000 + 180_000;
    const offset = -180_000;                    // serverMs - localMs
    expect(remainingMs({ closeMs: 1_030_000 } as never, localNow, offset)).toBe(30_000);
  });
  it('never reports negative time', () => {
    expect(remainingMs({ closeMs: 100 } as never, 5_000, 0)).toBe(0);
  });
});

describe('HuntPanel', () => {
  it('waits visibly when no round is open', () => {
    render(<HuntPanel round={null} leaderboard={[]} serverOffsetMs={0} onForecast={() => {}} />);
    expect(screen.getByTestId('hunt-idle').textContent).toMatch(/no round|next round|waiting/i);
  });

  it('shows the countdown and the pot for an open round', () => {
    vi.setSystemTime(new Date(31_000));
    render(<HuntPanel round={round()} leaderboard={[]} serverOffsetMs={0} onForecast={() => {}} />);
    expect(screen.getByTestId('hunt-countdown').textContent).toContain('30');
    expect(screen.getByTestId('hunt-pot').textContent).toContain('25');
    vi.useRealTimers();
  });

  it('submits a forecast as a probability in [0,1]', async () => {
    const onForecast = vi.fn();
    render(<HuntPanel round={round()} leaderboard={[]} serverOffsetMs={0} onForecast={onForecast} />);
    const input = screen.getByLabelText(/your call/i);
    await userEvent.clear(input);
    await userEvent.type(input, '72');
    await userEvent.click(screen.getByRole('button', { name: /submit|call/i }));
    expect(onForecast).toHaveBeenCalledTimes(1);
    const arg = onForecast.mock.calls[0]![0] as { p: number; marketId: string };
    expect(arg.p).toBeCloseTo(0.72, 6);
    expect(arg.p).toBeGreaterThan(0);
    expect(arg.p).toBeLessThan(1);
    expect(arg.marketId).toBe('m1');
  });

  it('blocks an out-of-range call before it reaches the server', async () => {
    const onForecast = vi.fn();
    render(<HuntPanel round={round()} leaderboard={[]} serverOffsetMs={0} onForecast={onForecast} />);
    const input = screen.getByLabelText(/your call/i);
    await userEvent.clear(input);
    await userEvent.type(input, '140');
    await userEvent.click(screen.getByRole('button', { name: /submit|call/i }));
    expect(onForecast).not.toHaveBeenCalled();
    expect(screen.getByTestId('hunt-error').textContent).toMatch(/between/i);
  });

  it('shows payouts and the viewer\'s rank after settlement', () => {
    render(
      <HuntPanel
        round={null}
        leaderboard={[
          { userAddr: '0xaaa', brier: 0.10, rank: 1, payoutUsd: 15 },
          { userAddr: '0xbbb', brier: 0.30, rank: 2, payoutUsd: 10 },
        ]}
        userAddr="0xbbb"
        serverOffsetMs={0}
        onForecast={() => {}}
      />,
    );
    const settled = screen.getByTestId('hunt-settled');
    expect(settled.textContent).toContain('15');
    expect(screen.getByTestId('hunt-you').textContent).toMatch(/2/);
  });
});
