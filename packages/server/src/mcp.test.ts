import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
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
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const subTopic = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'mrd',
    scope_query: 'ctDNA',
  });

  const mcp = buildMcpServer(server, { caller: { identity_id: identity.id } });
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
    'submit_assigned_proposal',
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
  ] as const;

  it('lists every registered tool (exhaustive — no drift between MCP wrapper and ToolName)', async () => {
    const { client } = await fixtureWithClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
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
    const bobMcp = buildMcpServer(server, { caller: { identity_id: bob.id } });
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
      name: 'submit_assigned_proposal',
      arguments: {
        assignment_id: offerData.assignment_id,
        payload: {
          kind: 'excerpt',
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          parent_anchor_id: offerData.task.parent_anchor_id,
          content: 'span content',
          quoted_span: { text: 'span', offset: 0 },
        },
      },
    });
    expect(submitted.isError).toBeFalsy();
    const proposalId = (submitted.structuredContent as { proposal_id: string }).proposal_id;
    const assignment = server.store.assignments.get(offerData.assignment_id as never);
    expect(assignment?.status).toBe('submitted');
    expect(assignment?.fulfilled_by).toBe(proposalId);
  });

  it('accepts submit_assigned_proposal with a JSON-string-encoded payload', async () => {
    // A model client that stringifies the nested `payload` value (a
    // recurring slip with smaller models — observed thrashing real
    // deep-loop runs) is not refused over the encoding: the contract
    // schema parses a string payload before validating the object.
    const { server, identity, cause, subTopic } = await fixtureWithClient();
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
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobMcp = buildMcpServer(server, { caller: { identity_id: bob.id } });
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
      task: { parent_anchor_id?: string };
    };
    await bob_client.callTool({
      name: 'accept_assignment',
      arguments: { assignment_id: offerData.assignment_id },
    });
    const submitted = await bob_client.callTool({
      name: 'submit_assigned_proposal',
      arguments: {
        assignment_id: offerData.assignment_id,
        payload: JSON.stringify({
          kind: 'excerpt',
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          parent_anchor_id: offerData.task.parent_anchor_id,
          content: 'span content',
          quoted_span: { text: 'span', offset: 0 },
        }),
      },
    });
    expect(submitted.isError).toBeFalsy();
    const proposalId = (submitted.structuredContent as { proposal_id: string }).proposal_id;
    expect(server.store.assignments.get(offerData.assignment_id as never)?.fulfilled_by).toBe(
      proposalId,
    );
  });
});
