'use client';
// The launch page.
//
// Voice shifts deliberately here: the marketing surface speaks editorially (the
// serif display), the arena speaks in instrumentation (Plex sans and mono). Two
// registers, one product.
//
// Every number on this page is fetched from the RUNNING system. If the api is
// not up the page says so — a landing page rendering a confident "0 markets"
// while nothing is running is a lie told in the most expensive place.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Logo, Wordmark } from '../components/Logo';
import { HeroInstrument, type HeroPoint } from '../components/HeroInstrument';

const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';

interface Live { mode: string | null; markets: number; trades: number; valuations: number; points: HeroPoint[] }

function useLive(): { live: Live | null; offline: boolean } {
  const [live, setLive] = useState<Live | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [h, s] = await Promise.all([
          fetch(`${API}/api/health`).then((r) => r.json()),
          fetch(`${API}/api/snapshot`).then((r) => r.json()),
        ]);
        if (!alive) return;
        setLive({
          mode: h?.mode ?? null,
          markets: (s?.markets ?? []).length,
          trades: (s?.tape ?? []).length,
          valuations: (s?.valuations ?? []).length,
          // Real divergences drive the hero when the agent is up.
          points: (s?.valuations ?? [])
            .filter((v: { skipReason?: string | null }) => v.skipReason == null)
            .slice(0, 6)
            .map((v: { marketId: string; pModel: number; pMarket: number }) => ({
              symbol: (s?.markets ?? []).find((m: { id: string }) => m.id === v.marketId)?.symbol ?? 'market',
              pModel: v.pModel, pMarket: v.pMarket,
            })),
        });
        setOffline(false);
      } catch {
        if (!alive) return;
        setLive(null);
        setOffline(true);
      }
    };
    void poll();
    const t = setInterval(poll, 4_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { live, offline };
}

function Stat({ id, value, label, tone = 'text-ink' }: {
  id: string; value: string; label: string; tone?: string;
}) {
  return (
    <div data-testid={id} className="rounded-card border border-line bg-surface px-4 py-3.5">
      <div className={`font-mono text-3xl tabular-nums ${tone}`}>{value}</div>
      <div className="mt-1.5 text-sm text-ink-faint">{label}</div>
    </div>
  );
}

const STEPS: [string, string][] = [
  ['Forecast', 'It estimates volatility from live spot prices with an exponentially-weighted model, updated on every tick.'],
  ['Price', 'That volatility gives a fair probability for each market. Where the opening price has not been posted yet, it prices nothing and says so.'],
  ['Trade', 'It acts only when its probability and the book disagree by more than fees, spread and noise — sized at quarter-Kelly, capped by a risk guard.'],
];

const CLAIMS: [string, string][] = [
  ['Every fill links out', 'Each trade on the tape opens the transaction that produced it on the Shannon explorer.'],
  ['Positions come from chain', 'Holdings are reconciled against the venue, not accumulated from local guesses.'],
  ['Absent is not zero', 'A market MIRA cannot price shows why it was skipped. It never shows a number it did not compute.'],
  ['Your keys stay yours', 'Mirroring builds an unsigned transaction. Your wallet signs it; the arena never holds a key.'],
];

export default function LaunchPage() {
  const { live, offline } = useLive();

  return (
    <div className="flex min-h-screen w-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-3.5 lg:px-10">
        <span className="inline-flex items-center gap-2.5">
          <Logo className="h-5 w-5 text-accent" />
          <Wordmark className="text-base" />
        </span>
        <nav className="flex items-center gap-7 text-base">
          <a href="#how" className="hidden text-ink-muted hover:text-ink sm:inline">How it works</a>
          <a href="#verify" className="hidden text-ink-muted hover:text-ink sm:inline">Verify</a>
          <Link href="/mira" className="hidden text-ink-muted hover:text-ink sm:inline">The agent</Link>
          <Link href="/arena" className="border border-accent rounded px-4 py-2 text-accent hover:bg-accent hover:text-bg">
            Open the arena
          </Link>
        </nav>
      </header>

      <main className="flex-1">
        {/* Hero, full width, with the live rail beside it rather than beneath. */}
        <div className="grid gap-12 border-b border-line px-6 py-16 lg:grid-cols-[minmax(0,1fr)_19rem] lg:px-10 lg:py-24">
          <div>
            <h1 className="max-w-[16ch] font-display text-[clamp(2.75rem,7.5vw,6rem)] leading-[0.92] text-ink">
              A market is only worth trading when it is wrong.
            </h1>

            <p className="mt-8 max-w-[58ch] text-lg leading-relaxed text-ink-muted">
              MIRA is an autonomous agent trading binary prediction markets on Somnia. It
              forecasts volatility from live spot prices, prices each market from that
              forecast, and trades only the gap between what it believes and what the book
              is asking. Every order it signs, and every fill it takes, lands on-chain where
              you can check it.
            </p>

            <div className="mt-14 max-w-[46rem]">
              <HeroInstrument points={live?.points ?? []} live={!!live && !offline} />
            </div>

            <div className="mt-12">
              <Link
                href="/arena"
                className="inline-flex items-center rounded border border-accent px-7 py-3.5 text-lg text-accent transition-colors hover:bg-accent hover:text-bg"
              >
                Watch it trade
              </Link>
            </div>
          </div>

          <section aria-label="Live status" className="lg:border-l lg:border-line lg:pl-10">
            <h2 className="mb-5 text-lg text-ink">Right now</h2>
            {offline || !live ? (
              <p data-testid="live-status" className="text-base leading-relaxed text-ink-faint">
                {offline
                  ? 'The agent is not running right now. Start it with npm run agent to see live figures here.'
                  : 'Reading the arena…'}
              </p>
            ) : (
              <div data-testid="live-status" className="flex flex-col gap-3">
                <Stat id="stat-markets" value={String(live.markets)} label="markets tracked" />
                <Stat id="stat-valuations" value={String(live.valuations)} label="markets priced" />
                <Stat id="stat-trades" value={String(live.trades)} label="trades on the tape" />
                {live.mode ? (
                  <Stat
                    id="stat-mode"
                    value={live.mode}
                    label={live.mode === 'LIVE' ? 'Somnia testnet, real orders' : 'test rig'}
                    tone={live.mode === 'LIVE' ? 'text-live' : 'text-sim'}
                  />
                ) : null}
              </div>
            )}
          </section>
        </div>

        {/* A genuine sequence, so numbering it is honest. */}
        <section id="how" aria-label="How it works" className="border-b border-line px-6 py-16 lg:px-10">
          <h2 className="font-display text-[clamp(1.6rem,3vw,2.4rem)] text-ink">How MIRA decides</h2>
          <ol className="mt-10 grid gap-10 md:grid-cols-3">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="rounded-card border border-line bg-surface p-6">
                <span className="font-mono text-sm text-ink-faint">{i + 1}</span>
                <h3 className="mt-3 text-lg text-ink">{title}</h3>
                <p className="mt-2.5 max-w-[44ch] text-base leading-relaxed text-ink-muted">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="verify" aria-label="Verify" className="border-b border-line px-6 py-16 lg:px-10">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <div>
              <h2 className="font-display text-[clamp(1.6rem,3vw,2.4rem)] text-ink">
                Nothing here asks to be believed
              </h2>
              <p className="mt-5 max-w-[50ch] text-lg leading-relaxed text-ink-muted">
                The arena runs against Somnia testnet. Every fill carries the transaction
                that produced it, so any claim on the screen can be checked against the
                chain rather than taken on trust.
              </p>
            </div>
            <dl className="grid gap-x-12 gap-y-7 sm:grid-cols-2">
              {CLAIMS.map(([t, d]) => (
                <div key={t} className="border-t border-line pt-3">
                  <dt className="text-base text-ink">{t}</dt>
                  <dd className="mt-1.5 max-w-[40ch] text-sm leading-relaxed text-ink-muted">{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* What it is built on — concrete, checkable, no marketing adjectives. */}
        <section aria-label="Built on" className="border-b border-line px-6 py-16 lg:px-10">
          <h2 className="font-display text-[clamp(1.6rem,3vw,2.4rem)] text-ink">What it runs on</h2>
          <dl className="mt-10 grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ['Somnia testnet', 'Chain 50312. Binary prediction markets settled at expiry, quoted as an order book per outcome.'],
              ['Volatility model', 'Exponentially-weighted moving variance over log returns, updated on every spot tick.'],
              ['Pricing', 'The normal CDF of d₂, with Itô\u2019s correction. The inverse reads the book back as an implied volatility.'],
              ['Position sizing', 'Quarter-Kelly on the measured edge, then whichever hard cap binds first.'],
            ] as [string, string][]).map(([t, d]) => (
              <div key={t} className="rounded-card border border-line bg-surface p-5">
                <dt className="text-base text-ink">{t}</dt>
                <dd className="mt-2 text-base leading-relaxed text-ink-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* The honest limitations. A page that lists none is not credible. */}
        <section aria-label="Limits" className="border-b border-line px-6 py-16 lg:px-10">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <h2 className="font-display text-[clamp(1.6rem,3vw,2.4rem)] text-ink">
              What this does not claim
            </h2>
            <dl className="grid gap-x-12 gap-y-7 sm:grid-cols-2">
              {([
                ['It is not proven profitable', 'It trades a model against a book. Over a short session, profit and loss says more about the market than about the model.'],
                ['The testnet book is thin', 'These venues launched with no organic flow. Prices there are not the prices a deep market would produce.'],
                ['Spot comes from an exchange', 'The underlying price is read from Binance. Real prices, but not sourced from the venue it trades on.'],
                ['A skip is not a failure', 'Most markets are refused most of the time. That is the model declining to guess, and it is the behaviour to want.'],
              ] as [string, string][]).map(([t, d]) => (
                <div key={t} className="border-t border-line pt-3">
                  <dt className="text-base text-ink">{t}</dt>
                  <dd className="mt-2 max-w-[42ch] text-base leading-relaxed text-ink-muted">{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section aria-label="ECHO" className="border-b border-line px-6 py-16 lg:px-10">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <h2 className="font-display text-[clamp(1.6rem,3vw,2.4rem)] text-ink">
              A market with no one in it is not a market
            </h2>
            <p className="max-w-[62ch] rounded-card border border-line bg-surface p-6 text-base leading-relaxed text-ink-muted">
              These venues launched with no organic counterparty — every market had a trade
              count of zero. So the arena runs a second agent. ECHO quotes both sides around
              its own estimate of fair value and signs with its own key, because the venue
              blocks an account from matching itself. MIRA has someone to trade against, and
              the tape has something on it.
            </p>
          </div>
        </section>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-4 px-6 py-7 text-sm text-ink-faint lg:px-10">
        <span>Somnia testnet · chain 50312 · every fill verifiable on the Shannon explorer</span>
        <Link href="/arena" className="text-ink-muted hover:text-ink">Open the arena</Link>
      </footer>
    </div>
  );
}
