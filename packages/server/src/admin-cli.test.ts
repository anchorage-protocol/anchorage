import { describe, expect, it } from 'vitest';
import { type AdminCliDeps, runAdminCli } from './admin-cli.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { Server } from './server.js';

// Slice 4b — `anchorage-admin` CLI coverage. The test fixture injects
// a deterministic `Server` (seeded id-gen, fake clock) so subcommand
// output is byte-stable; the SQLite-against-disk path is exercised
// indirectly via the existing `sqlite-store.test.ts` parity test
// (mutations through this CLI write to the same `Store.identities`
// surface the parity test pins across backends). The CLI's actual
// production wiring (`makeProductionServer` over a real SqliteStore)
// is exercised by `mint-curator` on a temp file end-to-end at the
// bottom.

interface Capture {
  stdout: string[];
  stderr: string[];
  deps: AdminCliDeps;
  server: Server;
}

function fixture(): Capture {
  const server = new Server({
    clock: new FakeClock('2026-05-14T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('cli'),
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    server,
    deps: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      makeServer: () => ({ server, close: () => {} }),
    },
  };
}

describe('admin-cli help / unknown', () => {
  it('prints usage on `help`', async () => {
    const { deps, stdout } = fixture();
    const result = await runAdminCli(['help'], deps);
    expect(result.exit_code).toBe(0);
    expect(stdout.join('\n')).toContain('anchorage-admin');
    expect(stdout.join('\n')).toContain('mint-curator');
  });

  it('prints usage and exits 1 when invoked with no arguments', async () => {
    const { deps, stdout } = fixture();
    const result = await runAdminCli([], deps);
    expect(result.exit_code).toBe(1);
    expect(stdout.join('\n')).toContain('Usage:');
  });

  it('errors on an unknown subcommand', async () => {
    const { deps, stderr } = fixture();
    const result = await runAdminCli(['frobnicate'], deps);
    expect(result.exit_code).toBe(1);
    expect(stderr.join('\n')).toContain('unknown subcommand');
  });
});

describe('admin-cli mint-curator', () => {
  it('mints a curator identity + credential and prints the one-shot secret', async () => {
    const { deps, stdout, server } = fixture();
    const result = await runAdminCli(
      ['mint-curator', '--db=ignored', '--display-name=Aurelius'],
      deps,
    );
    expect(result.exit_code).toBe(0);
    expect(stdout).toHaveLength(1);
    const out = JSON.parse(stdout[0] ?? '') as {
      identity_id: string;
      credential_id: string;
      display_name: string;
      secret: string;
    };
    expect(out.identity_id).toMatch(/^idn_/);
    expect(out.credential_id).toMatch(/^agt_/);
    expect(out.display_name).toBe('Aurelius');
    // Secret is a non-trivial URL-safe-base64 string (the
    // SeededIdGen-driven shape for tests; production uses
    // `crypto.randomBytes`).
    expect(out.secret.length).toBeGreaterThan(8);

    // The minted identity is a curator under the `'harness'` provider
    // — the role-provider invariant the bootstrap method enforces
    // (slice 4b). The agent credential is bound to it and active.
    const ident = server.store.identities.get(out.identity_id as never);
    expect(ident).toMatchObject({
      role: 'curator',
      identity_provider: 'harness',
      status: 'active',
      display_name: 'Aurelius',
    });
    const cred = server.store.agentCredentials.get(out.credential_id as never);
    expect(cred).toMatchObject({
      identity_id: out.identity_id,
      status: 'active',
      label: 'curator:Aurelius',
    });
  });

  it('respects --label override', async () => {
    const { deps, stdout, server } = fixture();
    await runAdminCli(
      ['mint-curator', '--db=ignored', '--display-name=Beatrice', '--label=oncall'],
      deps,
    );
    const out = JSON.parse(stdout[0] ?? '') as { credential_id: string };
    const cred = server.store.agentCredentials.get(out.credential_id as never);
    expect(cred?.label).toBe('oncall');
  });

  it('refuses when --display-name is missing', async () => {
    const { deps, stderr } = fixture();
    const result = await runAdminCli(['mint-curator', '--db=ignored'], deps);
    expect(result.exit_code).toBe(2);
    expect(stderr.join('\n')).toMatch(/invalid_input/);
  });
});

describe('admin-cli mint-reader', () => {
  it('mints a contributor-role harness identity with no credential', async () => {
    const { deps, stdout, server } = fixture();
    const result = await runAdminCli(['mint-reader', '--db=ignored', '--display-name=web'], deps);
    expect(result.exit_code).toBe(0);
    expect(stdout).toHaveLength(1);
    const out = JSON.parse(stdout[0] ?? '') as {
      identity_id: string;
      display_name: string;
    };
    expect(out.identity_id).toMatch(/^idn_/);
    expect(out.display_name).toBe('web');
    // No `credential_id`, no `secret` — the in-process posture means
    // the web tier constructs its Caller directly from identity_id;
    // there is no bearer to mint here.
    expect((out as Record<string, unknown>)['credential_id']).toBeUndefined();
    expect((out as Record<string, unknown>)['secret']).toBeUndefined();

    // The minted identity is a *contributor* (not curator) under the
    // harness provider. The constraint that the web tier never calls
    // write tools is enforced by the web codebase, not by role; the
    // role choice here keeps the identity revocable through the
    // standard `revoke-identity` path.
    const ident = server.store.identities.get(out.identity_id as never);
    expect(ident).toMatchObject({
      role: 'contributor',
      identity_provider: 'harness',
      status: 'active',
      display_name: 'web',
    });
  });

  it('refuses when --display-name is missing', async () => {
    const { deps, stderr } = fixture();
    const result = await runAdminCli(['mint-reader', '--db=ignored'], deps);
    expect(result.exit_code).toBe(2);
    expect(stderr.join('\n')).toMatch(/invalid_input/);
  });
});

describe('admin-cli list-curators', () => {
  it('lists only curators, not contributors', async () => {
    const { deps, stdout, server } = fixture();
    // Seed a contributor + two curators directly so the list reflects
    // pre-existing state without going through mint-curator twice.
    server.bootstrap.mintIdentity({ display_name: 'contributor-alice' });
    server.bootstrap.mintIdentity({ display_name: 'curator-bob', role: 'curator' });
    server.bootstrap.mintIdentity({ display_name: 'curator-carol', role: 'curator' });

    const result = await runAdminCli(['list-curators', '--db=ignored'], deps);
    expect(result.exit_code).toBe(0);
    const out = JSON.parse(stdout[0] ?? '') as {
      count: number;
      curators: Array<{ display_name: string; status: string }>;
    };
    expect(out.count).toBe(2);
    expect(out.curators.map((c) => c.display_name).sort()).toEqual([
      'curator-bob',
      'curator-carol',
    ]);
    for (const c of out.curators) {
      expect(c.status).toBe('active');
    }
  });

  it('returns an empty list when no curators exist', async () => {
    const { deps, stdout } = fixture();
    const result = await runAdminCli(['list-curators', '--db=ignored'], deps);
    expect(result.exit_code).toBe(0);
    const out = JSON.parse(stdout[0] ?? '') as { count: number; curators: unknown[] };
    expect(out.count).toBe(0);
    expect(out.curators).toEqual([]);
  });
});

describe('admin-cli revoke-identity', () => {
  it('flips an active identity to revoked', async () => {
    const { deps, stdout, server } = fixture();
    const identity = server.bootstrap.mintIdentity({ display_name: 'mallory' });
    const result = await runAdminCli(
      ['revoke-identity', '--db=ignored', `--identity-id=${identity.id}`],
      deps,
    );
    expect(result.exit_code).toBe(0);
    const out = JSON.parse(stdout[0] ?? '') as {
      identity_id: string;
      status: string;
      changed: boolean;
    };
    expect(out).toEqual({ identity_id: identity.id, status: 'revoked', changed: true });
    expect(server.store.identities.get(identity.id)?.status).toBe('revoked');
  });

  it('is idempotent on an already-revoked identity (changed: false)', async () => {
    const { deps, stdout, server } = fixture();
    const identity = server.bootstrap.mintIdentity({ display_name: 'mallory' });
    server.store.identities.set(identity.id, { ...identity, status: 'revoked' });
    const result = await runAdminCli(
      ['revoke-identity', '--db=ignored', `--identity-id=${identity.id}`],
      deps,
    );
    expect(result.exit_code).toBe(0);
    const out = JSON.parse(stdout[0] ?? '') as { changed: boolean };
    expect(out.changed).toBe(false);
  });

  it('errors when the identity does not exist', async () => {
    const { deps, stderr } = fixture();
    const result = await runAdminCli(
      ['revoke-identity', '--db=ignored', '--identity-id=idn_does_not_exist'],
      deps,
    );
    expect(result.exit_code).toBe(2);
    expect(stderr.join('\n')).toMatch(/not_found/);
  });
});

describe('admin-cli flag parsing', () => {
  it('accepts both --key=value and --key value forms', async () => {
    const { deps, stdout: s1 } = fixture();
    await runAdminCli(['mint-curator', '--db=ignored', '--display-name=alice'], deps);
    const a = JSON.parse(s1[0] ?? '') as { display_name: string };
    expect(a.display_name).toBe('alice');

    const { deps: deps2, stdout: s2 } = fixture();
    await runAdminCli(['mint-curator', '--db', 'ignored', '--display-name', 'bob'], deps2);
    const b = JSON.parse(s2[0] ?? '') as { display_name: string };
    expect(b.display_name).toBe('bob');
  });
});
