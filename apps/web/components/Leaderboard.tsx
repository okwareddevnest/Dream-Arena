// The human leaderboard.
//
// Scored by Brier, which is a LOSS: lower is better, so rank 1 is the SMALLEST
// score. Sorting this the familiar "biggest number wins" way would put the worst
// forecaster on top, which is why the ordering is asserted in the tests.
// spec: PRD F-A5 · IF §11

export interface Score { userAddr: string; brier: number; rank: number; payoutUsd: number }

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function Leaderboard({ scores, userAddr }: { scores: Score[]; userAddr?: string }) {
  if (!scores.length) {
    return (
      <p data-testid="lb-empty" className="py-5 text-base text-ink-faint">
        No forecasts yet. Call a market to join the round.
      </p>
    );
  }
  const ranked = [...scores].sort((a, b) => a.brier - b.brier);
  return (
    <ol className="divide-y divide-line">
      {ranked.map((s, i) => {
        const you = userAddr && s.userAddr.toLowerCase() === userAddr.toLowerCase();
        return (
          <li
            key={s.userAddr}
            data-testid={`lb-row-${s.userAddr}`}
            data-addr={s.userAddr}
            {...(you ? { 'data-you': 'true' } : {})}
            className={`grid grid-cols-[1.5rem_1fr_auto] items-baseline gap-4 py-2.5 text-base ${
              you ? 'text-accent' : 'text-ink'
            }`}
          >
            <span className="font-mono tabular-nums text-ink-faint">{i + 1}</span>
            <span className="truncate font-mono">{short(s.userAddr)}</span>
            <span className="font-mono tabular-nums text-ink-muted">{s.brier.toFixed(3)}</span>
          </li>
        );
      })}
    </ol>
  );
}
