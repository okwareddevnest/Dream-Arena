'use client';
// The arena — a three-column workspace, full bleed.
//
// Left rail: what the system is watching and what it is doing.
// Centre: the divergence board (the hero) and the tape beneath it.
// Right rail: the money, the round, and the way in for a visitor.
//
// The board stays unboxed and full width: the gap between belief and price is
// the product, and it should have the most room on the screen.
// spec: PRD F-A1 · FR-U5 · IF §13
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Logo, Wordmark } from '../../components/Logo';
import { ModeBadge, ConnectionDot } from '../../components/ModeBadge';
import { Gauge } from '../../components/Gauge';
import { Tape } from '../../components/Tape';
import { PnlChart } from '../../components/PnlChart';
import { Leaderboard } from '../../components/Leaderboard';
import { Vitals } from '../../components/Vitals';
import { Positions } from '../../components/Positions';
import { MarketRail } from '../../components/MarketRail';
import { HuntPanel } from '../../components/HuntPanel';
import { MirrorButton } from '../../components/MirrorButton';
import { connectWallet, type Wallet } from '../../lib/wallet';
import { useArena } from '../../lib/useArena';
import { useAgent } from '../../lib/useAgent';
import { Card } from '../../components/Card';

const EDGE_IN = 0.06;

export default function ArenaPage() {
  const { state, staleness } = useArena();
  const { stats, health, offsetMs } = useAgent();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const valuationFor = (id: string) => state.valuations.find((v) => v.marketId === id) ?? null;
  const diverged = state.valuations.filter(
    (v) => v.skipReason == null && Math.abs(v.edge ?? 0) >= EDGE_IN,
  ).length;

  return (
    <div className="flex min-h-screen w-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <Logo className="h-6 w-6 text-accent" />
            <Wordmark className="text-lg" />
          </Link>
          <nav className="hidden items-center gap-5 text-base sm:flex">
            <Link href="/mira" className="text-ink-muted hover:text-ink">How it works</Link>
            <Link href="/console" className="text-ink-muted hover:text-ink">Console</Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <ConnectionDot connected={state.connected} stale={staleness.stale} ageMs={staleness.ageMs} />
          <ModeBadge mode={state.mode} />
        </div>
      </header>

      <main
        aria-label="Arena"
        className="grid flex-1 gap-0 xl:grid-cols-[15rem_minmax(0,1fr)_20rem] lg:grid-cols-[14rem_minmax(0,1fr)]"
      >
        {/* left rail — what the system sees and does */}
        <aside className="flex flex-col gap-4 bg-bg px-4 py-4 lg:border-r lg:border-line">
          <Card title="Agent">
            <Vitals stats={stats as never} health={health} />
          </Card>
          <Card title="Holdings">
            <Positions positions={state.positions as never} />
          </Card>
          <Card title="Markets" note="soonest first">
            <MarketRail markets={state.markets as never} nowMs={now} />
          </Card>
        </aside>

        {/* centre — the board, then the tape */}
        <div className="flex min-w-0 flex-col gap-4 px-4 py-4">
          <Card
            weight="feature"
            title="What MIRA believes, against what the market is pricing"
            note={diverged ? `${diverged} above threshold` : 'live'}
          >
            {state.markets.length === 0 ? (
              <p className="py-10 text-base text-ink-faint">Awaiting the first market from the venue.</p>
            ) : (
              <div>
                {state.markets.map((m) => (
                  <Gauge key={m.id} market={m} valuation={valuationFor(m.id)} edgeIn={EDGE_IN} />
                ))}
              </div>
            )}
          </Card>

          <Card title="Trades" note="every fill is verifiable on-chain">
            <Tape fills={state.tape} />
          </Card>
        </div>

        {/* right rail — money, round, participation */}
        <aside className="flex flex-col gap-4 bg-bg px-4 py-4 xl:border-l xl:border-line">
          <Card title="Profit and loss">
            <PnlChart series={state.pnlCurve} />
          </Card>
          <Card title="This round" note="forecast against MIRA">
            <HuntPanel
              round={state.round as never}
              leaderboard={state.leaderboard as never}
              {...(wallet ? { userAddr: wallet.address } : {})}
              serverOffsetMs={offsetMs}
              onForecast={() => { /* wired to the socket in the console card */ }}
            />
          </Card>
          <Card title="Forecasters" note="Brier, lower is better">
            <Leaderboard scores={state.leaderboard as never} {...(wallet ? { userAddr: wallet.address } : {})} />
          </Card>
          <Card title="Trade alongside MIRA" note="your keys stay in your wallet">
            {wallet ? (
              <MirrorButton fill={(state.tape[0] as never) ?? null} wallet={wallet} />
            ) : (
              <button
                type="button"
                onClick={() => { void connectWallet().then(setWallet); }}
                className="w-full rounded border border-line px-4 py-2.5 text-base text-ink-muted hover:border-accent hover:text-accent"
              >
                Connect a wallet
              </button>
            )}
          </Card>
        </aside>
      </main>
    </div>
  );
}
