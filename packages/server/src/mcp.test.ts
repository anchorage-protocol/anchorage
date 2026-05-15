import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// End-to-end: a Server, an MCP wrapper around it, an MCP client over
// in-memory transport, and a tool call round-tripped. The point is to
// confirm the wire-shape doesn't lose anything: typed Server methods
// → MCP tool calls → typed responses, with ServerError preserved as a
// tool error result that carries the typed `code`.
//
// The testbed connects to the production server through this same
// surface, so every invariant the in-process tests cover (auth,
// validation, materialization) must also hold over the transport.

async function fixtureWithClient() {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('m'),
    verifier: new FakeVerifier(),
  });
  const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const { secret } = server.bootstrap.bindAgentCredential({
    identity_id: identity.id,
    label: 'desktop',
  });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const subTopic = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'mrd',
    scope_query: 'ctDNA',
  });

  const mcp = buildMcpServer(server, { token: secret });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client, identity, cause, subTopic };
}

describe('mcp transport', () => {
  // Mirrors ToolName in @anchorage/contracts/tools.ts. Asserted as a
  // set rather than just per-name presence, so a tool added to the
  // registry without an MCP-side registration (or vice versa) trips
  // this test rather than slipping through silently — the same drift
  // that hid query_reputation from the contracts-side ToolName test
  // before the exhaustiveness pin landed there.
  const REGISTERED_TOOL_NAMES = [
    'set_capacity',
    'request_assignment',
    'accept_assignment',
    'decline_assignment',
    'propose_anchor',
    'propose_excerpt',
    'propose_synthesis',
    'propose_supersedes',
    'propose_membership',
    'propose_change_of_home',
    'propose_sub_topic',
    'cast_review_vote',
    'query_frontier',
    'query_proposals',
    'fetch_calibration_batch',
    'query_reputation',
    'curator_accept_proposal',
    'curator_reject_proposal',
    'curator_defer_sub_topic',
    'curator_revoke_identity',
    'curator_archive_stale_proposals',
    'curator_expire_stale_assignments',
    'curator_decline_patterns',
    'curator_identity_clusters',
  ] as const;

  it('lists every registered tool (exhaustive — no drift between MCP wrapper and ToolName)', async () => {
    // The exhaustive check now spans two sessions: a contributor's
    // `tools/list` omits the curator block (discovery filter), so
    // the wiring-vs-spec invariant is "the union across roles equals
    // ToolName". The role split is a feature (PRD §MCP tool surface,
    // Curator-only tools); a single-session assertion would silently
    // fail on the contributor side and re-introduce drift.
    const { client: contribClient } = await fixtureWithClient();
    const contribNames = (await contribClient.listTools()).tools.map((t) => t.name);
    // Spin up a curator session against the same Server.
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('cx'),
      verifier: new FakeVerifier(),
    });
    const curator = server.bootstrap.mintIdentity({ display_name: 'carol', role: 'curator' });
    const { secret } = server.bootstrap.bindAgentCredential({
      identity_id: curator.id,
      label: 'carol-desktop',
    });
    const curatorMcp = buildMcpServer(server, { token: secret });
    const curatorClient = new Client({ name: 'curator-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([curatorMcp.connect(st), curatorClient.connect(ct)]);
    const curatorNames = (await curatorClient.listTools()).tools.map((t) => t.name);

    const union = new Set([...contribNames, ...curatorNames]);
    expect([...union].sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
    // And the role split itself: contributor sees no curator_*.
    expect(contribNames.some((n) => n.startsWith('curator_'))).toBe(false);
    expect(curatorNames.some((n) => n.startsWith('curator_'))).toBe(true);
  });

  it('round-trips propose_anchor, returning the proposal_id in structuredContent', async () => {
    const { client, server, cause, subTopic } = await fixtureWithClient();
    const result = await client.callTool({
      name: 'propose_anchor',
      arguments: {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'Tie et al., ctDNA-guided adjuvant chemotherapy',
        external_ref: { kind: 'pmid', value: '35657323' },
      },
    });
    expect(result.isError).toBeFalsy();
    const proposalId = (result.structuredContent as { proposal_id: string }).proposal_id;
    expect(proposalId).toMatch(/^prp_/);
    // The Server saw the proposal — same code path as in-process tests.
    expect(server.store.proposals.get(proposalId as never)?.status).toBe('staged');
  });

  it('returns ServerError as a tool error result with code preserved', async () => {
    const { client, cause } = await fixtureWithClient();
    const result = await client.callTool({
      name: 'propose_anchor',
      arguments: {
        cause_id: cause.id,
        home_sub_topic_id: 'stp_missing',
        content: 'x',
        external_ref: { kind: 'pmid', value: '1' },
      },
    });
    expect(result.isError).toBe(true);
    // The typed payload rides in the first `content` text block, not
    // in `structuredContent` — see the error-shape note in `mcp.ts`
    // (an error payload would fail the tool's output-schema validation
    // for any client that has listed tools).
    expect(result.structuredContent).toBeUndefined();
    const textBlock = (result.content as { type: string; text?: string }[]).find(
      (b) => b.type === 'text',
    );
    const payload = JSON.parse(textBlock?.text ?? '{}') as { code?: string; message?: string };
    // PRD's typed error codes — the testbed adversaries pattern-match
    // on these against the in-process server, and they must survive
    // the transport unchanged.
    expect(payload.code).toBe('not_found');
    expect(payload.message).toMatch(/sub-topic/);
  });

  it('runs the assignment loop end-to-end across the wire', async () => {
    const { server, identity, cause, subTopic } = await fixtureWithClient();
    // Alice seeds an orphan anchor (the loop "supplies" work); Bob
    // is the contributor that will pull and fulfill an assignment.
    const a = await server.tools.proposeAnchor(
      { identity_id: identity.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'orphan',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(a.proposal_id);

    // Bob: a fresh identity, his own MCP session.
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const { secret: bobSecret } = server.bootstrap.bindAgentCredential({
      identity_id: bob.id,
      label: 'bob-desktop',
    });
    const bobMcp = buildMcpServer(server, { token: bobSecret });
    const bob_client = new Client({ name: 'bob-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([bobMcp.connect(st), bob_client.connect(ct)]);

    await bob_client.callTool({
      name: 'set_capacity',
      arguments: { cause_id: cause.id, rate: 3, kinds: ['excerpt'] },
    });
    const offered = await bob_client.callTool({
      name: 'request_assignment',
      arguments: { cause_id: cause.id },
    });
    const offerData = offered.structuredContent as {
      assignment_id: string;
      task: { kind: string; parent_anchor_id?: string };
    };
    expect(offerData.task.kind).toBe('excerpt');

    await bob_client.callTool({
      name: 'accept_assignment',
      arguments: { assignment_id: offerData.assignment_id },
    });
    const submitted = await bob_client.callTool({
      name: 'propose_excerpt',
      arguments: {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: offerData.task.parent_anchor_id,
        content: 'span content',
        quoted_span: { text: 'span', offset: 0 },
        assignment_id: offerData.assignment_id,
      },
    });
    expect(submitted.isError).toBeFalsy();
    const proposalId = (submitted.structuredContent as { proposal_id: string }).proposal_id;
    const assignment = server.store.assignments.get(offerData.assignment_id as never);
    expect(assignment?.status).toBe('submitted');
    expect(assignment?.fulfilled_by).toBe(proposalId);
  });
});

// The Authenticator is the trust boundary (PRD §Identity, Authenticator
// seam). These tests pin the boundary behavior under the default
// `HarnessAuthenticator`: well-formed bearer secrets (issued by
// `bootstrap.bindAgentCredential`) resolve to a Caller carrying both
// the identity_id and the agent_credential_id; every other token
// refuses with `unauthorized` at the seam — before any tool handler
// runs, no rate-limit budget burned, no per-tool gates exercised.
// Slice 3c's `GithubOAuthAuthenticator` plugs in at the same surface;
// downstream the contract is identical.
//
// Slice 3b shape: tokens are opaque bearer secrets. The
// `identity_id` / `identity_id/credential_id` grammars from 3a are
// retired — every caller comes from an issued credential, mirroring
// how the production OAuth path issues session secrets.
describe('authenticator seam', () => {
  function freshServer(): Server {
    return new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('a'),
      verifier: new FakeVerifier(),
    });
  }

  function mintAlice(server: Server): { identity_id: string; secret: string } {
    const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { secret } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label: 'desktop',
    });
    return { identity_id: identity.id, secret };
  }

  it('rejects empty tokens with unauthorized', () => {
    const server = freshServer();
    expect(() => buildMcpServer(server, { token: '' })).toThrow(ServerError);
    try {
      buildMcpServer(server, { token: '' });
    } catch (err) {
      expect((err as ServerError).code).toBe('unauthorized');
    }
  });

  it('rejects tokens that do not match any issued secret', () => {
    const server = freshServer();
    // Even after minting an identity + credential, a *different*
    // bearer value must not resolve to it — the only path is the
    // exact secret returned by `bindAgentCredential`.
    mintAlice(server);
    expect(() => buildMcpServer(server, { token: 'not-a-real-secret' })).toThrow(ServerError);
    try {
      buildMcpServer(server, { token: 'not-a-real-secret' });
    } catch (err) {
      expect((err as ServerError).code).toBe('unauthorized');
    }
  });

  it('rejects a credential id used as a token (id is not the secret)', () => {
    const server = freshServer();
    const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label: 'desktop',
    });
    // The credential id is a public handle; only the bearer secret
    // (returned once at bind time) authenticates. Presenting the id
    // must refuse — otherwise the bearer model collapses.
    expect(() => buildMcpServer(server, { token: credential.id })).toThrow(ServerError);
  });

  it('accepts a valid secret and round-trips both ids through tool calls', async () => {
    const server = freshServer();
    const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential, secret } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label: 'desktop',
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });

    const mcp = buildMcpServer(server, { token: secret });
    const client = new Client({ name: 'delegated-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);

    // `set_capacity` is a write tool — exercising it confirms the
    // resolved caller flowed through and the downstream gates did not
    // refuse on its account. The Caller posture is opaque from the
    // wire's perspective; we cross-check the identity's capacity
    // record landed under alice's id and the credential survived as
    // the side-channel reference (credential id is the audit handle).
    const result = await client.callTool({
      name: 'set_capacity',
      arguments: { cause_id: cause.id, rate: 1, kinds: ['excerpt'] },
    });
    expect(result.isError).toBeFalsy();
    const cap = server.store.capacities.get(`${identity.id}|${cause.id}`);
    expect(cap?.rate).toBe(1);
    expect(server.store.agentCredentials.get(credential.id)?.status).toBe('active');
  });

  it('refuses a token whose credential has been revoked', () => {
    const server = freshServer();
    const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential, secret } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label: 'desktop',
    });
    server.store.agentCredentials.set(credential.id, { ...credential, status: 'revoked' });
    expect(() => buildMcpServer(server, { token: secret })).toThrow(ServerError);
  });

  it('refuses a token for a revoked identity at the seam', () => {
    const server = freshServer();
    const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { secret } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label: 'desktop',
    });
    // Direct store mutation to flip status — revocation tooling is
    // not yet exposed as a bootstrap method, and the seam check
    // doesn't care how the status got to `revoked`.
    server.store.identities.set(identity.id, { ...identity, status: 'revoked' });
    expect(() => buildMcpServer(server, { token: secret })).toThrow(ServerError);
  });
});

// Slice 7a: curator-only MCP tool surface. PRD §MCP tool surface
// (Curator-only tools) commits the eight `curator_*` tools that wrap
// the in-process `server.curator.*` surface, with role enforcement
// at the MCP wrapper (`wrapCurator`). A contributor calling any of
// them refuses with `permission_denied`; a curator round-trips end-
// to-end. The seam pins both halves so contributor-vs-curator drift
// surfaces at test time, not at production runtime.
describe('curator tool surface', () => {
  async function curatorFixture() {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('c'),
      verifier: new FakeVerifier(),
    });
    // Contributor (default-role) + curator (harness-provider mint,
    // role explicitly 'curator'). Both bind a bearer credential —
    // production-shaped path through the Authenticator seam.
    const contributor = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { secret: contribSecret } = server.bootstrap.bindAgentCredential({
      identity_id: contributor.id,
      label: 'alice-desktop',
    });
    const curator = server.bootstrap.mintIdentity({
      display_name: 'carol',
      role: 'curator',
    });
    const { secret: curatorSecret } = server.bootstrap.bindAgentCredential({
      identity_id: curator.id,
      label: 'carol-desktop',
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'mrd',
      scope_query: 'ctDNA',
    });

    async function connect(secret: string, name: string) {
      const mcp = buildMcpServer(server, { token: secret });
      const client = new Client({ name, version: '0.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(st), client.connect(ct)]);
      return client;
    }

    const contribClient = await connect(contribSecret, 'contrib');
    const curatorClient = await connect(curatorSecret, 'curator');

    return { server, contributor, curator, cause, subTopic, contribClient, curatorClient };
  }

  function errorPayload(result: Awaited<ReturnType<Client['callTool']>>): {
    code?: string;
    message?: string;
  } {
    const textBlock = (result.content as { type: string; text?: string }[]).find(
      (b) => b.type === 'text',
    );
    return JSON.parse(textBlock?.text ?? '{}') as { code?: string; message?: string };
  }

  it("a contributor's tools/list omits every curator_* tool (discovery filter)", async () => {
    const { contribClient, curatorClient } = await curatorFixture();
    const contribTools = (await contribClient.listTools()).tools.map((t) => t.name);
    const curatorTools = (await curatorClient.listTools()).tools.map((t) => t.name);
    // Contributor session: zero curator_* names.
    expect(contribTools.filter((n) => n.startsWith('curator_'))).toEqual([]);
    // Curator session: exactly the eight curator tools committed in
    // PRD §MCP tool surface (Curator-only tools).
    expect(curatorTools.filter((n) => n.startsWith('curator_')).sort()).toEqual(
      [
        'curator_accept_proposal',
        'curator_archive_stale_proposals',
        'curator_decline_patterns',
        'curator_defer_sub_topic',
        'curator_expire_stale_assignments',
        'curator_identity_clusters',
        'curator_reject_proposal',
        'curator_revoke_identity',
      ].sort(),
    );
    // Read- and write-path tools survive on both sides — the filter
    // is curator-scoped, not a wholesale wire change.
    for (const t of ['propose_anchor', 'cast_review_vote', 'query_frontier']) {
      expect(contribTools).toContain(t);
      expect(curatorTools).toContain(t);
    }
  });

  it('lets a curator accept a staged proposal end-to-end', async () => {
    const { server, contributor, curatorClient, cause, subTopic } = await curatorFixture();
    const proposal = await server.tools.proposeAnchor(
      { identity_id: contributor.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'orphan',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    const result = await curatorClient.callTool({
      name: 'curator_accept_proposal',
      arguments: { proposal_id: proposal.proposal_id },
    });
    expect(result.isError).toBeFalsy();
    const { node_id } = result.structuredContent as { node_id?: string };
    expect(node_id).toMatch(/^nod_/);
    expect(server.store.proposals.get(proposal.proposal_id)?.status).toBe('accepted');
  });

  it('lets a curator reject a staged proposal without materializing it', async () => {
    const { server, contributor, curatorClient, cause, subTopic } = await curatorFixture();
    const proposal = await server.tools.proposeAnchor(
      { identity_id: contributor.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'orphan',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    const result = await curatorClient.callTool({
      name: 'curator_reject_proposal',
      arguments: { proposal_id: proposal.proposal_id },
    });
    expect(result.isError).toBeFalsy();
    expect(server.store.proposals.get(proposal.proposal_id)?.status).toBe('rejected');
  });

  it('curator_revoke_identity round-trips and is idempotent on re-revoke', async () => {
    const { server, contributor, curatorClient } = await curatorFixture();
    const first = await curatorClient.callTool({
      name: 'curator_revoke_identity',
      arguments: { identity_id: contributor.id },
    });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toEqual({
      identity_id: contributor.id,
      status: 'revoked',
      changed: true,
    });
    expect(server.store.identities.get(contributor.id)?.status).toBe('revoked');

    const second = await curatorClient.callTool({
      name: 'curator_revoke_identity',
      arguments: { identity_id: contributor.id },
    });
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toEqual({
      identity_id: contributor.id,
      status: 'revoked',
      changed: false,
    });
  });

  it('curator_decline_patterns and curator_identity_clusters return empty result on a fresh cause', async () => {
    const { curatorClient, cause } = await curatorFixture();
    const declines = await curatorClient.callTool({
      name: 'curator_decline_patterns',
      arguments: { cause_id: cause.id },
    });
    expect(declines.isError).toBeFalsy();
    expect(declines.structuredContent).toEqual({ entries: [] });

    const clusters = await curatorClient.callTool({
      name: 'curator_identity_clusters',
      arguments: {},
    });
    expect(clusters.isError).toBeFalsy();
    expect(clusters.structuredContent).toEqual({ pairs: [] });
  });

  it('wire-level permission_denied when a curator session is demoted to contributor mid-connection', async () => {
    // The role gate inside `wrapCurator` re-resolves the caller from
    // the store on every call. Demoting the curator after the
    // connection is established must propagate to the next tool
    // invocation: the tool stays *registered* on the session (the
    // discovery filter is a build-time hint, not the gate), but the
    // call refuses with `permission_denied` — distinct from the
    // `unauthorized` seam refusal that fires when the identity is
    // revoked outright.
    const { server, curator, curatorClient, cause } = await curatorFixture();
    server.store.identities.set(curator.id, { ...curator, role: 'contributor' });
    const result = await curatorClient.callTool({
      name: 'curator_decline_patterns',
      arguments: { cause_id: cause.id },
    });
    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe('permission_denied');
  });

  it('refuses a curator whose identity was revoked mid-connection (re-resolution per call)', async () => {
    // Same re-resolution path, but for the outright revocation case —
    // `resolveCaller` refuses at the Authenticator seam with
    // `unauthorized` (status !== 'active'); the role check never
    // runs because the call refuses one step earlier.
    const { server, curator, curatorClient, cause } = await curatorFixture();
    server.store.identities.set(curator.id, { ...curator, status: 'revoked' });
    const result = await curatorClient.callTool({
      name: 'curator_decline_patterns',
      arguments: { cause_id: cause.id },
    });
    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe('unauthorized');
  });
});
