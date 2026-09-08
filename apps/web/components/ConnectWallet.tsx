'use client';
// Choose a wallet, rather than having one chosen for you.
//
// Every installed wallet announces itself (EIP-6963) with its own name and icon,
// and the person picks. Free and standard — nothing to sign up for, no SDK. If
// nothing is installed the panel says so and points somewhere useful rather than
// showing a dead button.
import { useEffect, useState } from 'react';
import { discoverWallets, connectTo, type DiscoveredWallet, type Connected } from '../lib/wallets';

export function ConnectWallet({
  connected, onConnect, onDisconnect,
}: {
  connected: Connected | null;
  onConnect: (c: Connected) => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open || wallets) return;
    void discoverWallets().then(setWallets);
  }, [open, wallets]);

  if (connected) {
    return (
      <div className="flex items-center justify-between gap-3 rounded border border-line px-3 py-2">
        <span className="flex min-w-0 items-center gap-2">
          {connected.icon
            ? <img src={connected.icon} alt="" className="h-5 w-5 rounded" />
            : <span className="h-5 w-5 rounded bg-raised" />}
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink">{connected.name}</span>
            <span className="block truncate font-mono text-xs text-ink-faint">
              {connected.address.slice(0, 6)}…{connected.address.slice(-4)}
            </span>
          </span>
        </span>
        <button type="button" onClick={onDisconnect} className="shrink-0 text-sm text-ink-faint hover:text-short">
          Disconnect
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded border border-accent px-4 py-2.5 text-base text-accent hover:bg-accent hover:text-bg"
      >
        Connect a wallet
      </button>
    );
  }

  return (
    <div className="rounded-card border border-line bg-raised p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm text-ink">Choose a wallet</span>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>

      {wallets === null ? (
        <p className="py-2 text-sm text-ink-faint">Looking for wallets…</p>
      ) : wallets.length === 0 ? (
        <p data-testid="no-wallets" className="py-2 text-sm leading-relaxed text-ink-faint">
          No wallet found in this browser. Any EVM wallet works — install one, then
          reopen this panel. You only need it to trade; watching needs nothing.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {wallets.map((w) => (
            <li key={w.info.uuid}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(w.info.uuid); setNote(null);
                  void connectTo(w).then((c) => {
                    setBusy(null);
                    if (c) { onConnect(c); setOpen(false); }
                    else setNote(`${w.info.name} did not connect. Approve the request in the wallet.`);
                  });
                }}
                className="flex w-full items-center gap-2.5 rounded border border-line px-3 py-2 text-left hover:border-accent"
              >
                {w.info.icon
                  ? <img src={w.info.icon} alt="" className="h-5 w-5 rounded" />
                  : <span className="h-5 w-5 rounded bg-surface" />}
                <span className="flex-1 text-base text-ink">{w.info.name}</span>
                {busy === w.info.uuid ? <span className="text-sm text-ink-faint">waiting…</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="mt-2 text-sm text-warn">{note}</p> : null}
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">
        Your keys never leave your wallet. The arena only ever sends it an unsigned
        transaction to approve.
      </p>
    </div>
  );
}
