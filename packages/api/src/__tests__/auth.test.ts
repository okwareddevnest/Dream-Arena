// Sign-In With Ethereum (EIP-4361).
//
// Connecting a wallet reveals an address; it does not prove control of it. Until
// this existed anyone could POST a forecast under anyone else's address and land
// it on their record — demonstrated against MIRA's own wallet. A signature is the
// only thing that turns a claimed address into an authenticated one.
import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { AuthService } from '../auth.ts';

const DOMAIN = 'arena.test';
const URI = 'https://arena.test';

const svc = (over: Partial<ConstructorParameters<typeof AuthService>[0]> = {}) =>
  new AuthService({ domain: DOMAIN, uri: URI, chainId: 50312, now: () => Date.now(), ...over });

async function signIn(a: AuthService, key = generatePrivateKey()) {
  const account = privateKeyToAccount(key);
  const { message } = a.challenge(account.address);
  const signature = await account.signMessage({ message });
  return { account, message, signature };
}

describe('challenge', () => {
  it('produces an EIP-4361 message bound to this site and chain', () => {
    const a = svc();
    const addr = privateKeyToAccount(generatePrivateKey()).address;
    const { message, nonce } = a.challenge(addr);
    expect(message).toContain(`${DOMAIN} wants you to sign in`);
    expect(message).toContain(addr);
    expect(message).toContain(`URI: ${URI}`);
    expect(message).toContain('Chain ID: 50312');
    expect(message).toContain(`Nonce: ${nonce}`);
  });

  it('issues a different nonce every time', () => {
    const a = svc();
    const addr = privateKeyToAccount(generatePrivateKey()).address;
    expect(a.challenge(addr).nonce).not.toBe(a.challenge(addr).nonce);
  });

  it('states plainly that signing costs nothing and authorises no spending', () => {
    const a = svc();
    const { message } = a.challenge(privateKeyToAccount(generatePrivateKey()).address);
    expect(message).toMatch(/does not.*transaction|no.*(gas|fee)/i);
  });
});

describe('verify', () => {
  it('accepts a genuine signature and issues a session', async () => {
    const a = svc();
    const { account, message, signature } = await signIn(a);
    const s = await a.verify(message, signature);
    expect(s).not.toBeNull();
    expect(s!.address.toLowerCase()).toBe(account.address.toLowerCase());
    expect(a.addressFor(s!.token)!.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('rejects a REPLAY — a nonce is single use', async () => {
    const a = svc();
    const { message, signature } = await signIn(a);
    expect(await a.verify(message, signature)).not.toBeNull();
    expect(await a.verify(message, signature), 'the same signature cannot be reused').toBeNull();
  });

  it('rejects a signature from a DIFFERENT key', async () => {
    const a = svc();
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const { message } = a.challenge(victim.address);         // challenge names the victim
    const signature = await attacker.signMessage({ message }); // signed by someone else
    expect(await a.verify(message, signature)).toBeNull();
  });

  it('rejects a message tampered with after signing', async () => {
    const a = svc();
    const { message, signature } = await signIn(a);
    expect(await a.verify(message.replace('Chain ID: 50312', 'Chain ID: 1'), signature)).toBeNull();
  });

  it('rejects a challenge that has expired', async () => {
    let t = 1_000_000;
    const a = svc({ now: () => t, challengeTtlMs: 60_000 });
    const account = privateKeyToAccount(generatePrivateKey());
    const { message } = a.challenge(account.address);
    const signature = await account.signMessage({ message });
    t += 61_000;
    expect(await a.verify(message, signature)).toBeNull();
  });

  it('rejects a challenge issued for another domain', async () => {
    const a = svc();
    const other = svc({ domain: 'evil.test' });
    const account = privateKeyToAccount(generatePrivateKey());
    const { message } = other.challenge(account.address);
    const signature = await account.signMessage({ message });
    expect(await a.verify(message, signature), 'a signature for another site is not a login here').toBeNull();
  });

  it('rejects garbage without throwing', async () => {
    const a = svc();
    expect(await a.verify('not a message', '0xdead')).toBeNull();
    expect(await a.verify('', '')).toBeNull();
  });
});

describe('sessions', () => {
  it('expire', async () => {
    let t = 1_000_000;
    const a = svc({ now: () => t, sessionTtlMs: 10_000 });
    const account = privateKeyToAccount(generatePrivateKey());
    const { message } = a.challenge(account.address);
    const s = await a.verify(message, await account.signMessage({ message }));
    expect(a.addressFor(s!.token)).not.toBeNull();
    t += 11_000;
    expect(a.addressFor(s!.token), 'a stale session is not a session').toBeNull();
  });

  it('an unknown token authenticates nobody', () => {
    expect(svc().addressFor('made-up')).toBeNull();
  });

  it('can be signed out', async () => {
    const a = svc();
    const { message, signature } = await signIn(a);
    const s = await a.verify(message, signature);
    a.signOut(s!.token);
    expect(a.addressFor(s!.token)).toBeNull();
  });
});
