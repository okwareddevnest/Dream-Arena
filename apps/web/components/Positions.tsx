'use client';
// MIRA's open positions — what it is actually holding, from chain truth.
export interface Position {
  marketId: string; agent: string; netContracts: number;
  avgPrice: number; unrealizedPnlUsd: number;
}
const short = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

export function Positions({ positions }: { positions: Position[] }) {
  if (!positions.length) {
    return <p data-testid="pos-empty" className="text-sm text-ink-faint">Flat — no open positions.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {positions.map((p) => {
        const side = p.netContracts >= 0 ? 'YES' : 'NO';
        return (
          <li
            key={p.marketId} data-testid={`pos-${p.marketId}`} data-side={side}
            className="grid grid-cols-[1fr_auto] items-baseline gap-3 py-2.5 text-base"
          >
            <span className="truncate font-mono text-ink-faint">{short(p.marketId)}</span>
            <span className="font-mono tabular-nums">
              <span className={side === 'YES' ? 'text-long' : 'text-short'}>{side}</span>
              <span className="ml-2 text-ink">{Math.abs(p.netContracts)}</span>
              <span className="ml-2 text-ink-faint">@{(p.avgPrice * 100).toFixed(0)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
