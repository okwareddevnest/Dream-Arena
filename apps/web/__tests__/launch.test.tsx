// Launch page acceptance.
// The entry point has one job: say what this is, prove it is real, and get the
// visitor into the arena. Its numbers come from the LIVE api — and when the api
// is unreachable it says so rather than showing a plausible-looking zero.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import LaunchPage from '../app/page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stubApi = (health: unknown, snapshot: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    ({ ok: true, json: async () => (String(url).includes('health') ? health : snapshot) })));
};

describe('LaunchPage', () => {
  it('states what the product is, in the hero', () => {
    stubApi({}, {});
    render(<LaunchPage />);
    const main = screen.getByRole('main');
    expect(main.textContent).toMatch(/MIRA/);
    expect(main.textContent!.length).toBeGreaterThan(120);
  });

  it('offers a way into the arena from anywhere on the page', () => {
    stubApi({}, {});
    render(<LaunchPage />);
    // Header, hero and footer all lead in; every one of them must actually go there.
    const links = screen.getAllByRole('link', { name: /arena|watch it trade/i });
    expect(links.length).toBeGreaterThan(1);
    for (const l of links) expect(l.getAttribute('href')).toBe('/arena');
  });

  it('explains how the agent decides, as a real sequence', () => {
    stubApi({}, {});
    render(<LaunchPage />);
    const how = screen.getByRole('region', { name: /how it works/i });
    expect(how.textContent).toMatch(/forecast/i);
    expect(how.textContent).toMatch(/quarter-Kelly/i);
  });

  it('states what can be independently checked', () => {
    stubApi({}, {});
    render(<LaunchPage />);
    const v = screen.getByRole('region', { name: /verify/i });
    expect(v.textContent).toMatch(/explorer/i);
    expect(v.textContent, 'the no-fabrication promise is stated plainly').toMatch(/never shows a number it did not compute/i);
  });

  it('shows live figures once the api answers', async () => {
    stubApi({ ok: true, mode: 'LIVE' }, { markets: [{ id: 'a' }, { id: 'b' }], tape: [{ fillId: 'f' }], valuations: [] });
    render(<LaunchPage />);
    await waitFor(() => expect(screen.getByTestId('stat-markets').textContent).toContain('2'));
    expect(screen.getByTestId('stat-mode').textContent).toContain('LIVE');
  });

  it('says the system is offline rather than showing a fake zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
    render(<LaunchPage />);
    await waitFor(() => expect(screen.getByTestId('live-status').textContent).toMatch(/offline|not running/i));
    expect(screen.queryByTestId('stat-markets')).toBeNull();
  });

  it('never claims LIVE before the server has said so', () => {
    stubApi({}, {});
    render(<LaunchPage />);
    expect(screen.queryByTestId('stat-mode')).toBeNull();
  });

  it('carries the brand mark', () => {
    stubApi({}, {});
    render(<LaunchPage />);
    expect(screen.getAllByRole('img', { name: /dream arena/i }).length).toBeGreaterThan(0);
  });
});
