// T-050 acceptance — the arena shell and its colour discipline are the subject.
// spec: 30-TASKS T-050 · PRD FR-U5,F-A1 · ARCH §1
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import ArenaPage from '../app/arena/page';
import { PALETTE, cssVars, THEME_TOKENS } from '../lib/theme';

const web = resolve(import.meta.dirname, '..');

/** Every colour-bearing source file except the one allowed to hold literals. */
function colourSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') walk(p); continue; }
      if (['.tsx', '.ts', '.css'].includes(extname(e.name)) && p !== resolve(web, 'lib/theme.ts')) out.push(p);
    }
  };
  walk(join(web, 'app'));
  walk(join(web, 'components'));
  walk(join(web, 'lib'));
  return out;
}

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC = /\b(?:rgba?|hsla?|oklch|color-mix)\(/;
const TW_PALETTE =
  /\b(?:bg|text|border|ring|from|via|to|fill|stroke|shadow|outline|decoration|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/;

afterEach(cleanup);

describe('T-050 arena shell', () => {
  it('renders the arena route with no live server, no network, no fabricated data', () => {
    render(<ArenaPage />);
    // The brand and the three F-A1 regions exist as labelled landmarks…
    expect(screen.getByRole('main', { name: /arena/i })).toBeTruthy();
    // Landmark names track the visible headings (an aria-label that disagrees
    // with its heading is an accessibility anti-pattern), so they are asserted
    // by the copy the page actually shows.
    for (const region of ['what mira believes', 'trades', 'forecasters', 'agent', 'holdings', 'markets']) {
      expect(screen.getByRole('region', { name: new RegExp(region, 'i') }), region).toBeTruthy();
    }
  });

  // AMENDED at T-052/53/54. The original required the literal word "awaiting" in
  // every empty region. The rule that matters is that an empty region NEVER
  // fabricates a number; the wording is now specific to each panel, because an
  // empty screen should say what to expect rather than repeat one stock phrase.
  it('shows an honest empty state rather than placeholder numbers', () => {
    render(<ArenaPage />);
    for (const name of ['what mira believes', 'trades', 'forecasters']) {
      const region = screen.getByRole('region', { name: new RegExp(name, 'i') });
      const text = region.textContent ?? '';
      expect(text, `${name} must not fabricate values`).not.toMatch(/\d/);
      expect(text.trim().length, `${name} explains itself`).toBeGreaterThan(10);
    }
  });

  it('exposes the broadcast palette as tokens with a dark ground', () => {
    expect(Object.keys(PALETTE).length).toBeGreaterThanOrEqual(8);
    for (const [k, v] of Object.entries(PALETTE)) {
      expect(v, `${k} is a hex literal`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // Broadcast = dark ground: the base background must be very dark.
    const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, b) => a + b, 0) / 3;
    expect(lum(PALETTE.bg), 'bg is a dark ground').toBeLessThan(40);
    expect(lum(PALETTE.ink), 'ink is legible on it').toBeGreaterThan(180);
    // Every token is emitted as a CSS custom property and mapped for Tailwind.
    const css = cssVars();
    for (const k of Object.keys(PALETTE)) {
      expect(css, `--arena-${k} emitted`).toContain(`--arena-${k}:`);
      expect(THEME_TOKENS[k as keyof typeof PALETTE], `${k} mapped`).toBe(`var(--arena-${k})`);
    }
  });

  it('theme.ts is the ONLY source of colour in the app', () => {
    const files = colourSources();
    expect(files.length, 'sources were actually scanned').toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = f.slice(web.length + 1);
      expect(HEX.test(src), `${rel} holds a hex colour`).toBe(false);
      expect(FUNC.test(src), `${rel} holds a colour function`).toBe(false);
      expect(TW_PALETTE.test(src), `${rel} uses a raw Tailwind palette colour`).toBe(false);
    }
  });

  it('next build exits 0', () => {
    // Build from a clean slate. A stale .next left by a dev server or a manual
    // build makes this fail on a missing route module (observed: "Cannot find
    // module for page: /icon.svg"), which says nothing about the code under test.
    rmSync(resolve(web, '.next'), { recursive: true, force: true });
    execFileSync('npx', ['next', 'build'], { cwd: web, stdio: 'pipe', timeout: 300_000 });
  });
});
