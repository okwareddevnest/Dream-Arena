// The divergence board — the arena's hero.
//
// One shared probability axis, 0 on the left and 1 on the right, with two marks:
// what MIRA's model believes, and what the market is pricing. The span between
// them is the edge, and it is the only saturated thing on the page, so a large
// divergence is visible from across a room. Stacking every market on the SAME
// axis is what makes ten of them comparable at a glance.
//
// A skipped valuation shows why it was skipped and draws no span at all: a market
// MIRA refuses to price must never look like an opportunity (GWT-3).
// spec: PRD F-A1 · GWT-1 · GWT-3 · IF §3

export interface GaugeMarket { id: string; symbol: string; asset: string; expiryMs?: number }
export interface GaugeValuation {
  marketId: string; pModel: number; pMarket: number; edge: number;
  skipReason: string | null;
}

/** A probability as a position on the axis, clamped to it. */
export function markPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p * 100));
}

const pct = (p: number) => `${(p * 100).toFixed(1)}`;

export function Gauge({
  market, valuation, edgeIn,
}: { market: GaugeMarket; valuation: GaugeValuation | null; edgeIn: number }) {
  const skipped = valuation?.skipReason != null;
  const state = valuation === null ? 'waiting' : skipped ? 'skipped'
    : Math.abs(valuation.edge) >= edgeIn ? 'diverged' : 'quiet';

  const model = valuation && !skipped ? markPercent(valuation.pModel) : null;
  const market_ = valuation && !skipped ? markPercent(valuation.pMarket) : null;
  const lo = model !== null && market_ !== null ? Math.min(model, market_) : 0;
  const hi = model !== null && market_ !== null ? Math.max(model, market_) : 0;

  return (
    <div
      data-testid="gauge-row"
      data-state={state}
      className="group grid grid-cols-[11rem_1fr_6.5rem] items-center gap-5 border-b border-line py-3.5 last:border-b-0"
    >
      {/* identity */}
      <div className="min-w-0">
        <div className="truncate text-base text-ink">{market.symbol}</div>
        <div className="mt-0.5 text-sm text-ink-faint">{market.asset}</div>
      </div>

      {/* the axis */}
      <div data-testid="axis" className="relative h-9">
        {/* 0 -> 1 rule, with a midpoint reference at even odds */}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
        <div className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-line" />

        {state === 'diverged' || state === 'quiet' ? (
          <>
            <div
              data-testid="gap"
              className={`absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full ${
                state === 'diverged' ? 'bg-accent' : 'bg-ink-faint'
              }`}
              style={{ left: `${lo}%`, width: `${hi - lo}%` }}
            />
            <span
              data-testid="mark-market"
              title="market price"
              className="absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-ink-muted"
              style={{ left: `${market_}%` }}
            />
            <span
              data-testid="mark-model"
              title="MIRA's model"
              className={`absolute top-1/2 h-6 w-[2px] -translate-x-1/2 -translate-y-1/2 ${
                state === 'diverged' ? 'bg-accent' : 'bg-ink-muted'
              }`}
              style={{ left: `${model}%` }}
            />
          </>
        ) : (
          <div className="absolute inset-y-0 left-0 flex items-center">
            <span className="text-sm text-ink-faint">
              {state === 'skipped' ? valuation?.skipReason : 'Awaiting first tick'}
            </span>
          </div>
        )}
      </div>

      {/* the numbers */}
      <div className="text-right font-mono text-lg tabular-nums">
        {state === 'diverged' || state === 'quiet' ? (
          <>
            <div data-testid="p-model" className={state === 'diverged' ? 'text-accent' : 'text-ink'}>
              {pct(valuation!.pModel)}
            </div>
            <div data-testid="p-market" className="text-ink-faint">{pct(valuation!.pMarket)}</div>
          </>
        ) : (
          <div className="text-ink-faint">&mdash;</div>
        )}
      </div>
    </div>
  );
}
