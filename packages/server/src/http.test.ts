import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeGithubApi, GithubOAuthAuthenticator } from './auth-github.js';
import { FakeClock } from './clock.js';
import { type AnchorageHttpServer, startHttpServer } from './http.js';
import { SeededIdGen } from './id-gen.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Slice 4a — HTTP transport. End-to-end coverage that the HTTP surface
// preserves every invariant the in-memory MCP transport already pins
// (mcp.test.ts), and that the device-code OAuth endpoints (slice 3c's
// GithubOAuthAuthenticator, now exposed over HTTP) produce a bearer
// secret that round-trips into the /mcp surface — the slice's
// load-bearing sim≡prod assertion at the HTTP layer: tokens are
// indistinguishable from credentials produced through the in-process
// `bindAgentCredential` path the testbed uses.

function freshServer(): Server {
  return new Server({
    clock: new FakeClock('2026-05-14T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('http'),
    verifier: new FakeVerifier(),
  });
}

function seedCauseAndSubTopic(server: Server): { cause_id: string; sub_topic_id: string } {
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const sub = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'mrd',
    scope_query: 'ctDNA',
  });
  return { cause_id: cause.id, sub_topic_id: sub.id };
}

// Each test allocates its own server + listening socket. Ports are
// ephemeral so tests run in parallel without binding-conflict, and the
// `afterEach` close keeps the suite leak-free.
let httpServer: AnchorageHttpServer | undefined;

beforeEach(() => {
  httpServer = undefined;
});

afterEach(async () => {
  if (httpServer) await httpServer.close();
});

describe('GET /healthz', () => {
  it('returns 200 { ok: true }', async () => {
    const server = freshServer();
    httpServer = await startHttpServer({ server, log: () => {} });
    const res = await fetch(`${httpServer.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  it('returns 405 for non-GET methods', async () => {
    const server = freshServer();
    httpServer = await startHttpServer({ server, log: () => {} });
    const res = await fetch(`${httpServer.url}/healthz`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('POST /mcp — authentication at the seam', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const server = freshServer();
    httpServer = await startHttpServer({ server, log: () => {} });
    const res = await fetch(`${httpServer.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('returns 401 when the bearer token is unknown', async () => {
    const server = freshServer();
    httpServer = await startHttpServer({ server, log: () => {} });
    const res = await fetch(`${httpServer.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('unauthorized');
  });

  it('returns 401 when the bound credential has been revoked', async () => {
    const server = freshServer();
    const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential, secret } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label: 'desktop',
    });
    server.store.agentCredentials.set(credential.id, { ...credential, status: 'revoked' });
    httpServer = await startHttpServer({ server, log: () => {} });
    const res = await fetch(`${httpServer.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });
});

describe('POST /mcp — round-trips a tool call over the HTTP transport', () => {
  it('lists tools and invokes propose_anchor with the same wire-shape the in-memory transport produces', async () => {
    const server = freshServer();
    const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { secret } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label: 'desktop',
    });
    const { cause_id, sub_topic_id } = seedCauseAndSubTopic(server);
    httpServer = await startHttpServer({ server, log: () => {} });

    const transport = new StreamableHTTPClientTransport(new URL(`${httpServer.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
    const client = new Client({ name: 'http-test-client', version: '0.0.0' });
    // SDK declares `StreamableHTTPClientTransport.sessionId` as `string
    // | undefined` while `Transport.sessionId` is `?: string`; under
    // `exactOptionalPropertyTypes` they don't unify. Same cast pattern
    // used at the server-side seam in http.ts.
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('propose_anchor');

      const result = await client.callTool({
        name: 'propose_anchor',
        arguments: {
          cause_id,
          home_sub_topic_id: sub_topic_id,
          content: 'Tie et al., ctDNA-guided adjuvant chemotherapy',
          external_ref: { kind: 'pmid', value: '35657323' },
        },
      });
      expect(result.isError).toBeFalsy();
      const proposalId = (result.structuredContent as { proposal_id: string }).proposal_id;
      expect(proposalId).toMatch(/^prp_/);
      // The proposal landed on the server through the same code path
      // the in-memory transport drives — the only difference is the
      // transport. PRD §Identity (Authenticator seam): downstream
      // gates see only the resolved `Caller`.
      expect(server.store.proposals.get(proposalId as never)?.status).toBe('staged');
    } finally {
      await client.close();
    }
  });
});

describe('POST /auth/github/start + /complete', () => {
  it('round-trips a device-code flow and the issued secret authenticates /mcp', async () => {
    const server = freshServer();
    const githubAuth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    seedCauseAndSubTopic(server);
    httpServer = await startHttpServer({ server, githubAuth, log: () => {} });

    const startRes = await fetch(`${httpServer.url}/auth/github/start`, { method: 'POST' });
    expect(startRes.status).toBe(200);
    const start = (await startRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
    };
    expect(start.device_code).toBeTruthy();
    expect(start.user_code).toBeTruthy();
    expect(start.verification_uri).toMatch(/^https:\/\//);

    const completeRes = await fetch(`${httpServer.url}/auth/github/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    expect(completeRes.status).toBe(200);
    const complete = (await completeRes.json()) as {
      status: string;
      secret?: string;
      credential_id?: string;
      identity_id?: string;
    };
    expect(complete.status).toBe('authorized');
    expect(complete.secret).toBeTruthy();
    expect(complete.credential_id).toMatch(/^agt_/);

    // The wire-shape promise of slice 4a: the secret produced by the
    // OAuth path authenticates against /mcp identically to a secret
    // produced by the in-process `bindAgentCredential` path the
    // testbed uses. Same Authenticator seam, same Caller resolution.
    const transport = new StreamableHTTPClientTransport(new URL(`${httpServer.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${complete.secret}` } },
    });
    const client = new Client({ name: 'http-oauth-client', version: '0.0.0' });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('returns 400 when the request body is missing device_code', async () => {
    const server = freshServer();
    const githubAuth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    httpServer = await startHttpServer({ server, githubAuth, log: () => {} });
    const res = await fetch(`${httpServer.url}/auth/github/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_input');
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    const server = freshServer();
    const githubAuth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    httpServer = await startHttpServer({ server, githubAuth, log: () => {} });
    const res = await fetch(`${httpServer.url}/auth/github/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_input');
  });

  it('returns 429 with issuance_cap when the IdP cap is exhausted', async () => {
    const server = freshServer();
    const githubAuth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
      config: { issuance_cap_per_epoch: 1, issuance_epoch_seconds: 60 },
    });
    httpServer = await startHttpServer({ server, githubAuth, log: () => {} });

    const s1 = (await (
      await fetch(`${httpServer.url}/auth/github/start`, { method: 'POST' })
    ).json()) as { device_code: string };
    const c1 = await fetch(`${httpServer.url}/auth/github/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: s1.device_code }),
    });
    expect(c1.status).toBe(200);

    const s2 = (await (
      await fetch(`${httpServer.url}/auth/github/start`, { method: 'POST' })
    ).json()) as { device_code: string };
    const c2 = await fetch(`${httpServer.url}/auth/github/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: s2.device_code }),
    });
    expect(c2.status).toBe(429);
    const body = (await c2.json()) as { code: string };
    expect(body.code).toBe('issuance_cap');
  });

  it('returns 404 when no github authenticator is wired', async () => {
    const server = freshServer();
    httpServer = await startHttpServer({ server, log: () => {} });
    const res = await fetch(`${httpServer.url}/auth/github/start`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('not_found');
  });
});

describe('routing edges', () => {
  it('returns 404 for unknown paths', async () => {
    const server = freshServer();
    httpServer = await startHttpServer({ server, log: () => {} });
    const res = await fetch(`${httpServer.url}/no-such-route`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('not_found');
  });

  it('returns 405 on /auth/github/start when method is not POST', async () => {
    const server = freshServer();
    const githubAuth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    httpServer = await startHttpServer({ server, githubAuth, log: () => {} });
    const res = await fetch(`${httpServer.url}/auth/github/start`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('per-IP throttle on the pre-auth surface', () => {
  it('refuses with 429 rate_limited past the per-epoch limit, and exempts /mcp and /healthz', async () => {
    // The pre-auth routes sit before every identity-keyed control the
    // server has; the throttle is the only gate an unauthenticated
    // flood meets. /mcp is bearer-gated (per-identity rate limits own
    // it) and stays exempt.
    const server = freshServer();
    const githubAuth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    httpServer = await startHttpServer({
      server,
      githubAuth,
      // Wide epoch so the FakeClock's 1s-per-call ticks stay inside
      // one epoch for the whole test.
      authThrottle: { limit: 3, epoch_seconds: 24 * 60 * 60 },
      log: () => {},
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${httpServer.url}/auth/github/start`, { method: 'POST' });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    const last = await fetch(`${httpServer.url}/auth/github/start`, { method: 'POST' });
    const body = (await last.json()) as { code: string };
    expect(body.code).toBe('rate_limited');
    // Exempt routes are unaffected by the exhausted budget.
    const health = await fetch(`${httpServer.url}/healthz`);
    expect(health.status).toBe(200);
    const mcp = await fetch(`${httpServer.url}/mcp`, { method: 'POST' });
    expect(mcp.status).toBe(401); // missing bearer, not 429
    await mcp.arrayBuffer();
  });
});
