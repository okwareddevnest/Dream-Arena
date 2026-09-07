// The trade tape — every fill MIRA and ECHO make, newest first.
//
// The explorer link is the point of this component. PRD F-A1 requires each fill
// to be verifiable on the testnet explorer: it is what separates "the agent says
// it traded" from a judge clicking through and seeing the transaction. A fill
// with no transaction behind it (SIM) says so plainly and offers no dead link.
// spec: PRD F-A1 · IF §5

export const TAPE_ROWS = 60;

export interface TapeFill {
  fillId: string; agent: string; side: string;
  sizeContracts: number; price: number;
  explorerUrl: string | null; txHash: string | null; tsMs: number;
}

const clock = (ms: number) =>
  new Date(ms).toISOString().slice(11, 19);

export function Tape({ fills }: { fills: TapeFill[] }) {
  if (!fills.length) {
    return (
      <p data-testid="tape-empty" className="py-8 text-center text-base text-ink-faint">
        No trades yet. The tape fills as MIRA and ECHO transact.
      </p>
    );
  }
  return (
    <ol className="divide-y divide-line">
      {fills.slice(0, TAPE_ROWS).map((f) => (
        <li
          key={f.fillId}
          data-testid={`tape-row-${f.fillId}`}
          data-agent={f.agent}
          className="grid grid-cols-[4.4rem_3.4rem_1fr_auto] items-baseline gap-4 py-2.5 font-mono text-base tabular-nums"
        >
          <time className="text-ink-faint">{clock(f.tsMs)}</time>
          <span className={f.side === 'YES' ? 'text-long' : 'text-short'}>{f.side}</span>
          <span className="text-ink">
            {f.sizeContracts}
            <span className="text-ink-faint"> @ </span>
            <span data-testid={`tape-price-${f.fillId}`}>{(f.price * 100).toFixed(1)}</span>
            <span className="text-ink-faint">%</span>
            <span className="ml-2 text-ink-muted">{f.agent}</span>
          </span>
          {f.explorerUrl ? (
            <a
              href={f.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={f.txHash ?? undefined}
              className="text-accent underline-offset-2 hover:underline"
            >
              Verify
            </a>
          ) : (
            <span className="text-ink-faint">SIM</span>
          )}
        </li>
      ))}
    </ol>
  );
}
