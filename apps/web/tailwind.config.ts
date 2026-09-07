// T-050 — colours are NOT defined here; they are imported from lib/theme.ts (the single source).
import type { Config } from 'tailwindcss';
import { THEME_TOKENS } from './lib/theme';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: { colors: { ...THEME_TOKENS } } },
} satisfies Config;
