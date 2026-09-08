'use client';
// Wallet discovery and connection, via EIP-6963.
//
// `window.ethereum` is a single slot that whichever extension loads last claims,
// so with two wallets installed the user has no say in which one they use.
// EIP-6963 fixes it properly: the page asks, every installed wallet ANNOUNCES
// itself with a name and icon, and the person picks. It is a browser standard —
// no SDK, no project id, no paid tier, nothing to sign up for.
//
// A legacy `window.ethereum` is still offered as a last resort so older wallets
// are not shut out.

export const SOMNIA_CHAIN_ID = 50312;
const HEX_CHAIN = `0x${SOMNIA_CHAIN_ID.toString(16)}`;

export interface WalletInfo { uuid: string; name: string; rdns: string; icon: string }
export interface Eip1193 { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
export interface DiscoveredWallet { info: WalletInfo; provider: Eip1193 }
export interface Connected {
  address: string; name: string; rdns: string; icon: string; provider: Eip1193;
  sendTransaction(tx: { to: string; data: string; value?: string }): Promise<string>;
}

/** Ask every installed wallet to announce itself, and collect the replies. */
export function discoverWallets(waitMs = 350): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') { resolve([]); return; }
    const byUuid = new Map<string, DiscoveredWallet>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as DiscoveredWallet | undefined;
      if (!d?.info?.uuid || byUuid.has(d.info.uuid)) return;
      byUuid.set(d.info.uuid, d);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      const found = [...byUuid.values()];
      // Older wallets predate the standard; offer them rather than exclude them.
      const legacy = (globalThis as { ethereum?: Eip1193 }).ethereum;
      if (!found.length && legacy) {
        found.push({
          info: { uuid: 'legacy', name: 'Injected wallet', rdns: 'legacy.injected', icon: '' },
          provider: legacy,
        });
      }
      resolve(found.sort((a, b) => a.info.name.localeCompare(b.info.name)));
    }, waitMs);
  });
}

/**
 * Connect to one chosen wallet. Returns null on a rejection — declining is a
 * normal outcome, not an exception the UI should have to catch.
 */
export async function connectTo(w: DiscoveredWallet): Promise<Connected | null> {
  try {
    const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[];
    const address = accounts?.[0];
    if (!address) return null;

    // Offer to move to Somnia if they are elsewhere. If they decline, they stay
    // connected — reading the arena does not require the right chain, only
    // signing does, and the wallet will refuse that itself.
    const chainId = (await w.provider.request({ method: 'eth_chainId' })) as string;
    if (chainId?.toLowerCase() !== HEX_CHAIN) {
      await w.provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: HEX_CHAIN }],
      }).catch(async () => {
        // Not added yet: offer to add it, with the public endpoints.
        await w.provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: HEX_CHAIN,
            chainName: 'Somnia Testnet',
            nativeCurrency: { name: 'Somnia Test Token', symbol: 'STT', decimals: 18 },
            rpcUrls: ['https://api.infra.testnet.somnia.network'],
            blockExplorerUrls: ['https://shannon-explorer.somnia.network'],
          }],
        }).catch(() => undefined);
      });
    }

    return {
      address,
      name: w.info.name,
      rdns: w.info.rdns,
      icon: w.info.icon,
      provider: w.provider,
      // Only an UNSIGNED transaction crosses this boundary; the key stays in the
      // wallet, which is the entire point.
      async sendTransaction(tx) {
        return (await w.provider.request({
          method: 'eth_sendTransaction',
          params: [{ from: address, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }],
        })) as string;
      },
    };
  } catch {
    return null;
  }
}
