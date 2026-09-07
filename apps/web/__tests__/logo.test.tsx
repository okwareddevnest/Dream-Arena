// Brand mark acceptance.
// The identity is derived from the product's own thesis rather than decoration:
// two marks on a shared probability axis with the span between them — the
// divergence MIRA trades on, reduced to its simplest geometry.
// Constraints from the client: no emoji, no gradients, colour from theme tokens only.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logo, Wordmark } from '../components/Logo';

afterEach(cleanup);
const web = resolve(import.meta.dirname, '..');
const logoSrc = readFileSync(resolve(web, 'components/Logo.tsx'), 'utf8');
const iconSrc = readFileSync(resolve(web, 'app/icon.svg'), 'utf8');

describe('the mark', () => {
  it('renders an accessible, labelled graphic', () => {
    render(<Logo />);
    const svg = screen.getByRole('img', { name: /dream arena/i });
    expect(svg.tagName.toLowerCase()).toBe('svg');
  });

  it('scales from favicon to header without a fixed pixel size', () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox'), 'must scale').toBeTruthy();
  });

  it('carries the two marks and the span between them', () => {
    const { container } = render(<Logo />);
    expect(container.querySelector('[data-part="model"]')).not.toBeNull();
    expect(container.querySelector('[data-part="market"]')).not.toBeNull();
    expect(container.querySelector('[data-part="span"]')).not.toBeNull();
    expect(container.querySelector('[data-part="axis"]')).not.toBeNull();
  });

  it('uses NO gradients anywhere', () => {
    for (const [name, src] of [['Logo.tsx', logoSrc], ['icon.svg', iconSrc]] as const) {
      expect(/linearGradient|radialGradient|gradient\(/i.test(src), `${name} is flat`).toBe(false);
    }
  });

  it('uses NO emoji', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    expect(emoji.test(logoSrc)).toBe(false);
    expect(emoji.test(iconSrc)).toBe(false);
  });

  it('takes its colour from the theme, never a literal, so it inherits the palette', () => {
    // theme.ts is the single source of colour (enforced by shell.test.tsx).
    expect(/#[0-9a-f]{3,8}\b/i.test(logoSrc), 'no hex in the component').toBe(false);
    expect(logoSrc).toContain('currentColor');
  });

  it('ships a real favicon rather than an emoji glyph', () => {
    expect(iconSrc).toContain('<svg');
    expect(iconSrc).toContain('viewBox');
  });
});

describe('the wordmark', () => {
  it('reads as the product name', () => {
    render(<Wordmark />);
    expect(screen.getByText(/dream arena/i)).toBeTruthy();
  });
  it('is set in one weight — the mark carries the identity, not a bolded half', () => {
    // "accent one word of a title" is the commonest generated-design tell.
    expect(/font-(bold|semibold|black)/.test(logoSrc)).toBe(false);
  });
});
