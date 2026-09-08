'use client';
// Signing in.
//
// Three steps, all free: ask the server for a challenge, have the wallet sign it
// (`personal_sign` is off-chain and costs no gas), send the signature back for a
// session. The wallet proves control of the address; nothing else can.
import type { Connected } from './wallets';

const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080';
const KEY = 'arena.session';

export interface ArenaSession { token: string; address: string; expiresAt: number }

export function loadSession(): ArenaSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as ArenaSession;
    // An expired session is not a session; clear it rather than send it.
    if (!s?.token || s.expiresAt <= Date.now()) { localStorage.removeItem(KEY); return null; }
    return s;
  } catch { return null; }
}

export function clearSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** Returns the session, or a reason it did not happen. Declining to sign is a
 *  normal outcome, not an error to throw at the page. */
export async function signIn(w: Connected): Promise<{ session?: ArenaSession; error?: string }> {
  try {
    const nonceRes = await fetch(`${API}/api/auth/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: w.address }),
    });
    const { message } = await nonceRes.json();
    if (!message) return { error: 'The arena did not issue a challenge.' };

    const signature = (await w.provider.request({
      method: 'personal_sign',
      params: [message, w.address],
    })) as string;

    const verifyRes = await fetch(`${API}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });
    const body = await verifyRes.json();
    if (!verifyRes.ok || !body?.token) return { error: body?.error ?? 'That signature did not verify.' };

    const session: ArenaSession = body;
    try { localStorage.setItem(KEY, JSON.stringify(session)); } catch { /* private mode */ }
    return { session };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: /reject|denied/i.test(msg) ? 'You declined the signature.' : msg };
  }
}
