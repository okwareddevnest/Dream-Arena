#!/usr/bin/env node
// Journal replay (T-064).
//
// Every run appends a JSONL journal. This reads one back and reconstructs what
// happened — which is the difference between "the demo did something odd" and
// knowing exactly what it did. Read-only: it never touches a chain or a key.
//   npm run replay                      # newest run
//   npm run replay -- <file> --kind fill
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'state/journal';
const argv = process.argv.slice(2);
const kindArg = argv.indexOf('--kind');
const wantKind = kindArg >= 0 ? argv[kindArg + 1] : null;
const file = argv.find((a) => a.endsWith('.jsonl'))
  ?? (existsSync(DIR)
    ? readdirSync(DIR).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, t: readFileSync(join(DIR, f), 'utf8').length }))
        .sort((a, b) => b.t - a.t)[0]?.f && join(DIR, readdirSync(DIR)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, m: readFileSync(join(DIR, f), 'utf8').length }))
        .sort((a, b) => b.m - a.m)[0].f)
    : null);

if (!file || !existsSync(file)) {
  console.error(`No journal found. Run the agent first; journals land in ${DIR}/.`);
  process.exit(2);
}

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const kinds = new Map();
const fills = [];
const orders = [];
const quips = [];
let firstMs = null, lastMs = null, mode = null, runId = null;

for (const l of lines) {
  let e;
  try { e = JSON.parse(l); } catch { continue; }   // a torn last line is normal
  kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  firstMs ??= e.tsMs; lastMs = e.tsMs;
  mode ??= e.mode; runId ??= e.runId;
  if (e.kind === 'fill') fills.push(e.payload);
  if (e.kind === 'order') orders.push(e.payload);
  if (e.kind === 'quip') quips.push(e.payload);
}

const secs = firstMs && lastMs ? Math.max(1, Math.round((lastMs - firstMs) / 1000)) : 0;
const notional = fills.reduce((a, f) => a + (f.sizeContracts ?? 0) * (f.price ?? 0), 0);

console.log(`\n  ${file}`);
console.log(`  run ${runId} · ${mode} · ${secs}s · ${lines.length} events\n`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(6)}  ${k}`);
}
console.log(`\n  orders ${orders.length} · fills ${fills.length} · notional ${notional.toFixed(2)} USD`);
if (quips.length) console.log(`  MIRA said: "${quips[quips.length - 1].text}"`);

if (wantKind) {
  console.log(`\n  ── ${wantKind} ──`);
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.kind !== wantKind) continue;
    console.log(`  ${new Date(e.tsMs).toISOString()}  ${JSON.stringify(e.payload).slice(0, 150)}`);
  }
}
console.log('');
