// Edge proxy — one public port in front of two local upstreams.
//
// Render (and every other single-port PaaS) exposes exactly ONE port per
// service, and the free tier's 750 instance-hours/month only stretches to one
// always-on service. So the whole arena — Next.js, the API, the WebSocket, and
// both agents — lives behind this one socket. That is not a compromise for
// hosting: it also makes the browser's API base same-origin, which is what
// SIWE domain binding (packages/api/src/auth.ts) already assumes.
//
// Routing is deliberately the dumbest thing that can work, because a proxy that
// makes decisions is a proxy that can be wrong in production and right in test.
// spec: ARCH §1 · IF §13 · docs/80-DEPLOY.md
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

export interface Upstream {
  readonly host: string;
  readonly port: number;
}

export interface EdgeRoutes {
  /** The arena API + WebSocket, inside the MIRA agent process. */
  readonly api: Upstream;
  /** `next start`. */
  readonly web: Upstream;
}

/**
 * Which upstream serves `path`.
 *
 * `/api/...` and `/ws` belong to the agent process; everything else — pages,
 * `/_next/*`, favicons, the lot — is Next's. Anchored at a segment boundary so
 * a page route named `/apiary` is NOT swallowed by the API lane.
 */
export function routeFor(path: string, routes: EdgeRoutes): Upstream {
  const p = path.split('?')[0] ?? '/';
  if (p === '/api' || p.startsWith('/api/')) return routes.api;
  if (p === '/ws' || p.startsWith('/ws/')) return routes.api;
  return routes.web;
}

/** TCP reachability, used by the health endpoint. Never throws. */
export function probe(u: Upstream, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: u.host, port: u.port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

export interface EdgeOptions extends EdgeRoutes {
  /** The platform's port. On Render this is `process.env.PORT`. */
  readonly port: number;
  readonly log?: (s: string) => void;
}

export interface Edge {
  readonly port: number;
  readonly server: Server;
  stop(): Promise<void>;
}

/**
 * Start the edge. Resolves once it is accepting connections, so the caller can
 * report a real port (`port: 0` in tests) rather than a hoped-for one.
 */
export function startEdge(o: EdgeOptions): Promise<Edge> {
  const log = o.log ?? (() => {});
  const routes: EdgeRoutes = { api: o.api, web: o.web };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/';

    // The edge's own liveness, answered without touching a child. Render marks
    // a deploy live off this, so it must not 200 while the site cannot serve:
    // it reports what is actually reachable rather than that the proxy booted.
    if (path === '/healthz' || path.startsWith('/healthz?')) {
      void Promise.all([probe(routes.web), probe(routes.api)]).then(([web, api]) => {
        const body = JSON.stringify({ edge: true, web, api });
        res.writeHead(web ? 200 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(body);
      });
      return;
    }

    const up = routeFor(path, routes);
    const proxied = httpRequest(
      { host: up.host, port: up.port, method: req.method, path, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    proxied.on('error', (e: Error) => {
      // A child that is still booting, or has crashed and not yet been
      // restarted. Say which lane, because "502" alone costs ten minutes.
      log(`edge 502 ${up.port} ${req.method} ${path}: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream unavailable');
    });
    req.pipe(proxied);
  });

  // WebSocket. The upgrade never reaches the `request` handler, so it is piped
  // raw: rebuilding the handshake by hand is how proxies lose Sec-WebSocket-*.
  server.on('upgrade', (req: IncomingMessage, sock: Socket, head: Buffer) => {
    const path = req.url ?? '/';
    const up = routeFor(path, routes);
    const upSock = connect({ host: up.host, port: up.port }, () => {
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upSock.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upSock.write(head);
      upSock.pipe(sock);
      sock.pipe(upSock);
    });
    const drop = (e?: Error) => {
      if (e) log(`edge upgrade ${up.port} ${path}: ${e.message}`);
      upSock.destroy();
      sock.destroy();
    };
    upSock.on('error', drop);
    sock.on('error', drop);
  });

  return new Promise<Edge>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : o.port;
      server.removeListener('error', reject);
      log(`edge listening on ${port} → api ${o.api.port} · web ${o.web.port}`);
      resolve({
        port,
        server,
        stop: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}
