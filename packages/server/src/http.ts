import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { GithubOAuthAuthenticator } from './auth-github.js';
import { ServerError, type ServerErrorCode } from './errors.js';
import { buildMcpServer } from './mcp.js';
import type { Server } from './server.js';

// HTTP transport for the Anchorage MCP server (slice 4a). Three
// surfaces, one host:
//
//   - `POST /mcp` (+ optional `GET /mcp` SSE stream, `DELETE /mcp`
//     session teardown) — streamable HTTP MCP transport. Each request
//     stands alone (stateless): the bearer token in the `Authorization`
//     header is resolved through `server.authenticator` once per
//     request, a fresh `buildMcpServer` is bound to the resolved
//     `Caller`, and the transport handles the single JSON-RPC
//     round-trip before tearing down. Per-request build is the
//     production-shaped sibling of the per-connection build the
//     in-memory transport uses; only the resolved `Caller` flows
//     downstream, so the gate stack is unchanged (PRD §Identity,
//     Authenticator seam — same surface as `mcp.test.ts`'s
//     `InMemoryTransport` path).
//
//   - `POST /auth/github/start` and `POST /auth/github/complete` —
//     device-code OAuth flow exposed over HTTP. Unauthenticated by
//     design: these endpoints are how a brand-new MCP client *acquires*
//     its bearer secret. `startSignin` returns the device + user codes;
//     `completeSignin(device_code)` polls and, on authorization,
//     returns the freshly-minted credential's bearer secret to the
//     client exactly once. The endpoints are present iff a
//     `GithubOAuthAuthenticator` is wired in `opts.githubAuth`; the
//     harness-only deployment posture omits them (slice-4a tests
//     exercise the harness-only posture too, so the omission is CI-
//     pinned). Both routes refuse `unauthorized` / `issuance_cap` with
//     the typed payload the seam already emits — no new wire shape.
//
//   - `GET /healthz` — liveness probe, returns `{ ok: true }`. The
//     TLS-terminating edge / load-balancer reads this to gate traffic
//     (slice 4c picks the concrete hoster; the handler stays
//     edge-agnostic).
//
// Refusal mapping. A `ServerError` thrown anywhere in the handler is
// caught at the top level and rendered as JSON `{ code, message }` —
// the same shape `mcp.ts` returns on the MCP wire — at the HTTP status
// most-aligned with the typed code (`unauthorized` → 401,
// `rate_limited` / `issuance_cap` → 429, `invalid_input` /
// `invalid_state` → 400, `not_found` → 404). Unknown routes 404; wrong
// method 405; uncaught throws are passed to `onError` and rendered as
// 500.
//
// TLS termination, edge rate-limit, sticky disk for `SqliteStore`, and
// backup live in the deployment surface (`docs/deploy.md`, slice 4c);
// the handler is intentionally agnostic about who terminates TLS in
// front of it.

export interface AnchorageHttpOpts {
  server: Server;
  // GithubOAuthAuthenticator-backed device-code endpoints. Optional so
  // local-only / testbed-only deployments can stand up an HTTP MCP
  // surface without the IdP plumbing. When omitted, `/auth/github/*`
  // routes 404.
  githubAuth?: GithubOAuthAuthenticator;
  // Outbound info log sink. Defaults to `console.log`. Production
  // deployments inject structured-log sinks.
  log?: (message: string, fields?: Record<string, unknown>) => void;
  // Hook for transport-layer faults (uncaught throws inside the
  // request handler, transport errors not already mapped to typed
  // ServerError). Defaults to `console.error`.
  onError?: (err: unknown, context: { method: string; pathname: string }) => void;
}

export type AnchorageHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// Pure handler (no listening socket). Used by `startHttpServer` and by
// in-process tests that want to invoke routes without binding a port.
// `void`-return at the call site is fine: errors are caught internally
// and rendered onto `res`.
export function buildHttpHandler(opts: AnchorageHttpOpts): AnchorageHttpHandler {
  const log = opts.log ?? defaultLog;
  const onError = opts.onError ?? defaultOnError;
  const server = opts.server;
  const githubAuth = opts.githubAuth;

  return async (req, res) => {
    const method = req.method ?? 'GET';
    // The host portion of `req.url` is irrelevant; we only use the
    // pathname. Use a placeholder base so `new URL` succeeds for
    // path-only inputs.
    const url = new URL(req.url ?? '/', 'http://anchorage.local');
    const pathname = url.pathname;

    try {
      if (pathname === '/healthz') {
        if (method !== 'GET') {
          sendMethodNotAllowed(res, ['GET']);
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/auth/github/start') {
        if (method !== 'POST') {
          sendMethodNotAllowed(res, ['POST']);
          return;
        }
        if (!githubAuth) {
          sendJson(res, 404, {
            code: 'not_found',
            message: 'github authenticator is not wired on this deployment',
          });
          return;
        }
        const dc = await githubAuth.startSignin();
        log('auth.github.start', { user_code: dc.user_code });
        sendJson(res, 200, dc);
        return;
      }

      if (pathname === '/auth/github/complete') {
        if (method !== 'POST') {
          sendMethodNotAllowed(res, ['POST']);
          return;
        }
        if (!githubAuth) {
          sendJson(res, 404, {
            code: 'not_found',
            message: 'github authenticator is not wired on this deployment',
          });
          return;
        }
        const body = await readJsonBody(req);
        const device_code = readStringField(body, 'device_code');
        if (device_code === undefined) {
          sendJson(res, 400, {
            code: 'invalid_input',
            message: 'device_code is required (POST JSON {"device_code": "..."} )',
          });
          return;
        }
        const result = await githubAuth.completeSignin(device_code);
        // The bearer secret rides in the response body exactly once,
        // mirrored from `GithubSigninResult.secret`. The transport
        // does not log it (the `log` call below stays at metadata
        // granularity).
        log('auth.github.complete', { status: result.status });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/mcp') {
        await handleMcp(server, req, res);
        return;
      }

      sendJson(res, 404, {
        code: 'not_found',
        message: `no route: ${method} ${pathname}`,
      });
    } catch (err) {
      if (err instanceof ServerError) {
        sendJson(res, serverErrorStatus(err.code), {
          code: err.code,
          message: err.message,
        });
        return;
      }
      onError(err, { method, pathname });
      if (!res.writableEnded) {
        sendJson(res, 500, { code: 'invalid_state', message: 'internal error' });
      }
    }
  };
}

// /mcp dispatch. Per-request: extract bearer → buildMcpServer (which
// authenticates) → wire a fresh stateless transport → handleRequest.
// The transport and McpServer are torn down once the response closes;
// the SDK's stateless mode keeps no cross-request state so there is
// nothing else to clean.
async function handleMcp(server: Server, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractBearer(req);
  if (token === undefined) {
    sendJson(res, 401, {
      code: 'unauthorized',
      message: 'missing or malformed Authorization: Bearer header',
    });
    return;
  }
  let mcp: ReturnType<typeof buildMcpServer>;
  try {
    mcp = buildMcpServer(server, { token });
  } catch (err) {
    if (err instanceof ServerError) {
      sendJson(res, serverErrorStatus(err.code), { code: err.code, message: err.message });
      return;
    }
    throw err;
  }
  // Stateless: omitting `sessionIdGenerator` puts the transport in
  // stateless mode (per the SDK docs — "if not provided, session
  // management is disabled"). Per-request build composes with this:
  // there is no cross-request session state to resume across
  // reconnects.
  const transport = new StreamableHTTPServerTransport({});
  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await transport.close();
    } catch {
      // Best-effort: transport may already be torn down.
    }
    try {
      await mcp.close();
    } catch {
      // Best-effort: server may already be closed.
    }
  };
  res.on('close', () => {
    void cleanup();
  });
  // MCP SDK 1.29 declares `StreamableHTTPServerTransport.onclose` as
  // `(() => void) | undefined` while the `Transport` interface
  // declares it as `?: () => void` (no `| undefined`); under our
  // tsconfig's `exactOptionalPropertyTypes` the two don't unify even
  // though they're structurally compatible. Cast at the seam; the
  // runtime contract is unaffected.
  await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
  await transport.handleRequest(req, res);
}

function extractBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return undefined;
  const tok = m[1]?.trim();
  return tok && tok.length > 0 ? tok : undefined;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage, max = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        reject(new ServerError('invalid_input', `request body too large (max ${max} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ServerError('invalid_input', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readStringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendMethodNotAllowed(res: ServerResponse, allowed: string[]): void {
  if (res.headersSent || res.writableEnded) return;
  const json = JSON.stringify({
    code: 'invalid_input',
    message: `method not allowed; expected ${allowed.join(' | ')}`,
  });
  res.writeHead(405, {
    Allow: allowed.join(', '),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// Typed-code → HTTP status mapping. The mapping is intentionally lossy
// (clients should branch on `code`, not on status) but conforms to the
// closest standard status for tooling that doesn't read the body.
function serverErrorStatus(code: ServerErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'not_found':
      return 404;
    case 'rate_limited':
    case 'issuance_cap':
      return 429;
    case 'invalid_input':
    case 'invalid_state':
      return 400;
  }
}

function defaultLog(message: string, fields?: Record<string, unknown>): void {
  if (fields && Object.keys(fields).length > 0) {
    console.log(message, fields);
  } else {
    console.log(message);
  }
}

function defaultOnError(err: unknown, ctx: { method: string; pathname: string }): void {
  console.error(`http error ${ctx.method} ${ctx.pathname}:`, err);
}

// ── Listening server (production runtime + tests) ──────────────────

export interface StartHttpServerOpts extends AnchorageHttpOpts {
  // Address to bind. Defaults to `127.0.0.1` (loopback only —
  // production deployments behind a TLS-terminating edge override with
  // `0.0.0.0`).
  host?: string;
  // Port to bind. Defaults to 0 (ephemeral — tests use this; the
  // production runtime sets `ANCHORAGE_PORT`).
  port?: number;
}

export interface AnchorageHttpServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly underlying: NodeHttpServer;
  close(): Promise<void>;
}

// Bind a Node `http.Server` to the handler. Returns the bound URL so
// tests can `fetch(url + '/...')` without guessing the ephemeral port.
export async function startHttpServer(opts: StartHttpServerOpts): Promise<AnchorageHttpServer> {
  const handler = buildHttpHandler(opts);
  const httpServer = createServer((req, res) => {
    void handler(req, res);
  });
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      httpServer.removeListener('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, host);
  });
  const addr = httpServer.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : port;
  return {
    url: `http://${host}:${boundPort}`,
    host,
    port: boundPort,
    underlying: httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
