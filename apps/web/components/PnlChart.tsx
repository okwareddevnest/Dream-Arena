// MIRA's realised PnL over the session.
//
// A sparkline, not a chart with furniture: the arena already carries a lot of
// numbers, and this one earns its place by showing shape — up, down, or flat —
// rather than precision. The exact figure is stated once, in words.
// spec: PRD F-A1 · IF §11

import { LineChart } from './LineChart';

export interface PnlPoint { tsMs: number; pnlUsd: number }

export function PnlChart({ series }: { series: PnlPoint[] }) {
  if (!series.length) {
    return (
      <p data-testid="pnl-empty" className="py-5 text-base text-ink-faint">
        No realised profit or loss yet.
      </p>
    );
  }
  const latest = series[series.length - 1]!.pnlUsd;
  const up = latest >= 0;
  return (
    <div>
      <div
        data-testid="pnl-latest"
        className={`font-mono text-3xl tabular-nums ${up ? 'text-long' : 'text-short'}`}
      >
        {up ? '+' : '−'}{Math.abs(latest).toFixed(2)}
        <span className="ml-1.5 text-base text-ink-faint">USD</span>
      </div>
      {/* Drawn in measured pixel space with a pinned stroke — see lib/chart.ts. */}
      <div className="mt-2">
        <LineChart
          points={series.map((p, i) => ({ x: i, y: p.pnlUsd }))}
          tone={up ? 'text-long' : 'text-short'}
          height={104}
          baselineAt={0}
          formatY={(v) => (v === 0 ? '0' : v.toFixed(0))}
          label="MIRA realised profit and loss"
        />
      </div>

    </div>
  );
}
