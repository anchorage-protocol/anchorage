import {
  AnchorageClient,
  type ContentProvider,
  type HallucinationFabricator,
  acceptAllDecider,
  payloadBiasedDecider,
  rejectAllDecider,
  runHallucinator,
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

  it('catches a lazy-accepter reviewer: rep moves down when honest rejecters converge', async () => {
    // The smallest "the testbed measures attack-success rates"
    // demonstration: a lazy-accepter votes accept on a proposal that
    // honest rejecters mark for rejection. With threshold 2 on
    // rejects, the proposal converges to rejected, and the lazy
    // reviewer's accept-vote was inaccurate against the converged
    // outcome — they lose rep. Honest rejecters gain rep. The pattern
    // generalizes: as adversary load increases, rep distributions
    // diverge, which is the testbed's measurement handle.
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
    // Alice (proposer) submits a contributor-initiated anchor — a
    // weak proposal that the rejecters will mark down.
    await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'weak claim',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );

    const lazy = server.bootstrap.mintIdentity({ display_name: 'lazy' });
    const honest1 = server.bootstrap.mintIdentity({ display_name: 'honest-1' });
    const honest2 = server.bootstrap.mintIdentity({ display_name: 'honest-2' });
    const lazyClient = await wireArchetype(server, lazy.id);
    const honest1Client = await wireArchetype(server, honest1.id);
    const honest2Client = await wireArchetype(server, honest2.id);

    // Lazy goes first — votes accept on whatever's offered.
    await runHonestReviewer(lazyClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    // Then the honest rejecters. With threshold 2 rejects, the
    // second one closes the proposal.
    await runHonestReviewer(honest1Client, {
      cause_id: cause.id,
      rate: 5,
      decide: rejectAllDecider,
    });
    await runHonestReviewer(honest2Client, {
      cause_id: cause.id,
      rate: 5,
      decide: rejectAllDecider,
    });

    // The proposal converged to rejected.
    const proposals = [...server.store.proposals.values()];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe('rejected');

    // Reputation: lazy lost (inaccurate accept against rejected
    // outcome); honest-1 and honest-2 gained (accurate rejects);
    // alice (proposer) lost contributor-initiated proposer-loss.
    const lazyRep = await lazyClient.queryReputation({ cause_id: cause.id });
    expect(lazyRep.entries).toEqual([{ sub_topic_id: subTopic.id, score: -1 }]);
    const honest1Rep = await honest1Client.queryReputation({ cause_id: cause.id });
    expect(honest1Rep.entries).toEqual([{ sub_topic_id: subTopic.id, score: 1 }]);
    const honest2Rep = await honest2Client.queryReputation({ cause_id: cause.id });
    expect(honest2Rep.entries).toEqual([{ sub_topic_id: subTopic.id, score: 1 }]);
  });

  it('catches the hallucinator at the verifier, before reviewers see anything', async () => {
    // PRD adversary taxonomy line 305: hallucinated submissions
    // "Should be caught at the verification engine (span mismatch,
    // unresolved citations) before review." Operationalized: the
    // FakeVerifier holds source content for two PMIDs; the
    // hallucinator's constantFabricator submits spans that don't
    // appear in either source. The server's propose_excerpt path
    // calls verifier.verifySpan and throws invalid_input, so no
    // proposal record is ever created. The reviewer pool stays
    // empty. The hallucinator gains no rep — verification rejection
    // is not a review rejection (ProposalStatus's documented
    // distinction in @anchorage/contracts).
    const sources = new Map<string, string>([
      ['1', 'paper one says ctDNA detection precedes radiographic recurrence by months'],
      ['2', 'paper two reports MRD positivity correlates with relapse risk in stage III CRC'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'mrd',
      scope_query: 'ctDNA',
    });
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

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);

    // Fabricator: a span that appears in neither source.
    const fabricator: HallucinationFabricator = {
      fabricateForAnchor: () => ({
        content: 'fabricated finding',
        quoted_span: { text: 'this exact text is not in any source', offset: 0 },
      }),
    };

    const result = await runHallucinator(bobClient, {
      cause_id: cause.id,
      rate: 5,
      fabricator,
    });

    // Two anchors → two requested+accepted+submit_rejected triples,
    // then idle.
    const submitRejected = result.actions.filter((a) => a.kind === 'submit_rejected');
    expect(submitRejected).toHaveLength(2);
    expect(
      submitRejected.every((a) => a.kind === 'submit_rejected' && a.code === 'invalid_input'),
    ).toBe(true);
    expect(result.actions[result.actions.length - 1]?.kind).toBe('idle');

    // No excerpt proposal record exists — that is the load-bearing
    // assertion. Reviewers literally cannot see what was never
    // staged, so the hallucinator never burns reviewer time.
    expect(
      [...server.store.proposals.values()].filter((p) => p.payload.kind === 'excerpt'),
    ).toHaveLength(0);

    // The reviewer-side query: needs_review surface is empty
    // because no excerpt is staged. Cross-checked over the wire so
    // the assertion isn't reaching into internals.
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const carolClient = await wireArchetype(server, carol.id);
    const frontier = await carolClient.queryFrontier({
      cause_id: cause.id,
      frontier_kind: 'needs_review',
    });
    expect(frontier.items).toHaveLength(0);

    // Reputation: hallucinator has no rep entry in the cause —
    // verification-rejected work neither earns nor loses rep, by
    // the same property that no proposal record was created.
    const bobRep = await bobClient.queryReputation({ cause_id: cause.id });
    expect(bobRep.entries).toEqual([]);
  });

  it('verifier accepts honest spans that appear in the configured source', async () => {
    // Symmetric check: with sources configured, a span that *does*
    // appear in the parent anchor's source passes verification and
    // the loop works as it did before. Without this, the
    // verifySpan path could be silently rejecting honest work and
    // the only signal would be a lower honest-strong throughput in
    // sweeps — caught here at the unit grain instead.
    const sources = new Map<string, string>([
      ['1', 'paper one says ctDNA detection precedes radiographic recurrence by months'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
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
        content: 'paper one',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(a.proposal_id);

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);

    // The span is a verbatim slice of the configured source.
    const provider: ContentProvider = {
      forAnchor: () => ({
        content: 'ctDNA detection precedes radiographic recurrence',
        quoted_span: {
          text: 'ctDNA detection precedes radiographic recurrence',
          offset: 0,
        },
      }),
    };

    const result = await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    expect(result.actions.filter((a) => a.kind === 'submitted')).toHaveLength(1);
    expect(
      [...server.store.proposals.values()].filter((p) => p.payload.kind === 'excerpt'),
    ).toHaveLength(1);
  });

  it('surfaces the strategic-coalition attack: bias flips both convergence and rep', async () => {
    // PRD adversary taxonomy line 306: a strategic adversary biases
    // the graph toward outcome X. Line 309: a coalition is N of them
    // sharing the bias. With pure-vote convergence and reputation
    // tracked against the converged outcome, a 2-of-3 coalition
    // wins both ledgers — the well-grounded honest excerpt is
    // suppressed AND the honest reviewer is punished for voting
    // honestly. This is the open attack surface PRD names; later
    // phases close it via calibration (line 304: "Lazy. Reviewer
    // that votes without reading. Should be caught by calibration")
    // by seeding batches with proposals of known ground truth, so
    // the strategic adversary's bias visibly diverges from the
    // calibrated outcome rather than just from honest reviewers'
    // votes. This test is the regression handle on the pre-
    // calibration state — a defense that closes the surface should
    // make this scenario fail.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
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

    // Bob is the honest proposer. Both excerpts are well-grounded:
    // verbatim spans from the source, content honestly summarizes
    // each finding. The system should treat both equivalently.
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);
    const provider: ContentProvider = {
      forAnchor: (anchorId) =>
        anchorId.endsWith('1') || anchorId.endsWith('a')
          ? {
              content: 'treatment X works for stage III',
              quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
            }
          : {
              content: 'treatment X has no effect for stage IV',
              quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
            },
    };
    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    // Erin is the honest reviewer — accepts well-grounded claims
    // regardless of finding direction. She runs first, voting on
    // both excerpts; neither converges yet (1 accept each, threshold
    // 2). Then the strategic coalition runs.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // The coalition shares one biased decider: accept findings that
    // claim treatment X works, reject findings that don't. Both
    // strategics see both excerpts (assignment is system-driven —
    // no pre-arrangement; the leverage is vote bias, not selection).
    const biased = payloadBiasedDecider({
      acceptIf: (payload) => 'content' in payload && payload.content.includes('works'),
      rationaleAccept: 'consistent with prevailing evidence',
      rationaleReject: 'underpowered, methodological concerns',
    });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, { cause_id: cause.id, rate: 5, decide: biased });
    await runHonestReviewer(daveClient, { cause_id: cause.id, rate: 5, decide: biased });

    // Convergence: excerpt-works gets 3 accepts (Erin + 2 strategics)
    // → accepted. Excerpt-no-effect gets 1 accept (Erin) + 2 rejects
    // (strategics) → rejected. The well-grounded "no effect" finding
    // is suppressed.
    const excerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerpts).toHaveLength(2);
    const works = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('works'),
    );
    const noEffect = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    expect(works?.status).toBe('accepted');
    expect(noEffect?.status).toBe('rejected');

    // Reputation: Erin is at zero net (+1 from the accepted "works",
    // -1 from the rejected "no-effect" because her accept was
    // inaccurate against the converged reject). Despite voting
    // honestly on both well-grounded excerpts, the system credits
    // her with nothing.
    const erinRep = await erinClient.queryReputation({ cause_id: cause.id });
    const erinScore = erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    expect(erinScore).toBe(0);

    // The strategic pair both come out positive — they voted with
    // the converged outcome on every excerpt they saw, so every
    // vote was "accurate." The coalition gained rep from suppressing
    // valid work.
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    const carolScore = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const daveScore = daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    expect(carolScore).toBeGreaterThan(0);
    expect(daveScore).toBeGreaterThan(0);

    // Materialization: only the bias-aligned excerpt has a node;
    // the suppressed one doesn't.
    const excerptNodes = [...server.store.nodes.values()].filter((n) => n.kind === 'excerpt');
    expect(excerptNodes).toHaveLength(1);
    expect(excerptNodes[0]?.content).toContain('works');
  });

  it('calibration injection costs the strategic coalition rep without preventing convergence subversion', async () => {
    // Companion to the strategic-coalition scenario above. Same setup
    // (two well-grounded excerpts, one honest reviewer + a 2-of-3
    // biased coalition); the only change is calibration injection
    // turned on at the server (every 2nd review-task offer is a
    // calibration item drawn from validated history). PRD line 203:
    // "Reviewers who fail calibration lose reputation" — this is the
    // mechanism the named defense relies on.
    //
    // The defense is honest about its scope: it does *not* prevent
    // the coalition from suppressing the bias-misaligned excerpt at
    // the convergence layer (only a 3rd honest reviewer, calibration-
    // aware vote weighting, or stratified assignment can do that).
    // What it does is cost the coalition reputation on calibration
    // items their bias misfires on, while crediting the honest
    // reviewer for honest acceptance. The rep ledger flips: the
    // honest reviewer ends strictly positive; the coalition's net
    // is no longer a clean win.
    //
    // The defense is also imperfect: a coalition member whose bias
    // happens to match a calibration item still passes (here, Dave
    // catches the just-converged "works" excerpt as calibration on
    // his second offer and accepts it, since "works" matches his
    // predicate). This is the calibration-aware adversary case PRD
    // line 281 names ("strategic adversary ... while passing
    // calibration"); patient/sweep variants are testbed work that
    // builds on this seam, not regressions of it.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: { calibration_inject_every_n: 2 },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
    // Two anchors, both curator-accepted. These are the initial
    // calibration corpus: payload content is "paper 1"/"paper 2",
    // which contains neither "works" nor "no effect" — so the
    // coalition's bias predicate ("includes 'works'") rejects both,
    // failing calibration on each.
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

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);
    const provider: ContentProvider = {
      forAnchor: (anchorId) =>
        anchorId.endsWith('1') || anchorId.endsWith('a')
          ? {
              content: 'treatment X works for stage III',
              quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
            }
          : {
              content: 'treatment X has no effect for stage IV',
              quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
            },
    };
    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    const biased = payloadBiasedDecider({
      acceptIf: (payload) => 'content' in payload && payload.content.includes('works'),
      rationaleAccept: 'consistent with prevailing evidence',
      rationaleReject: 'underpowered, methodological concerns',
    });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, { cause_id: cause.id, rate: 5, decide: biased });
    await runHonestReviewer(daveClient, { cause_id: cause.id, rate: 5, decide: biased });

    // Convergence still flips with the bias — calibration does not
    // close the convergence-layer surface, only the rep-ledger one.
    // This part of the assertion is the regression handle on the
    // open-attack scenario above: if a future change closes the
    // convergence vector too, this expectation should be updated
    // alongside.
    const excerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    const works = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('works'),
    );
    const noEffect = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    expect(works?.status).toBe('accepted');
    expect(noEffect?.status).toBe('rejected');

    const erinRep = await erinClient.queryReputation({ cause_id: cause.id });
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    const erinScore = erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const carolScore = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const daveScore = daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;

    // Headline inversion: in the no-calibration scenario above,
    // erinScore was 0 and the coalition was strictly positive on
    // both members. Here, the honest reviewer's calibration passes
    // give her a strictly positive score and dominate the lower of
    // the two coalition scores. Both halves of this expectation
    // are what calibration was added to do; together they're the
    // regression handle that says "the defense, where it bites,
    // bites in the right direction."
    expect(erinScore).toBeGreaterThan(0);
    expect(erinScore).toBeGreaterThan(Math.min(carolScore, daveScore));
  });

  it('calibration-aware convergence closes the strategic-coalition convergence half', async () => {
    // Sequel to the calibration-injection scenario above. Same setup
    // (two well-grounded excerpts, honest reviewer + 2-of-3 biased
    // coalition, calibration injected every 2nd review-task offer);
    // the only change is calibration_aware_convergence=true. The
    // convergence-layer half of the strategic-coalition vector — the
    // one calibration alone could not close — closes here: the
    // bias-misaligned "no effect" excerpt is no longer rejected,
    // because the coalition's calibration record went sour and their
    // votes carry zero weight at convergence time.
    //
    // What this defense does: a reviewer's per-(cause, sub-topic)
    // calibration record (passes minus fails) determines their vote
    // weight at convergence. Convergence requires both ≥ N distinct
    // reviewers AND ≥ N weighted sum on either side — so a coalition
    // member with a negative calibration record contributes 0 to the
    // weighted sum even when they contribute 1 to the distinct count.
    // They can hold a convergence open, but they cannot drive it.
    //
    // What this defense does not do: stop a calibration-aware
    // adversary that holds bias on real proposals while voting
    // ground-truth on calibration items (PRD line 281). That's an
    // open testbed target that builds on this seam, not a regression
    // of it.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
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

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);
    const provider: ContentProvider = {
      forAnchor: (anchorId) =>
        anchorId.endsWith('1') || anchorId.endsWith('a')
          ? {
              content: 'treatment X works for stage III',
              quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
            }
          : {
              content: 'treatment X has no effect for stage IV',
              quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
            },
    };
    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    // Erin runs first so she accumulates a positive calibration record
    // (acceptAllDecider passes every calibration item, which is the
    // ground-truth-correct vote since calibration items are accepted-
    // from-history). When the coalition arrives, Erin's vote weight
    // is already > 1.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    const biased = payloadBiasedDecider({
      acceptIf: (payload) => 'content' in payload && payload.content.includes('works'),
      rationaleAccept: 'consistent with prevailing evidence',
      rationaleReject: 'underpowered, methodological concerns',
    });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, { cause_id: cause.id, rate: 5, decide: biased });
    await runHonestReviewer(daveClient, { cause_id: cause.id, rate: 5, decide: biased });

    // Headline assertion: the bias-misaligned excerpt is no longer
    // rejected. It stays staged — the coalition can hold convergence
    // open, but cannot drive it past threshold once their calibration
    // record has dropped their weight to zero. The pre-defense
    // scenario above asserts `noEffect.status === 'rejected'`; this
    // is the regression handle that says the convergence half closed.
    const excerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerpts).toHaveLength(2);
    const works = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('works'),
    );
    const noEffect = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    // The bias-aligned "works" excerpt still converges to accepted —
    // it has Erin's high-weight accept plus a coalition accept, both
    // distinct, both positive-weight (Carol's first vote on works
    // happens before her calibration record has gone sour). The
    // defense isn't symmetric and isn't trying to be: well-grounded
    // claims that happen to align with bias are still well-grounded.
    expect(works?.status).toBe('accepted');
    // The bias-misaligned "no effect" excerpt stays staged.
    expect(noEffect?.status).toBe('staged');

    // Materialization follows: works has a node, no-effect doesn't
    // (it would only materialize on convergence to accepted).
    const excerptNodes = [...server.store.nodes.values()].filter((n) => n.kind === 'excerpt');
    expect(excerptNodes).toHaveLength(1);
    expect(excerptNodes[0]?.content).toContain('works');

    // Reputation ledger continues to bite the way the calibration-
    // injection scenario established: Erin strictly positive, both
    // coalition members strictly less than Erin. The convergence
    // defense compounds rather than replaces the rep-ledger one.
    const erinRep = await erinClient.queryReputation({ cause_id: cause.id });
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    const erinScore = erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const carolScore = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const daveScore = daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    expect(erinScore).toBeGreaterThan(0);
    expect(erinScore).toBeGreaterThan(carolScore);
    expect(erinScore).toBeGreaterThan(daveScore);
  });

  it('calibration-aware coalition bypasses both defenses (PRD line 281)', async () => {
    // The naive strategic-coalition tests above use a globally-applied
    // bias predicate ("accept iff content includes 'works'"), which
    // misfires on the paper-1 / paper-2 calibration corpus and gets
    // caught by both calibration defenses. PRD line 281 names the
    // realistic version of the archetype: "strategic adversary
    // ... while passing calibration." This test is the regression
    // handle for that vector.
    //
    // The trick is that a real strategic adversary's bias is narrow.
    // It only fires inside the contested topic; anything outside —
    // including, by construction, every item in the calibration corpus
    // (which is broader than any one adversary's agenda) — is voted
    // ground-truth-correctly. The adversary doesn't need to identify
    // calibration items at all, which is the property the
    // indistinguishability commitment (PRD §Calibration batches)
    // protects against. They just need to keep their bias zone
    // narrower than the calibration sampler's.
    //
    // Modeled here as a payload-biased decider whose predicate is
    // "accept anything outside the zone (no 'treatment' token) OR
    // anything in-zone-and-aligned (contains 'works')". The paper-1
    // / paper-2 calibration items pass the first clause; the works
    // excerpt passes the second; the no-effect excerpt fails both.
    //
    // Headline result: both defenses go quiet against this archetype.
    // The convergence layer still flips no-effect to rejected (the
    // coalition's calibration record stays clean, so their convergence
    // weights stay at full strength), and the rep ledger no longer
    // dominates honest reviewers — the coalition gains rep on every
    // calibration item AND on the bias-driven convergence outcomes.
    // This is the open testbed target the convergence-aware defense
    // commit's ROADMAP entry named.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
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

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);
    const provider: ContentProvider = {
      forAnchor: (anchorId) =>
        anchorId.endsWith('1') || anchorId.endsWith('a')
          ? {
              content: 'treatment X works for stage III',
              quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
            }
          : {
              content: 'treatment X has no effect for stage IV',
              quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
            },
    };
    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Zone-aware bias: accept everything outside the bias zone (no
    // 'treatment' token — captures the calibration corpus by
    // construction) OR aligned-and-in-zone. The second clause is the
    // bias proper; the first is what makes the adversary calibration-
    // aware without needing to identify calibration items.
    const calAwareBiased = payloadBiasedDecider({
      acceptIf: (payload) =>
        'content' in payload &&
        (!payload.content.includes('treatment') || payload.content.includes('works')),
      rationaleAccept: 'consistent with prevailing evidence',
      rationaleReject: 'underpowered, methodological concerns',
    });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiased,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiased,
    });

    // Convergence flips both ways: works to accepted, no-effect to
    // rejected. The calibration-aware convergence defense doesn't bite
    // because the coalition's calibration record stays at (passes>0,
    // fails=0), so their convergence weights are ≥ 1 and the weighted-
    // sum threshold is reached. Compare against the previous test,
    // where the same coalition's weights collapsed to 0 and no-effect
    // stayed staged. This is the regression handle on the open vector.
    const excerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    const works = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('works'),
    );
    const noEffect = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    expect(works?.status).toBe('accepted');
    expect(noEffect?.status).toBe('rejected');

    // Materialization mirrors the suppressed-excerpt baseline: only
    // the bias-aligned excerpt becomes a node.
    const excerptNodes = [...server.store.nodes.values()].filter((n) => n.kind === 'excerpt');
    expect(excerptNodes).toHaveLength(1);
    expect(excerptNodes[0]?.content).toContain('works');

    // Reputation: the coalition's rep dominance returns. Erin gets
    // +1 from works (accurate) and -1 from no-effect (inaccurate against
    // the converged reject), netting 0 from convergence; she still
    // accumulates calibration passes (accept-all is ground-truth on
    // every calibration item). The coalition gets +1 from each
    // converged outcome (both biased votes were "accurate" against
    // the bias-driven outcome) AND keeps its calibration passes
    // because narrow bias never fires on the calibration corpus.
    // So at least one coalition member's score is strictly above
    // Erin's. The honest-dominance property the prior commit
    // established does not hold against this archetype — the rep-
    // ledger half is also bypassed.
    const erinRep = await erinClient.queryReputation({ cause_id: cause.id });
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    const erinScore = erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const carolScore = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const daveScore = daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    expect(Math.max(carolScore, daveScore)).toBeGreaterThan(erinScore);
  });

  it('pool-size scaling closes the calibration-aware coalition with sufficient honest reviewers', async () => {
    // PRD line 195: convergence and divergence thresholds are claim-
    // class-aware; high-stakes classes draw larger pools and tighter
    // thresholds. The previous test surfaces the standing open vector:
    // a 2-of-3 calibration-aware coalition bypasses both calibration
    // defenses against a single honest reviewer at votes_to_X = 2.
    // This test is the regression handle on the pool-size lever:
    // raise votes_to_X to 3 and add a third and fourth honest
    // reviewer, and the same coalition can no longer drive a
    // bias-aligned suppression — the bias-misaligned excerpt
    // converges to accepted under honest-majority weight rather than
    // staying staged or flipping rejected.
    //
    // What the lever does: at threshold N, a coalition of size < N
    // cannot solo-drive a convergence on either side. The minimum
    // honest-reviewer count to beat a coalition of size K on the
    // suppression vector is K+1 — three honest votes outpace two
    // coalition rejects when the threshold is 3. This is the third-
    // honest-reviewer effect named in the convergence-aware-defense
    // commit's milestones.
    //
    // What the lever doesn't do: it doesn't help on small sub-topics
    // where the eligible pool can't furnish K+1 honest reviewers
    // (PRD line 311 names this directly — "how the regime degrades
    // on small sub-topics where the floor isn't reached"). And the
    // assignment-time stratification work that closes that
    // degradation is still the next defense target.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 3,
        votes_to_reject: 3,
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
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

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);
    const provider: ContentProvider = {
      forAnchor: (anchorId) =>
        anchorId.endsWith('1') || anchorId.endsWith('a')
          ? {
              content: 'treatment X works for stage III',
              quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
            }
          : {
              content: 'treatment X has no effect for stage IV',
              quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
            },
    };
    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt'],
      content: provider,
    });

    // Run the first honest reviewer. Then the coalition runs (so they
    // get to vote on real proposals before convergence happens). Then
    // the remaining honest reviewers, who carry the no-effect excerpt
    // past threshold despite the coalition's reject votes.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    const calAwareBiased = payloadBiasedDecider({
      acceptIf: (payload) =>
        'content' in payload &&
        (!payload.content.includes('treatment') || payload.content.includes('works')),
      rationaleAccept: 'consistent with prevailing evidence',
      rationaleReject: 'underpowered, methodological concerns',
    });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiased,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiased,
    });

    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const grace = server.bootstrap.mintIdentity({ display_name: 'grace' });
    const frankClient = await wireArchetype(server, frank.id);
    const graceClient = await wireArchetype(server, grace.id);
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(graceClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Headline: both excerpts converge to accepted. The coalition's
    // 2 reject votes on no-effect cannot drive convergence past the
    // threshold of 3, and the three honest accepts (erin + frank +
    // grace) carry no-effect to acceptance. Compare to the previous
    // test where the same coalition flipped no-effect to rejected.
    const excerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    const works = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('works'),
    );
    const noEffect = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    expect(works?.status).toBe('accepted');
    expect(noEffect?.status).toBe('accepted');

    // Both excerpts materialize as nodes. The previous test asserts
    // exactly one excerpt node (the bias-aligned one); this test
    // asserts the suppressed-excerpt baseline does not return.
    const excerptNodes = [...server.store.nodes.values()].filter((n) => n.kind === 'excerpt');
    expect(excerptNodes).toHaveLength(2);

    // Reputation: honest dominance restored. Erin votes accurately
    // on both convergences and accumulates calibration passes; the
    // coalition splits — accurate on works, inaccurate on no-effect.
    // The honest leader strictly dominates each coalition member.
    const erinRep = await erinClient.queryReputation({ cause_id: cause.id });
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    const erinScore = erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const carolScore = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    const daveScore = daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.score ?? 0;
    expect(erinScore).toBeGreaterThan(carolScore);
    expect(erinScore).toBeGreaterThan(daveScore);
  });

  it('stratification closes the calibration-aware coalition on the small-pool case', async () => {
    // The headline scenario stratification was committed for: a
    // calibration-aware coalition in a pool too small to furnish K+1
    // honest reviewers. The previous calibration-aware-coalition test
    // shows the bypass standing open at this pool size; this test
    // adds stratification_enabled and demonstrates the cross-stratum
    // draw rule closing the bias-suppression vector.
    //
    // The cluster signal is built first via priming reviews — three
    // bias-aligned excerpts that Carol and Dave both vote accept on,
    // accumulating shared-vote history. Erin does not vote on the
    // priming run (she stays a singleton stratum). After priming,
    // Carol and Dave fall in the same vote-pattern cluster. The
    // contested no-effect excerpt then comes up: Erin votes accept,
    // Carol pulls and votes reject, and Dave's request_assignment
    // skips the contested item by the cross-stratum draw rule —
    // Carol-already-routed plus Dave-co-stratum-with-Carol blocks
    // it. The proposal sits at one accept / one reject, below the
    // votes_to_reject=2 threshold, and stays staged. The bias
    // suppression closes against the same archetype that bypassed
    // the calibration defenses.
    //
    // This is the small-pool case the roadmap named: a 3-reviewer
    // pool can't furnish 3 honest reviewers (the K+1 honest defense
    // doesn't reach), but vote-pattern stratification still detects
    // the coalition's behavioral correlation and routes the second
    // coalition member away from the contested slot.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        // Calibration injection off here — the headline is the cross-
        // stratum draw, not the calibration channel. Layered defenses
        // compound elsewhere in the suite (e.g. pool-size scaling).
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
        // Lower min_shared so 3 priming proposals are enough to form
        // an edge. Production tuning is testbed-swept; this value is
        // chosen for a tractable test fixture, not as a recommended
        // default.
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
    const aliceCaller = { identity_id: alice.id };

    // Anchor under paper 1 — the priming excerpts hang off this
    // anchor, all citing the same span so the FakeVerifier accepts.
    const anchor1 = await server.tools.proposeAnchor(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'paper 1',
      external_ref: { kind: 'pmid', value: '1' },
    });
    server.curator.acceptProposal(anchor1.proposal_id);
    const anchor1Node = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper 1',
    );
    if (!anchor1Node) throw new Error('paper 1 anchor not materialized');
    const anchor2 = await server.tools.proposeAnchor(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'paper 2',
      external_ref: { kind: 'pmid', value: '2' },
    });
    server.curator.acceptProposal(anchor2.proposal_id);
    const anchor2Node = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper 2',
    );
    if (!anchor2Node) throw new Error('paper 2 anchor not materialized');

    // Reviewer identities + capacity. Erin honest, Carol/Dave coalition.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erinClient = await wireArchetype(server, erin.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    for (const c of [{ identity_id: carol.id }, { identity_id: dave.id }]) {
      await server.tools.setCapacity(c, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });
    }

    // PRIMING: three bias-aligned excerpts. Carol and Dave both vote
    // accept on each via direct cast_review_vote — bypassing the
    // assignment loop so the priming step doesn't itself trigger
    // cross-stratum routing decisions. The first priming excerpt
    // auto-converges (cluster signal not yet formed at the time of
    // its tally); the second and third would otherwise stay staged
    // because the freshly-formed cluster collapses the pool to a
    // single stratum and stratification-degraded tightens the
    // threshold past their two accepts. Curator-accepting them
    // takes them out of the frontier so the archetype phase below
    // sees only the contested item and the priming votes still
    // inform clustering.
    for (let i = 0; i < 3; i++) {
      const excerpt = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }

    // CONTESTED: the no-effect excerpt under paper 2 — the proposal
    // the coalition wants to suppress.
    const contested = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchor2Node.id,
      content: 'treatment X has no effect for stage IV',
      quoted_span: {
        text: 'treatment X has no effect in stage IV patients',
        offset: 0,
      },
    });

    // ARCHETYPE PHASE.
    //
    // Erin runs first. She's a singleton stratum (no votes in scope
    // until she casts on the contested item). She accepts the
    // contested item via the assignment loop — 1 accept on contested.
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Carol runs next. The cluster signal is now established: she
    // and Dave share three accepts on priming excerpts, agreement
    // ratio 1.0, above threshold. Carol's stratum equals Dave's.
    // Erin (singleton) is already routed to the contested item but
    // singleton:erin != Carol's cluster id, so cross-stratum check
    // passes for Carol. She picks up the contested item and votes
    // reject under the calibration-aware bias predicate.
    const calAwareBiased = payloadBiasedDecider({
      acceptIf: (payload) =>
        'content' in payload &&
        (!payload.content.includes('treatment') || payload.content.includes('works')),
      rationaleAccept: 'consistent with prevailing evidence',
      rationaleReject: 'underpowered, methodological concerns',
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiased,
    });

    // Dave runs last. The contested item is the only staged review
    // task in the frontier (priming proposals are accepted; Erin and
    // Carol have already voted). Dave's stratum matches Carol's;
    // Carol-already-routed-to-contested triggers the cross-stratum
    // skip. With no other eligible task, Dave's request_assignment
    // surfaces not_found and the archetype idles.
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiased,
    });

    // HEADLINE: contested stays staged. Without stratification (see
    // calibration-aware-coalition test) the same archetype drives
    // it to rejected at votes_to_reject=2. With stratification on,
    // Dave is blocked from voting, the tally is 1 accept (Erin) and
    // 1 reject (Carol), and the bias-suppression vector closes.
    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('staged');

    // The contested excerpt does not materialize as a node — it
    // hasn't been accepted, just held open against suppression.
    const noEffectNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'excerpt' && n.content.includes('no effect'),
    );
    expect(noEffectNode).toBeUndefined();

    // Dave never voted on the contested excerpt. Vote roster on the
    // contested proposal: Erin (accept), Carol (reject). One each.
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(2);
    expect(contestedVotes.map((v) => v.reviewer_id).sort()).toEqual([carol.id, erin.id].sort());
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
