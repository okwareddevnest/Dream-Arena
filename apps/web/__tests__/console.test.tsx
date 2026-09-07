// T-057 acceptance — the director console.
// spec: 30-TASKS T-057 · PRD F-A7 · GWT-7,GWT-8
// The console can stop a live trading agent, so every control is token-gated and
// the page refuses to render its controls without one.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Console } from '../components/Console';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const health = (over: Record<string, unknown> = {}) => ({
  ok: true, killSwitch: false, tickLagMs: 300, tickLagAlarmMs: 5_000, mode: 'LIVE',
  components: { venue: { ok: true }, ingester: { ok: true } }, ...over,
});
const okFetch = () => {
  const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ killSwitch: true }) }));
  vi.stubGlobal('fetch', f);
  return f;
};

describe('Console', () => {
  it('refuses to show controls without an operator token', () => {
    okFetch();
    render(<Console token="" health={health()} scenarios={[]} />);
    expect(screen.getByTestId('console-locked').textContent).toMatch(/token/i);
    expect(screen.queryByRole('button', { name: /stop trading/i })).toBeNull();
  });

  it('stops trading through the console endpoint and reflects it', async () => {
    const f = okFetch();
    render(<Console token="t0k" health={health()} scenarios={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /stop trading/i }));
    await waitFor(() => expect(f).toHaveBeenCalled());
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/console/kill');
    expect(JSON.parse(String(init.body))).toMatchObject({ on: true });
    expect(String((init.headers as Record<string, string>)['x-operator-token'])).toBe('t0k');
  });

  it('shows the killed state and offers to resume', () => {
    okFetch();
    render(<Console token="t0k" health={health({ killSwitch: true })} scenarios={[]} />);
    expect(screen.getByTestId('kill-state').textContent).toMatch(/stopped/i);
    expect(screen.getByRole('button', { name: /resume/i })).toBeTruthy();
  });

  it('turns a component tile red when it reports not-ok', () => {
    okFetch();
    render(<Console token="t0k" health={health({ components: { venue: { ok: false }, bus: { ok: true } } })} scenarios={[]} />);
    expect(screen.getByTestId('tile-venue').dataset.ok).toBe('false');
    expect(screen.getByTestId('tile-bus').dataset.ok).toBe('true');
  });

  it('shows tick lag and flags it past the alarm threshold', () => {
    okFetch();
    const { rerender } = render(<Console token="t" health={health({ tickLagMs: 400 })} scenarios={[]} />);
    expect(screen.getByTestId('tick-lag').dataset.alarm).toBe('false');
    rerender(<Console token="t" health={health({ tickLagMs: 9_000 })} scenarios={[]} />);
    expect(screen.getByTestId('tick-lag').dataset.alarm).toBe('true');
    expect(screen.getByTestId('tick-lag').textContent).toContain('9000');
  });

  it('lists the scenarios the server offers and posts the chosen name', async () => {
    const f = okFetch();
    render(<Console token="t0k" health={health()} scenarios={['vol_spike', 'flat_market']} />);
    await userEvent.click(screen.getByRole('button', { name: /vol_spike/i }));
    await waitFor(() => expect(f).toHaveBeenCalled());
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/console/scenario');
    expect(JSON.parse(String(init.body))).toMatchObject({ name: 'vol_spike' });
  });

  it('reports a rejected command instead of pretending it worked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'operator token required' }) })));
    render(<Console token="wrong" health={health()} scenarios={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /stop trading/i }));
    await waitFor(() => expect(screen.getByTestId('console-error').textContent).toMatch(/operator token/i));
  });
});
