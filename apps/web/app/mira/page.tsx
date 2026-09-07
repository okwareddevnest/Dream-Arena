'use client';
// MIRA's profile — how the agent actually decides.
//
// The explainer is STATIC and works with the agent down: this is how a reader
// understands the strategy, and it must not depend on a process being up. The
// live configuration is layered on when available, and its absence is stated
// rather than filled with plausible defaults.
// spec: PRD §6 P1 · WP §4
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Logo, Wordmark } from '../../components/Logo';
import { Card } from '../../components/Card';

const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';

interface Risk {
  edgeIn: number; edgeOut: number; kellyFraction: number;
  maxNotionalUsd: number; maxNetContractsPerMarket: number;
}
interface Profile { strategy?: string; risk?: Risk; mode?: string }

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export default function MiraPage() {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${API}/api/agent/mira`).then((x) => x.json());
        if (alive) setP(r);
      } catch { if (alive) setP(null); }
    };
    void poll();
    const t = setInterval(poll, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const risk = p?.risk;

  return (
    <div className="flex min-h-screen w-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-3.5 lg:px-10">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <Logo className="h-6 w-6 text-accent" />
          <Wordmark className="text-lg" />
        </Link>
        <Link href="/arena" className="text-base text-ink-muted hover:text-ink">Arena</Link>
      </header>

      <main aria-label="MIRA" className="flex-1 px-6 py-12 lg:px-10">
        <h1 className="max-w-[20ch] font-display text-[clamp(2.25rem,5vw,3.5rem)] leading-[0.98] text-ink">
          How MIRA prices a market
        </h1>
        <p className="mt-6 max-w-[62ch] text-lg leading-relaxed text-ink-muted">
          Every market asks one question: will the underlying finish above a line?
          MIRA answers it with a volatility forecast, converts that answer into a
          probability, and compares it with the price the book is asking.
        </p>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          <Card title="Forecast volatility" note="F4">
            <p className="text-base leading-relaxed text-ink-muted">
              An exponentially-weighted moving variance over log returns, updated on
              every tick. Recent movement counts for more than old movement, and the
              estimate is reported as an annualised sigma.
            </p>
            <p data-testid="formula-f4" className="mt-4 rounded border border-line bg-raised p-3 font-mono text-sm text-ink">
              σ²ₜ = λ·σ²ₜ₋₁ + (1−λ)·rₜ²
            </p>
          </Card>

          <Card title="Price the market" note="F1">
            <p className="text-base leading-relaxed text-ink-muted">
              With a volatility and a time to expiry, the chance of finishing above the
              line is the standard normal of d₂. The −σ²τ/2 term is Itô&rsquo;s correction;
              leaving it out overstates the edge at the money.
            </p>
            <p data-testid="formula-f1" className="mt-4 rounded border border-line bg-raised p-3 font-mono text-sm text-ink">
              P = N(d₂), d₂ = [ln(S/K) − σ²τ/2] / (σ√τ)
            </p>
          </Card>

          <Card title="Read the book back" note="F2">
            <p className="text-base leading-relaxed text-ink-muted">
              The inverse: what volatility would justify the market&rsquo;s price? Where no
              volatility produces it, the quote is unattainable and MIRA skips the
              market rather than inventing an edge.
            </p>
            <p data-testid="formula-f2" className="mt-4 rounded border border-line bg-raised p-3 font-mono text-sm text-ink">
              solve σ from N(d₂) = p, taking the low root
            </p>
          </Card>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <Card weight="feature" title="When it trades">
            {risk ? (
              <p data-testid="live-thresholds" className="text-base leading-relaxed text-ink-muted">
                MIRA enters when its probability and the book disagree by more than{' '}
                <span className="text-accent">{pct(risk.edgeIn)}</span>, and holds until the
                gap falls under <span className="text-ink">{pct(risk.edgeOut)}</span>. Two
                thresholds, not one: a single line would make it trade in and out on noise.
              </p>
            ) : (
              <p className="text-base leading-relaxed text-ink-muted">
                MIRA enters on a divergence wider than its entry threshold and holds until
                the gap falls under a lower exit threshold. Two thresholds, not one: a single
                line would make it trade in and out on noise.
              </p>
            )}
            <p className="mt-4 text-base leading-relaxed text-ink-muted">
              Size is quarter-Kelly on the edge, then cut by whichever hard cap binds first —
              per-market contracts, gross contracts, notional, session loss, or order rate.
              The gap between what it wanted and what it placed is shown live in the arena.
            </p>
          </Card>

          <Card title="Live configuration">
            {risk ? (
              <dl className="divide-y divide-line">
                {([
                  ['risk-edgeIn', 'Enter above', pct(risk.edgeIn)],
                  ['risk-edgeOut', 'Exit below', pct(risk.edgeOut)],
                  ['risk-kelly', 'Kelly fraction', risk.kellyFraction.toFixed(2)],
                  ['risk-notional', 'Max notional', `${risk.maxNotionalUsd} USD`],
                  ['risk-net', 'Max per market', `${risk.maxNetContractsPerMarket}`],
                ] as const).map(([id, label, value]) => (
                  <div key={id} data-testid={id} className="flex items-baseline justify-between py-2">
                    <dt className="text-sm text-ink-faint">{label}</dt>
                    <dd className="font-mono text-base tabular-nums text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p data-testid="risk-offline" className="text-base text-ink-faint">
                The agent is not reachable, so its live thresholds are not shown here.
                Start it with npm run agent.
              </p>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
