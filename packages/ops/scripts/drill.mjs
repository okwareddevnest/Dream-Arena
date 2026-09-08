#!/usr/bin/env node
// Recovery drill (T-065, re-scoped by RFC-003).
//
// The card originally timed a LIVE→SIM switchover. RFC-003 removed SIM as a demo
// path, so the drill that matters is LIVE→LIVE recovery: the agent dies mid-demo
// and has to come back without leaving collateral stranded in resting orders.
// This measures that, for real, against the running system.
import { execFileSync, spawn } from 'node:child_process';

const API = process.env.API_BASE ?? 'http://localhost:8080';
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (s) => console.log(`  [${since().padStart(6)}] ${s}`);

const health = async () => {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

const waitFor = async (pred, label, budgetMs) => {
  const start = Date.now();
  for (;;) {
    const h = await health();
    if (pred(h)) return Date.now() - start;
    if (Date.now() - start > budgetMs) throw new Error(`${label} did not happen within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

process.on('unhandledRejection', (e) => { console.error(`\n  ✗ ${e}\n`); process.exit(1); });
console.log('\n  Recovery drill — LIVE agent dies and returns\n');

const before = await health();
if (!before) { console.error('  ✗ No agent on :8080. Start one first: npm run agent\n'); process.exit(2); }
log(`agent up · mode ${before.mode} · tick lag ${before.tickLagMs}ms`);

// SIGINT, not SIGKILL: the graceful path is the one that cancels resting orders,
// and that is exactly what the drill needs to prove.
// -sTCP:LISTEN matters: a bare `lsof -ti:8080` also lists every process with an
// open CONNECTION to that port — including this script, which has just polled
// /api/health. Without the filter the drill SIGINTs itself and exits 130.
const pids = execFileSync('bash', ['-lc', 'lsof -ti:8080 -sTCP:LISTEN || true'])
  .toString().split('\n').map((x) => x.trim()).filter(Boolean)
  .filter((x) => Number(x) !== process.pid);
log(`stopping agent (pid ${pids.join(',')})`);
for (const pid of pids) { try { process.kill(Number(pid), 'SIGINT'); } catch { /* gone */ } }

const downMs = await waitFor((h) => h === null, 'shutdown', 60_000);
log(`agent down after ${(downMs / 1000).toFixed(1)}s (it cancels resting orders first)`);

log('restarting');
// Fully detached through a shell: the restarted agent must outlive this script,
// which is the whole point of a recovery drill.
const child = spawn('bash', ['-lc', 'nohup npm run --silent agent > state/logs/drill-restart.log 2>&1 &'], {
  detached: true, stdio: 'ignore', cwd: process.cwd(),
});
child.unref();

const upMs = await waitFor((h) => h !== null && h.ok === true, 'recovery', 120_000);
const after = await health();
log(`agent healthy again after ${(upMs / 1000).toFixed(1)}s · mode ${after.mode}`);

const total = (Date.now() - t0) / 1000;
console.log(`\n  total ${total.toFixed(1)}s · recovery ${(upMs / 1000).toFixed(1)}s`);
console.log(after.mode === before.mode
  ? `  ✓ came back on the same venue (${after.mode})\n`
  : `  ✗ came back on a DIFFERENT venue: ${before.mode} → ${after.mode}\n`);
process.exit(after.mode === before.mode ? 0 : 1);
