'use client';
// Wallet access — non-custodial, by construction.
//
// The app asks the user's wallet to sign. It never receives, requests, stores or
// transmits a private key, and there is no code path that could: the only thing
// crossing this boundary is an unsigned transaction going out and a hash coming
// back. `isKeyLike` exists so that promise is TESTABLE rather than merely stated.
// spec: PRD F-A6 · GWT-4

export interface UnsignedTx { to: string; data: string; value?: string; chainId?: number }
export interface Wallet {
  address: string;
  sendTransaction(tx: UnsignedTx): Promise<string>;
}

/** Does this string look like a private key or seed? Used to assert that none
 *  ever reaches us — a 64-hex blob has no business in this app. */
export function isKeyLike(s: string): boolean {
  if (!s) return false;
  return /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/.test(s);
}

interface Eip1193 {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Connect to an injected EIP-1193 wallet, or null if the browser has none. */
export async function connectWallet(): Promise<Wallet | null> {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) return null;
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts?.[0];
  if (!address) return null;
  return {
    address,
    async sendTransaction(tx: UnsignedTx) {
      // Only ever an UNSIGNED transaction goes out; the wallet holds the key.
      return (await eth.request({
        method: 'eth_sendTransaction',
        params: [{ from: address, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }],
      })) as string;
    },
  };
}
