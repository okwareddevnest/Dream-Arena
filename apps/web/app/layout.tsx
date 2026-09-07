// T-050 — document shell. Emits the palette once as CSS custom properties so that
// lib/theme.ts stays the only place a colour value is written. spec: PRD FR-U5.
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono, Instrument_Serif } from 'next/font/google';
import { cssVars } from '../lib/theme';
import './globals.css';

// Self-hosted at build time, so the demo never waits on a font CDN.
// Plex is engineered rather than neutral — it reads as instrumentation, which is
// what this is — and both faces ship true tabular figures, which the tape needs
// so prices align digit for digit.
const sans = IBM_Plex_Sans({
  subsets: ['latin'], weight: ['400', '500'], display: 'swap', variable: '--font-sans',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'], weight: ['400', '500'], display: 'swap', variable: '--font-mono',
});
// Display face, used ONLY on the launch page. The shift is deliberate: the
// marketing surface speaks in an editorial voice, the arena speaks in
// instrumentation. Two registers, one product.
const display = Instrument_Serif({
  subsets: ['latin'], weight: ['400'], style: ['normal', 'italic'],
  display: 'swap', variable: '--font-display',
});

export const metadata: Metadata = {
  title: 'Dream Arena',
  description:
    'MIRA is an autonomous agent trading live prediction markets on Somnia. ' +
    'Watch what it believes, what the market prices, and every trade it makes on-chain.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <head>
        {/* single injection point for every colour in the app */}
        <style dangerouslySetInnerHTML={{ __html: cssVars() }} />
      </head>
      <body className="min-h-screen bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
