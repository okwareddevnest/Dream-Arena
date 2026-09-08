// The wallet picker.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectWallet } from '../components/ConnectWallet';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const connected = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  name: 'Rabby', rdns: 'io.rabby', icon: '', provider: {} as never,
  sendTransaction: vi.fn(),
};

describe('ConnectWallet', () => {
  it('offers to connect when nobody is connected', () => {
    render(<ConnectWallet connected={null} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByRole('button', { name: /connect a wallet/i })).toBeTruthy();
  });

  it('says plainly when no wallet is installed, and that watching needs none', async () => {
    render(<ConnectWallet connected={null} onConnect={() => {}} onDisconnect={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /connect a wallet/i }));
    await waitFor(() => expect(screen.getByTestId('no-wallets')).toBeTruthy());
    expect(screen.getByTestId('no-wallets').textContent).toMatch(/watching needs nothing/i);
  });

  it('shows the connected wallet by name and shortened address', () => {
    render(<ConnectWallet connected={connected as never} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText('Rabby')).toBeTruthy();
    expect(screen.getByText(/0x1234…5678/)).toBeTruthy();
  });

  it('can disconnect', async () => {
    const onDisconnect = vi.fn();
    render(<ConnectWallet connected={connected as never} onConnect={() => {}} onDisconnect={onDisconnect} />);
    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('promises the key never leaves the wallet, where the user can read it', async () => {
    render(<ConnectWallet connected={null} onConnect={() => {}} onDisconnect={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /connect a wallet/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/keys never leave your wallet/i));
  });
});
