// The README's diagrams must actually parse.
//
// A malformed mermaid block does not fail quietly on GitHub — it renders a red
// error box in place of the diagram, on the first page anyone reads. Cheaper to
// assert it here than to find out from a reviewer.
//
// README.md is the ONLY published document. The submission drafts are part of
// the private engineering record (.gitignore), so a clone of this repository
// does not have them — this file must still pass there, or CI is red for a
// reason that has nothing to do with the code. Their checks therefore skip when
// the file is absent, and run in full where it exists.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const at = (f: string) => resolve(import.meta.dirname, '../../../', f);
const root = (f: string) => readFileSync(at(f), 'utf8');
const maybe = (f: string): string | null => (existsSync(at(f)) ? root(f) : null);

const readme = root('README.md');
const submission = maybe('SUBMISSION.md');
const dora = maybe('SUBMISSION-DORAHACKS.md');

const grab = (md: string) => [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);
const blocks = [...grab(readme), ...(submission ? grab(submission) : [])];

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
    expect(readme.split('```').length % 2, 'README has an unclosed fence').toBe(1);
  });

  it('links only to paths that are actually published', () => {
    // The private record is git-ignored. A README link into it is a 404 for
    // everyone who clones — which is exactly what happened once already.
    const targets = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!)
      .filter((t) => !/^(https?:|mailto:|#)/.test(t));
    for (const t of targets) {
      expect(existsSync(at(t.split('#')[0]!)), `README links to ${t}`).toBe(true);
    }
    for (const p of ['docs/', 'state/STATE.md', 'SUBMISSION.md', 'prompt.md']) {
      expect(readme.includes(`(${p}`), `README must not link into ${p} — it is private`).toBe(false);
    }
  });
});

// ── Private submission drafts ───────────────────────────────────────────────
describe.skipIf(!submission)('submission draft', () => {
  it('has balanced code fences', () => {
    expect(submission!.split('```').length % 2, 'unclosed fence').toBe(1);
  });

  it('points at a logo that exists', () => {
    const ref = /src="(brand\/[^"]+)"/.exec(submission!)?.[1];
    expect(ref, 'the submission shows a logo').toBeTruthy();
    expect(existsSync(at(ref!)), `${ref} exists`).toBe(true);
  });
});

describe.skipIf(!dora)('DoraHacks variant', () => {
  it('has NO mermaid — that platform renders it as a code block', () => {
    expect(dora!.includes('```mermaid'), 'a mermaid fence would render as a code block there').toBe(false);
    expect((dora!.match(/!\[/g) ?? []).length, 'diagrams present as images').toBeGreaterThanOrEqual(3);
    expect(dora!.split('```').length % 2, 'unclosed fence').toBe(1);
  });

  it('every image it references exists on disk', () => {
    const paths = [...dora!.matchAll(/(brand\/[A-Za-z0-9._\/-]+\.png)/g)].map((m) => m[1]!);
    expect(paths.length, 'it references images').toBeGreaterThanOrEqual(3);
    for (const p of new Set(paths)) expect(existsSync(at(p)), `${p} exists`).toBe(true);
  });
});
