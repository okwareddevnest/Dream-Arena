// The README's diagrams must actually parse.
//
// A malformed mermaid block does not fail quietly on GitHub — it renders a red
// error box in place of the diagram, on the first page anyone reads. Cheaper to
// assert it here than to find out from a reviewer.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readme = readFileSync(resolve(import.meta.dirname, '../../../README.md'), 'utf8');
const blocks = [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);

describe('README diagrams', () => {
  it('has diagrams at all', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it('every block parses as valid mermaid', async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    for (const [i, src] of blocks.entries()) {
      // parse() throws on a syntax error, which is exactly what we want to catch.
      await expect(mermaid.parse(src), `block ${i + 1} parses`).resolves.toBeTruthy();
    }
  }, 60_000);

  it('every block is themed, so none renders as default grey', () => {
    for (const [i, src] of blocks.entries()) {
      expect(src, `block ${i + 1} carries a theme`).toContain("'theme':'base'");
      expect(src, `block ${i + 1} uses the arena palette`).toContain('#0b0c10');
    }
  });

  it('code fences are balanced', () => {
    expect(readme.split('```').length % 2, 'an odd split means an unclosed fence').toBe(1);
  });
});
