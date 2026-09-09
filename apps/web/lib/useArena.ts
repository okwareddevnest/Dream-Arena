'use client';
// React binding for the arena feed. One store, one socket, for the whole page.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createArenaStore, type ArenaState, type Staleness } from './store';
import { createArenaClient } from './ws';

const apiBase = () => process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';

/** The arena feed's socket URL.
 *
 *  In development the API is a separate origin on :8080. In deployment
 *  everything sits behind one port (docs/80-DEPLOY.md), so NEXT_PUBLIC_API_BASE
 *  is empty and the socket must be resolved against the page instead — which
 *  also gets the scheme right: a page served over https MUST use wss, and a
 *  relative `new WebSocket('/ws')` is not reliably supported. */
export function wsUrl(base = apiBase(), origin?: string): string {
  const abs = /^https?:\/\//.test(base)
    ? base
    : (origin ?? (typeof window === 'undefined' ? 'http://localhost:8080' : window.location.origin)) + base;
  return abs.replace(/^http/, 'ws') + '/ws';
}

export function useArena(): { state: ArenaState; staleness: Staleness } {
  const store = useRef(createArenaStore()).current;
  const [staleness, setStaleness] = useState<Staleness>({ stale: true, ageMs: 0 });

  const state = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.get(),
    () => store.get(),
  );

  useEffect(() => {
    const client = createArenaClient({ url: wsUrl(), store });
    client.start();
    // Staleness is a function of TIME, not of events, so it needs its own tick:
    // a feed that stops sending produces no event to notice the silence with.
    const t = setInterval(() => setStaleness(store.staleness()), 1_000);
    return () => { clearInterval(t); client.stop(); };
  }, [store]);

  return { state, staleness };
}
