// The socket URL is the difference between a live arena and a dead page, and
// it is the one thing that changes shape between dev (two origins) and
// deployment (one). spec: docs/80-DEPLOY.md · IF §13
import { describe, it, expect } from 'vitest';
import { wsUrl } from '../lib/useArena';

describe('wsUrl', () => {
  it('uses an absolute API base as-is (development, two origins)', () => {
    expect(wsUrl('http://localhost:8080')).toBe('ws://localhost:8080/ws');
  });

  it('resolves against the page when the API is same-origin (deployment)', () => {
    expect(wsUrl('', 'https://dream-arena.onrender.com')).toBe('wss://dream-arena.onrender.com/ws');
  });

  it('keeps wss over https — a page on https cannot open a ws:// socket', () => {
    expect(wsUrl('', 'https://example.com')).toMatch(/^wss:/);
    expect(wsUrl('', 'http://localhost:10000')).toMatch(/^ws:/);
  });
});
