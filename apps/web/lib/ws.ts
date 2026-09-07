// WS client for the arena feed: connect, hydrate, stream, reconnect.
// spec: IF §13 · T-051
//
// The client never decides what the data MEANS — it only delivers frames to the
// store. Its own job is staying connected and being honest about when it is not.
import type { ArenaStore } from './store';

const BASE_MS = 500;
const CEIL_MS = 30_000;

/** Exponential backoff with a ceiling, jittered so a restarted server does not
 *  get every reconnecting client back in the same millisecond. */
export function backoffMs(attempt: number): number {
  const raw = Math.min(CEIL_MS, BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(raw * (0.7 + Math.random() * 0.3));
}

export interface ArenaClientOptions {
  url: string;
  store: ArenaStore;
  /** Injected so the client is testable without a browser socket. */
  socketFactory?: (url: string) => WebSocket;
  onError?: (e: unknown) => void;
}

export interface ArenaClient {
  start(): void;
  stop(): void;
  send(msg: unknown): void;
}

export function createArenaClient(o: ArenaClientOptions): ArenaClient {
  const make = o.socketFactory ?? ((u: string) => new WebSocket(u));
  let sock: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const clearTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  const schedule = () => {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(connect, backoffMs(attempt++));
  };

  function connect(): void {
    if (stopped) return;
    let s: WebSocket;
    try { s = make(o.url); } catch (e) { o.onError?.(e); schedule(); return; }
    sock = s;

    s.onopen = () => {
      attempt = 0;                       // a good connection resets the ladder
      o.store.setConnected(true);
    };
    s.onmessage = (e: MessageEvent) => {
      try { o.store.apply(JSON.parse(String((e as { data: unknown }).data))); }
      catch (err) { o.onError?.(err); }  // one bad frame must not drop the feed
    };
    s.onclose = () => {
      o.store.setConnected(false);       // keep the data, mark it stale
      if (!stopped) schedule();
    };
    s.onerror = (e: unknown) => { o.onError?.(e); };
  }

  return {
    start() { stopped = false; attempt = 0; connect(); },
    stop() {
      stopped = true;
      clearTimer();
      try { sock?.close(); } catch { /* already gone */ }
      sock = null;
    },
    send(msg) {
      try { sock?.send(JSON.stringify(msg)); } catch (e) { o.onError?.(e); }
    },
  };
}
