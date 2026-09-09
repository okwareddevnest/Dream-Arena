// Single-box boot — the whole arena in one service, behind one port.
//
//   npm start          # what Render runs
//
// WHY ONE PROCESS TREE. Render's free tier has no background workers, only web
// services, and grants 750 instance-hours per workspace per month — a 30-day
// month is 720 hours, so exactly ONE service can stay up around the clock.
// MIRA, ECHO and the site therefore share a host. They do NOT share a key: the
// venue blocks self-matching (RFC-001 A7), so each agent keeps its own signer,
// its own NonceManager and its own TxQueue, exactly as when they ran apart.
// Separate processes are still separate here — the supervisor just owns them.
// spec: ARCH §1 · RFC-001 A7 · RFC-003 · docs/80-DEPLOY.md
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startEdge } from './edge.ts';
import { restartDelayMs, shouldGiveUp, CRASH_WINDOW_MS } from './restart.ts';

const log = (s: string) => console.log(`${new Date().toISOString()} [boot] ${s}`);

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

interface ChildSpec {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** A child whose death should take the whole service down with it. */
  readonly critical: boolean;
}

// Absolute, so nothing depends on where the service was started from.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_DIR = resolve(ROOT, 'apps/web');
const NEXT_BIN = resolve(ROOT, 'node_modules/next/dist/bin/next');

const PORT = num(process.env.PORT, 10_000);          // Render's port
const WEB_PORT = num(process.env.WEB_PORT, 3_000);   // internal `next start`
const API_PORT = num(process.env.API_PORT, 8_080);   // internal arena API + /ws

// SIWE binds the signed message to a domain (packages/api/src/auth.ts), and on
// a single origin that domain is this service's own URL. Render publishes it,
// so the operator does not have to know their subdomain before first deploy.
const ORIGIN = process.env.WEB_ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const shared: NodeJS.ProcessEnv = {
  ...process.env,
  WEB_ORIGIN: ORIGIN,
  API_PORT: String(API_PORT),
};

const NODE = process.execPath;
const STRIP = '--experimental-strip-types';

const specs: ChildSpec[] = [
  {
    name: 'web',
    cmd: NODE,
    // Run FROM apps/web: `next start` resolves .next against its cwd, so from
    // the repo root it finds no build and exits immediately.
    args: [NEXT_BIN, 'start', '-p', String(WEB_PORT)],
    env: { ...shared, PORT: String(WEB_PORT) },
    cwd: WEB_DIR,
    critical: true,
  },
  {
    // Serves /api and /ws. Without it the site renders but has nothing to say.
    name: 'mira',
    cmd: NODE,
    args: [STRIP, resolve(ROOT, 'packages/ops/src/main.ts')],
    env: { ...shared, PORT: String(API_PORT) },
    cwd: ROOT,                                  // state/journal is repo-relative
    critical: true,
  },
];

// ECHO is optional by construction: it needs a SECOND funded key, and a deploy
// without one should still serve MIRA rather than refuse to boot.
const echoKey = process.env.ECHO_PRIVATE_KEY ?? '';
const echoOn = (process.env.ECHO_ENABLED ?? 'true') !== 'false';
if (echoOn && echoKey && echoKey !== process.env.MIRA_PRIVATE_KEY) {
  specs.push({
    name: 'echo', cmd: NODE, args: [STRIP, resolve(ROOT, 'packages/ops/src/echoMain.ts')],
    env: shared, cwd: ROOT, critical: false,
  });
} else {
  log(`echo not started — ${!echoOn ? 'ECHO_ENABLED=false' : 'no distinct ECHO_PRIVATE_KEY'}. ` +
      'MIRA will trade against whatever organic flow exists (T-S4 measured none).');
}

const children = new Map<string, ChildProcess>();
const crashes = new Map<string, number>();
let stopping = false;

const start = (spec: ChildSpec): void => {
  if (stopping) return;
  const child = spawn(spec.cmd, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.set(spec.name, child);
  log(`${spec.name} pid ${child.pid}`);

  child.on('exit', (code, signal) => {
    children.delete(spec.name);
    if (stopping) return;
    const n = (crashes.get(spec.name) ?? 0) + 1;
    crashes.set(spec.name, n);
    log(`${spec.name} exited code=${code} signal=${signal} (crash ${n})`);

    if (shouldGiveUp(n)) {
      log(`${spec.name} gave up after ${n} crashes — not restarting.`);
      // A dead critical child means the service is lying to its health check.
      // Better to fail the deploy visibly than to serve a page with no arena.
      if (spec.critical) void shutdown(`${spec.name} unrecoverable`, 1);
      return;
    }
    const wait = restartDelayMs(n - 1);
    log(`${spec.name} restarting in ${wait}ms`);
    setTimeout(() => start(spec), wait).unref();
  });

  child.on('error', (e: Error) => log(`${spec.name} spawn error: ${e.message}`));
};

// A crash half an hour ago should not count against a restart now.
setInterval(() => crashes.clear(), CRASH_WINDOW_MS).unref();

for (const s of specs) start(s);

const edge = await startEdge({
  port: PORT,
  api: { host: '127.0.0.1', port: API_PORT },
  web: { host: '127.0.0.1', port: WEB_PORT },
  log,
});

log(`arena up on ${edge.port} · origin ${ORIGIN} · mode ${process.env.VENUE_MODE ?? 'LIVE'}`);

// ── Shutdown ────────────────────────────────────────────────────────────────
// Render sends SIGTERM and SIGKILLs 30s later. Both agents cancel their resting
// orders on SIGTERM — an abandoned order is real collateral on a real chain —
// so the grace period here is what protects that, and it must end before
// Render's does.
const GRACE_MS = num(process.env.SHUTDOWN_GRACE_MS, 25_000);

async function shutdown(why: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${why})`);
  try { await edge.stop(); } catch { /* already closed */ }
  for (const [name, c] of children) { log(`SIGTERM ${name}`); c.kill('SIGTERM'); }

  const deadline = Date.now() + GRACE_MS;
  while (children.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const [name, c] of children) { log(`SIGKILL ${name} (did not exit in ${GRACE_MS}ms)`); c.kill('SIGKILL'); }
  log('stopped');
  process.exit(code);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
