'use client';
// Operator console. The token is held in this browser only — it is never put in
// the URL, where it would end up in history, logs and referrers.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Logo, Wordmark } from '../../components/Logo';
import { Card } from '../../components/Card';
import { Console, type ConsoleHealth } from '../../components/Console';
import { ModeBadge } from '../../components/ModeBadge';

const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';
const KEY = 'arena.operatorToken';

export default function ConsolePage() {
  const [token, setToken] = useState('');
  const [health, setHealth] = useState<ConsoleHealth | null>(null);
  const [scenarios, setScenarios] = useState<string[]>([]);

  useEffect(() => {
    try { setToken(localStorage.getItem(KEY) ?? ''); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await fetch(`${API}/api/health`).then((r) => r.json());
        if (alive) setHealth(h);
      } catch { if (alive) setHealth(null); }
      try {
        const s = await fetch(`${API}/api/console/scenarios`).then((r) => r.json());
        if (alive) setScenarios(Array.isArray(s) ? s : (s?.scenarios ?? []));
      } catch { /* optional */ }
    };
    void poll();
    const t = setInterval(poll, 3_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const save = (v: string) => {
    setToken(v);
    try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
  };

  return (
    <div className="flex min-h-screen w-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-3.5 lg:px-10">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <Logo className="h-6 w-6 text-accent" />
          <Wordmark className="text-lg" />
        </Link>
        <div className="flex items-center gap-5">
          <ModeBadge mode={(health?.mode as 'LIVE' | 'SIM') ?? null} />
          <Link href="/arena" className="text-base text-ink-muted hover:text-ink">Arena</Link>
        </div>
      </header>

      <main aria-label="Console" className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card title="Operator" note="held in this browser only">
          <label htmlFor="tok" className="block text-sm text-ink-muted">Operator token</label>
          <input
            id="tok" type="password" value={token} onChange={(e) => save(e.target.value)}
            placeholder="OPERATOR_TOKEN from .env"
            className="mt-2 w-full rounded border border-line bg-raised px-3 py-2 font-mono text-base text-ink outline-none focus:border-accent"
          />
          <p className="mt-3 text-sm text-ink-faint">
            The server checks this on every command. Without it the controls do not render.
          </p>
        </Card>

        <Card weight="feature" title="Controls" note={health ? 'connected' : 'agent not reachable'}>
          <Console token={token} health={health} scenarios={scenarios} />
        </Card>
      </main>
    </div>
  );
}
