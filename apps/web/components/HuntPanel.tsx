'use client';
// The hunt: humans forecast the same markets MIRA trades, and are scored against
// it. spec: PRD F-A5 · FR-U1 · IF §11
//
// The countdown derives from the SERVER's clock via an offset, never from the
// browser's alone. A viewer whose machine is three minutes fast would otherwise
// watch a round expire early and be told their on-time forecast was late.
import { useState } from 'react';
import type { Score } from './Leaderboard';

export interface Round { roundId: string; marketIds: string[]; openedMs: number; closeMs: number; potUsd: number }

/** Time left, measured on the server's clock. `offset = serverMs - localMs`. */
export function remainingMs(round: Round, localNowMs: number, offsetMs: number): number {
  return Math.max(0, round.closeMs - (localNowMs + offsetMs));
}

const secs = (ms: number) => Math.ceil(ms / 1000);

export function HuntPanel({
  round, leaderboard, userAddr, serverOffsetMs, onForecast,
}: {
  round: Round | null;
  leaderboard: Score[];
  userAddr?: string;
  serverOffsetMs: number;
  onForecast: (f: { marketId: string; p: number }) => void;
}) {
  const [raw, setRaw] = useState('50');
  const [error, setError] = useState<string | null>(null);

  if (!round) {
    const paid = leaderboard.filter((s) => s.payoutUsd > 0);
    const you = userAddr ? leaderboard.find((s) => s.userAddr.toLowerCase() === userAddr.toLowerCase()) : undefined;
    if (paid.length) {
      return (
        <div data-testid="hunt-settled" className="text-sm">
          <p className="text-ink-muted">Round settled.</p>
          <ul className="mt-2 divide-y divide-line">
            {paid.map((s, i) => (
              <li key={s.userAddr} className="flex justify-between py-1.5 font-mono tabular-nums">
                <span className="text-ink-faint">{i + 1}</span>
                <span className="text-long">{s.payoutUsd.toFixed(2)} USD</span>
              </li>
            ))}
          </ul>
          {you ? (
            <p data-testid="hunt-you" className="mt-2 text-accent">
              You finished {leaderboard.filter((s) => s.brier < you.brier).length + 1} of {leaderboard.length}.
            </p>
          ) : null}
        </div>
      );
    }
    return (
      <p data-testid="hunt-idle" className="text-base text-ink-faint">
        No round open. The next one starts when MIRA has markets to trade.
      </p>
    );
  }

  const left = remainingMs(round, Date.now(), serverOffsetMs);
  const submit = () => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      setError('Your call must be between 1 and 99.');
      return;
    }
    setError(null);
    onForecast({ marketId: round.marketIds[0]!, p: n / 100 });
  };

  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between">
        <span data-testid="hunt-countdown" className="font-mono text-3xl tabular-nums text-ink">
          {secs(left)}<span className="ml-1.5 text-base text-ink-faint">s</span>
        </span>
        <span data-testid="hunt-pot" className="font-mono tabular-nums text-ink-muted">
          {round.potUsd.toFixed(2)} USD
        </span>
      </div>

      <label htmlFor="hunt-p" className="mt-5 block text-base text-ink-muted">
        Your call — chance this resolves yes
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="hunt-p" type="number" min={1} max={99} value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="w-24 rounded border border-line bg-raised px-3 py-2 font-mono text-lg tabular-nums text-ink outline-none focus:border-accent"
        />
        <button
          type="button" onClick={submit}
          className="rounded border border-accent px-4 py-2 text-base text-accent hover:bg-accent hover:text-bg"
        >
          Submit call
        </button>
      </div>
      {error ? <p data-testid="hunt-error" className="mt-1.5 text-short">{error}</p> : null}
    </div>
  );
}
