// T-050 — the arena route. This is the SHELL only: it lays out the F-A1 regions and
// states honestly that no feed is attached yet. It fabricates nothing — the gauge, tape
// and standings are filled from the real WS snapshot by the FRONT cards that follow.
// spec: PRD F-A1 · FR-U5 · ARCH §1
import type { ReactNode } from 'react';

/** A titled broadcast panel. `label` becomes the region's accessible name. */
function Panel({
  label, title, kicker, className = '', children,
}: {
  label: string; title: string; kicker?: string; className?: string; children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={`flex flex-col rounded-lg border border-line bg-surface ${className}`}
    >
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{title}</h2>
        {kicker ? (
          <span className="text-[0.625rem] uppercase tracking-widest text-ink-faint">{kicker}</span>
        ) : null}
      </header>
      <div className="flex flex-1 items-center justify-center p-6">{children}</div>
    </section>
  );
}

/** Honest empty state — shown until a real feed lands. Never a fake number. */
function Awaiting({ what }: { what: string }) {
  return (
    <p className="text-center text-sm text-ink-faint">
      <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full align-middle bg-warn" />
      Awaiting {what}
    </p>
  );
}

export default function ArenaPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-[110rem] flex-col gap-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold tracking-[0.2em] text-ink">DREAM ARENA</span>
          <span className="text-xs uppercase tracking-[0.18em] text-accent">MIRA</span>
        </div>
        {/* mode badge + health tiles are installed by the console card */}
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-ink-faint">
          <span className="inline-block h-2 w-2 rounded-full bg-warn" />
          Feed not connected
        </div>
      </header>

      <main aria-label="Arena" className="grid flex-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Panel label="Divergence" title="Model vs Market" kicker="MIRA" className="min-h-[20rem]">
            <Awaiting what="live market feed" />
          </Panel>
          <Panel label="Tape" title="Trade Tape" kicker="Somnia testnet" className="min-h-[16rem]">
            <Awaiting what="fills" />
          </Panel>
        </div>
        <Panel label="Standings" title="Standings" kicker="Brier" className="min-h-[36rem]">
          <Awaiting what="players" />
        </Panel>
      </main>
    </div>
  );
}
