'use client';
// Why MIRA is NOT trading.
//
// Most of the time an agent's most informative output is its refusals, and this
// system produces named ones. Showing the raw enum would be showing internals;
// each is translated, so a reader learns what the agent is waiting for.

export interface SkipLike { skipReason: string | null }

/** Commonest refusal first. Priced markets are not refusals. */
export function tallySkips(valuations: SkipLike[]): { reason: string; count: number }[] {
  const n = new Map<string, number>();
  for (const v of valuations) {
    if (!v?.skipReason) continue;
    n.set(v.skipReason, (n.get(v.skipReason) ?? 0) + 1);
  }
  return [...n.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/** Plain English for each refusal the pricer can produce. */
const MEANING: Record<string, string> = {
  BOUNDARY_NOT_POSTED: 'the opening price this market settles against has not been published yet',
  EXPIRED: 'the market is past its expiry',
  DEGENERATE: 'the inputs cannot produce a probability',
  NEGATIVE_DISCRIMINANT: 'no volatility could produce the price being asked, so the quote is unattainable',
  STALE_QUOTE: 'the book has not updated recently enough to trust',
  NO_QUOTE: 'the venue returned no book for this market',
};

export function SkipReasons({ valuations }: { valuations: SkipLike[] }) {
  const rows = tallySkips(valuations);
  if (!rows.length) {
    return (
      <p data-testid="skip-none" className="text-sm text-ink-faint">
        Every market is priceable right now.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {rows.map(({ reason, count }) => (
        <li key={reason} data-testid={`skip-${reason}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-sm text-ink-muted">{reason.toLowerCase().replace(/_/g, ' ')}</span>
            <span className="font-mono text-base tabular-nums text-ink">{count}</span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-ink-faint">
            {MEANING[reason] ?? 'the pricer declined this market'}
          </p>
        </li>
      ))}
    </ul>
  );
}
