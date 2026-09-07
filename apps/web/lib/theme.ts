// T-050 — THE single source of colour for the arena. spec: PRD FR-U5 (dark broadcast aesthetic).
// Every other file in apps/web references these tokens; shell.test.tsx enforces that by scan.
// Values are emitted once as CSS custom properties (cssVars) and consumed by Tailwind through
// THEME_TOKENS, so a colour is never written twice and never drifts between CSS and TS.

/** Broadcast palette: a near-black ground so live numbers and the gauge carry the screen. */
export const PALETTE = {
  /** page ground — the studio floor */
  bg: '#07090c',
  /** panel ground */
  surface: '#0e1319',
  /** raised panel / hovered row */
  raised: '#151c24',
  /** hairline borders and grid rules */
  line: '#1f2933',
  /** primary text */
  ink: '#e6edf3',
  /** secondary text — labels, units */
  'ink-muted': '#8b98a5',
  /** tertiary text — timestamps, disabled */
  'ink-faint': '#55606b',
  /** MIRA's identity colour; also the model curve */
  accent: '#38bdf8',
  /** long / YES / profit */
  long: '#22c55e',
  /** short / NO / loss */
  short: '#f43f5e',
  /** caution — stale feed, degraded health */
  warn: '#fbbf24',
  /** LIVE badge (real venue, real money-at-risk) */
  live: '#22c55e',
  /** SIM badge (test rig only — never the demo path) */
  sim: '#fbbf24',
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
