// The personal scorecard — the one thing on the site that is different for
// every visitor. It must be honest about an empty record: a new forecaster has
// no skill estimate, and showing them a confident 0.000 would be a lie.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Scorecard, CalibrationCurve } from '../components/Scorecard';

afterEach(cleanup);

const record = (over: Record<string, unknown> = {}) => ({
  userAddr: '0xabc',
  record: { n: 12, brier: 0.18, reliability: 0.02, resolution: 0.06, uncertainty: 0.24, baseRate: 0.4 },
  calibration: [
    { lo: 0, hi: 0.2, stated: 0.1, observed: 0.12, n: 3 },
    { lo: 0.2, hi: 0.4, stated: 0.3, observed: null, n: 0 },
    { lo: 0.8, hi: 1, stated: 0.9, observed: 0.66, n: 6 },
  ],
  versusMira: { n: 9, userBrier: 0.18, miraBrier: 0.22, verdict: 'ahead' },
  forecasts: 15, pending: 3, ...over,
});

describe('Scorecard', () => {
  it('tells the user how they are wrong, not just that they are', () => {
    render(<Scorecard data={record() as never} />);
    const t = screen.getByTestId('score-diagnosis').textContent!;
    // reliability 0.02 is small, resolution 0.06 is the larger term → discrimination
    expect(t.length).toBeGreaterThan(30);
    expect(t).toMatch(/calibrat|separat|confiden/i);
  });

  it('names the head-to-head result against MIRA', () => {
    render(<Scorecard data={record() as never} />);
    expect(screen.getByTestId('score-vs').textContent).toMatch(/ahead/i);
    expect(screen.getByTestId('score-vs').textContent).toContain('9');
  });

  it('shows pending calls as pending, never as a score', () => {
    render(<Scorecard data={record() as never} />);
    expect(screen.getByTestId('score-pending').textContent).toContain('3');
  });

  it('refuses to score a forecaster with no resolved calls', () => {
    render(<Scorecard data={record({ record: { n: 0, brier: null, reliability: 0, resolution: 0, uncertainty: 0, baseRate: 0 }, versusMira: { n: 0, userBrier: null, miraBrier: null, verdict: 'untested' } }) as never} />);
    expect(screen.getByTestId('score-empty')).toBeTruthy();
    expect(screen.queryByTestId('score-brier')).toBeNull();
  });

  it('prompts a visitor with no wallet rather than showing a blank', () => {
    render(<Scorecard data={null} />);
    expect(screen.getByTestId('score-connect')).toBeTruthy();
  });
});

describe('CalibrationCurve', () => {
  it('plots only buckets that actually have calls in them', () => {
    const { container } = render(<CalibrationCurve buckets={record().calibration as never} />);
    // two populated buckets → two markers; the empty one is not drawn as zero
    expect(container.querySelectorAll('[data-testid^="cal-pt-"]').length).toBe(2);
  });
  it('draws the perfect-calibration reference', () => {
    const { container } = render(<CalibrationCurve buckets={record().calibration as never} />);
    expect(container.querySelector('[data-testid="cal-ideal"]')).not.toBeNull();
  });
  it('says so when nothing has resolved', () => {
    render(<CalibrationCurve buckets={[{ lo: 0, hi: 1, stated: 0.5, observed: null, n: 0 }] as never} />);
    expect(screen.getByTestId('cal-empty')).toBeTruthy();
  });
});
