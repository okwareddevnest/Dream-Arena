// MIRA's voice.
// The persona feed (T-027) was built with 16 tests and never wired to anything.
// It is what makes the arena an agent you are watching rather than a dashboard
// you are reading, so it gets a first-class place on the page.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Voice } from '../components/Voice';

afterEach(cleanup);

const quip = (over: Record<string, unknown> = {}) => ({
  quipId: 'q1', text: 'I make it 63%. The book says 48%. Taking it.',
  roundId: null, trigger: 'skip', tsMs: 1_700_000_000_000, ...over,
});

describe('Voice', () => {
  it('speaks the latest line most prominently', () => {
    render(<Voice quips={[quip({ quipId: 'new', text: 'Newest line.' }), quip({ quipId: 'old', text: 'Older line.' })]} />);
    expect(screen.getByTestId('voice-latest').textContent).toContain('Newest line.');
  });

  it('keeps recent lines beneath it', () => {
    render(<Voice quips={[quip({ quipId: 'a', text: 'A' }), quip({ quipId: 'b', text: 'B' })]} />);
    expect(screen.getByTestId('voice-past').textContent).toContain('B');
    expect(screen.getByTestId('voice-past').textContent).not.toContain('A');
  });

  it('waits in character rather than showing an empty panel', () => {
    render(<Voice quips={[]} />);
    expect(screen.getByTestId('voice-idle').textContent!.length).toBeGreaterThan(20);
  });

  it('caps how much it shows, however long the session runs', () => {
    const many = Array.from({ length: 200 }, (_, i) => quip({ quipId: `q${i}`, text: `line ${i}` }));
    render(<Voice quips={many} />);
    expect(screen.getAllByTestId(/^voice-line-/).length).toBeLessThanOrEqual(6);
  });

  it('animates the newest line in, keyed so React replaces it', () => {
    const { rerender } = render(<Voice quips={[quip({ quipId: 'one', text: 'One' })]} />);
    const first = screen.getByTestId('voice-latest').getAttribute('data-quip');
    rerender(<Voice quips={[quip({ quipId: 'two', text: 'Two' }), quip({ quipId: 'one', text: 'One' })]} />);
    expect(screen.getByTestId('voice-latest').getAttribute('data-quip')).not.toBe(first);
  });
});
