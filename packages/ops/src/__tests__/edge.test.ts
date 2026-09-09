// The edge is the only thing between a browser and everything that already
// works. If it routes wrong, every other passing test is irrelevant — so it is
// exercised against REAL sockets, not a mocked http module.
// spec: docs/80-DEPLOY.md · IF §13
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { routeFor, probe, startEdge, type Edge, type Upstream } from '../edge.ts';
import { restartDelayMs, shouldGiveUp } from '../restart.ts';

const API: Upstream = { host: '127.0.0.1', port: 1 };
const WEB: Upstream = { host: '127.0.0.1', port: 2 };
const R = { api: API, web: WEB };

describe('routeFor', () => {
  it('sends the API lane to the agent', () => {
    expect(routeFor('/api/state', R)).toBe(API);
    expect(routeFor('/api/auth/nonce', R)).toBe(API);
    expect(routeFor('/api', R)).toBe(API);
  });

  it('sends the websocket to the agent', () => {
    expect(routeFor('/ws', R)).toBe(API);
    expect(routeFor('/ws?token=x', R)).toBe(API);
  });

  it('sends everything else to next', () => {
    for (const p of ['/', '/arena', '/mira', '/console', '/_next/static/a.js', '/favicon.ico']) {
      expect(routeFor(p, R)).toBe(WEB);
    }
  });

  it('does not swallow a page route that merely starts with the same letters', () => {
    // The bug this guards: startsWith('/api') would proxy a page to the agent.
    expect(routeFor('/apiary', R)).toBe(WEB);
    expect(routeFor('/wsdl', R)).toBe(WEB);
  });
});

describe('probe', () => {
  it('is false for a port nobody is listening on', async () => {
    expect(await probe({ host: '127.0.0.1', port: 1 }, 300)).toBe(false);
  });
});

describe('restart policy', () => {
  it('backs off exponentially and caps at a minute', () => {
    expect(restartDelayMs(0)).toBe(1_000);
    expect(restartDelayMs(3)).toBe(8_000);
    expect(restartDelayMs(50)).toBe(60_000);
  });

  it('stops restarting a child that will not stay up', () => {
    expect(shouldGiveUp(1)).toBe(false);
    expect(shouldGiveUp(7)).toBe(false);
    expect(shouldGiveUp(8)).toBe(true);
  });
});

// ── Live sockets ────────────────────────────────────────────────────────────
const listen = (s: Server): Promise<number> =>
  new Promise((res) => s.listen(0, () => {
    const a = s.address();
    res(typeof a === 'object' && a ? a.port : 0);
  }));

const shut = new Set<() => Promise<void> | void>();
afterEach(async () => { for (const f of shut) await f(); shut.clear(); });

describe('startEdge (real sockets)', () => {
  it('proxies each lane to its own upstream and reports health', async () => {
    const api = createServer((_q, r) => { r.writeHead(200); r.end('AGENT'); });
    const web = createServer((_q, r) => { r.writeHead(200); r.end('NEXT'); });
    const apiPort = await listen(api);
    const webPort = await listen(web);
    shut.add(() => new Promise<void>((d) => api.close(() => d())));
    shut.add(() => new Promise<void>((d) => web.close(() => d())));

    const edge: Edge = await startEdge({
      port: 0,
      api: { host: '127.0.0.1', port: apiPort },
      web: { host: '127.0.0.1', port: webPort },
    });
    shut.add(() => edge.stop());
    const base = `http://127.0.0.1:${edge.port}`;

    expect(await (await fetch(`${base}/api/state`)).text()).toBe('AGENT');
    expect(await (await fetch(`${base}/arena`)).text()).toBe('NEXT');

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ edge: true, web: true, api: true });
  });

  it('serves 502 rather than hanging when a child is down', async () => {
    const web = createServer((_q, r) => { r.writeHead(200); r.end('NEXT'); });
    const webPort = await listen(web);
    shut.add(() => new Promise<void>((d) => web.close(() => d())));

    const edge = await startEdge({
      port: 0,
      api: { host: '127.0.0.1', port: 1 },      // nothing there: MIRA still booting
      web: { host: '127.0.0.1', port: webPort },
    });
    shut.add(() => edge.stop());

    const res = await fetch(`http://127.0.0.1:${edge.port}/api/state`);
    expect(res.status).toBe(502);
    // The site is up even though the agent is not; health says so honestly.
    const health = await fetch(`http://127.0.0.1:${edge.port}/healthz`);
    expect(health.status).toBe(200);
    expect((await health.json() as { api: boolean }).api).toBe(false);
  });

  it('fails health when the site itself cannot serve', async () => {
    const edge = await startEdge({ port: 0, api: { host: '127.0.0.1', port: 1 }, web: { host: '127.0.0.1', port: 1 } });
    shut.add(() => edge.stop());
    expect((await fetch(`http://127.0.0.1:${edge.port}/healthz`)).status).toBe(503);
  });

  it('carries a websocket through the upgrade', async () => {
    // This is the frame path the whole arena page runs on (IF §13).
    const http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/ws' });
    wss.on('connection', (sock) => {
      sock.on('message', (m) => sock.send(`echo:${m.toString()}`));
    });
    const apiPort = await listen(http);
    shut.add(() => new Promise<void>((d) => { wss.close(); http.close(() => d()); }));

    const edge = await startEdge({
      port: 0,
      api: { host: '127.0.0.1', port: apiPort },
      web: { host: '127.0.0.1', port: 1 },
    });
    shut.add(() => edge.stop());

    const client = new WebSocket(`ws://127.0.0.1:${edge.port}/ws`);
    const got = await new Promise<string>((res, rej) => {
      client.on('open', () => client.send('hello'));
      client.on('message', (m) => res(m.toString()));
      client.on('error', rej);
    });
    expect(got).toBe('echo:hello');
    client.close();
  });
});
