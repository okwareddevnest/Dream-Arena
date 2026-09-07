// T-050 — colours are NOT defined here; they are imported from lib/theme.ts (the single source).
import type { Config } from 'tailwindcss';
import { THEME_TOKENS } from './lib/theme';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    // A deliberate scale, roughly a 1.2 ratio, replacing Tailwind's defaults so
    // there is ONE vocabulary of sizes and no ad-hoc bracket values drifting in.
    // Body sits at 17px: this is a screen people read across a room, not a form.
    fontSize: {
      xs:   ['0.8125rem', { lineHeight: '1.15rem' }],   // units, timestamps
      sm:   ['0.9375rem', { lineHeight: '1.4rem'  }],   // labels, secondary
      base: ['1.0625rem', { lineHeight: '1.7rem'  }],   // body
      lg:   ['1.25rem',   { lineHeight: '1.6rem'  }],   // panel headings
      xl:   ['1.5rem',    { lineHeight: '1.85rem' }],
      '2xl':['1.9375rem', { lineHeight: '2.2rem'  }],   // primary figures
      '3xl':['2.5rem',    { lineHeight: '2.7rem'  }],
      '4xl':['3.25rem',   { lineHeight: '1.05'    }],
    },
    extend: {
      colors: { ...THEME_TOKENS },
      borderRadius: { card: '0.625rem' },
      // Wired to next/font's CSS variables (see app/layout.tsx).
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        display: ['var(--font-display)', 'ui-serif', 'Georgia', 'serif'],
      },
    },
  },
} satisfies Config;
