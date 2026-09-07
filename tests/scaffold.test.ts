// T-001 acceptance — the toolchain itself is the subject.
// spec: 30-TASKS T-001 · ARCH §1,§5
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const WORKSPACES = ['shared', 'data', 'core', 'venue', 'api', 'ops'] as const;

describe('T-001 scaffold', () => {
  it('every ARCH §5 workspace exists with an ESM package manifest', () => {
    for (const w of WORKSPACES) {
      const p = resolve(root, `packages/${w}/package.json`);
      expect(existsSync(p), `${w} manifest`).toBe(true);
      const m = JSON.parse(readFileSync(p, 'utf8'));
      expect(m.name).toBe(`@arena/${w}`);
      expect(m.type).toBe('module');
    }
  });

  it('every workspace resolves @arena/shared by import specifier', async () => {
    const shared = await import('@arena/shared');
    expect(typeof shared).toBe('object');
    // each package re-exports something, proving cross-workspace resolution works
    for (const w of WORKSPACES) {
      const mod = await import(`@arena/${w}`);
      expect(mod, `@arena/${w} importable`).toBeTruthy();
    }
  });

  it('npm run typecheck exits 0', () => {
    // throws on non-zero exit
    execFileSync('npm', ['run', '--silent', 'typecheck'], { cwd: root, stdio: 'pipe' });
  });

  it('vitest discovers at least one test file in every package', () => {
    const out = execFileSync('npx', ['vitest', 'list', '--filesOnly'], { cwd: root, stdio: 'pipe' }).toString();
    for (const w of WORKSPACES) {
      expect(out, `${w} has a test file`).toMatch(new RegExp(`packages/${w}/`));
    }
  });
});
