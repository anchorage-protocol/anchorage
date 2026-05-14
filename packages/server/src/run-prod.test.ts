import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeGithubApi } from './auth-github.js';
import { type ProdServerHandle, parseProdConfig, runProdServer } from './run-prod.js';
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
      ANCHORAGE_ISSUANCE_CAP_PER_EPOCH: '3',
      ANCHORAGE_ISSUANCE_EPOCH_SECONDS: '3600',
      ANCHORAGE_ATTESTATION_AGE_DAYS_FOR_LEVEL2: '60',
    });
    expect(cfg.github).toEqual({
      client_id: 'Iv1.abc',
      issuance_cap_per_epoch: 3,
      issuance_epoch_seconds: 3600,
      account_age_days_for_level2: 60,
    });
  });

  it('refuses non-positive integer tunables', () => {
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
        ANCHORAGE_ISSUANCE_CAP_PER_EPOCH: '0',
      }),
    ).toThrow(/ANCHORAGE_ISSUANCE_CAP_PER_EPOCH/);
    expect(() =>
      parseProdConfig({
        ANCHORAGE_DB_PATH: '/tmp/x.db',
        ANCHORAGE_GITHUB_CLIENT_ID: 'Iv1.abc',
        ANCHORAGE_ISSUANCE_EPOCH_SECONDS: '-1',
      }),
    ).toThrow(/ANCHORAGE_ISSUANCE_EPOCH_SECONDS/);
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
        github: { client_id: 'Iv1.test' },
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
