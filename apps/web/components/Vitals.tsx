'use client';
// What the agent is doing right now.
//
// The number that matters most is the GAP between enters and orders: how many
// trades the model wanted versus how many the risk guard allowed. That gap was
// unreadable for most of this build because `enters` was a declared-but-never-
// incremented counter, so it is surfaced explicitly here.

export interface EngineStats {
  ticks: number; valuations: number; skips: number; enters: number;
  ordersPlaced: number; orderErrors: number; quoteErrors: number; vetoes: number;
}
export interface HealthLite { ok: boolean; tickLagMs: number; killSwitch: boolean }

function Row({ id, label, value, tone = 'text-ink' }: { id?: string; label: string; value: string; tone?: string }) {
  return (
    <div data-testid={id} className="flex items-baseline justify-between py-1.5">
      <span className="text-sm text-ink-faint">{label}</span>
      <span className={`font-mono text-base tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

export function Vitals({ stats, health }: { stats: EngineStats | null; health: HealthLite | null }) {
  if (!stats) {
    return <p data-testid="vitals-empty" className="text-sm text-ink-faint">Waiting for the agent.</p>;
  }
  const held = Math.max(0, stats.enters - stats.ordersPlaced);
  return (
    <div className="divide-y divide-line">
      {health?.killSwitch ? (
        <p data-testid="vital-kill" className="py-2 text-base text-short">Trading stopped by the kill switch.</p>
      ) : null}
      <Row id="vital-ticks" label="Price updates" value={String(stats.ticks)} />
      <Row label="Markets priced" value={String(stats.valuations)} />
      <Row label="Skipped" value={String(stats.skips)} tone="text-ink-muted" />
      <Row label="Wanted to trade" value={String(stats.enters)} />
      <Row id="vital-orders" label="Orders placed" value={String(stats.ordersPlaced)} tone="text-accent" />
      <Row id="vital-held" label="Held back by risk" value={String(held)} tone={held ? 'text-warn' : 'text-ink-muted'} />
      {stats.orderErrors + stats.quoteErrors > 0 ? (
        <Row label="Errors" value={String(stats.orderErrors + stats.quoteErrors)} tone="text-short" />
      ) : null}
      {health ? (
        <Row label="Tick lag" value={`${health.tickLagMs} ms`} tone={health.tickLagMs > 5000 ? 'text-warn' : 'text-ink-muted'} />
      ) : null}
    </div>
  );
}
