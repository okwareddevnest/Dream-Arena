// The README's diagrams must actually parse.
//
// A malformed mermaid block does not fail quietly on GitHub — it renders a red
// error box in place of the diagram, on the first page anyone reads. Cheaper to
// assert it here than to find out from a reviewer.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = (f: string) => readFileSync(resolve(import.meta.dirname, '../../../', f), 'utf8');
const readme = root('README.md');
const submission = root('SUBMISSION.md');
const grab = (md: string) => [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);
// Both public-facing documents: a broken block renders a red error box on the
// first page a judge reads.
const blocks = [...grab(readme), ...grab(submission)];

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

  it('code fences are balanced in both documents', () => {
    expect(readme.split('```').length % 2, 'README has an unclosed fence').toBe(1);
    expect(submission.split('```').length % 2, 'SUBMISSION has an unclosed fence').toBe(1);
  });

  it('the DoraHacks version has NO mermaid — that platform renders it as code', () => {
    const dora = root('SUBMISSION-DORAHACKS.md');
    expect(dora.includes('```mermaid'), 'a mermaid fence would render as a code block there').toBe(false);
    // …and carries the rendered diagrams instead.
    expect((dora.match(/!\[/g) ?? []).length, 'diagrams present as images').toBeGreaterThanOrEqual(3);
    expect(dora.split('```').length % 2, 'unclosed fence').toBe(1);
  });

  it('every image the DoraHacks version references exists on disk', () => {
    const dora = root('SUBMISSION-DORAHACKS.md');
    const paths = [...dora.matchAll(/(brand\/[A-Za-z0-9._\/-]+\.png)/g)].map((m) => m[1]!);
    expect(paths.length, 'it references images').toBeGreaterThanOrEqual(3);
    for (const p of new Set(paths)) {
      expect(existsSync(resolve(import.meta.dirname, '../../../', p)), `${p} exists`).toBe(true);
    }
  });

  it('the submission points at a logo that exists', () => {
    const ref = /src="(brand\/[^"]+)"/.exec(submission)?.[1];
    expect(ref, 'the submission shows a logo').toBeTruthy();
    expect(existsSync(resolve(import.meta.dirname, '../../../', ref!)), `${ref} exists`).toBe(true);
  });
});
