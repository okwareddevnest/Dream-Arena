// On-page verification.
//
// A link that opens a background tab is not evidence — you are still on the site
// with nothing to show. This reads the transaction receipt from the chain IN THE
// BROWSER and puts the result on screen: status, block, gas. The explorer link
// stays, but it is no longer the only proof.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchReceipt, formatReceipt } from '../lib/receipt';

afterEach(() => vi.unstubAllGlobals());

const rpc = (result: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result }) })));

describe('fetchReceipt', () => {
  it('reads a confirmed transaction from the chain', async () => {
    rpc({ status: '0x1', blockNumber: '0x1cbf1a2', gasUsed: '0x3d8f0', logs: [{}, {}] });
    const r = await fetchReceipt('0xabc');
    expect(r).toEqual({ found: true, success: true, blockNumber: 30142882, gasUsed: 252144, logs: 2 });
  });

  it('reports a REVERTED transaction as failed, not as missing', async () => {
    rpc({ status: '0x0', blockNumber: '0x10', gasUsed: '0x10', logs: [] });
    const r = await fetchReceipt('0xabc');
    expect(r.found).toBe(true);
    expect(r.success).toBe(false);
  });

  it('says "not found" for a hash the chain has never seen', async () => {
    rpc(null);
    expect((await fetchReceipt('0xabc')).found).toBe(false);
  });

  it('never throws at the UI when the RPC is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(fetchReceipt('0xabc')).resolves.toEqual({ found: false, success: false, error: true });
  });
});

describe('formatReceipt', () => {
  it('states the confirmation in words a person can read out', () => {
    const s = formatReceipt({ found: true, success: true, blockNumber: 30142882, gasUsed: 252144, logs: 2 });
    expect(s).toMatch(/confirmed/i);
    expect(s).toContain('30142882');
  });
  it('does not call a reverted transaction confirmed', () => {
    const s = formatReceipt({ found: true, success: false, blockNumber: 1, gasUsed: 1, logs: 0 });
    expect(s).not.toMatch(/confirmed/i);
    expect(s).toMatch(/revert/i);
  });
  it('is honest when the chain has not seen it', () => {
    expect(formatReceipt({ found: false, success: false })).toMatch(/not found|not yet/i);
  });
});
