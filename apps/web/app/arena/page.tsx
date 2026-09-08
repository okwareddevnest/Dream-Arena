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
import { ConnectWallet } from '../../components/ConnectWallet';
import type { Connected } from '../../lib/wallets';
import { signIn, loadSession, clearSession, type ArenaSession } from '../../lib/session';
import { useArena } from '../../lib/useArena';
import { useAgent } from '../../lib/useAgent';
import { Card } from '../../components/Card';
import { Voice } from '../../components/Voice';
import { SpotChart } from '../../components/SpotChart';
import { SkipReasons } from '../../components/SkipReasons';
import { SessionStrip } from '../../components/SessionStrip';
import { Scorecard, type ScoreData } from '../../components/Scorecard';

const EDGE_IN = 0.06;

export default function ArenaPage() {
  const { state, staleness } = useArena();
  const { stats, health, offsetMs } = useAgent();
  const [wallet, setWallet] = useState<Connected | null>(null);
  // The rail collapses so the board can have the screen when it matters. The
  // choice is remembered per browser — a demo should not have to re-collapse it.
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try { setRailOpen(localStorage.getItem('arena.rail') !== 'closed'); } catch { /* private mode */ }
  }, []);
  const toggleRail = () => {
    setRailOpen((v) => {
      const next = !v;
      try { localStorage.setItem('arena.rail', next ? 'open' : 'closed'); } catch { /* ignore */ }
      return next;
    });
  };
  const [now, setNow] = useState(() => Date.now());
  const [score, setScore] = useState<ScoreData | null>(null);
  const [callNote, setCallNote] = useState<string | null>(null);
  const [session, setSession] = useState<ArenaSession | null>(null);
  useEffect(() => { setSession(loadSession()); }, []);

  // Your own record, polled while a wallet is connected. Nothing here is shared
  // with anyone else: it is what YOU said and how it turned out.
  useEffect(() => {
    if (!wallet) { setScore(null); return; }
    const base = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';
    let alive = true;
    const poll = () => {
      fetch(`${base}/api/you/${wallet.address}`)
        .then((r) => r.json())
        .then((d) => { if (alive) setScore(d as ScoreData); })
        .catch(() => { if (alive) setScore(null); });
    };
    poll();
    const t = setInterval(poll, 8_000);
    return () => { alive = false; clearInterval(t); };
  }, [wallet]);
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
        className={`grid flex-1 gap-0 ${railOpen
          ? 'xl:grid-cols-[19rem_minmax(0,1fr)_21rem] lg:grid-cols-[18rem_minmax(0,1fr)]'
          : 'xl:grid-cols-[3rem_minmax(0,1fr)_21rem] lg:grid-cols-[3rem_minmax(0,1fr)]'}`}
      >
        {/* left rail — what the system sees and does */}
        <aside
          aria-label="Rail"
          className={`flex flex-col gap-4 bg-bg py-4 lg:border-r lg:border-line ${railOpen ? 'px-4' : 'items-center px-2'}`}
        >
          <button
            type="button"
            onClick={toggleRail}
            aria-expanded={railOpen}
            aria-label={railOpen ? 'Collapse the rail' : 'Expand the rail'}
            title={railOpen ? 'Collapse' : 'Expand'}
            className="flex h-8 w-8 shrink-0 items-center justify-center self-end rounded border border-line text-ink-faint hover:border-accent hover:text-accent"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
              <path
                d={railOpen ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'}
                stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          </button>
          {railOpen ? (
          <>
          <Card title="Agent">
            <Vitals stats={stats as never} health={health} />
          </Card>
          <Card title="Holdings">
            <Positions positions={state.positions as never} />
          </Card>
          {Object.entries(state.spot).slice(0, 2).map(([sym, series]) => (
            <Card key={sym} title={sym} note="underlying">
              <SpotChart symbol={sym} series={series as never} />
            </Card>
          ))}
          <Card title="Why it is waiting" note="refusals are information">
            <SkipReasons valuations={state.valuations as never} />
          </Card>
          <Card title="Markets" note="soonest first">
            <MarketRail markets={state.markets as never} nowMs={now} />
          </Card>
          </>
          ) : null}
        </aside>

        {/* centre — the board, then the tape */}
        <div className="flex min-w-0 flex-col gap-4 px-4 py-4">
          <Card title="This session" note="live counters">
            <SessionStrip
              stats={stats as never}
              tape={state.tape}
              positions={state.positions}
            />
          </Card>

          <Card title="MIRA" note="thinking out loud">
            <Voice quips={state.quips as never} />
          </Card>

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

          <Card title="Your record" note="how you are wrong, not just that you are">
            <Scorecard data={score} />
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
              onForecast={(f) => {
                // A forecast is a claim a person is making; it goes to the server
                // under their own address, and the server stamps the round.
                if (!wallet) { setCallNote('Connect a wallet to make a call.'); return; }
                const base = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';
                if (!session) { setCallNote('Sign in with your wallet to make a call.'); return; }
                void fetch(`${base}/api/forecast`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${session.token}`,
                  },
                  body: JSON.stringify({
                    marketId: f.marketId, p: f.p,
                    userAddr: wallet.address,
                    roundId: (state.round as { roundId?: string } | null)?.roundId ?? '',
                  }),
                })
                  .then(async (r) => {
                    const b = await r.json().catch(() => ({}));
                    setCallNote(r.ok ? 'Call recorded. It scores when the market settles.'
                                     : (b?.error ?? 'That call was not accepted.'));
                  })
                  .catch(() => setCallNote('Could not reach the arena.'));
              }}
            />
            {callNote ? <p className="mt-3 text-sm text-ink-muted">{callNote}</p> : null}
          </Card>
          <Card title="Forecasters" note="Brier, lower is better">
            <Leaderboard scores={state.leaderboard as never} {...(wallet ? { userAddr: wallet.address } : {})} />
          </Card>
          <Card title="Trade alongside MIRA" note="your keys stay in your wallet">
            <ConnectWallet
              connected={wallet}
              onConnect={(c) => {
                setWallet(c);
                // Connecting reveals an address; signing proves it. Without the
                // signature the arena cannot record a forecast as yours.
                void signIn(c).then((r) => {
                  if (r.session) { setSession(r.session); setCallNote(null); }
                  else setCallNote(r.error ?? 'Sign-in did not complete.');
                });
              }}
              onDisconnect={() => { setWallet(null); setSession(null); clearSession(); }}
            />
            {wallet && !session ? (
              <p className="mt-2 text-sm text-warn">
                Signed out. Sign the message in your wallet to make calls — it costs no gas.
              </p>
            ) : null}
            {wallet ? (
              <div className="mt-3">
                <MirrorButton fill={(state.tape[0] as never) ?? null} wallet={wallet} />
              </div>
            ) : null}
          </Card>
        </aside>
      </main>
    </div>
  );
}
