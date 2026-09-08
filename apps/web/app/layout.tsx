// T-050 — document shell. Emits the palette once as CSS custom properties so that
// lib/theme.ts stays the only place a colour value is written. spec: PRD FR-U5.
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { Fraunces, Manrope, JetBrains_Mono } from 'next/font/google';
import { cssVars } from '../lib/theme';
import './globals.css';

// Self-hosted at build time, so the demo never waits on a font CDN.
//
// A deliberate change of voice. Fraunces is a variable serif with real
// personality — its optical-size axis means the display cut is genuinely drawn
// for large sizes rather than a body face scaled up, which is what gives the
// headlines warmth instead of authority-by-default. Manrope carries the
// interface: geometric, open, friendlier than a grotesque without being soft.
// JetBrains Mono holds the numbers — true tabular figures, and enough character
// that a column of prices looks designed rather than dumped.
// Variable: `axes` and a fixed `weight` are mutually exclusive in next/font, and
// the whole point of Fraunces here is the axes — SOFT rounds the terminals, WONK
// enables the alternate shapes, and opsz means the display cut is genuinely
// drawn for large sizes rather than a body face scaled up.
const display = Fraunces({
  subsets: ['latin'], axes: ['SOFT', 'WONK', 'opsz'],
  display: 'swap', variable: '--font-display',
});
const sans = Manrope({
  subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--font-sans',
});
const mono = JetBrains_Mono({
  subsets: ['latin'], weight: ['400', '500'], display: 'swap', variable: '--font-mono',
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
