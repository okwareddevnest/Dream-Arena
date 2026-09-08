'use client';
// The session at a glance — the four numbers that say whether anything is
// happening. Every one is a real counter from the running agent.

export interface Stats { ticks: number; valuations: number; enters: number; ordersPlaced: number }

function Figure({ id, value, label, tone = 'text-ink' }: {
  id: string; value: string; label: string; tone?: string;
}) {
  return (
    <div data-testid={id} className="min-w-0">
      <div className={`font-mono text-2xl tabular-nums ${tone}`}>{value}</div>
      <div className="mt-1 truncate text-sm text-ink-faint">{label}</div>
    </div>
  );
}

export function SessionStrip({
  stats, tape, positions,
}: { stats: Stats | null; tape: unknown[]; positions: unknown[] }) {
  const held = stats ? Math.max(0, stats.enters - stats.ordersPlaced) : 0;
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
      <Figure id="sess-priced" value={String(stats?.valuations ?? 0)} label="markets priced" />
      <Figure id="sess-fills" value={String(tape.length)} label="trades filled" tone="text-gold" />
      <Figure id="sess-open" value={String(positions.length)} label="positions open" />
      <Figure
        id="sess-held"
        value={String(held)}
        label="held back by risk"
        tone={held ? 'text-warn' : 'text-ink-muted'}
      />
    </div>
  );
}
