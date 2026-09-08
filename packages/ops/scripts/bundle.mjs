#!/usr/bin/env node
// Pre-confirmed transaction bundle (T-081).
//
// Harvests every transaction hash the agents recorded in their journals and
// VERIFIES each one on-chain before writing it down. A bundle of hashes nobody
// checked is worse than no bundle: it invites someone to paste a link on stage
// that 404s. Only receipts that come back `success` are included.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';

const RPC = process.env.SOMNIA_RPC_URL ?? 'https://api.infra.testnet.somnia.network';
const EXPLORER = 'https://shannon-explorer.somnia.network/tx/';
const DIR = 'state/journal';
const OUT = 'docs/submission/tx-bundle.md';

const pub = createPublicClient({ transport: http(RPC, { timeout: 12_000, retryCount: 2 }) });

if (!existsSync(DIR)) { console.error(`No journals in ${DIR}. Run the agent first.`); process.exit(2); }

// Collect (hash → what produced it) from every recorded session.
const found = new Map();
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {};
    const hash = p.txHash ?? p.hash;
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) continue;
    if (!found.has(hash)) {
      found.set(hash, {
        kind: e.kind, mode: e.mode, tsMs: e.tsMs,
        detail: e.kind === 'fill'
          ? `${p.agent} ${p.side} ${p.sizeContracts} @ ${(p.price * 100).toFixed(1)}%`
          : e.kind === 'ack' ? `${p.status} ${p.clientOrderId ?? ''}`.trim()
          : e.kind,
      });
    }
  }
}
console.log(`\n  ${found.size} candidate transaction(s) across the journals`);
if (!found.size) { console.error('  Nothing to bundle yet.\n'); process.exit(1); }

// Verify. This is the point of the exercise.
const rows = [];
let checked = 0;
for (const [hash, meta] of found) {
  process.stdout.write(`\r  verifying ${++checked}/${found.size}…`);
  try {
    const r = await pub.getTransactionReceipt({ hash });
    if (r.status !== 'success') continue;
    rows.push({ hash, ...meta, block: r.blockNumber.toString(), gas: r.gasUsed.toString() });
  } catch { /* dropped, reorged, or never mined — excluded on purpose */ }
}
process.stdout.write('\r');
rows.sort((a, b) => Number(b.block) - Number(a.block));

mkdirSync('docs/submission', { recursive: true });
writeFileSync(OUT, `# Verified transactions

Every hash below was read back from Somnia testnet and returned a receipt with
\`status: success\` at the time of writing. Anything the chain did not confirm was
excluded rather than listed — a bundle nobody checked is an invitation to paste a
dead link on stage.

Regenerate with \`npm run bundle\`.

| when | what | block | gas | transaction |
|---|---|---|---|---|
${rows.slice(0, 40).map((r) =>
  `| ${new Date(r.tsMs).toISOString().slice(0, 19).replace('T', ' ')} | ${r.kind} — ${r.detail} | ${r.block} | ${r.gas} | [${r.hash.slice(0, 14)}…](${EXPLORER}${r.hash}) |`,
).join('\n')}

${rows.length} confirmed of ${found.size} recorded.
`);

console.log(`  ${rows.length} confirmed on-chain, ${found.size - rows.length} excluded`);
console.log(`  written to ${OUT}\n`);
