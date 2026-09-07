// T-057 (badge half) — the LIVE / SIM indicator.
// spec: 30-TASKS T-057 · GWT-8 · RFC-003
// RFC-003 makes LIVE the demo path, so this badge is the claim the whole demo
// rests on: it must read from the server's snapshot, never from a build flag or
// a hopeful default, or it could assert LIVE while showing simulated data.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ModeBadge, ConnectionDot } from '../components/ModeBadge';

afterEach(cleanup);

describe('ModeBadge', () => {
  it('reads LIVE from the server', () => {
    render(<ModeBadge mode="LIVE" />);
    const b = screen.getByTestId('mode-badge');
    expect(b.textContent).toContain('LIVE');
    expect(b.dataset.mode).toBe('LIVE');
  });

  it('reads SIM from the server', () => {
    render(<ModeBadge mode="SIM" />);
    expect(screen.getByTestId('mode-badge').dataset.mode).toBe('SIM');
  });

  it('claims neither until the server has said which', () => {
    render(<ModeBadge mode={null} />);
    const b = screen.getByTestId('mode-badge');
    expect(b.dataset.mode).toBe('unknown');
    expect(b.textContent).not.toContain('LIVE');
    expect(b.textContent).not.toContain('SIM');
  });
});

describe('ConnectionDot', () => {
  it('is quiet while the feed is fresh', () => {
    render(<ConnectionDot connected stale={false} ageMs={200} />);
    expect(screen.getByTestId('conn').dataset.state).toBe('live');
  });

  it('reports the age when the feed goes stale but stays connected', () => {
    render(<ConnectionDot connected stale ageMs={8_400} />);
    const el = screen.getByTestId('conn');
    expect(el.dataset.state).toBe('stale');
    expect(el.textContent).toContain('8s');
  });

  it('says plainly when the feed has dropped', () => {
    render(<ConnectionDot connected={false} stale ageMs={30_000} />);
    const el = screen.getByTestId('conn');
    expect(el.dataset.state).toBe('down');
    expect(el.textContent).toMatch(/reconnect/i);
  });
});
