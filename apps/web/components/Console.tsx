'use client';
// The director console.
//
// These controls stop a live trading agent, so every one of them is token-gated
// and the component renders NO controls without a token — the guard is the
// absence of the buttons, not a disabled attribute someone can flip in devtools.
// The server checks the token again on every call; this is the second lock, not
// the only one.
// spec: PRD F-A7 · GWT-7,GWT-8 · IF §14
import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';

export interface ConsoleHealth {
  ok: boolean; killSwitch: boolean; tickLagMs: number; tickLagAlarmMs: number;
  mode: string; components: Record<string, { ok: boolean }>;
}

export function Console({
  token, health, scenarios,
}: { token: string; health: ConsoleHealth | null; scenarios: string[] }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!token) {
    return (
      <p data-testid="console-locked" className="text-base text-ink-faint">
        This console needs an operator token. Set one and reload to take control.
      </p>
    );
  }

  async function post(path: string, body: unknown, tag: string) {
    setBusy(tag); setError(null);
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-operator-token': token },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      // A refused command must never look like a successful one.
      if (!res.ok) setError(out?.error ?? `Refused (${res.status}).`);
    } catch {
      setError('Could not reach the arena.');
    } finally {
      setBusy(null);
    }
  }

  const killed = !!health?.killSwitch;
  const lag = health?.tickLagMs ?? 0;
  const alarm = !!health && lag > health.tickLagAlarmMs;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p data-testid="kill-state" className={`text-base ${killed ? 'text-short' : 'text-ink-muted'}`}>
          {killed ? 'Trading is stopped.' : 'Trading is running.'}
        </p>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void post('/api/console/kill', { on: !killed, by: 'console' }, 'kill')}
          className={`mt-3 rounded border px-5 py-2.5 text-base ${
            killed ? 'border-long text-long hover:bg-long hover:text-bg'
                   : 'border-short text-short hover:bg-short hover:text-bg'
          }`}
        >
          {killed ? 'Resume trading' : 'Stop trading'}
        </button>
      </div>

      <div>
        <h3 className="mb-2 text-sm text-ink-muted">Feed</h3>
        <p
          data-testid="tick-lag"
          data-alarm={String(alarm)}
          className={`font-mono text-2xl tabular-nums ${alarm ? 'text-short' : 'text-ink'}`}
        >
          {lag}<span className="ml-1.5 text-base text-ink-faint">ms behind</span>
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-sm text-ink-muted">Components</h3>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(health?.components ?? {}).map(([name, c]) => (
            <div
              key={name}
              data-testid={`tile-${name}`}
              data-ok={String(!!c?.ok)}
              className={`rounded border px-3 py-2 text-sm ${
                c?.ok ? 'border-line text-ink-muted' : 'border-short text-short'
              }`}
            >
              {name}
            </div>
          ))}
        </div>
      </div>

      {scenarios.length ? (
        <div>
          <h3 className="mb-2 text-sm text-ink-muted">Inject a scenario</h3>
          <div className="flex flex-wrap gap-2">
            {scenarios.map((n) => (
              <button
                key={n}
                type="button"
                disabled={busy !== null}
                onClick={() => void post('/api/console/scenario', { name: n }, n)}
                className="rounded border border-line px-3 py-2 font-mono text-sm text-ink-muted hover:border-accent hover:text-accent"
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <p data-testid="console-error" className="text-base text-short">{error}</p> : null}
    </div>
  );
}
