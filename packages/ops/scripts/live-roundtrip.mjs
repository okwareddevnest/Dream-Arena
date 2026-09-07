#!/usr/bin/env node
// G4 write-path smoke — thin runner over the SHARED implementation in
// packages/ops/src/liveSmoke.ts, so this script and the live test suite can
// never drift apart.
//   npm run smoke:live          # place + cancel for real
//   npm run smoke:live -- --dry # reads only, no writes
import { runRoundTrip } from '../src/liveSmoke.ts';

const KEY = process.env.MIRA_PRIVATE_KEY;
if (!KEY) { console.error('MIRA_PRIVATE_KEY required (see docs/70-FUNDING.md)'); process.exit(2); }

try {
  const r = await runRoundTrip({
    privateKey: KEY,
    venueId: process.env.VENUE_ID,
    rpcUrl: process.env.SOMNIA_RPC_URL,
    indexerUrl: process.env.SOMNIA_INDEXER_URL,
    dry: process.argv.includes('--dry'),
    log: (l) => console.log(`  ${l}`),
  });
  console.log(`\n  ${r.asset} — "${r.question}"`);
  console.log(`  market ${r.marketId}`);
  if (r.dry) { console.log('\n  --dry: reads only, no writes.\n'); process.exit(0); }
  console.log(`  place  https://shannon-explorer.somnia.network/tx/${r.placeTxHash}`);
  console.log(`  cancel https://shannon-explorer.somnia.network/tx/${r.cancelTxHash}`);
  console.log(`\n  ✓ G4 ROUND-TRIP VERIFIED — resting ${r.restingBefore} → ${r.restingAfterPlace} → ${r.restingAfterCancel}\n`);
  process.exit(0);
} catch (e) {
  console.error(`\n  ✗ FAILED: ${e?.message ?? e}\n`);
  process.exit(1);
}
