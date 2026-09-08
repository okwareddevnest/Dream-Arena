'use client';
// The landing hero: the instrument itself, running.
//
// A static diagram of a product is a picture of a product. This is the same
// component logic the arena uses, driven by live valuations when the agent is
// up and by a slow demonstration cycle when it is not — the cycle is clearly a
// demonstration (it says so) rather than fabricated live data.
import { useEffect, useState } from 'react';

export interface HeroPoint { symbol: string; pModel: number; pMarket: number }

/** A slow, obvious demonstration for when nothing is running. */
const DEMO: HeroPoint[] = [
  { symbol: 'BTC closes above open', pModel: 0.52, pMarket: 0.13 },
  { symbol: 'ETH closes above open', pModel: 0.48, pMarket: 0.31 },
  { symbol: 'BTC closes above open', pModel: 0.61, pMarket: 0.58 },
];

export function HeroInstrument({ points, live }: { points: HeroPoint[]; live: boolean }) {
  const source = points.length ? points : DEMO;
  const [i, setI] = useState(0);
  useEffect(() => {
    if (source.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % source.length), 3_200);
    return () => clearInterval(t);
  }, [source.length]);

  const p = source[Math.min(i, source.length - 1)]!;
  const model = Math.min(100, Math.max(0, p.pModel * 100));
  const market = Math.min(100, Math.max(0, p.pMarket * 100));
  const lo = Math.min(model, market);
  const hi = Math.max(model, market);
  const edge = Math.abs(model - market);
  const wide = edge >= 6;

  return (
    <figure className="rounded-lg border border-line bg-surface p-6 lg:p-8">
      <div className="flex items-baseline justify-between">
        <figcaption className="text-base text-ink">{p.symbol}</figcaption>
        <span className="text-sm text-ink-faint">{live ? 'live' : 'demonstration'}</span>
      </div>

      <div className="relative mt-7 h-20">
        <div className="absolute inset-y-6 inset-x-0 overflow-hidden rounded bg-raised">
          <div className="sweep absolute inset-y-0 w-1/4 bg-accent/[0.06]" />
        </div>
        {[10, 20, 30, 40, 50, 60, 70, 80, 90].map((t) => (
          <span
            key={t}
            className={`absolute top-1/2 -translate-y-1/2 ${t === 50 ? 'h-7 w-px bg-line' : 'h-3 w-px bg-grid'}`}
            style={{ left: `${t}%` }}
          />
        ))}
        <div
          className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-700 ease-out ${
            wide ? 'h-3 bg-accent shadow-[0_0_28px] shadow-accent/50' : 'h-1.5 bg-ink-faint'
          }`}
          style={{ left: `${lo}%`, width: `${Math.max(hi - lo, 0.5)}%` }}
        />
        <span
          className="absolute top-1/2 h-10 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-muted transition-all duration-700 ease-out"
          style={{ left: `${market}%` }}
        />
        <span
          className={`absolute top-1/2 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-hot transition-all duration-700 ease-out ${
            wide ? 'breathe h-14' : 'h-11'
          }`}
          style={{ left: `${model}%` }}
        />
      </div>

      <div className="mt-6 grid grid-cols-3 gap-4 font-mono tabular-nums">
        <div>
          <div className="text-2xl text-ink-muted">{market.toFixed(0)}%</div>
          <div className="mt-1 font-sans text-sm text-ink-faint">the book</div>
        </div>
        <div>
          <div className="text-2xl text-accent-hot">{model.toFixed(0)}%</div>
          <div className="mt-1 font-sans text-sm text-ink-faint">MIRA</div>
        </div>
        <div>
          <div className={`text-2xl ${wide ? 'text-accent' : 'text-ink-faint'}`}>{edge.toFixed(0)}</div>
          <div className="mt-1 font-sans text-sm text-ink-faint">
            {wide ? 'points of edge — it trades' : 'points — it waits'}
          </div>
        </div>
      </div>
    </figure>
  );
}
