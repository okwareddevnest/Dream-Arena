#!/usr/bin/env node
// Checkpoint one card in state/STATE.md. Usage: ledger.mjs T-001 done 21/21 "note"
import { readFileSync, writeFileSync } from 'node:fs';
const [id, status, tests = '-', ...rest] = process.argv.slice(2);
if (!id || !status) { console.error('usage: ledger.mjs <T-id> <status> [tests] [note...]'); process.exit(2); }
const note = rest.join(' ');
const p = 'state/STATE.md';
const lines = readFileSync(p, 'utf8').split('\n');
let hit = false;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\| (T-[A-Z0-9]+) \| ([^|]*)\| ([^|]*)\| ([^|]*)\| ([^|]*)\| ([^|]*)\|$/);
  if (!m || m[1] !== id) continue;
  lines[i] = `| ${id} | ${m[2].trim()} | ${m[3].trim()} | ${status} | ${tests} | ${note || m[6].trim()} |`;
  hit = true; break;
}
if (!hit) { console.error(`ledger: no row for ${id}`); process.exit(1); }
writeFileSync(p, lines.join('\n'));
console.log(`ledger: ${id} -> ${status} (${tests}) ${note}`);
