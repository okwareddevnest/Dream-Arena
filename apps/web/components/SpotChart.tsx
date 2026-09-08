'use client';
// The underlying, as MIRA sees it.
//
// This is the input to every valuation on the page, so it belongs next to them.
// The series is accumulated from the live tick stream — there is no historical
// endpoint, so a fresh page genuinely has no history and says so rather than
// drawing a single reading as though it were a trend.
import { LineChart } from './LineChart';

export interface SpotPoint { tsMs: number; price: number }

export function SpotChart({ symbol, series }: { symbol: string; series: SpotPoint[] }) {
  if (series.length < 2) {
    return (
      <p data-testid="spot-collecting" className="py-6 text-sm text-ink-faint">
        Collecting {symbol} prices. The curve appears once there is a window to draw.
      </p>
    );
  }
  const first = series[0]!.price;
  const last = series[series.length - 1]!.price;
  const change = last - first;
  const up = change >= 0;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span
          data-testid="spot-last"
          className="font-mono text-2xl tabular-nums text-ink"
        >
          {last.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </span>
        <span
          data-testid="spot-change"
          className={`font-mono text-base tabular-nums ${up ? 'text-long' : 'text-short'}`}
        >
          {up ? '+' : '−'}{Math.abs(change).toFixed(2)}
        </span>
      </div>
      <div className="mt-3">
        <LineChart
          points={series.map((p, i) => ({ x: i, y: p.price }))}
          tone={up ? 'text-long' : 'text-short'}
          height={112}
          formatY={(v) => v.toFixed(0)}
          label={`${symbol} spot price`}
        />
      </div>
    </div>
  );
}
