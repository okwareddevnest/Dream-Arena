'use client';
// MIRROR — copy MIRA's trade with your own wallet.
//
// Two deliberate steps: fetch the intent, SHOW it, then sign. A one-click
// "mirror" that signs immediately would be asking someone to approve a
// transaction whose size and price they never saw. The server builds the
// unsigned intent; the wallet signs it; this component never touches a key.
// spec: PRD F-A6 · GWT-4
import { useState } from 'react';
import type { Wallet, UnsignedTx } from '../lib/wallet';

const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';
const EXPLORER = 'https://shannon-explorer.somnia.network/tx/';

export interface MirrorFill { fillId: string; marketId: string; side: string; sizeContracts: number; price: number }
interface Intent { sizeContracts: number; limitPrice: number; side: string; tx: UnsignedTx }

type Phase =
  | { k: 'idle' } | { k: 'fetching' } | { k: 'review'; intent: Intent }
  | { k: 'signing'; intent: Intent } | { k: 'done'; hash: string } | { k: 'error'; msg: string };

export function MirrorButton({
  fill, wallet, balanceUsd = 0,
}: { fill: MirrorFill | null; wallet: Wallet | null; balanceUsd?: number }) {
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const busy = phase.k === 'fetching' || phase.k === 'signing';

  async function requestIntent() {
    if (!wallet || !fill) return;
    setPhase({ k: 'fetching' });
    try {
      const res = await fetch(`${API}/api/mirror`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userAddr: wallet.address, userBalanceUsd: balanceUsd, fillId: fill.fillId }),
      });
      const body = await res.json();
      if (!res.ok) { setPhase({ k: 'error', msg: body?.error ?? 'The arena could not build that intent.' }); return; }
      setPhase({ k: 'review', intent: body as Intent });
    } catch {
      setPhase({ k: 'error', msg: 'Could not reach the arena.' });
    }
  }

  async function sign(intent: Intent) {
    if (!wallet) return;
    setPhase({ k: 'signing', intent });
    try {
      const hash = await wallet.sendTransaction(intent.tx);
      setPhase({ k: 'done', hash });
    } catch (e) {
      // A rejection is a normal outcome, not a failure: say so and reset, so the
      // button is immediately usable again with nothing left pending.
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ k: 'error', msg: /reject|denied/i.test(msg) ? 'You rejected the transaction.' : msg });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={!wallet || !fill || busy}
        onClick={() => void requestIntent()}
        className="inline-flex items-center justify-center border border-accent rounded px-5 py-2.5 text-base text-accent transition-colors hover:bg-accent hover:text-bg disabled:border-line disabled:text-ink-faint disabled:hover:bg-transparent disabled:hover:text-ink-faint"
      >
        {phase.k === 'fetching' ? 'Building…' : 'Mirror this trade'}
      </button>

      {!wallet ? (
        <p data-testid="mirror-note" className="text-sm text-ink-faint">
          Connect a wallet to mirror. Your keys stay in your wallet.
        </p>
      ) : null}

      {phase.k === 'review' || phase.k === 'signing' ? (
        <div data-testid="mirror-intent" className="rounded-card border border-line p-4 text-base">
          <p className="text-ink">
            Buy <span className="font-mono tabular-nums">{phase.intent.sizeContracts}</span>{' '}
            {phase.intent.side} at{' '}
            <span className="font-mono tabular-nums">{(phase.intent.limitPrice * 100).toFixed(1)}%</span>
          </p>
          <p className="mt-1 text-ink-faint">Your wallet will ask you to approve this. Nothing is signed until you do.</p>
          <button
            type="button"
            data-testid="mirror-confirm"
            disabled={phase.k === 'signing'}
            onClick={() => void sign(phase.intent)}
            className="mt-3 rounded border border-accent px-4 py-2 text-accent hover:bg-accent hover:text-bg"
          >
            {phase.k === 'signing' ? 'Waiting for your wallet…' : 'Approve in wallet'}
          </button>
          {phase.k === 'signing' ? <span data-testid="mirror-pending" className="sr-only">pending</span> : null}
        </div>
      ) : null}

      {phase.k === 'done' ? (
        <p data-testid="mirror-done" className="text-base text-long">
          Mirrored.{' '}
          <a href={`${EXPLORER}${phase.hash}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            View transaction
          </a>
        </p>
      ) : null}

      {phase.k === 'error' ? (
        <p data-testid="mirror-error" className="text-base text-short">{phase.msg}</p>
      ) : null}
    </div>
  );
}
