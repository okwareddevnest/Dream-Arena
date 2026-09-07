#!/usr/bin/env node
// OPS — testnet funding preflight for the LIVE path (G4 write-path unblock, RFC-003).
// Reads real balances from Somnia testnet; optionally pulls tUSDC from the on-chain faucet.
//   npm run fund                 # report every wallet configured in .env
//   npm run fund -- 0xaddr       # report one address (no key needed)
//   npm run fund -- --faucet     # mint tUSDC for every configured wallet that needs it
//   npm run fund -- --faucet --wallet=echo
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, formatEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.SOMNIA_RPC_URL ?? 'https://api.infra.testnet.somnia.network';
const CHAIN_ID = Number(process.env.SOMNIA_CHAIN_ID ?? 50312);
// TestUSDC — 6 dp, public `faucet(uint256)`. Source: dreamdex-bot-kit ec-core/addresses.ts (testnet).
const TUSDC = getAddress('0x70a86d8842fb63c4ad2b7cdddf530ebf1bb25d8e');
const FAUCET_AMOUNT = 10_000n * 10n ** 6n; // SDK default: 10_000 tUSDC
const GAS_FLOOR = 10n ** 17n;              // 0.1 STT — approve + mint-a-pair + several orders

const chain = {
  id: CHAIN_ID, name: 'Somnia Testnet',
  nativeCurrency: { name: 'Somnia Test Token', symbol: 'STT', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Shannon', url: 'https://shannon-explorer.somnia.network' } },
};
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function faucet(uint256)']);
const EXPLORER = 'https://shannon-explorer.somnia.network';
const RED = (s) => `\x1b[31m${s}\x1b[0m`, GRN = (s) => `\x1b[32m${s}\x1b[0m`, DIM = (s) => `\x1b[2m${s}\x1b[0m`;

const argv = process.argv.slice(2);
// A private key must never travel in argv — it lands in shell history. Refuse loudly.
if (argv.some((a) => /^(0x)?[0-9a-fA-F]{64}$/.test(a))) {
  console.error(RED('\n  Refusing to run: that looks like a private key passed on the command line.'));
  console.error('  It is now in your shell history. Rotate it, then put the key in .env as MIRA_PRIVATE_KEY.\n');
  process.exit(2);
}
const wantFaucet = argv.includes('--faucet');
const only = argv.find((a) => a.startsWith('--wallet='))?.split('=')[1];
const argAddr = argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

const toAccount = (name, raw) => {
  if (!raw?.trim()) return null;
  try { return { name, account: privateKeyToAccount(raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`) }; }
  catch { console.error(RED(`  ${name}_PRIVATE_KEY is malformed — expected 0x + 64 hex chars.`)); return null; }
};

/** Targets: an explicit address, or every wallet whose key is configured. */
let targets;
if (argAddr) {
  targets = [{ name: 'address', account: null, address: getAddress(argAddr.toLowerCase()) }];
} else {
  targets = [toAccount('MIRA', process.env.MIRA_PRIVATE_KEY), toAccount('ECHO', process.env.ECHO_PRIVATE_KEY)]
    .filter(Boolean)
    .filter((t) => !only || t.name.toLowerCase() === only.toLowerCase())
    .map((t) => ({ ...t, address: t.account.address }));
}

if (!targets.length) {
  console.error(RED('\n  No wallet to check.'));
  console.error('  Set MIRA_PRIVATE_KEY (and ECHO_PRIVATE_KEY) in .env, or pass an address:');
  console.error(DIM('    npm run fund -- 0xYourAddress\n'));
  process.exit(2);
}

const pub = createPublicClient({ chain, transport: http(RPC) });
const onChainId = await pub.getChainId();
if (onChainId !== CHAIN_ID) throw new Error(`RPC is chain ${onChainId}, expected ${CHAIN_ID}`);
console.log(`\n  chain ${onChainId} via ${RPC}`);

let needGas = false;
for (const t of targets) {
  const [stt, usdc] = await Promise.all([
    pub.getBalance({ address: t.address }),
    pub.readContract({ address: TUSDC, abi: erc20, functionName: 'balanceOf', args: [t.address] }),
  ]);
  const gasOk = stt >= GAS_FLOOR, usdcOk = usdc > 0n;
  needGas ||= !gasOk;
  console.log(`\n  ${t.name.padEnd(8)}${t.address}`);
  console.log(`    STT gas   ${formatEther(stt).padEnd(12)} ${gasOk ? GRN('OK') : RED('NEEDED')}`);
  console.log(`    tUSDC     ${formatUnits(usdc, 6).padEnd(12)} ${usdcOk ? GRN('OK') : RED('NEEDED')}`);

  if (!wantFaucet) {
    if (!usdcOk && gasOk) console.log(DIM('    → self-serve: npm run fund -- --faucet'));
    continue;
  }
  if (!t.account) { console.log(DIM('    → faucet needs a key; this is a read-only address check.')); continue; }
  if (!gasOk) { console.log(RED('    → cannot faucet: STT gas must land first.')); continue; }
  if (usdcOk) { console.log(DIM('    → already funded, skipping faucet.')); continue; }

  const wallet = createWalletClient({ account: t.account, chain, transport: http(RPC) });
  const hash = await wallet.writeContract({ address: TUSDC, abi: erc20, functionName: 'faucet', args: [FAUCET_AMOUNT] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  // The SDK resolves even when a tx REVERTED — check receipt.status ourselves.
  if (rc.status !== 'success') throw new Error(`faucet reverted: ${EXPLORER}/tx/${hash}`);
  const after = await pub.readContract({ address: TUSDC, abi: erc20, functionName: 'balanceOf', args: [t.address] });
  console.log(`    ${GRN('faucet OK')} ${formatUnits(after, 6)} tUSDC`);
  console.log(DIM(`    tx ${EXPLORER}/tx/${hash}`));
}

if (needGas) {
  console.log(`\n  STT is gas and cannot be self-served. Paste the address into either faucet:`);
  console.log(`    https://cloud.google.com/application/web3/faucet/somnia/shannon`);
  console.log(`    https://stakely.io/faucet/somnia-testnet-stt`);
}
console.log('');
