'use client';
// React binding for the arena feed. One store, one socket, for the whole page.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createArenaStore, type ArenaState, type Staleness } from './store';
import { createArenaClient } from './ws';

const apiBase = () => process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';
const wsUrl = () => apiBase().replace(/^http/, 'ws') + '/ws';

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
