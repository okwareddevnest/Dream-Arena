// T-050 — THE single source of colour for the arena. spec: PRD FR-U5 (dark broadcast aesthetic).
// Every other file in apps/web references these tokens; shell.test.tsx enforces that by scan.
// Values are emitted once as CSS custom properties (cssVars) and consumed by Tailwind through
// THEME_TOKENS, so a colour is never written twice and never drifts between CSS and TS.

/** Broadcast palette: a near-black ground so live numbers and the gauge carry the screen. */
export const PALETTE = {
  /** page ground — a deep blue-black, not a neutral one: the cool cast makes the
   *  green/red of a position read as colour rather than as noise on grey */
  bg: '#06080b',
  /** panel ground */
  surface: '#0b0f14',
  /** raised panel / hovered row */
  raised: '#121820',
  /** hairline borders — structure comes from these, not from shadows */
  line: '#1b232d',
  /** chart gridlines: present enough to read a value against, quiet enough to
   *  never compete with the series */
  grid: '#141c25',
  /** primary text */
  ink: '#e8eef4',
  /** secondary text — labels, units */
  'ink-muted': '#93a1b0',
  /** tertiary text — timestamps, disabled */
  'ink-faint': '#5b6875',
  /** MIRA's identity, and the divergence span. The only saturated thing on the
   *  arena, so a large edge is visible from across a room. */
  accent: '#4cc9f0',
  /** long / YES / profit */
  long: '#2ee6a8',
  /** short / NO / loss */
  short: '#ff5d7a',
  /** caution — stale feed, degraded health */
  warn: '#ffc857',
  /** LIVE badge (real venue, real money-at-risk) */
  live: '#2ee6a8',
  /** SIM badge (test rig only — never the demo path) */
  sim: '#ffc857',
} as const;

export type ThemeToken = keyof typeof PALETTE;

/** `--arena-<token>` custom properties, emitted once into the document root. */
export function cssVars(): string {
  const body = (Object.keys(PALETTE) as ThemeToken[])
    .map((k) => `  --arena-${k}: ${PALETTE[k]};`)
    .join('\n');
  return `:root {\n${body}\n}`;
}

/** Tailwind colour map — indirection only, so no literal ever leaves this file. */
export const THEME_TOKENS = Object.fromEntries(
  (Object.keys(PALETTE) as ThemeToken[]).map((k) => [k, `var(--arena-${k})`]),
) as Record<ThemeToken, string>;
