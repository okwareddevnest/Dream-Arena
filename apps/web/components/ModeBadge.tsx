// Is this real? — the two indicators that answer it.
//
// RFC-003 makes LIVE the demo path, so the badge is the claim the entire demo
// rests on. It reads the mode the SERVER reported in its snapshot; it has no
// default and no build-time flag, because a badge that could assert LIVE while
// showing simulated data would be worse than no badge.
// spec: PRD F-A7 · GWT-8 · RFC-003

export function ModeBadge({ mode }: { mode: 'LIVE' | 'SIM' | null }) {
  const known = mode === 'LIVE' || mode === 'SIM';
  return (
    <span
      data-testid="mode-badge"
      data-mode={known ? mode : 'unknown'}
      className={`inline-flex items-center gap-1.5 border rounded px-2.5 py-1 text-sm ${
        mode === 'LIVE' ? 'border-live text-live'
          : mode === 'SIM' ? 'border-sim text-sim'
          : 'border-line text-ink-faint'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          mode === 'LIVE' ? 'bg-live' : mode === 'SIM' ? 'bg-sim' : 'bg-ink-faint'
        }`}
      />
      {known ? mode : 'Connecting'}
    </span>
  );
}

/**
 * Feed health. Stale data is KEPT and labelled with its age rather than blanked
 * — a number that is visibly eight seconds old is more useful than an empty
 * panel, and far more honest than a stale number pretending to be current.
 */
export function ConnectionDot({
  connected, stale, ageMs,
}: { connected: boolean; stale: boolean; ageMs: number }) {
  const state = !connected ? 'down' : stale ? 'stale' : 'live';
  const secs = Math.round(ageMs / 1000);
  return (
    <span
      data-testid="conn"
      data-state={state}
      className={`inline-flex items-center gap-2 text-sm ${
        state === 'live' ? 'text-ink-faint' : state === 'stale' ? 'text-warn' : 'text-short'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          state === 'live' ? 'bg-live' : state === 'stale' ? 'bg-warn' : 'bg-short'
        }`}
      />
      {state === 'live' ? 'Live feed' : state === 'stale' ? `Stale ${secs}s` : 'Reconnecting'}
    </span>
  );
}
