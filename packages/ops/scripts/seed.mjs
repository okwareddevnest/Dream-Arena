#!/usr/bin/env node
// Demo preflight (T-061, re-scoped by RFC-003).
//
// The card originally built canned fixtures. RFC-003 made LIVE the demo path, so
// there is nothing to fake: what a demo actually needs is for the real venue to
// be ready. This checks every precondition and says exactly which one is missing.
// Read-only apart from the tUSDC faucet, which is self-serve.
import { createPublicClient, http, parseAbi, getAddress, formatUnits, formatEther, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.SOMNIA_RPC_URL ?? 'https://api.infra.testnet.somnia.network';
const INDEXER = process.env.SOMNIA_INDEXER_URL ?? 'https://dev.smk.somnia.host/v1/graphql';
const VENUE_ID = process.env.VENUE_ID;
const GAS_FLOOR = 3n * 10n ** 17n;        // 0.3 STT — several writes at 4M gas
const USDC_FLOOR = 100n * 10n ** 6n;

const chain = defineChain({
  id: Number(process.env.SOMNIA_CHAIN_ID ?? 50312), name: 'somnia',
  nativeCurrency: { name: 'Somnia Test Token', symbol: 'STT', decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: ['wss://api.infra.testnet.somnia.network/ws'] } },
});
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 12_000, retryCount: 2 }) });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

const OK = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const NO = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const problems = [];
const check = (ok, good, bad) => { console.log(ok ? OK(good) : NO(bad)); if (!ok) problems.push(bad); };

console.log('\n  Demo preflight\n');

// 1. chain
const id = await pub.getChainId().catch(() => null);
check(id === chain.id, `chain ${id} reachable`, `RPC unreachable or wrong chain (got ${id})`);

// 2. venue configured
check(!!VENUE_ID, `venue ${String(VENUE_ID).slice(0, 14)}…`, 'VENUE_ID is not set in .env');

// 3. both wallets funded
const sdk = await import('@somnia-chain/markets-sdk');
const token = getAddress(String(sdk.SOMNIA_TESTNET_ADDRESSES.collateral).toLowerCase());
for (const [name, key] of [['MIRA', process.env.MIRA_PRIVATE_KEY], ['ECHO', process.env.ECHO_PRIVATE_KEY]]) {
  if (!key) { check(false, '', `${name}_PRIVATE_KEY missing`); continue; }
  const addr = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`).address;
  const [stt, usdc] = await Promise.all([
    pub.getBalance({ address: addr }),
    pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [addr] }),
  ]);
  check(stt >= GAS_FLOOR, `${name} gas ${formatEther(stt)} STT`,
    `${name} needs STT (has ${formatEther(stt)}, wants ${formatEther(GAS_FLOOR)}) — use a faucet, see docs/70-FUNDING.md`);
  check(usdc >= USDC_FLOOR, `${name} collateral ${formatUnits(usdc, 6)} tUSDC`,
    `${name} needs tUSDC — run: npm run fund -- --faucet`);
}

// 4. tradable markets exist, with time on them
const { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } = sdk;
const ex = new SomniaMarkets({
  indexerUrl: INDEXER, chain, wsRpcUrl: 'wss://api.infra.testnet.somnia.network/ws',
  addresses: SOMNIA_TESTNET_ADDRESSES,
});
try {
  const rows = await ex.client.listBinaryMarkets({ venueId: VENUE_ID, status: 'Trading', limit: 20 });
  const now = Math.floor(Date.now() / 1000);
  const usable = rows.filter((r) => Number(r.expiry) - now > 120);
  check(usable.length > 0, `${usable.length} market(s) with >2min left (of ${rows.length} trading)`,
    'no market has enough time left to trade — wait for the next series to roll');

  // 5. a book to trade against
  if (usable.length) {
    const b = await ex.client.getBinaryOrderBook(usable[0].poolAddress);
    const depth = (b.yesBids?.length ?? 0) + (b.yesAsks?.length ?? 0);
    check(depth > 0, `book has ${depth} resting level(s)`,
      'the book is empty — start ECHO so there is a counterparty: npm run echo');
  }
} catch (e) {
  check(false, '', `indexer unreachable: ${e?.message ?? e}`);
}
await Promise.race([Promise.resolve(ex.close?.()).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);

console.log(problems.length
  ? `\n  ${problems.length} thing(s) to fix before demoing.\n`
  : '\n  Ready to demo.\n');
process.exit(problems.length ? 1 : 0);
