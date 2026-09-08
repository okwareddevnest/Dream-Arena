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

/** Where a probability sits on the axis, as a percentage. */
export function markPercent2(p: number): number { return markPercent(p); }

export function Gauge({
  market, valuation, edgeIn,
}: { market: GaugeMarket; valuation: GaugeValuation | null; edgeIn: number }) {
  const skipped = valuation?.skipReason != null;
  const state = valuation === null ? 'waiting' : skipped ? 'skipped'
    : Math.abs(valuation.edge) >= edgeIn ? 'diverged' : 'quiet';
  const live = state === 'diverged' || state === 'quiet';

  const model = live ? markPercent(valuation!.pModel) : null;
  const mkt = live ? markPercent(valuation!.pMarket) : null;
  const lo = model !== null && mkt !== null ? Math.min(model, mkt) : 0;
  const hi = model !== null && mkt !== null ? Math.max(model, mkt) : 0;
  const modelAbove = (model ?? 0) >= (mkt ?? 0);
  const edgePts = live ? Math.abs(valuation!.edge) * 100 : 0;

  return (
    <div
      data-testid="gauge-row"
      data-state={state}
      className={`group relative grid grid-cols-[12rem_1fr_8.5rem] items-center gap-6 rounded-lg border px-4 py-4 transition-colors ${
        state === 'diverged'
          ? 'border-accent/40 bg-accent/[0.06]'
          : 'border-transparent hover:border-line'
      }`}
    >
      {/* identity */}
      <div className="min-w-0">
        <div className="truncate text-base text-ink">{market.symbol}</div>
        <div className="mt-0.5 flex items-center gap-2 text-sm text-ink-faint">
          <span>{market.asset}</span>
          {state === 'diverged' ? (
            <span className="relative flex h-1.5 w-1.5">
              <span className="ring absolute inline-flex h-full w-full rounded-full bg-accent" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
          ) : null}
        </div>
      </div>

      {/* the instrument */}
      <div data-testid="axis" className="relative h-14">
        {/* face */}
        <div className="absolute inset-y-3 inset-x-0 overflow-hidden rounded bg-raised">
          {/* a slow pass, so a live instrument never looks frozen */}
          {live ? <div className="sweep absolute inset-y-0 w-1/4 bg-accent/[0.05]" /> : null}
        </div>
        {/* decile ticks — something to read a value against */}
        {live ? [10, 20, 30, 40, 50, 60, 70, 80, 90].map((t) => (
          <span
            key={t}
            className={`absolute top-1/2 -translate-y-1/2 ${t === 50 ? 'h-5 w-px bg-line' : 'h-2 w-px bg-grid'}`}
            style={{ left: `${t}%` }}
          />
        )) : null}

        {live ? (
          <>
            {/* the span: the edge, and the only saturated thing on the page */}
            <div
              data-testid="gap"
              className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-500 ease-out ${
                state === 'diverged' ? 'h-2.5 bg-accent shadow-[0_0_20px] shadow-accent/50' : 'h-1 bg-ink-faint'
              }`}
              style={{ left: `${lo}%`, width: `${Math.max(hi - lo, 0.4)}%` }}
            />
            {/* market: where the book is */}
            <span
              data-testid="mark-market"
              title="market price"
              className="absolute top-1/2 h-7 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-muted transition-all duration-500 ease-out"
              style={{ left: `${mkt}%` }}
            />
            {/* model: what MIRA believes — taller, and alive when it is tradeable */}
            <span
              data-testid="mark-model"
              title="MIRA's model"
              className={`absolute top-1/2 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-500 ease-out ${
                state === 'diverged' ? 'breathe h-11 bg-accent-hot' : 'h-8 bg-ink'
              }`}
              style={{ left: `${model}%` }}
            />
            {/* how big the gap is, written on the gap */}
            {state === 'diverged' ? (
              <span
                className="absolute -translate-x-1/2 font-mono text-xs tabular-nums text-accent-hot"
                style={{ left: `${lo + (hi - lo) / 2}%`, top: '-0.1rem' }}
              >
                {modelAbove ? '+' : '−'}{edgePts.toFixed(1)}
              </span>
            ) : null}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center">
            <span className="text-sm text-ink-faint">
              {state === 'skipped' ? valuation?.skipReason : 'Awaiting first tick'}
            </span>
          </div>
        )}
      </div>

      {/* the numbers */}
      <div className="text-right font-mono tabular-nums">
        {live ? (
          <>
            <div
              data-testid="p-model"
              className={`tabular-shift text-2xl ${state === 'diverged' ? 'text-accent-hot' : 'text-ink'}`}
            >
              {pct(valuation!.pModel)}
            </div>
            <div data-testid="p-market" className="tabular-shift text-base text-ink-faint">
              {pct(valuation!.pMarket)} book
            </div>
          </>
        ) : (
          <div className="text-base text-ink-faint">&mdash;</div>
        )}
      </div>
    </div>
  );
}
