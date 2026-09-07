// T-050 — document shell. Emits the palette once as CSS custom properties so that
// lib/theme.ts stays the only place a colour value is written. spec: PRD FR-U5.
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { cssVars } from '../lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dream Arena — MIRA',
  description: 'An autonomous agent trading live prediction markets on Somnia.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* single injection point for every colour in the app */}
        <style dangerouslySetInnerHTML={{ __html: cssVars() }} />
      </head>
      <body className="min-h-screen bg-bg text-ink antialiased">{children}</body>
    </html>
  );
}
