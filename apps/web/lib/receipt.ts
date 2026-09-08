'use client';
// Read a transaction receipt straight from the chain, in the browser.
//
// The tape used to offer only a link to the explorer. Clicking it opens a
// background tab and leaves you on the site with nothing shown — which is not
// evidence, it is a promise of evidence. This fetches the receipt over plain
// JSON-RPC (no library, nothing to bundle) so the confirmation appears on the
// page, next to the trade it belongs to.

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://api.infra.testnet.somnia.network';

export interface ReceiptView {
  found: boolean;
  success: boolean;
  blockNumber?: number;
  gasUsed?: number;
  logs?: number;
  error?: boolean;
}

export async function fetchReceipt(hash: string): Promise<ReceiptView> {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
      signal: AbortSignal.timeout(10_000),
    });
    const { result } = await res.json();
    // A null result is a real answer: the chain has not seen this hash.
    if (!result) return { found: false, success: false };
    return {
      found: true,
      success: result.status === '0x1',
      blockNumber: Number(result.blockNumber),
      gasUsed: Number(result.gasUsed),
      logs: Array.isArray(result.logs) ? result.logs.length : 0,
    };
  } catch {
    // Unreachable RPC is not the same as a failed transaction, and must not be
    // shown as one.
    return { found: false, success: false, error: true };
  }
}

export function formatReceipt(r: ReceiptView): string {
  if (r.error) return 'Could not reach the chain to check.';
  if (!r.found) return 'Not yet on chain — it may still be propagating.';
  if (!r.success) return `Reverted on chain in block ${r.blockNumber}.`;
  return `Confirmed on chain in block ${r.blockNumber} · ${r.gasUsed?.toLocaleString()} gas · ${r.logs} events.`;
}
