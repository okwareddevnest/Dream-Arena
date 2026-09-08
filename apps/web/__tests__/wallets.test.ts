// Wallet discovery (EIP-6963).
//
// The old code reached for `window.ethereum`, which is whichever extension won
// the race to claim it — with two wallets installed the user has no say. EIP-6963
// is the standard fix: wallets ANNOUNCE themselves, the page collects them, and
// the person chooses. No SDK, no project id, no paid tier.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { discoverWallets, connectTo } from '../lib/wallets';

const announce = (info: { uuid: string; name: string; rdns: string; icon?: string }, provider: unknown) => {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: { info: { icon: 'data:image/svg+xml,<svg/>', ...info }, provider },
  }));
};

// Each test installs a listener that answers the discovery request; without
// removing them, a later test hears the earlier tests' wallets announce too.
const installed: EventListener[] = [];
const onRequest = (fn: EventListener) => {
  window.addEventListener('eip6963:requestProvider', fn);
  installed.push(fn);
};
afterEach(() => {
  for (const fn of installed.splice(0)) window.removeEventListener('eip6963:requestProvider', fn);
  vi.restoreAllMocks();
});

describe('discoverWallets', () => {
  it('collects every wallet that announces itself', async () => {
    onRequest(() => {
      announce({ uuid: 'a', name: 'Rabby', rdns: 'io.rabby' }, { request: vi.fn() });
      announce({ uuid: 'b', name: 'MetaMask', rdns: 'io.metamask' }, { request: vi.fn() });
    });
    const found = await discoverWallets(40);
    expect(found.map((w) => w.info.name)).toEqual(['MetaMask', 'Rabby']);
  });

  it('never lists the same wallet twice, however often it announces', async () => {
    onRequest(() => {
      announce({ uuid: 'a', name: 'Rabby', rdns: 'io.rabby' }, { request: vi.fn() });
      announce({ uuid: 'a', name: 'Rabby', rdns: 'io.rabby' }, { request: vi.fn() });
    });
    expect(await discoverWallets(40)).toHaveLength(1);
  });

  it('returns an empty list rather than throwing when nothing is installed', async () => {
    await expect(discoverWallets(30)).resolves.toEqual([]);
  });

  it('falls back to a legacy injected provider so older wallets still work', async () => {
    (globalThis as { ethereum?: unknown }).ethereum = { request: vi.fn(), isMetaMask: true };
    const found = await discoverWallets(30);
    expect(found).toHaveLength(1);
    expect(found[0]!.info.rdns).toBe('legacy.injected');
    delete (globalThis as { ethereum?: unknown }).ethereum;
  });
});

describe('connectTo', () => {
  const wallet = (accounts: string[], chainId = '0xc488') => ({
    info: { uuid: 'a', name: 'Rabby', rdns: 'io.rabby', icon: '' },
    provider: {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return accounts;
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') return null;
        return null;
      }),
    },
  });

  it('returns an address and the wallet name that produced it', async () => {
    const w = wallet(['0xabc']);
    const c = await connectTo(w as never);
    expect(c!.address).toBe('0xabc');
    expect(c!.name).toBe('Rabby');
  });

  it('asks the wallet to switch when it is on the wrong chain', async () => {
    const w = wallet(['0xabc'], '0x1');
    await connectTo(w as never);
    const methods = w.provider.request.mock.calls.map((c) => (c[0] as { method: string }).method);
    expect(methods).toContain('wallet_switchEthereumChain');
  });

  it('does not ask to switch when already on Somnia', async () => {
    const w = wallet(['0xabc'], '0xc488');
    await connectTo(w as never);
    const methods = w.provider.request.mock.calls.map((c) => (c[0] as { method: string }).method);
    expect(methods).not.toContain('wallet_switchEthereumChain');
  });

  it('returns null when the user approves nothing', async () => {
    expect(await connectTo(wallet([]) as never)).toBeNull();
  });

  it('surfaces a rejection as null rather than throwing at the UI', async () => {
    const w = {
      info: { uuid: 'a', name: 'Rabby', rdns: 'io.rabby', icon: '' },
      provider: { request: vi.fn(async () => { throw new Error('User rejected'); }) },
    };
    await expect(connectTo(w as never)).resolves.toBeNull();
  });

  it('never handles a private key — only addresses cross this boundary', async () => {
    const w = wallet(['0xabc']);
    const c = await connectTo(w as never);
    expect(JSON.stringify(c)).not.toMatch(/[0-9a-f]{64}/i);
  });
});
