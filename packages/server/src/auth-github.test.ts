import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  computeGithubAttestationLevel,
  FakeGithubApi,
  GithubOAuthAuthenticator,
} from './auth-github.js';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Slice 3c — GithubOAuthAuthenticator, the production-runtime
// concrete behind the Authenticator seam (PRD §Identity). Coverage
// pins, in order:
//
//   1. Device-code flow round-trips against a scripted GithubApi:
//      pending → authorized produces a bearer secret, and that
//      secret authenticates against the same seam every other
//      authenticator uses (sim≡prod invariant).
//   2. Identity-on-first-signin: first authorized signin for a
//      given (provider, github_user_id) mints a fresh identity;
//      subsequent signins re-use it (one human, one identity).
//   3. Attestation mapping: 2FA + verified-email + account age ≥
//      threshold → level 2; anything weaker → level 1.
//   4. Issuance-frequency cap (PRD bullet 2) fires per (provider,
//      bucket, epoch) at the IdP layer, refusing with `issuance_cap`
//      before any identity is minted.
//   5. The seam's refusal modes: unknown token, revoked credential,
//      revoked identity all refuse `unauthorized`.

function freshServer(): Server {
  return new Server({
    clock: new FakeClock('2026-05-14T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('gh'),
    verifier: new FakeVerifier(),
  });
}

describe('computeGithubAttestationLevel', () => {
  it('returns 2 when 2FA on + verified primary email + account age past threshold', () => {
    const level = computeGithubAttestationLevel(
      {
        id: '1',
        login: 'octo',
        two_factor_authentication: true,
        created_at: '2020-01-01T00:00:00Z',
      },
      { primary_verified: true },
      '2026-05-14T00:00:00Z',
      30,
    );
    expect(level).toBe(2);
  });

  it('returns 1 when 2FA is off', () => {
    const level = computeGithubAttestationLevel(
      {
        id: '1',
        login: 'octo',
        two_factor_authentication: false,
        created_at: '2020-01-01T00:00:00Z',
      },
      { primary_verified: true },
      '2026-05-14T00:00:00Z',
      30,
    );
    expect(level).toBe(1);
  });

  it('returns 1 when primary email is not verified', () => {
    const level = computeGithubAttestationLevel(
      {
        id: '1',
        login: 'octo',
        two_factor_authentication: true,
        created_at: '2020-01-01T00:00:00Z',
      },
      { primary_verified: false },
      '2026-05-14T00:00:00Z',
      30,
    );
    expect(level).toBe(1);
  });

  it('returns 1 when account is younger than threshold', () => {
    const level = computeGithubAttestationLevel(
      {
        id: '1',
        login: 'octo',
        two_factor_authentication: true,
        created_at: '2026-05-01T00:00:00Z',
      },
      { primary_verified: true },
      '2026-05-14T00:00:00Z',
      30,
    );
    expect(level).toBe(1);
  });

  it('returns 1 when 2FA status is undefined (unknown == not-attested)', () => {
    const level = computeGithubAttestationLevel(
      { id: '1', login: 'octo', created_at: '2020-01-01T00:00:00Z' },
      { primary_verified: true },
      '2026-05-14T00:00:00Z',
      30,
    );
    expect(level).toBe(1);
  });
});

describe('GithubOAuthAuthenticator — device-code flow', () => {
  it('startSignin → completeSignin produces a credential whose secret authenticates', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    const dc = await auth.startSignin();
    expect(dc.user_code).toBeTruthy();
    expect(dc.verification_uri).toContain('github');

    const result = await auth.completeSignin(dc.device_code);
    expect(result.status).toBe('authorized');
    expect(result.secret).toBeTruthy();
    expect(result.identity_id).toBeTruthy();
    expect(result.credential_id).toBeTruthy();
    expect(result.github_login).toBe('octocat');
    expect(result.attestation_level).toBe(2);

    // The issued secret resolves at the same seam every other
    // authenticator uses — the downstream-gate code path is
    // indistinguishable from a `HarnessAuthenticator`-issued
    // secret. Build an MCP server against the GitHub-flavored
    // authenticator and round-trip a write tool.
    server.setAuthenticator(auth);
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'mrd',
      scope_query: 'ctDNA',
    });
    // Seed an accepted orphan anchor so the frontier has an excerpt
    // task for the GitHub-authenticated caller to pull.
    const seed = await server.tools.proposeAnchor(
      { identity_id: result.identity_id as never },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'orphan',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(seed.proposal_id);
    const mcp = buildMcpServer(server, {
      token: result.secret as string,
    });
    const client = new Client({ name: 't', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);
    const toolResult = await client.callTool({
      name: 'request_assignment',
      arguments: { cause_id: cause.id },
    });
    expect(toolResult.isError).toBeFalsy();
    const assignmentId = (toolResult.structuredContent as { assignment_id: string }).assignment_id;
    expect(server.store.assignments.get(assignmentId as never)?.contributor_id).toBe(
      result.identity_id,
    );
  });

  it('returns pending while GitHub has not yet authorized', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi({
        poll_responses: [
          { status: 'pending' },
          { status: 'slow_down', interval_seconds: 12 },
          { status: 'authorized', access_token: 'fake-access-token' },
        ],
      }),
    });
    const dc = await auth.startSignin();
    expect((await auth.completeSignin(dc.device_code)).status).toBe('pending');
    const slowdown = await auth.completeSignin(dc.device_code);
    expect(slowdown.status).toBe('pending');
    expect(slowdown.interval_seconds).toBe(12);
    expect((await auth.completeSignin(dc.device_code)).status).toBe('authorized');
  });

  it('expired device_code refuses subsequent completeSignin calls', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi({
        poll_responses: [{ status: 'expired' }],
      }),
    });
    const dc = await auth.startSignin();
    expect((await auth.completeSignin(dc.device_code)).status).toBe('expired');
    // Once flushed, the device_code is unknown — same refusal.
    expect((await auth.completeSignin(dc.device_code)).status).toBe('expired');
  });

  it('denied (user-declined) refuses without minting', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi({
        poll_responses: [{ status: 'denied' }],
      }),
    });
    const dc = await auth.startSignin();
    expect((await auth.completeSignin(dc.device_code)).status).toBe('denied');
    expect(server.store.identities.size).toBe(0);
    expect(server.store.agentCredentials.size).toBe(0);
  });

  it('idempotent on retry — same device_code returns same credential', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    const dc = await auth.startSignin();
    const first = await auth.completeSignin(dc.device_code);
    const second = await auth.completeSignin(dc.device_code);
    expect(second.status).toBe('authorized');
    expect(second.credential_id).toBe(first.credential_id);
    expect(second.identity_id).toBe(first.identity_id);
    expect(second.secret).toBe(first.secret);
    // Only one identity and one credential were created.
    expect(server.store.identities.size).toBe(1);
    expect(server.store.agentCredentials.size).toBe(1);
  });

  it('stops re-returning the secret after the completed-retention window', async () => {
    // The idempotency window absorbs a dropped network response; it
    // must not be an indefinite plaintext-secret cache that any later
    // holder of the device_code can replay against.
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    const dc = await auth.startSignin();
    const first = await auth.completeSignin(dc.device_code);
    expect(first.status).toBe('authorized');
    // Within the window: retry still returns the cached secret.
    const retry = await auth.completeSignin(dc.device_code);
    expect(retry.secret).toBe(first.secret);
    // Past the window: the entry is gone; the replay gets nothing.
    (server.clock as FakeClock).advance(3 * 60 * 1000);
    const replay = await auth.completeSignin(dc.device_code);
    expect(replay.status).toBe('expired');
    expect(replay.secret).toBeUndefined();
    // No duplicate credential was minted by any of it.
    expect(server.store.agentCredentials.size).toBe(1);
  });
});

describe('GithubOAuthAuthenticator — identity-on-first-signin', () => {
  it('reuses the existing identity when the same GitHub user signs in again', async () => {
    const server = freshServer();
    const api = new FakeGithubApi();
    const auth = new GithubOAuthAuthenticator({ server, githubApi: api });

    const dc1 = await auth.startSignin();
    const first = await auth.completeSignin(dc1.device_code);
    const dc2 = await auth.startSignin();
    const second = await auth.completeSignin(dc2.device_code);

    expect(first.identity_id).toBe(second.identity_id);
    // Each signin mints a *fresh* credential under the same identity
    // — losing a laptop and re-signing in must not collide with
    // the old credential's secret.
    expect(first.credential_id).not.toBe(second.credential_id);
    expect(first.secret).not.toBe(second.secret);
    expect(server.store.identities.size).toBe(1);
    expect(server.store.agentCredentials.size).toBe(2);
  });

  it('mints a distinct identity for a distinct GitHub user id', async () => {
    const server = freshServer();
    const alice = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi({
        device_code: 'dc-alice',
        access_token: 'tok-alice',
        user: {
          id: '111',
          login: 'alice',
          two_factor_authentication: true,
          created_at: '2020-01-01T00:00:00Z',
        },
      }),
    });
    const bob = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi({
        device_code: 'dc-bob',
        access_token: 'tok-bob',
        user: {
          id: '222',
          login: 'bob',
          two_factor_authentication: false,
          created_at: '2026-05-01T00:00:00Z',
        },
      }),
    });
    const dcA = await alice.startSignin();
    const rA = await alice.completeSignin(dcA.device_code);
    const dcB = await bob.startSignin();
    const rB = await bob.completeSignin(dcB.device_code);
    expect(rA.identity_id).not.toBe(rB.identity_id);
    expect(rA.attestation_level).toBe(2);
    expect(rB.attestation_level).toBe(1);
  });

  it('refuses signin for a revoked identity at the same wire-shape as the seam refusal', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    const dc1 = await auth.startSignin();
    const first = await auth.completeSignin(dc1.device_code);
    // Curator-side revocation (direct store flip — curator tooling
    // lands alongside the operational surface in slice 7).
    const identity = server.store.identities.get(first.identity_id as never);
    server.store.identities.set(first.identity_id as never, {
      ...(identity as NonNullable<typeof identity>),
      status: 'revoked',
    });
    const dc2 = await auth.startSignin();
    await expect(auth.completeSignin(dc2.device_code)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('GithubOAuthAuthenticator — issuance-frequency cap', () => {
  it('refuses signin with issuance_cap once the per-bucket cap is exhausted', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
      config: {
        issuance_cap_per_epoch: 1,
        issuance_epoch_seconds: 60,
      },
    });
    const dc1 = await auth.startSignin();
    const first = await auth.completeSignin(dc1.device_code);
    expect(first.status).toBe('authorized');
    // Second signin in the same epoch under the same GitHub user
    // (same bucket key) exhausts the cap. The refusal must fire
    // *before* any identity mint — the existing identity should
    // still exist, no second credential should appear.
    const credentialsBefore = server.store.agentCredentials.size;
    const dc2 = await auth.startSignin();
    await expect(auth.completeSignin(dc2.device_code)).rejects.toMatchObject({
      code: 'issuance_cap',
    });
    expect(server.store.agentCredentials.size).toBe(credentialsBefore);
  });

  it('inert configuration (cap = Infinity) never fires the gate', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
      // Defaults are inert; pass nothing.
    });
    // Multiple back-to-back signins for the same user succeed
    // because the cap is Infinity by default (slice 3c commits the
    // *layer*; production deployments pick a finite value).
    for (let i = 0; i < 3; i++) {
      const dc = await auth.startSignin();
      const r = await auth.completeSignin(dc.device_code);
      expect(r.status).toBe('authorized');
    }
    expect(server.store.idpIssuanceCounters.size).toBe(0);
  });
});

describe('GithubOAuthAuthenticator — authenticate seam', () => {
  it('refuses empty / unknown tokens with unauthorized', () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    expect(() => auth.authenticate('')).toThrow(ServerError);
    try {
      auth.authenticate('');
    } catch (err) {
      expect((err as ServerError).code).toBe('unauthorized');
    }
    expect(() => auth.authenticate('not-a-real-secret')).toThrow(ServerError);
  });

  it('refuses a revoked credential at the seam', async () => {
    const server = freshServer();
    const auth = new GithubOAuthAuthenticator({
      server,
      githubApi: new FakeGithubApi(),
    });
    const dc = await auth.startSignin();
    const r = await auth.completeSignin(dc.device_code);
    const credential = server.store.agentCredentials.get(r.credential_id as never);
    server.store.agentCredentials.set(r.credential_id as never, {
      ...(credential as NonNullable<typeof credential>),
      status: 'revoked',
    });
    expect(() => auth.authenticate(r.secret as string)).toThrow(ServerError);
    try {
      auth.authenticate(r.secret as string);
    } catch (err) {
      expect((err as ServerError).code).toBe('unauthorized');
    }
  });
});
