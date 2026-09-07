// T-055 acceptance — MIRROR.
// spec: 30-TASKS T-055 · PRD F-A6 · GWT-4
// Non-custodial is the whole point: the server builds an UNSIGNED intent, the
// user's own wallet signs it. The app must never see, request or hold a key.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MirrorButton } from '../components/MirrorButton';
import { isKeyLike } from '../lib/wallet';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const fill = { fillId: 'f1', marketId: 'm1', side: 'YES', sizeContracts: 50, price: 0.42 } as never;
const intent = { sizeContracts: 12, limitPrice: 0.43, marketId: 'm1', side: 'YES',
  tx: { to: '0xpool', data: '0xdead', value: '0', chainId: 50312 }, expiresMs: Date.now() + 60_000 };

const okApi = () => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => intent })));

const wallet = (over: Record<string, unknown> = {}) => ({
  address: '0xuser', sendTransaction: vi.fn(async () => '0xtxhash'), ...over,
});

describe('key safety', () => {
  it('recognises anything key-shaped so it can be refused', () => {
    expect(isKeyLike('0x' + 'a'.repeat(64))).toBe(true);
    expect(isKeyLike('a'.repeat(64))).toBe(true);
    expect(isKeyLike('0xuser')).toBe(false);
    expect(isKeyLike('')).toBe(false);
  });
});

describe('MirrorButton', () => {
  it('is disabled with a reason when no wallet is connected', () => {
    okApi();
    render(<MirrorButton fill={fill} wallet={null} />);
    const btn = screen.getByRole('button', { name: /mirror/i });
    expect(btn).toHaveProperty('disabled', true);
    expect(screen.getByTestId('mirror-note').textContent).toMatch(/connect/i);
  });

  it('requests an intent and shows its size and price before signing', async () => {
    okApi();
    const w = wallet();
    render(<MirrorButton fill={fill} wallet={w as never} />);
    await userEvent.click(screen.getByRole('button', { name: /mirror/i }));
    await waitFor(() => expect(screen.getByTestId('mirror-intent')).toBeTruthy());
    const t = screen.getByTestId('mirror-intent').textContent!;
    expect(t).toContain('12');
    expect(t).toContain('43');
    expect(w.sendTransaction, 'nothing is signed until the user confirms').not.toHaveBeenCalled();
  });

  it('asks the WALLET to sign and never handles a key', async () => {
    okApi();
    const w = wallet();
    render(<MirrorButton fill={fill} wallet={w as never} />);
    await userEvent.click(screen.getByRole('button', { name: /mirror/i }));
    await waitFor(() => screen.getByTestId('mirror-confirm'));
    await userEvent.click(screen.getByTestId('mirror-confirm'));
    await waitFor(() => expect(w.sendTransaction).toHaveBeenCalledTimes(1));
    const arg = JSON.stringify((w.sendTransaction.mock.calls as unknown[][])[0]?.[0]);
    expect(isKeyLike(arg)).toBe(false);
  });

  it('confirms with a link to the transaction (GWT-4)', async () => {
    okApi();
    render(<MirrorButton fill={fill} wallet={wallet() as never} />);
    await userEvent.click(screen.getByRole('button', { name: /mirror/i }));
    await waitFor(() => screen.getByTestId('mirror-confirm'));
    await userEvent.click(screen.getByTestId('mirror-confirm'));
    await waitFor(() => expect(screen.getByTestId('mirror-done')).toBeTruthy());
    expect(screen.getByRole('link', { name: /view|explorer/i }).getAttribute('href')).toContain('0xtxhash');
  });

  it('surfaces a user rejection without leaving pending state behind', async () => {
    okApi();
    const w = wallet({ sendTransaction: vi.fn(async () => { throw new Error('User rejected the request'); }) });
    render(<MirrorButton fill={fill} wallet={w as never} />);
    await userEvent.click(screen.getByRole('button', { name: /mirror/i }));
    await waitFor(() => screen.getByTestId('mirror-confirm'));
    await userEvent.click(screen.getByTestId('mirror-confirm'));
    await waitFor(() => expect(screen.getByTestId('mirror-error').textContent).toMatch(/rejected/i));
    expect(screen.queryByTestId('mirror-pending')).toBeNull();
    expect(screen.getByRole('button', { name: /mirror/i })).toHaveProperty('disabled', false);
  });

  it('reports a refused intent in the server\'s own words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: 'no trade to mirror yet' }) })));
    render(<MirrorButton fill={fill} wallet={wallet() as never} />);
    await userEvent.click(screen.getByRole('button', { name: /mirror/i }));
    await waitFor(() => expect(screen.getByTestId('mirror-error').textContent).toMatch(/no trade to mirror/i));
  });
});
