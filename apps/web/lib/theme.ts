// T-050 — THE single source of colour for the arena. spec: PRD FR-U5 (dark broadcast aesthetic).
// Every other file in apps/web references these tokens; shell.test.tsx enforces that by scan.
// Values are emitted once as CSS custom properties (cssVars) and consumed by Tailwind through
// THEME_TOKENS, so a colour is never written twice and never drifts between CSS and TS.

/** Broadcast palette: a near-black ground so live numbers and the gauge carry the screen. */
export const PALETTE = {
  /** The ground: a deep, warm-leaning charcoal-indigo. Not a blue-black terminal
   *  and not a neutral grey — it has a temperature, which is what stops a dark
   *  interface feeling like a void. */
  bg: '#0b0c10',
  /** panel ground, one step up */
  surface: '#131519',
  /** raised — feature cards, inputs, the instrument face */
  raised: '#1b1e24',
  /** the step above raised, used sparingly */
  overlay: '#242830',
  /** hairline structure */
  line: '#2a2f38',
  /** chart gridlines */
  grid: '#20242b',
  /** primary text — warm white, not clinical */
  ink: '#f2efe9',
  /** secondary */
  'ink-muted': '#a8a49c',
  /** tertiary */
  'ink-faint': '#6b6862',
  /** MIRA. A soft aqua that reads as considered rather than neon. */
  accent: '#5ecfc0',
  /** MIRA at full intensity — only where the eye must land first */
  'accent-hot': '#9df0e2',
  /** The warm counterpoint. An interface with only cool colour feels cold; this
   *  is the warmth, used for value, gain and emphasis. */
  gold: '#e8b464',
  /** ECHO — its own identity, so two agents on one tape are told apart at a glance */
  echo: '#b98ee0',
  /** long / YES / profit */
  long: '#6ec98d',
  /** short / NO / loss */
  short: '#e8737f',
  /** caution */
  warn: '#e8b464',
  /** LIVE badge */
  live: '#6ec98d',
  /** SIM badge */
  sim: '#e8b464',
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
