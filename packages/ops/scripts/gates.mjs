#!/usr/bin/env node
// Gate runner (G1..G6).
//
// A gate is only green when something ran and passed — never because a checklist
// was ticked. Each one below shells out to the real command and reports its exit
// code. Gates needing a funded key or a human are reported as such rather than
// quietly passing.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const run = (cmd, args) => {
  try { execFileSync(cmd, args, { stdio: 'pipe', timeout: 600_000 }); return true; }
  catch { return false; }
};
const npm = (script) => run('npm', ['run', '--silent', script]);

const G = (name, detail, ok) => ({ name, detail, ok });
const results = [];

// G1 — the toolchain and the simulated venue stand up, and CI-equivalent is green.
results.push(G('G1 scaffold + SimVenue + CI', 'typecheck, unit suite, docs gate',
  npm('typecheck') && npm('test') && npm('gate:0')));

// G2 — the agent works end to end on the test rig, faults included.
results.push(G('G2 agent E2E (rig)', 'GWT acceptance + fault injection',
  npm('test:integration') && npm('test:fault')));

// G3 — the arena builds and its components hold their contracts.
results.push(G('G3 arena E2E', 'web suite incl. production next build', npm('test:web')));

// G4 — the live chain. Needs a funded key; reported honestly when absent.
const haveKey = !!process.env.MIRA_PRIVATE_KEY;
results.push(G('G4 testnet smoke', haveKey ? 'live read + write round-trip' : 'NO KEY — not run',
  haveKey ? npm('test:live') : null));

// G5 — a rehearsal is a human act. What CAN be checked is that the runbook exists
// and a real session was journaled.
const journals = existsSync('state/journal')
  ? readdirSync('state/journal').filter((f) => f.endsWith('.jsonl')) : [];
results.push(G('G5 demo rehearsal', journals.length
  ? `${journals.length} recorded session(s); rehearsal sign-off is manual`
  : 'no recorded session yet', journals.length > 0 ? null : false));

// G6 — the submission bundle.
const bundle = ['README.md', 'docs/60-SUBMISSION.md', 'docs/submission/sdk-feedback.md',
  'docs/50-DEMO-RUNBOOK.md'];
const missing = bundle.filter((f) => !existsSync(f));
results.push(G('G6 submission bundle', missing.length ? `missing: ${missing.join(', ')}` : 'all artefacts present',
  missing.length === 0));

const mark = (ok) => (ok === null ? '\x1b[33m○ MANUAL\x1b[0m' : ok ? '\x1b[32m● PASS\x1b[0m' : '\x1b[31m● FAIL\x1b[0m');
console.log('\n  Gates\n');
for (const r of results) console.log(`  ${mark(r.ok)}  ${r.name.padEnd(30)} ${r.detail}`);
const failed = results.filter((r) => r.ok === false);
console.log(`\n  ${results.filter((r) => r.ok === true).length} passed · ${failed.length} failed · ${results.filter((r) => r.ok === null).length} manual\n`);
process.exit(failed.length ? 1 : 0);
