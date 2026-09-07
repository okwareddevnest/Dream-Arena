'use client';
// Agent vitals and the server clock offset, polled from REST.
//
// The offset matters: round countdowns must run on the SERVER's clock, or a
// viewer with a fast machine sees a round close before it does.
import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';

export interface AgentInfo {
  stats: Record<string, number> | null;
  health: { ok: boolean; tickLagMs: number; killSwitch: boolean } | null;
  /** serverMs - localMs */
  offsetMs: number;
}

export function useAgent(): AgentInfo {
  const [info, setInfo] = useState<AgentInfo>({ stats: null, health: null, offsetMs: 0 });
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [a, h] = await Promise.all([
          fetch(`${API}/api/agent/mira`).then((r) => r.json()),
          fetch(`${API}/api/health`).then((r) => r.json()),
        ]);
        if (!alive) return;
        setInfo({
          stats: a?.stats ?? null,
          health: h ? { ok: !!h.ok, tickLagMs: h.tickLagMs ?? 0, killSwitch: !!h.killSwitch } : null,
          offsetMs: typeof h?.tsMs === 'number' ? h.tsMs - Date.now() : 0,
        });
      } catch {
        if (alive) setInfo((p) => ({ ...p, stats: null, health: null }));
      }
    };
    void poll();
    const t = setInterval(poll, 3_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return info;
}
