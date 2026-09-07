'use client';
// The markets MIRA is watching, soonest to expire first.
//
// Ordering by time-to-expiry is the useful order here: these series roll every
// few minutes, so the top of this list is what is about to resolve.

export interface RailMarket { id: string; symbol: string; asset: string; expiryMs: number }

const URGENT_MS = 60_000;

export function timeLeft(expiryMs: number, nowMs: number): string {
  const ms = expiryMs - nowMs;
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function MarketRail({ markets, nowMs }: { markets: RailMarket[]; nowMs: number }) {
  if (!markets.length) {
    return <p className="text-sm text-ink-faint">No markets yet.</p>;
  }
  const sorted = [...markets].sort((a, b) => a.expiryMs - b.expiryMs);
  return (
    <ul className="divide-y divide-line">
      {sorted.map((m) => {
        const urgent = m.expiryMs - nowMs <= URGENT_MS && m.expiryMs > nowMs;
        return (
          <li
            key={m.id} data-testid={`rail-${m.id}`} data-id={m.id}
            {...(urgent ? { 'data-urgent': 'true' } : {})}
            className="flex items-baseline justify-between gap-3 py-2.5 text-base"
          >
            <span className="truncate text-ink">{m.symbol}</span>
            <span className={`font-mono tabular-nums ${urgent ? 'text-warn' : 'text-ink-faint'}`}>
              {timeLeft(m.expiryMs, nowMs)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
