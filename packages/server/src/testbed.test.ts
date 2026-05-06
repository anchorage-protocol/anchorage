import {
  AnchorageClient,
  type ContentProvider,
  acceptAllDecider,
  rejectAllDecider,
  runHonestReviewer,
  runHonestStrong,
} from '@anchorage/testbed';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Walking-skeleton testbed integration: a Server is wired to an
// honest-strong archetype over the in-memory MCP transport. The
// archetype drives the assignment loop end to end and the test
// asserts both the archetype's action log and the server's resulting
// state. This is the architectural spine for Phase 1: the testbed
// package owns archetype logic + the typed MCP client; the server
// package wires it up. By construction (testbed's tsconfig +
// package.json restrict deps to @anchorage/contracts) the testbed
// cannot reach into server internals — it only sees what real
// clients see.

async function wireArchetype(server: Server, identity_id: string) {
  const mcp = buildMcpServer(server, { caller: { identity_id: identity_id as never } });
  const client = new Client({ name: 'archetype', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  return new AnchorageClient(client);
}

describe('testbed: honest-strong archetype', () => {
  it('drains the orphan-anchor frontier by submitting excerpts', async () => {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'mrd',
      scope_query: 'ctDNA',
    });

    // Three orphan anchors waiting for excerpts. Alice (the seeder)
    // is *not* the contributor that runs the archetype; bob is. The
    // proposer-can't-review-own-work invariant doesn't apply here —
    // it's an assignment-eligibility check, and bob is fresh.
    const anchorIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const a = await server.tools.proposeAnchor(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          content: `paper ${i}`,
          external_ref: { kind: 'pmid', value: String(i) },
        },
      );
      const id = server.curator.acceptProposal(a.proposal_id).node_id;
      if (!id) throw new Error('expected anchor');
      anchorIds.push(id);
    }

    // Bob runs the archetype.
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);

    // Content fixture: every anchor gets a span. A real archetype
    // would derive these from the source content; the fixture makes
    // the test deterministic.
    const provider: ContentProvider = {
      forAnchor: (anchorId: string) => ({
        content: `claim derived from ${anchorId}`,
        quoted_span: { text: 'fixture span', offset: 0 },
      }),
    };

    const result = await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    // Action log: capacity, then three (request, accept, submit)
    // triples, then idle when the frontier dries up.
    const actionKinds = result.actions.map((a) => a.kind);
    expect(actionKinds[0]).toBe('set_capacity');
    expect(actionKinds.filter((k) => k === 'submitted')).toHaveLength(3);
    expect(actionKinds[actionKinds.length - 1]).toBe('idle');

    // Server state: three new excerpt proposals, all proposed by
    // bob, each with assignment_id pinned. Plus the three orphan
    // anchors and three submitted assignments.
    const excerptProposals = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerptProposals).toHaveLength(3);
    for (const p of excerptProposals) {
      expect(p.proposer_id).toBe(bob.id);
      expect(p.assignment_id).toBeDefined();
    }
    const submittedAssignments = [...server.store.assignments.values()].filter(
      (a) => a.status === 'submitted',
    );
    expect(submittedAssignments).toHaveLength(3);
  });

  it('declines tasks the archetype cannot fulfill, freeing the rate budget', async () => {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'st',
      description: 'x',
      scope_query: 'x',
    });
    // Two orphan anchors.
    for (let i = 1; i <= 2; i++) {
      const a = await server.tools.proposeAnchor(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          content: `p${i}`,
          external_ref: { kind: 'pmid', value: String(i) },
        },
      );
      server.curator.acceptProposal(a.proposal_id);
    }

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);

    // Provider rejects every anchor — archetype declines every task.
    const provider: ContentProvider = { forAnchor: () => null };

    const result = await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 1,
      kinds: ['excerpt'],
      content: provider,
    });

    const declines = result.actions.filter((a) => a.kind === 'declined');
    expect(declines).toHaveLength(2);
    // Final state: terminates idle (no fulfillable work) — the
    // archetype didn't get stuck against its rate cap because each
    // decline freed the budget.
    const last = result.actions[result.actions.length - 1];
    if (!last) throw new Error('expected at least one action');
    expect(last.kind).toBe('idle');
    expect(
      [...server.store.proposals.values()].filter((p) => p.payload.kind === 'excerpt'),
    ).toHaveLength(0);
  });

  it('drives proposal → reviewer-pool review → convergent merge end to end', async () => {
    // The Phase 1 thesis lives or dies on this scenario: honest
    // proposers + honest reviewers + the convergent-vote machinery
    // close the loop without curator action. Two reviewers with the
    // default threshold of 2 should auto-accept each excerpt the
    // proposer submits.
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'st',
      description: 'x',
      scope_query: 'x',
    });
    // Two orphan anchors waiting for excerpts.
    for (let i = 1; i <= 2; i++) {
      const a = await server.tools.proposeAnchor(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          content: `paper ${i}`,
          external_ref: { kind: 'pmid', value: String(i) },
        },
      );
      server.curator.acceptProposal(a.proposal_id);
    }

    const provider: ContentProvider = {
      forAnchor: (anchorId) => ({
        content: `claim from ${anchorId}`,
        quoted_span: { text: 'span', offset: 0 },
      }),
    };

    // Bob (proposer) and two reviewers (carol, dave). Each gets
    // their own MCP session — same architecture a multi-tenant
    // production deployment would use.
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const bobClient = await wireArchetype(server, bob.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);

    // Bob proposes excerpts. The two anchor-orphans drain into two
    // staged excerpt proposals.
    const proposerResult = await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });
    expect(proposerResult.actions.filter((a) => a.kind === 'submitted')).toHaveLength(2);

    // Carol and Dave each pull review assignments. With threshold 2,
    // two accepts on each proposal should converge it.
    const carolResult = await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    const daveResult = await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Each reviewer voted on both excerpts.
    const carolVotes = carolResult.actions.filter((a) => a.kind === 'voted');
    const daveVotes = daveResult.actions.filter((a) => a.kind === 'voted');
    expect(carolVotes).toHaveLength(2);
    expect(daveVotes).toHaveLength(2);

    // Both excerpts converged to accepted; both excerpt nodes were
    // materialized along with their derives edges.
    const excerptProposals = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerptProposals).toHaveLength(2);
    expect(excerptProposals.every((p) => p.status === 'accepted')).toBe(true);
    const excerptNodes = [...server.store.nodes.values()].filter((n) => n.kind === 'excerpt');
    expect(excerptNodes).toHaveLength(2);
    const derivesEdges = [...server.store.edges.values()].filter((e) => e.kind === 'derives');
    expect(derivesEdges).toHaveLength(2);
  });

  it('drives the rejection path: reject-all reviewers force auto-rejection', async () => {
    // The contrast scenario for the convergent-merge test above:
    // honest proposers, reject-all reviewers. The proposed excerpts
    // converge to *rejected*, not accepted, and no nodes materialize.
    // This is the rep-laundering wedge PRD's adversary taxonomy
    // describes — reject-everything reviewers prevent merge — and
    // demonstrates the testbed can express adversarial shapes
    // through the same decider seam honest variants use.
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'st',
      description: 'x',
      scope_query: 'x',
    });
    const a = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(a.proposal_id);

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const bobClient = await wireArchetype(server, bob.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);

    const provider: ContentProvider = {
      forAnchor: (anchorId) => ({
        content: `claim from ${anchorId}`,
        quoted_span: { text: 'span', offset: 0 },
      }),
    };

    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    // Both reviewers reject. With threshold 2, the excerpt converges
    // to rejected on the second reject vote.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: rejectAllDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: rejectAllDecider,
    });

    const excerptProposals = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerptProposals).toHaveLength(1);
    expect(excerptProposals[0]?.status).toBe('rejected');
    // No excerpt node materialized on the rejection path.
    const excerptNodes = [...server.store.nodes.values()].filter((n) => n.kind === 'excerpt');
    expect(excerptNodes).toHaveLength(0);
  });

  it('records reputation deltas observable via query_reputation across the wire', async () => {
    // Phase 1 measurement check: after a full convergent loop, the
    // testbed (which has only the contracts + an MCP client) can read
    // the resulting reputation movement through query_reputation. Bob
    // gets +1 in the home sub-topic for an assignment-driven excerpt
    // that converges to accepted; Carol and Dave (the two reviewers
    // who voted accept) each get +1 for accurate reviews.
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'st',
      description: 'x',
      scope_query: 'x',
    });
    const a = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(a.proposal_id);

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const bobClient = await wireArchetype(server, bob.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);

    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: {
        forAnchor: (id) => ({
          content: `claim ${id}`,
          quoted_span: { text: 'span', offset: 0 },
        }),
      },
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Bob's excerpt was assignment-driven, so full weight: +1.
    const bobRep = await bobClient.queryReputation({ cause_id: cause.id });
    expect(bobRep.entries).toEqual([{ sub_topic_id: subTopic.id, score: 1 }]);
    // Carol and Dave each voted with the converged outcome → +1.
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    expect(carolRep.entries).toEqual([{ sub_topic_id: subTopic.id, score: 1 }]);
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    expect(daveRep.entries).toEqual([{ sub_topic_id: subTopic.id, score: 1 }]);
  });

  it('surfaces typed error codes through AnchorageClientError', async () => {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const aliceClient = await wireArchetype(server, alice.id);
    // Calling set_capacity for a cause that doesn't exist surfaces
    // `not_found` over the wire — the testbed's adversary harness
    // pattern-matches on this code, so the round-trip is what we
    // exercise here.
    await expect(
      aliceClient.setCapacity({
        cause_id: 'cau_missing' as never,
        rate: 1,
        kinds: ['excerpt'],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
