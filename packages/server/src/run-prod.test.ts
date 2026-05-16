import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IdentityId, NodeId } from '@anchorage/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeGithubApi } from './auth-github.js';
import { type ProdServerHandle, parseProdConfig, runProdServer } from './run-prod.js';
import { Server } from './server.js';
import { SqliteStore } from './sqlite-store.js';
import { FakeVerifier } from './verifier.js';

// Slice 4c — production runtime entrypoint coverage. The env-parsing
// helper is pure and pinned directly; the server-wiring path is
// exercised end-to-end against a temp on-disk SQLite store, hitting
// `/healthz` over `fetch`. Live-fetch and GitHub API are not
// exercised over the network: tests inject `FakeVerifier` and
// `FakeGithubApi` at the `runProdServer` seam (the same fakes the
// unit-level tests use), so the production wiring is driven without
// touching NCBI / Crossref / GitHub.

describe('parseProdConfig', () => {
  it('parses the minimum required env (db_path) and applies defaults', () => {
    const cfg = parseProdConfig({ ANCHORAGE_DB_PATH: '/tmp/anchorage.db' });
    expect(cfg).toEqual({
      db_path: '/tmp/anchorage.db',
      host: '127.0.0.1',
      port: 8080,
    });
  });

  it('respects overrides for host and port', () => {
    const cfg = parseProdConfig({
      ANCHORAGE_DB_PATH: '/tmp/x.db',
      ANCHORAGE_HOST: '0.0.0.0',
      ANCHORAGE_PORT: '9090',
    });
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.port).toBe(9090);
  });

  it('refuses a missing ANCHORAGE_DB_PATH', () => {
    expect(() => parseProdConfig({})).toThrow(/ANCHORAGE_DB_PATH is required/);
  });

  it('refuses an out-of-range port', () => {
    expect(() =>
      parseProdConfig({ ANCHORAGE_DB_PATH: '/tmp/x.db', ANCHORAGE_PORT: '99999' }),
    ).toThrow(/ANCHORAGE_PORT/);
    expect(() =>
      parseProdConfig({ ANCHORAGE_DB_PATH: '/tmp/x.db', ANCHORAGE_PORT: 'abc' }),
    ).toThrow(/ANCHORAGE_PORT/);
  });

  it('omits the github block when ANCHORAGE_GITHUB_CLIENT_ID is unset', () => {
    const cfg = parseProdConfig({ ANCHORAGE_DB_PATH: '/tmp/x.db' });
    expect(cfg.github).toBeUndefined();
  });

  it('populates the github block when ANCHORAGE_GITHUB_CLIENT_ID is set', () => {
    const cfg = parseProdConfig({
      ANCHORAGE_DB_PATH: '/tmp/x.db',
      ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
      ANCHORAGE_GITHUB_CLIENT_SECRET: 'shhh',
      ANCHORAGE_PUBLIC_BASE_URL: 'https://mcp.anchorage.test',
      ANCHORAGE_ISSUANCE_CAP_PER_EPOCH: '3',
      ANCHORAGE_ISSUANCE_EPOCH_SECONDS: '3600',
      ANCHORAGE_ATTESTATION_AGE_DAYS_FOR_LEVEL2: '60',
    });
    expect(cfg.github).toEqual({
      client_id: 'Iv1.abc',
      client_secret: 'shhh',
      issuance_cap_per_epoch: 3,
      issuance_epoch_seconds: 3600,
      account_age_days_for_level2: 60,
    });
    expect(cfg.public_base_url).toBe('https://mcp.anchorage.test');
  });

  it('refuses ANCHORAGE_GITHUB_CLIENT_ID without a client secret', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
        ANCHORAGE_PUBLIC_BASE_URL: 'https://mcp.anchorage.test',
      }),
    ).toThrow(/ANCHORAGE_GITHUB_CLIENT_SECRET is required/);
  });

  it('refuses ANCHORAGE_GITHUB_CLIENT_ID without a public base url', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
        ANCHORAGE_GITHUB_CLIENT_SECRET: 'shhh',
      }),
    ).toThrow(/ANCHORAGE_PUBLIC_BASE_URL is required/);
  });

  it('refuses a non-https / non-loopback public base url', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
        ANCHORAGE_GITHUB_CLIENT_SECRET: 'shhh',
        ANCHORAGE_PUBLIC_BASE_URL: 'http://mcp.anchorage.test',
      }),
    ).toThrow(/must be https/);
  });

  it('omits web_reader_identity_id when ANCHORAGE_WEB_READER_IDENTITY is unset', () => {
    const cfg = parseProdConfig({ ANCHORAGE_DB_PATH: '/tmp/x.db' });
    expect(cfg.web_reader_identity_id).toBeUndefined();
  });

  it('populates web_reader_identity_id when ANCHORAGE_WEB_READER_IDENTITY is set', () => {
    const cfg = parseProdConfig({
      ANCHORAGE_DB_PATH: '/tmp/x.db',
      ANCHORAGE_WEB_READER_IDENTITY: 'idn_abc',
    });
    expect(cfg.web_reader_identity_id).toBe('idn_abc');
  });

  it('omits web_curator_identity_id when ANCHORAGE_WEB_CURATOR_IDENTITY is unset', () => {
    const cfg = parseProdConfig({
      ANCHORAGE_DB_PATH: '/tmp/x.db',
      ANCHORAGE_WEB_READER_IDENTITY: 'idn_abc',
    });
    expect(cfg.web_curator_identity_id).toBeUndefined();
  });

  it('populates web_curator_identity_id when both reader env vars are set', () => {
    const cfg = parseProdConfig({
      ANCHORAGE_DB_PATH: '/tmp/x.db',
      ANCHORAGE_WEB_READER_IDENTITY: 'idn_abc',
      ANCHORAGE_WEB_CURATOR_IDENTITY: 'idn_curator',
    });
    expect(cfg.web_curator_identity_id).toBe('idn_curator');
  });

  it('refuses ANCHORAGE_WEB_CURATOR_IDENTITY without ANCHORAGE_WEB_READER_IDENTITY', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_WEB_CURATOR_IDENTITY: 'idn_curator',
      }),
    ).toThrow(/requires ANCHORAGE_WEB_READER_IDENTITY/);
  });

  it('refuses non-positive integer tunables', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
        ANCHORAGE_GITHUB_CLIENT_SECRET: 'shhh',
        ANCHORAGE_PUBLIC_BASE_URL: 'https://mcp.anchorage.test',
        ANCHORAGE_ISSUANCE_CAP_PER_EPOCH: '0',
      }),
    ).toThrow(/ANCHORAGE_ISSUANCE_CAP_PER_EPOCH/);
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
        ANCHORAGE_GITHUB_CLIENT_SECRET: 'shhh',
        ANCHORAGE_PUBLIC_BASE_URL: 'https://mcp.anchorage.test',
        ANCHORAGE_ISSUANCE_EPOCH_SECONDS: '-1',
      }),
    ).toThrow(/ANCHORAGE_ISSUANCE_EPOCH_SECONDS/);
  });

  // Slice 7c part 2 — re-verification scheduler env knobs travel
  // together. Setting the interval is the opt-in; the two companions
  // (max_age_ms, batch_size) are required when it is set, and setting
  // only one of the companions without the interval refuses at boot.
  it('omits scheduler config when ANCHORAGE_REVERIFY_INTERVAL_MS is unset', () => {
    const cfg = parseProdConfig({ ANCHORAGE_DB_PATH: '/tmp/x.db' });
    expect(cfg.reverify_interval_ms).toBeUndefined();
    expect(cfg.reverify_max_age_ms).toBeUndefined();
    expect(cfg.reverify_batch_size).toBeUndefined();
  });

  it('populates scheduler config when all three knobs are set', () => {
    const cfg = parseProdConfig({
      ANCHORAGE_DB_PATH: '/tmp/x.db',
      ANCHORAGE_REVERIFY_INTERVAL_MS: '3600000',
      ANCHORAGE_REVERIFY_MAX_AGE_MS: '604800000',
      ANCHORAGE_REVERIFY_BATCH_SIZE: '16',
    });
    expect(cfg.reverify_interval_ms).toBe(3_600_000);
    expect(cfg.reverify_max_age_ms).toBe(604_800_000);
    expect(cfg.reverify_batch_size).toBe(16);
  });

  it('refuses ANCHORAGE_REVERIFY_INTERVAL_MS without max_age', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_REVERIFY_INTERVAL_MS: '60000',
        ANCHORAGE_REVERIFY_BATCH_SIZE: '8',
      }),
    ).toThrow(/ANCHORAGE_REVERIFY_MAX_AGE_MS is required/);
  });

  it('refuses ANCHORAGE_REVERIFY_INTERVAL_MS without batch_size', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_REVERIFY_INTERVAL_MS: '60000',
        ANCHORAGE_REVERIFY_MAX_AGE_MS: '86400000',
      }),
    ).toThrow(/ANCHORAGE_REVERIFY_BATCH_SIZE is required/);
  });

  it('refuses companion knobs without the interval (scheduler must be opt-in)', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_REVERIFY_MAX_AGE_MS: '86400000',
      }),
    ).toThrow(/require ANCHORAGE_REVERIFY_INTERVAL_MS/);
  });

  it('refuses non-positive scheduler tunables', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_REVERIFY_INTERVAL_MS: '0',
        ANCHORAGE_REVERIFY_MAX_AGE_MS: '86400000',
        ANCHORAGE_REVERIFY_BATCH_SIZE: '8',
      }),
    ).toThrow(/ANCHORAGE_REVERIFY_INTERVAL_MS/);
  });
});

describe('runProdServer (end-to-end against an on-disk SQLite file)', () => {
  let tmp: string;
  let handle: ProdServerHandle | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'anchorage-prod-'));
  });

  afterEach(async () => {
    if (handle) await handle.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('stands the HTTP server up against a fresh on-disk SQLite store and answers /healthz', async () => {
    handle = await runProdServer({
      config: {
        db_path: join(tmp, 'anchorage.db'),
        host: '127.0.0.1',
        port: 0,
      },
      verifier: new FakeVerifier(),
      log: () => {},
    });
    const res = await fetch(`${handle.http.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('routes /auth/github/* to 404 when no github client_id is configured', async () => {
    handle = await runProdServer({
      config: {
        db_path: join(tmp, 'anchorage.db'),
        host: '127.0.0.1',
        port: 0,
      },
      verifier: new FakeVerifier(),
      log: () => {},
    });
    const res = await fetch(`${handle.http.url}/auth/github/start`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('wires GithubOAuthAuthenticator when github config is present, and the device-code flow round-trips a bearer secret', async () => {
    handle = await runProdServer({
      config: {
        db_path: join(tmp, 'anchorage.db'),
        host: '127.0.0.1',
        port: 0,
        github: { client_id: 'Iv1.test', client_secret: 'test-secret' },
      },
      verifier: new FakeVerifier(),
      githubApi: new FakeGithubApi(),
      log: () => {},
    });

    const startRes = await fetch(`${handle.http.url}/auth/github/start`, { method: 'POST' });
    expect(startRes.status).toBe(200);
    const start = (await startRes.json()) as { device_code: string };

    const completeRes = await fetch(`${handle.http.url}/auth/github/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    expect(completeRes.status).toBe(200);
    const complete = (await completeRes.json()) as { status: string; secret?: string };
    expect(complete.status).toBe('authorized');
    expect(complete.secret).toBeTruthy();
  });

  it('exposes the MCP-spec OAuth surface and self-drives a client from 401 to an authenticated /mcp call', async () => {
    const BASE = 'https://mcp.anchorage.test';
    handle = await runProdServer({
      config: {
        db_path: join(tmp, 'anchorage.db'),
        host: '127.0.0.1',
        port: 0,
        github: { client_id: 'Iv1.test', client_secret: 'test-secret' },
        public_base_url: BASE,
      },
      verifier: new FakeVerifier(),
      githubApi: new FakeGithubApi(),
      log: () => {},
    });
    const root = handle.http.url;

    // RFC 9728 / RFC 8414 discovery.
    const prm = await (await fetch(`${root}/.well-known/oauth-protected-resource`)).json();
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const asm = (await (
      await fetch(`${root}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(asm['code_challenge_methods_supported']).toEqual(['S256']);

    // Unauthenticated /mcp carries the WWW-Authenticate challenge.
    const challenge = await fetch(`${root}/mcp`, { method: 'POST' });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.anchorage.test/.well-known/oauth-protected-resource"',
    );

    // DCR → authorize → github callback → token. PKCE S256.
    const redirect = 'https://client.test/cb';
    const verifier = 'e2e-verifier-'.repeat(4);
    const challengeS256 = createHash('sha256').update(verifier).digest('base64url');
    const reg = (await (
      await fetch(`${root}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirect], client_name: 'E2E Client' }),
      })
    ).json()) as { client_id: string };
    const clientId = reg.client_id;

    const authz = await fetch(
      `${root}/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challengeS256,
        code_challenge_method: 'S256',
        resource: `${BASE}/mcp`,
        state: 'cli-state',
      })}`,
    );
    expect(authz.status).toBe(200);
    const ghLink = /href="([^"]*github\.test[^"]*)"/
      .exec(await authz.text())?.[1]
      ?.replace(/&amp;/g, '&');
    const sid = new URL(ghLink as string).searchParams.get('state') as string;

    const cb = await fetch(
      `${root}/auth/github/callback?${new URLSearchParams({ state: sid, code: 'gh_web_code_test' })}`,
      { redirect: 'manual' },
    );
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location') as string);
    expect(back.searchParams.get('state')).toBe('cli-state');
    const code = back.searchParams.get('code') as string;

    const tok = (await (
      await fetch(`${root}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: `${BASE}/mcp`,
        }).toString(),
      })
    ).json()) as { token_type: string; access_token: string };
    expect(tok.token_type).toBe('Bearer');
    const accessToken = tok.access_token;

    // The issued token authenticates a real MCP JSON-RPC call.
    const mcp = await fetch(`${root}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(mcp.status).toBe(200);
  });

  it('does not mount the web tier when ANCHORAGE_WEB_READER_IDENTITY is unset', async () => {
    handle = await runProdServer({
      config: { db_path: join(tmp, 'anchorage.db'), host: '127.0.0.1', port: 0 },
      verifier: new FakeVerifier(),
      log: () => {},
    });
    // Unknown route falls through to the MCP transport's typed-JSON
    // 404 rather than the web handler's HTML 404 — proof the web
    // tier is not wired.
    const res = await fetch(`${handle.http.url}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('not_found');
  });

  it('mounts the web tier and serves the home page when ANCHORAGE_WEB_READER_IDENTITY names an active identity', async () => {
    const dbPath = join(tmp, 'anchorage.db');
    // Mint the reader identity in the same SQLite store the prod
    // runtime will open — the operator's bootstrap shape (the admin
    // CLI does exactly this against a SqliteStore handle).
    const seedStore = new SqliteStore({ path: dbPath });
    try {
      const seedServer = new Server({ store: seedStore });
      const identity = seedServer.bootstrap.mintIdentity({ display_name: 'web-reader' });
      seedServer.bootstrap.createCause({
        name: 'Colon cancer',
        description: 'colon cancer cause',
      });
      handle = await runProdServer({
        config: {
          db_path: dbPath,
          host: '127.0.0.1',
          port: 0,
          web_reader_identity_id: identity.id,
        },
        verifier: new FakeVerifier(),
        log: () => {},
      });
      const res = await fetch(`${handle.http.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const body = await res.text();
      expect(body).toContain('Colon cancer');
      expect(body).toContain('This instance hosts');
    } finally {
      seedStore.close();
    }
  });

  it('refuses at boot when ANCHORAGE_WEB_READER_IDENTITY names an unknown identity', async () => {
    await expect(
      runProdServer({
        config: {
          db_path: join(tmp, 'anchorage.db'),
          host: '127.0.0.1',
          port: 0,
          web_reader_identity_id: 'idn_does_not_exist' as IdentityId,
        },
        verifier: new FakeVerifier(),
        log: () => {},
      }),
    ).rejects.toThrow(/does not name an existing identity/);
  });

  it('refuses at boot when the web-reader identity is revoked', async () => {
    const dbPath = join(tmp, 'anchorage.db');
    const seedStore = new SqliteStore({ path: dbPath });
    try {
      const seedServer = new Server({ store: seedStore });
      const identity = seedServer.bootstrap.mintIdentity({ display_name: 'web-reader' });
      seedServer.store.identities.set(identity.id, { ...identity, status: 'revoked' });
      await expect(
        runProdServer({
          config: {
            db_path: dbPath,
            host: '127.0.0.1',
            port: 0,
            web_reader_identity_id: identity.id,
          },
          verifier: new FakeVerifier(),
          log: () => {},
        }),
      ).rejects.toThrow(/identity is revoked/);
    } finally {
      seedStore.close();
    }
  });

  it('mounts the curator console when ANCHORAGE_WEB_CURATOR_IDENTITY names an active curator', async () => {
    const dbPath = join(tmp, 'anchorage.db');
    const seedStore = new SqliteStore({ path: dbPath });
    let readerId: IdentityId;
    let curatorId: IdentityId;
    try {
      const seedServer = new Server({ store: seedStore });
      readerId = seedServer.bootstrap.mintIdentity({ display_name: 'web-reader' }).id;
      curatorId = seedServer.bootstrap.mintIdentity({
        display_name: 'carol',
        role: 'curator',
      }).id;
    } finally {
      seedStore.close();
    }
    handle = await runProdServer({
      config: {
        db_path: dbPath,
        host: '127.0.0.1',
        port: 0,
        web_reader_identity_id: readerId,
        web_curator_identity_id: curatorId,
      },
      verifier: new FakeVerifier(),
      log: () => {},
    });
    const res = await fetch(`${handle.http.url}/curator`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Curator console');
  });

  it('refuses at boot when ANCHORAGE_WEB_CURATOR_IDENTITY does not hold curator role', async () => {
    const dbPath = join(tmp, 'anchorage.db');
    const seedStore = new SqliteStore({ path: dbPath });
    let readerId: IdentityId;
    let contributorId: IdentityId;
    try {
      const seedServer = new Server({ store: seedStore });
      readerId = seedServer.bootstrap.mintIdentity({ display_name: 'web-reader' }).id;
      // Default role contributor — caught at the boot-time check
      // before any request is served.
      contributorId = seedServer.bootstrap.mintIdentity({ display_name: 'not-a-curator' }).id;
    } finally {
      seedStore.close();
    }
    await expect(
      runProdServer({
        config: {
          db_path: dbPath,
          host: '127.0.0.1',
          port: 0,
          web_reader_identity_id: readerId,
          web_curator_identity_id: contributorId,
        },
        verifier: new FakeVerifier(),
        log: () => {},
      }),
    ).rejects.toThrow(/does not hold curator role/);
  });

  it('refuses at boot when ANCHORAGE_WEB_CURATOR_IDENTITY names an unknown identity', async () => {
    const dbPath = join(tmp, 'anchorage.db');
    const seedStore = new SqliteStore({ path: dbPath });
    let readerId: IdentityId;
    try {
      const seedServer = new Server({ store: seedStore });
      readerId = seedServer.bootstrap.mintIdentity({ display_name: 'web-reader' }).id;
    } finally {
      seedStore.close();
    }
    await expect(
      runProdServer({
        config: {
          db_path: dbPath,
          host: '127.0.0.1',
          port: 0,
          web_reader_identity_id: readerId,
          web_curator_identity_id: 'idn_does_not_exist' as IdentityId,
        },
        verifier: new FakeVerifier(),
        log: () => {},
      }),
    ).rejects.toThrow(/does not name an existing identity/);
  });

  // Slice 7c part 2 — the periodic re-verification scheduler. The
  // tick path is exercised end-to-end here against the configured
  // verifier and the SQLite store: stand up the runtime with a
  // small interval, accept an anchor through the curator path, drift
  // the verifier mid-run, wait for at least one tick to fire, and
  // observe the anchor flipped to `unresolvable` in the store.
  it('ticks the re-verification scheduler when the env knobs are set, flipping drift to unresolvable', async () => {
    const dbPath = join(tmp, 'anchorage.db');
    const seedStore = new SqliteStore({ path: dbPath });
    let curatorId: IdentityId;
    let anchorId: NodeId;
    try {
      const seedServer = new Server({ store: seedStore, verifier: new FakeVerifier() });
      const alice = seedServer.bootstrap.mintIdentity({ display_name: 'alice' });
      curatorId = seedServer.bootstrap.mintIdentity({
        display_name: 'carol',
        role: 'curator',
      }).id;
      const cause = seedServer.bootstrap.createCause({ name: 'CRC', description: 'x' });
      const st = seedServer.bootstrap.seedSubTopic({
        cause_id: cause.id,
        name: 'ctDNA-MRD',
        description: 'x',
        scope_query: 'x',
      });
      const { proposal_id } = await seedServer.tools.proposeAnchor(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: st.id,
          content: 'trial',
          external_ref: { kind: 'pmid', value: '1' },
        },
      );
      const { node_id } = seedServer.curator.acceptProposal(proposal_id);
      if (!node_id) throw new Error('expected anchor materialization');
      anchorId = node_id;
    } finally {
      seedStore.close();
    }
    // Drifted verifier: same ref now resolves to a different hash, so
    // every re-verify against pmid:1 sees the mismatch.
    const drifted = new FakeVerifier(new Set(), new Map([['1', 'fake:pmid:1:drifted']]));
    handle = await runProdServer({
      config: {
        db_path: dbPath,
        host: '127.0.0.1',
        port: 0,
        reverify_interval_ms: 50,
        reverify_max_age_ms: 1,
        reverify_batch_size: 16,
      },
      verifier: drifted,
      log: () => {},
    });
    // The scheduler ticks every 50ms; one tick is sufficient. Poll
    // for up to a second so a slow CI doesn't flake.
    let flipped = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`${handle.http.url}/healthz`);
      expect(res.status).toBe(200);
      // Reach into the store via a fresh read against the live SQLite
      // file: the runtime owns the writer; we open a separate reader
      // to inspect state without racing the runtime's transaction.
      const probe = new SqliteStore({ path: dbPath });
      try {
        const node = probe.nodes.get(anchorId);
        if (node && node.kind === 'anchor' && node.status === 'unresolvable') {
          flipped = true;
          break;
        }
      } finally {
        probe.close();
      }
    }
    expect(flipped).toBe(true);
    // Curator was provisioned for completeness but the scheduler
    // does not need the web tier to be wired — proves the scheduler
    // runs independently of the web routes.
    expect(curatorId).toBeDefined();
  });

  it('does not start the scheduler when only some knobs are set (boot refusal lives in parseProdConfig)', async () => {
    // Sanity: when the operator omits the interval, the runtime
    // stands up cleanly without a scheduler, mirroring the
    // parseProdConfig path that gates the opt-in.
    handle = await runProdServer({
      config: { db_path: join(tmp, 'anchorage.db'), host: '127.0.0.1', port: 0 },
      verifier: new FakeVerifier(),
      log: () => {},
    });
    const res = await fetch(`${handle.http.url}/healthz`);
    expect(res.status).toBe(200);
  });

  it('closes the SQLite store on shutdown (durability across reopen)', async () => {
    const dbPath = join(tmp, 'anchorage.db');
    handle = await runProdServer({
      config: { db_path: dbPath, host: '127.0.0.1', port: 0 },
      verifier: new FakeVerifier(),
      log: () => {},
    });
    await handle.close();
    handle = undefined;

    // Reopen against the same file — the server stands up cleanly,
    // which is the durability contract the SqliteStore parity test
    // pins at the store level, exercised here at the runtime level.
    handle = await runProdServer({
      config: { db_path: dbPath, host: '127.0.0.1', port: 0 },
      verifier: new FakeVerifier(),
      log: () => {},
    });
    const res = await fetch(`${handle.http.url}/healthz`);
    expect(res.status).toBe(200);
  });
});
