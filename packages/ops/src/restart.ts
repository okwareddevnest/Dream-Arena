// Restart policy for supervised children. Pure, so it can be tested without
// spawning anything — boot.ts is an entrypoint with side effects at import, and
// a test that imported it would start a live agent.
// spec: docs/80-DEPLOY.md
/** Backoff for a child that died. Capped, so a persistently broken agent costs
 *  one restart a minute instead of a spin loop that burns the free tier. */
export function restartDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt));
}

/**
 * Whether to stop restarting a child.
 *
 * A crash-looping agent is worse than a stopped one: each start reconnects to
 * the venue, re-reads the chain and may re-enter a market. We give it room for
 * transient failure (an RPC blip, a redeploy race) and then leave it down and
 * loud, rather than churning real orders on a real chain.
 */
export function shouldGiveUp(crashesInWindow: number, limit = 8): boolean {
  return crashesInWindow >= limit;
}

/** How long a crash counts against a child before it is forgiven. */
export const CRASH_WINDOW_MS = 30 * 60_000;
