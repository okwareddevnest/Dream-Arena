// Sign-In With Ethereum (EIP-4361).
//
// Connecting a wallet reveals an address; it does not prove control of it. Until
// this existed, anyone could POST a forecast under anyone else's address and it
// landed on their record — verified against MIRA's own wallet during the build.
// A signature is the only thing that turns a claimed address into an
// authenticated one.
//
// Free and self-contained: the wallet signs a message, the server recovers the
// signer, and that is the whole protocol. No provider, no third party, no cost
// to the user — `personal_sign` is off-chain and spends no gas.
import { verifyMessage } from 'viem';

export interface AuthOptions {
  /** The site this signature is valid for. A signature for another domain is
   *  not a login here. */
  domain: string;
  uri: string;
  chainId: number;
  now?: () => number;
  /** How long a challenge may sit unsigned. */
  challengeTtlMs?: number;
  sessionTtlMs?: number;
}

export interface Session { token: string; address: string; expiresAt: number }

const rand = (n = 24) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

export class AuthService {
  private readonly o: Required<Omit<AuthOptions, 'now'>> & { now: () => number };
  /** nonce → the address it was issued to, and when. Single use. */
  private readonly challenges = new Map<string, { address: string; issuedAt: number }>();
  private readonly sessions = new Map<string, Session>();

  constructor(o: AuthOptions) {
    this.o = {
      domain: o.domain, uri: o.uri, chainId: o.chainId,
      challengeTtlMs: o.challengeTtlMs ?? 5 * 60_000,
      sessionTtlMs: o.sessionTtlMs ?? 12 * 60 * 60_000,
      now: o.now ?? (() => Date.now()),
    };
  }

  /** An EIP-4361 message for this address to sign. */
  challenge(address: string): { message: string; nonce: string } {
    const nonce = rand();
    const issuedAt = this.o.now();
    this.challenges.set(nonce, { address: address.toLowerCase(), issuedAt });
    const message =
      `${this.o.domain} wants you to sign in with your Ethereum account:\n` +
      `${address}\n\n` +
      `Sign in to Dream Arena. This proves you control this address so your ` +
      `forecasts are recorded as yours. It does not send a transaction and costs no gas.\n\n` +
      `URI: ${this.o.uri}\n` +
      `Version: 1\n` +
      `Chain ID: ${this.o.chainId}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${new Date(issuedAt).toISOString()}`;
    return { message, nonce };
  }

  /**
   * Verify a signed challenge and open a session. Returns null for every failure
   * — a wrong signer, a replay, an expired or unknown nonce, another site's
   * message, or garbage. The caller gets one answer: authenticated or not.
   */
  async verify(message: string, signature: string): Promise<Session | null> {
    try {
      const nonce = /^Nonce: (.+)$/m.exec(message)?.[1]?.trim();
      const address = message.split('\n')[1]?.trim();
      if (!nonce || !address) return null;

      // Bound to THIS site: a signature harvested elsewhere is not a login here.
      if (!message.startsWith(`${this.o.domain} wants you to sign in`)) return null;

      const issued = this.challenges.get(nonce);
      if (!issued) return null;                                  // unknown or replayed
      this.challenges.delete(nonce);                             // single use, always
      if (this.o.now() - issued.issuedAt > this.o.challengeTtlMs) return null;
      if (issued.address !== address.toLowerCase()) return null;

      const ok = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
      if (!ok) return null;

      const session: Session = {
        token: rand(32),
        address: address.toLowerCase(),
        expiresAt: this.o.now() + this.o.sessionTtlMs,
      };
      this.sessions.set(session.token, session);
      return session;
    } catch {
      return null;
    }
  }

  /** The address behind a token, or null if it is unknown or stale. */
  addressFor(token: string | undefined | null): string | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (this.o.now() > s.expiresAt) { this.sessions.delete(token); return null; }
    return s.address;
  }

  signOut(token: string): void { this.sessions.delete(token); }
  get sessionCount(): number { return this.sessions.size; }
}
