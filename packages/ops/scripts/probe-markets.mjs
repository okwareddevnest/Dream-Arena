// OPS probe — discover REAL binary markets on the configured venue.
// Uses the raw tier (venue-scoped) deliberately: the unified loadMarkets() sweeps
// every market paged at 500 and times out against the dev indexer (T-S4 fan-out).
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { defineChain } from 'viem';

const RPC = process.env.SOMNIA_RPC_URL ?? 'https://api.infra.testnet.somnia.network';
const WS = process.env.SOMNIA_WS_RPC_URL ?? 'wss://api.infra.testnet.somnia.network/ws';
const INDEXER = process.env.SOMNIA_INDEXER_URL ?? 'https://dev.smk.somnia.host/v1/graphql';
const VENUE_ID = process.env.VENUE_ID ?? '0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c';

const chain = defineChain({
  id: Number(process.env.SOMNIA_CHAIN_ID ?? 50312), name: 'somnia',
  nativeCurrency: { name: 'Somnia Test Token', symbol: 'STT', decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: [WS] } },
});
// Raw tier only — never loadMarkets(): that sweeps every market and times out (T-S4).
const exchange = new SomniaMarkets({ indexerUrl: INDEXER, chain, wsRpcUrl: WS, addresses: SOMNIA_TESTNET_ADDRESSES });
const client = exchange.client;

try {
  // NOTE: listBinaryVenueIds() (BinaryOriginPairs, a distinct_on aggregate) also
  // times out on the dev indexer — venue ids must come from config, not discovery.
  const rows = await client.listBinaryMarkets({ venueId: VENUE_ID, status: 'Trading', limit: 10 });
  console.log(`Trading markets: ${rows.length}`);
  console.log('\n── full shape of one market ──');
  console.log(JSON.stringify(rows[0], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2));
  console.log('\n── all ──');
  const now = Date.now();
  for (const m of rows) {
    const exp = Number(m.expiryTimestamp) * 1000;
    console.log(`  ${m.asset}  exp in ${Math.round((exp - now) / 1000)}s  nonce ${m.nonce}  ${m.marketId}`);
  }
} catch (e) {
  console.error('ERR', e?.message ?? e);
} finally {
  await Promise.race([Promise.resolve(exchange.close?.()).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  process.exit(0);
}
