// The trade tape — every fill MIRA and ECHO make, newest first.
//
// The explorer link is the point of this component. PRD F-A1 requires each fill
// to be verifiable on the testnet explorer: it is what separates "the agent says
// it traded" from a judge clicking through and seeing the transaction. A fill
// with no transaction behind it (SIM) says so plainly and offers no dead link.
// spec: PRD F-A1 · IF §5

'use client';
import { useState } from 'react';
import { fetchReceipt, formatReceipt, type ReceiptView } from '../lib/receipt';

export const TAPE_ROWS = 60;

export interface TapeFill {
  fillId: string; agent: string; side: string;
  sizeContracts: number; price: number;
  explorerUrl: string | null; txHash: string | null; tsMs: number;
}

const clock = (ms: number) =>
  new Date(ms).toISOString().slice(11, 19);

export function Tape({ fills }: { fills: TapeFill[] }) {
  // Verification happens ON THE PAGE. A link to the explorer opens a background
  // tab and leaves the viewer looking at the same screen with nothing shown —
  // that is a promise of evidence, not evidence.
  const [checked, setChecked] = useState<Record<string, ReceiptView | 'checking'>>({});
  const verify = (f: TapeFill) => {
    if (!f.txHash) return;
    setChecked((c) => ({ ...c, [f.fillId]: 'checking' }));
    void fetchReceipt(f.txHash).then((r) => setChecked((c) => ({ ...c, [f.fillId]: r })));
  };
  if (!fills.length) {
    return (
      <p data-testid="tape-empty" className="py-8 text-center text-base text-ink-faint">
        No trades yet. The tape fills as MIRA and ECHO transact.
      </p>
    );
  }
  return (
    <ol className="divide-y divide-line">
      {fills.slice(0, TAPE_ROWS).map((f, i) => (
        <li
          key={f.fillId}
          data-testid={`tape-row-${f.fillId}`}
          data-agent={f.agent}
          className={`grid grid-cols-[4.4rem_3.4rem_1fr_auto] items-baseline gap-4 rounded px-2 py-2.5 font-mono text-base tabular-nums ${
            i === 0 ? 'land' : ''
          }`}
        >
          <time className="text-ink-faint">{clock(f.tsMs)}</time>
          <span className={f.side === 'YES' ? 'text-long' : 'text-short'}>{f.side}</span>
          <span className="text-ink">
            {f.sizeContracts}
            <span className="text-ink-faint"> @ </span>
            <span data-testid={`tape-price-${f.fillId}`}>{(f.price * 100).toFixed(1)}</span>
            <span className="text-ink-faint">%</span>
            <span className={`ml-2 ${f.agent === 'ECHO' ? 'text-echo' : 'text-accent'}`}>{f.agent}</span>
          </span>
          {f.txHash ? (
            <button
              type="button"
              data-testid={`verify-${f.fillId}`}
              onClick={() => verify(f)}
              title={f.txHash}
              className="rounded border border-line px-2 py-1 text-sm text-accent hover:border-accent"
            >
              {checked[f.fillId] === 'checking' ? 'checking…' : 'Verify'}
            </button>
          ) : (
            <span className="text-ink-faint">SIM</span>
          )}
          {checked[f.fillId] && checked[f.fillId] !== 'checking' ? (
            <p
              data-testid={`receipt-${f.fillId}`}
              className={`col-span-4 mt-1 font-sans text-sm ${
                (checked[f.fillId] as ReceiptView).success ? 'text-long' : 'text-warn'
              }`}
            >
              {formatReceipt(checked[f.fillId] as ReceiptView)}{' '}
              {f.explorerUrl ? (
                <a
                  href={f.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline underline-offset-2"
                >
                  Open in explorer
                </a>
              ) : null}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
