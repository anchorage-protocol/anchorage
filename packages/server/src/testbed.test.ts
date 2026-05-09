import {
  AnchorageClient,
  acceptAllDecider,
  type ContentProvider,
  type HallucinationFabricator,
  payloadBiasedDecider,
  payloadDecliningDecider,
  rejectAllDecider,
  runHallucinator,
  runHonestReviewer,
  runHonestStrong,
  runHonestWeak,
} from '@anchorage/testbed';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
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

// Strategic-adversary deciders shared across the (cause "CRC", sub-
// topic "treatment-X") fixture used by every coalition / cluster /
// patient-adversary scenario in this file. Two flavors of the same
// hidden objective ("bias toward 'treatment X works' findings,
// against 'treatment X has no effect' findings"):
//
//   - naiveBiasedDecider applies the bias to every payload. It
//     misfires on the anchor calibration corpus (anchor content
//     "paper N" doesn't include "works" → reject → fail
//     calibration), which is the seam the calibration defenses
//     exploit. PRD §Adversary taxonomy (Strategic adversary)
//     baseline.
//   - calAwareBiasedDecider scopes the bias zone to payloads that
//     mention "treatment", accepting anything else by construction.
//     The anchor calibration corpus falls outside the bias zone
//     and is accepted; calibration passes. PRD §Adversary
//     taxonomy (Strategic adversary, "passing calibration") +
//     PRD §Calibration batches (calibration-aware bypass case).
//
// Hoisted here because they are byte-identical across every
// coalition / cluster / patient-adversary scenario in this file —
// the alternative (re-declaring inside each `it`) drifts the moment
// one copy is edited and the others aren't.
const naiveBiasedDecider = payloadBiasedDecider({
  acceptIf: (payload) => 'content' in payload && payload.content.includes('works'),
  rationaleAccept: 'consistent with prevailing evidence',
  rationaleReject: 'underpowered, methodological concerns',
});
const calAwareBiasedDecider = payloadBiasedDecider({
  acceptIf: (payload) =>
    'content' in payload &&
    (!payload.content.includes('treatment') || payload.content.includes('works')),
  rationaleAccept: 'consistent with prevailing evidence',
  rationaleReject: 'underpowered, methodological concerns',
});

describe('testbed: synthetic populations against the wired surface', () => {
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

    // Bob's excerpt was assignment-driven, so full weight: +1. Default
    // half-lives are Infinity so demonstrated and recent both equal
    // the cumulative bump.
    const bobRep = await bobClient.queryReputation({ cause_id: cause.id });
    expect(bobRep.entries).toEqual([{ sub_topic_id: subTopic.id, demonstrated: 1, recent: 1 }]);
    // Carol and Dave each voted with the converged outcome → +1.
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    expect(carolRep.entries).toEqual([{ sub_topic_id: subTopic.id, demonstrated: 1, recent: 1 }]);
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    expect(daveRep.entries).toEqual([{ sub_topic_id: subTopic.id, demonstrated: 1, recent: 1 }]);
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
    expect(lazyRep.entries).toEqual([{ sub_topic_id: subTopic.id, demonstrated: -1, recent: -1 }]);
    const honest1Rep = await honest1Client.queryReputation({ cause_id: cause.id });
    expect(honest1Rep.entries).toEqual([{ sub_topic_id: subTopic.id, demonstrated: 1, recent: 1 }]);
    const honest2Rep = await honest2Client.queryReputation({ cause_id: cause.id });
    expect(honest2Rep.entries).toEqual([{ sub_topic_id: subTopic.id, demonstrated: 1, recent: 1 }]);
  });

  it('catches the hallucinator at the verifier, before reviewers see anything', async () => {
    // PRD §Adversary taxonomy (Hallucinator): hallucinated submissions
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

  it('honest-weak archetype: friction rate matches the configured weak fraction', async () => {
    // PRD §Adversary taxonomy (Honest-weak): "modest-capability honest
    // contributor (e.g. small local model). Should largely succeed;
    // failure-to-contribute rate measures friction." This test pins
    // the friction measurement: the fraction of attempts the verifier
    // refuses is observable in the action log, and matches the
    // fraction the content provider models as weak.
    //
    // Setup: eight anchors, sources configured for all eight. The
    // content provider returns verifying spans for six and near-but-
    // wrong spans (text not in the corresponding source) for two —
    // simulating a smaller model that mostly grounds correctly but
    // occasionally produces a span the source doesn't actually
    // contain. Honest-weak's loop catches the verifier rejection,
    // records `submit_rejected`, and continues.
    //
    // The two failures are not adversarial. Hallucinator produces
    // zero verifying submissions; honest-strong produces only
    // verifying submissions; honest-weak sits between them, and the
    // gap *is* the friction the regime imposes on weaker contributors.
    const sources = new Map<string, string>();
    for (let i = 1; i <= 8; i++) {
      sources.set(String(i), `paper ${i} verifying span unique to source ${i}`);
    }
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('w'),
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
    // Capture node IDs in creation order so the content provider can
    // mark specific anchors as "weak-spot" by index without depending
    // on id-gen seeds.
    const anchorIds: string[] = [];
    for (let i = 1; i <= 8; i++) {
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
      const node = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
      );
      if (!node) throw new Error(`paper ${i} anchor not materialized`);
      anchorIds.push(node.id);
    }
    // Two of eight anchors get wrong spans — deterministic 25%
    // friction. Indices 1 and 5 picked arbitrarily; any pair works.
    const weakSpots = new Set([anchorIds[1], anchorIds[5]]);
    const provider: ContentProvider = {
      forAnchor: (anchorId) => {
        // PMID is recoverable from creation index since the test
        // built them in order; the verifier matches against PMID's
        // configured source text.
        const idx = anchorIds.indexOf(anchorId);
        if (idx < 0) return null;
        const pmid = String(idx + 1);
        if (weakSpots.has(anchorId)) {
          return {
            content: `weak-model paraphrase for paper ${pmid}`,
            quoted_span: {
              text: 'span the small model thought was verbatim but is not',
              offset: 0,
            },
          };
        }
        return {
          content: `paraphrase for paper ${pmid}`,
          quoted_span: {
            text: `paper ${pmid} verifying span unique to source ${pmid}`,
            offset: 0,
          },
        };
      },
    };

    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);

    const result = await runHonestWeak(bobClient, {
      cause_id: cause.id,
      rate: 10,
      kinds: ['excerpt'],
      content: provider,
    });

    const submitted = result.actions.filter((a) => a.kind === 'submitted');
    const rejected = result.actions.filter((a) => a.kind === 'submit_rejected');
    expect(submitted).toHaveLength(6);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((a) => a.kind === 'submit_rejected' && a.code === 'invalid_input')).toBe(
      true,
    );
    // Friction rate observable from the log alone: 2/8 = 0.25.
    const total = submitted.length + rejected.length;
    expect(rejected.length / total).toBe(0.25);

    // Server-side cross-check: exactly six excerpt proposals exist —
    // the verifier prevented the other two from materializing, just
    // as it does for the hallucinator. The cost is structurally the
    // same; the difference is intent and fraction.
    const excerptProposals = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerptProposals).toHaveLength(6);

    // Reputation: honest-weak earns nothing from rejected submits
    // (no proposal record means no review, means no rep settlement).
    // Successful submits don't earn rep until they converge through
    // review either, so at this point the contributor's rep is
    // empty — friction is the only signal so far.
    const bobRep = await bobClient.queryReputation({ cause_id: cause.id });
    expect(bobRep.entries).toEqual([]);
  });

  it('surfaces the strategic-coalition attack: bias flips both convergence and rep', async () => {
    // PRD §Adversary taxonomy (Strategic adversary): a strategic
    // adversary biases the graph toward outcome X. The Coalition
    // bullet in the same section: a coalition is N of them sharing
    // the bias. With pure-vote convergence and reputation tracked
    // against the converged outcome, a 2-of-3 coalition wins both
    // ledgers — the well-grounded honest excerpt is suppressed AND
    // the honest reviewer is punished for voting honestly. This is
    // the open attack surface PRD names; later phases close it via
    // calibration (the Lazy bullet in the same section: "votes
    // without reading. Should be caught by calibration")
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
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: naiveBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: naiveBiasedDecider,
    });

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
    const erinScore =
      erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    expect(erinScore).toBe(0);

    // The strategic pair both come out positive — they voted with
    // the converged outcome on every excerpt they saw, so every
    // vote was "accurate." The coalition gained rep from suppressing
    // valid work.
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    const daveRep = await daveClient.queryReputation({ cause_id: cause.id });
    const carolScore =
      carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const daveScore =
      daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
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
    // calibration item drawn from validated history). PRD
    // §Calibration batches: "Reviewers who fail calibration lose
    // reputation" — this is the
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
    // §Adversary taxonomy (Strategic adversary) names ("hidden-
    // objective model — instructed to bias the graph toward outcome
    // X while passing calibration"); patient/sweep variants are
    // testbed work that
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

    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: naiveBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: naiveBiasedDecider,
    });

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
    const erinScore =
      erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const carolScore =
      carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const daveScore =
      daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;

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
    // ground-truth on calibration items (PRD §Adversary taxonomy,
    // Strategic adversary). That's an
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

    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: naiveBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: naiveBiasedDecider,
    });

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
    const erinScore =
      erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const carolScore =
      carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const daveScore =
      daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    expect(erinScore).toBeGreaterThan(0);
    expect(erinScore).toBeGreaterThan(carolScore);
    expect(erinScore).toBeGreaterThan(daveScore);
  });

  it('calibration-aware coalition bypasses both defenses (PRD §Adversary taxonomy, Strategic adversary)', async () => {
    // The naive strategic-coalition tests above use a globally-applied
    // bias predicate ("accept iff content includes 'works'"), which
    // misfires on the paper-1 / paper-2 calibration corpus and gets
    // caught by both calibration defenses. PRD §Adversary taxonomy
    // (Strategic adversary) names the realistic version of the
    // archetype: "instructed to bias the graph toward outcome X
    // while passing calibration." This test is the regression
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
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
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
    const erinScore =
      erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const carolScore =
      carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const daveScore =
      daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    expect(Math.max(carolScore, daveScore)).toBeGreaterThan(erinScore);
  });

  it('pool-size scaling closes the calibration-aware coalition with sufficient honest reviewers', async () => {
    // PRD §Reviewer assignment: convergence and divergence
    // thresholds are claim-class-aware; high-stakes classes draw
    // larger pools and tighter thresholds. The previous test
    // surfaces the standing open vector:
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
    // (PRD §Adversary taxonomy, Coalition bullet — "how the regime
    // degrades on small sub-topics where the floor isn't reached").
    // And the
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

    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
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
    const erinScore =
      erinRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const carolScore =
      carolRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
    const daveScore =
      daveRep.entries.find((e) => e.sub_topic_id === subTopic.id)?.demonstrated ?? 0;
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
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
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
      decide: calAwareBiasedDecider,
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

  it('sybil-amplified coalition: a fresh recruit slips past stratification when an established member is gated out', async () => {
    // PRD §Adversary taxonomy (Sybil farm + Coalition): the
    // existing scenarios cover each half — sybil flood capacity,
    // coalition coordinate vote bias. This is the hybrid the v0
    // defenses do not catch: a known coalition (Carol+Dave with
    // shared priming history that the cluster signal has detected)
    // recruits a third identity (Eve) with no prior history. Eve is
    // structurally indistinguishable from an honest newcomer at the
    // cluster signal — co-occurrence is empty for her, so she sits
    // in a singleton stratum just like any first-time reviewer.
    //
    // Setup mirrors the stratification-closes-coalition scenario
    // above: same priming run on three bias-aligned excerpts so
    // Carol and Dave's pairwise agreement reaches the cluster
    // threshold; same single contested no-effect target. The
    // additions are (a) Eve, a fresh sybil with the same calibration-
    // aware biased predicate, no priming votes, and (b) a smaller
    // honest pool relative to the biased count. The stratification
    // gate fires correctly against Dave (Carol-already-routed +
    // Carol-Dave-co-stratum) but Eve has no co-stratum link; the
    // gate has nothing to enforce against her, and she walks in.
    //
    // Outcome: Carol and Eve both vote reject; the contested
    // proposal hits votes_to_reject = 2 before the second honest
    // accept lands. The composition didn't fail — it performed
    // exactly as designed against the coalition the system has
    // observed (Carol+Dave). The seam is that adding identities to
    // the coalition costs the operator nothing in v0 — PRD
    // §Identity names identity-binding cost, rate-limited issuance,
    // and global anti-abuse signals as the load-bearing defenses,
    // and none of those are wired. The defense lives at a layer
    // below the testbed surface; this scenario is the regression
    // handle that says behavior-dependent defenses cannot close it
    // alone.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('s'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        // Same stratification config as the small-pool-closes test
        // above. The headline is freshness, not the cluster knobs.
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
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

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const eve = server.bootstrap.mintIdentity({ display_name: 'eve' });
    const erinClient = await wireArchetype(server, erin.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    const eveClient = await wireArchetype(server, eve.id);
    for (const c of [
      { identity_id: carol.id },
      { identity_id: dave.id },
      { identity_id: eve.id },
    ]) {
      await server.tools.setCapacity(c, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });
    }

    // Priming: Carol and Dave both vote accept on three bias-aligned
    // excerpts, same shape as the stratification-closes-coalition
    // test. Eve does not vote — she stays a fresh identity with no
    // history, the property the attack hinges on.
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

    // Erin first (1 accept). Carol next (1 reject) — Carol gets
    // routed to contested because Erin's singleton-erin stratum
    // doesn't match her cluster. Dave next — cross-stratum gate
    // fires correctly: Carol is already routed to contested and
    // Dave is co-stratum with Carol, so request_assignment skips
    // the contested item and Dave idles. Then Eve runs as the
    // fresh recruit. Her stratum is singleton-eve (no votes
    // anywhere in scope); singleton-eve is distinct from Carol's
    // cluster, so the gate has no edge to enforce. Eve picks up
    // contested and votes reject. Reject count hits 2, weight
    // hits 2 (calibration-aware-convergence is off here so weight
    // = count by construction), and the contested target flips.
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(eveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('rejected');

    // Dave never voted (gated out). Carol and Eve both voted reject;
    // Erin voted accept. The contested proposal carries three votes,
    // not four — the gate did its job against the known coalition
    // member but had nothing to do against the fresh recruit.
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(3);
    expect(contestedVotes.map((v) => v.reviewer_id).sort()).toEqual(
      [carol.id, erin.id, eve.id].sort(),
    );
    const daveVotedOnContested = contestedVotes.some((v) => v.reviewer_id === dave.id);
    expect(daveVotedOnContested).toBe(false);
  });

  it('vote-decorrelating coalition stays in distinct strata and bypasses v0 stratification', async () => {
    // Companion to the stratification-closes test above. Same pool
    // shape (Erin honest, Carol+Dave coalition with the same bias
    // predicate) and same stratification config; the only change is
    // the coalition's adaptation. Instead of voting alike on priming,
    // Carol and Dave deliberately disagree on every non-bias-zone
    // proposal — one accepts, the other rejects. Their pairwise
    // agreement on shared proposals collapses to 0/N, well below the
    // 1.0 threshold, so no cluster edge forms. They sit in singleton
    // strata, indistinguishable to the v0 cluster primitive from two
    // independent reviewers who happen to disagree about routine
    // calls.
    //
    // Once the cluster signal fails to form, the cross-stratum draw
    // rule has nothing to enforce: when Dave requests an assignment,
    // his singleton stratum is not equal to Carol's singleton stratum,
    // so the routedReviewers check passes and Dave gets routed onto
    // the contested item alongside Carol. Both vote reject under the
    // shared bias predicate. With Erin's lone accept, the tally hits
    // votes_to_reject=2 and the bias-suppression vector closes —
    // against a defense that, with naive coalitions, did close the
    // small-pool case.
    //
    // The headline is that the contested excerpt is *rejected*, not
    // staged. This is the open seam the next testbed target works on:
    // the v0 cluster signal is co-occurrence-based and lossy. A
    // richer signal — weighting shared proposals by contention,
    // mixing in calibration-item agreement, or building strata from
    // payload-feature vote patterns — is what closes the
    // decorrelation bypass. Naming it as a failing-by-design test
    // anchors the seam.
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
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
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

    // PRIMING: three bias-aligned excerpts. Carol accepts, Dave
    // rejects on each — the decorrelation move. Direct cast_review_
    // vote bypasses the assignment selector so the priming step
    // doesn't itself trigger cross-stratum decisions, mirroring the
    // closes-stratification test's setup. After three priming
    // proposals: Carol+Dave share three votes, agree on zero. Below
    // threshold 1.0; no cluster edge.
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
          rationale: 'consistent with my read of the literature',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: 'reject',
          rationale: 'underpowered, methodological concerns',
        },
      );
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }

    // CONTESTED: the no-effect excerpt the coalition wants to suppress.
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
    // Erin runs first (singleton stratum, accepts the contested item).
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Carol runs next under the calibration-aware bias predicate —
    // identical to the predicate the closes-stratification test uses.
    // The cluster signal failed to form; Carol is a singleton. She
    // pulls the contested item and votes reject.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    // Dave runs last. In the closes-stratification scenario Dave's
    // stratum equalled Carol's and the cross-stratum check skipped
    // him. Here Carol's vote-history disagreement keeps her in
    // singleton:carol while Dave is singleton:dave; the strata
    // differ, the cross-stratum check passes, and Dave is routed
    // onto the contested item.
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    // HEADLINE: the contested excerpt is rejected. Tally hits
    // votes_to_reject=2 (Carol + Dave). Suppression succeeds — the
    // v0 stratification primitive does not catch a coalition that
    // budgets disagreement on non-bias-zone proposals.
    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('rejected');

    // Vote roster on the contested proposal: Erin accept, Carol +
    // Dave reject. All three reviewers got a slot — the cross-stratum
    // gate didn't fire because the cluster failed to form.
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(3);
    const erinVote = contestedVotes.find((v) => v.reviewer_id === erin.id);
    const carolVote = contestedVotes.find((v) => v.reviewer_id === carol.id);
    const daveVote = contestedVotes.find((v) => v.reviewer_id === dave.id);
    expect(erinVote?.decision).toBe('accept');
    expect(carolVote?.decision).toBe('reject');
    expect(daveVote?.decision).toBe('reject');
  });

  it('raw cluster primitive over-aggregates: unanimous-priming honest pool collapses into one stratum', async () => {
    // The v0 cluster primitive (vote-pattern co-occurrence with raw
    // agreement ratio) has a failure mode the decorrelating-coalition
    // test surfaces by negation: when honest reviewers happen to share
    // a unanimous priming history, raw 100%-agreement pulls them all
    // into one cluster, the cross-stratum draw rule fires against
    // them, and only one of them can vote on a contested item.
    // Coalition members who *avoided* the priming sit in singleton
    // strata and walk through the gate the honest reviewers got
    // locked out of — so the pathology actively favors the coalition.
    //
    // Setup: 3 honest reviewers (Erin, Frank, Gina) accumulate
    // shared accept-history on 3 "works" priming proposals via
    // direct cast_review_vote (the same priming pattern the
    // stratification-closes-coalition test uses) and the curator
    // accepts those proposals to clear them from the frontier.
    // Carol+Dave (coalition, shared bias predicate suppressing "no
    // effect" findings) sit out priming entirely — a one-line
    // adversary adaptation. Then the contested no-effect excerpt
    // comes up via the assignment loop. Erin pulls and votes accept;
    // Frank and Gina request assignments but get blocked by the
    // cross-stratum check (they're co-stratum with already-voted
    // Erin); Carol and Dave pull through (singletons) and both vote
    // reject. Tally lands at 1 accept / 2 rejects, hits
    // votes_to_reject=2, contested converges to rejected. The
    // companion test below demonstrates contention-weighted edges
    // closing this seam.
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
        votes_to_reject: 2,
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        stratum_contention_weighted: false,
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

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const gina = server.bootstrap.mintIdentity({ display_name: 'gina' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erinClient = await wireArchetype(server, erin.id);
    const frankClient = await wireArchetype(server, frank.id);
    const ginaClient = await wireArchetype(server, gina.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    for (const c of [
      { identity_id: erin.id },
      { identity_id: frank.id },
      { identity_id: gina.id },
      { identity_id: carol.id },
      { identity_id: dave.id },
    ]) {
      await server.tools.setCapacity(c, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });
    }

    // PRIMING. Three "works" proposals; Erin, Frank, Gina each
    // direct-cast accept on each. Direct cast bypasses the
    // assignment selector so the cluster signal accumulates without
    // triggering cross-stratum routing or stratification-degraded
    // tightening mid-priming. Curator-accepts any that linger
    // staged. Same pattern as the stratification-closes-coalition
    // test.
    for (let i = 0; i < 3; i++) {
      const excerpt = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      for (const r of [erin.id, frank.id, gina.id]) {
        await server.tools.castReviewVote(
          { identity_id: r },
          {
            proposal_id: excerpt.proposal_id,
            decision: 'accept',
            rationale: 'spot-checked, looks correct',
          },
        );
      }
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }

    // CONTESTED: the no-effect excerpt the coalition wants to suppress.
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

    // CONTESTED PHASE.
    // Erin runs first — her pair-edges with Frank and Gina from
    // priming put her squarely in cluster-EFG. She's first to the
    // contested slot, so the cross-stratum gate doesn't have anyone
    // routed yet to compare against, and her accept lands.
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    // Frank and Gina now hit the cross-stratum gate: Erin (already
    // voted, in routedReviewers) is co-stratum, so request_assignment
    // skips the contested item for them. They idle without voting.
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(ginaClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    // Carol and Dave (singletons — never voted on priming) walk
    // through. Both reject under the bias predicate.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    // HEADLINE: contested converges *rejected*. The honest pool's
    // shared priming history overaggregated them into one cluster,
    // the cross-stratum gate locked the majority of them out, and
    // the coalition collected the votes_to_reject=2 majority on its
    // own. Bias suppression succeeds — not via direct attack on the
    // diversity defense, but as a side effect of the raw cluster
    // primitive treating unanimous-easy agreement as coalition signal.
    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('rejected');
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(3);
    const erinVote = contestedVotes.find((v) => v.reviewer_id === erin.id);
    const frankVote = contestedVotes.find((v) => v.reviewer_id === frank.id);
    const ginaVote = contestedVotes.find((v) => v.reviewer_id === gina.id);
    const carolVote = contestedVotes.find((v) => v.reviewer_id === carol.id);
    const daveVote = contestedVotes.find((v) => v.reviewer_id === dave.id);
    expect(erinVote?.decision).toBe('accept');
    expect(frankVote).toBeUndefined();
    expect(ginaVote).toBeUndefined();
    expect(carolVote?.decision).toBe('reject');
    expect(daveVote?.decision).toBe('reject');
  });

  it('contention-weighted clustering keeps unanimous-priming pool in distinct strata, restoring honest review flow', async () => {
    // Companion to the over-aggregation test above. Identical setup
    // — same 5-reviewer pool, same 3 unanimous priming proposals,
    // same contested no-effect excerpt, same coalition predicate.
    // The only change is `stratum_contention_weighted: true`. With
    // contention weighting, each unanimous priming proposal carries
    // 0 weight (`2 * min(accepts, rejects) / total = 0`), the
    // weighted shared-history sum collapses to 0 for every pair, no
    // edges form, and all 5 reviewers sit in singleton strata.
    //
    // The cross-stratum gate then has nothing to enforce. Erin,
    // Frank, and Gina all walk through it on the contested slot;
    // their three accepts hit votes_to_accept=3 before the coalition
    // can vote, and the contested excerpt converges accepted. The
    // coalition's request_assignment surfaces not_found by the time
    // they run — the proposal is no longer staged.
    //
    // Headline: contention-weighting closes the over-aggregation
    // pathology without giving up the cluster signal where it
    // matters. A pair whose shared history sits entirely on
    // unanimous-easy proposals carries no edge weight; a pair whose
    // shared history includes contentious proposals where they
    // co-voted does, and that's the signal the clustering primitive
    // is actually trying to capture. The decorrelating-coalition
    // bypass remains open — that vector is named separately and is
    // the next testbed target on this seam.
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
        votes_to_reject: 2,
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        stratum_contention_weighted: true,
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

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const gina = server.bootstrap.mintIdentity({ display_name: 'gina' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erinClient = await wireArchetype(server, erin.id);
    const frankClient = await wireArchetype(server, frank.id);
    const ginaClient = await wireArchetype(server, gina.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    for (const c of [
      { identity_id: erin.id },
      { identity_id: frank.id },
      { identity_id: gina.id },
      { identity_id: carol.id },
      { identity_id: dave.id },
    ]) {
      await server.tools.setCapacity(c, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });
    }

    for (let i = 0; i < 3; i++) {
      const excerpt = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      for (const r of [erin.id, frank.id, gina.id]) {
        await server.tools.castReviewVote(
          { identity_id: r },
          {
            proposal_id: excerpt.proposal_id,
            decision: 'accept',
            rationale: 'spot-checked, looks correct',
          },
        );
      }
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }

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

    // Honest reviewers run first. Each is a singleton under
    // contention-weighted clustering (priming carries 0 weight,
    // 0 edges, 0 cluster aggregation). Three accepts in a row reach
    // votes_to_accept=3 and the proposal converges accepted before
    // the coalition has a chance to vote.
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(ginaClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    // Coalition runs — but contested is no longer staged.
    // request_assignment surfaces not_found and they idle.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('accepted');
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(3);
    expect(contestedVotes.map((v) => v.reviewer_id).sort()).toEqual(
      [erin.id, frank.id, gina.id].sort(),
    );
    expect(contestedVotes.every((v) => v.decision === 'accept')).toBe(true);
  });

  it('anti-correlation detection closes the decorrelating-coalition bypass', async () => {
    // Companion to the vote-decorrelating-coalition test above. Same
    // 3-reviewer pool (Erin honest, Carol+Dave coalition that
    // disagrees on every priming proposal), same calibration-aware
    // bias predicate, same contested no-effect excerpt. The only
    // change is `stratum_anti_correlation_threshold: 1.0`.
    //
    // The decorrelating coalition's signal is unmistakable in the
    // anti-correlation channel: 3 shared priming proposals, 0 agreed
    // — the disagreement ratio is 1.0, exactly what perfect
    // decorrelation looks like. Treating that as a co-stratum edge
    // pulls Carol+Dave into one cluster despite zero positive
    // correlation. The cross-stratum draw rule then fires against
    // the coalition: when Dave requests an assignment after Carol
    // has voted on the contested item, Dave's stratum equals
    // Carol's, the gate trips, and Dave is routed away.
    //
    // Headline: contested stays staged. The tally lands at 1 accept
    // (Erin) + 1 reject (Carol), neither threshold reached, and the
    // bias-suppression vector closes. Anti-correlation as a separate
    // cue catches what the positive-only co-occurrence primitive
    // can't.
    //
    // Cost / failure mode: anti-correlation will produce false
    // positives if two honest reviewers happen to systematically
    // disagree on shared proposals. The threshold is testbed-tuned;
    // 1.0 (perfect decorrelation only) is the cleanest defense
    // against the strict coalition variant; weaker thresholds
    // catch noisier adversaries at the cost of admitting more
    // honest false positives. The next testbed target on this seam
    // is a coalition that mixes some agreement *and* some
    // disagreement on non-bias-zone proposals, sitting in the gap
    // between the two thresholds.
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
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        stratum_anti_correlation_threshold: 1.0,
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

    // PRIMING with decorrelation: Carol accepts, Dave rejects on
    // each — exactly the move that defeated the positive-only
    // cluster primitive. Now anti-correlation fires.
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
          rationale: 'consistent with my read of the literature',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: 'reject',
          rationale: 'underpowered, methodological concerns',
        },
      );
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }

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

    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Carol runs. Anti-correlation edge has formed (3 shared, 0
    // agreed → disagreement ratio 1.0 ≥ threshold 1.0). Carol and
    // Dave are now in the same cluster. Carol pulls the contested
    // item (Erin singleton, no co-stratum routed yet) and votes
    // reject.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    // Dave runs. Carol's vote put Carol in routedReviewers; Dave's
    // stratum equals Carol's via the anti-correlation edge; the
    // cross-stratum gate trips and Dave is routed away from the
    // contested slot. He idles.
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('staged');
    const noEffectNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'excerpt' && n.content.includes('no effect'),
    );
    expect(noEffectNode).toBeUndefined();
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(2);
    expect(contestedVotes.map((v) => v.reviewer_id).sort()).toEqual([carol.id, erin.id].sort());
    const erinVote = contestedVotes.find((v) => v.reviewer_id === erin.id);
    const carolVote = contestedVotes.find((v) => v.reviewer_id === carol.id);
    expect(erinVote?.decision).toBe('accept');
    expect(carolVote?.decision).toBe('reject');
  });

  it('mixed-strategy coalition exploits the gap between agreement and anti-correlation thresholds', async () => {
    // The natural adaptation against the agreement+anti-correlation
    // pair of cluster signals: don't agree on every shared proposal
    // (defeats agreement), don't disagree on every shared proposal
    // either (defeats anti-correlation). Mix. With both thresholds
    // at 1.0, any non-perfect mix sits below both and evades the
    // cluster primitive entirely.
    //
    // The coalition needs to *look like* two reviewers who happen to
    // disagree some of the time and agree some of the time — the
    // statistical signature of two mostly-independent reviewers.
    // Fifty-fifty agreement on shared priming (2 agreed, 2 disagreed
    // out of 4) lights up neither metric at threshold 1.0. The pair
    // holds singleton strata, the cross-stratum draw rule has nothing
    // to enforce, and both members vote on the contested item.
    //
    // Headline: contested converges *rejected*. The bias-suppression
    // vector reopens against the v0 stratification regime, including
    // its anti-correlation refinement. Closing this gap requires a
    // signal that doesn't reduce to a single agreement/disagreement
    // ratio — calibration-item-specific agreement (where ground
    // truth is known) or payload-feature vote patterns (clustering
    // on what the pair votes about, not just whom they agree with).
    // Both are named in the PRD as the next testbed targets on this
    // seam.
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
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
        // Both thresholds at 1.0: catches perfect agreement and
        // perfect decorrelation, leaves the mix in between exposed.
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_anti_correlation_threshold: 1.0,
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

    // PRIMING with mixed strategy. Four "works" priming proposals.
    // Carol+Dave's vote pattern: (accept, accept), (accept, reject),
    // (reject, accept), (reject, reject). Shared = 4, agreed = 2
    // (positions 0 and 3), disagreed = 2 (positions 1 and 2).
    // Agreement ratio 0.5 < 1.0 (no positive edge). Disagreement
    // ratio 0.5 < 1.0 (no negative edge). They sit in singleton
    // strata.
    const carolDavePattern: Array<['accept' | 'reject', 'accept' | 'reject']> = [
      ['accept', 'accept'],
      ['accept', 'reject'],
      ['reject', 'accept'],
      ['reject', 'reject'],
    ];
    for (let i = 0; i < carolDavePattern.length; i++) {
      const excerpt = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      const pattern = carolDavePattern[i];
      if (!pattern) throw new Error('pattern out of range');
      const [carolVote, daveVote] = pattern;
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: carolVote,
          rationale:
            carolVote === 'accept'
              ? 'consistent with my read of the literature'
              : 'underpowered, methodological concerns',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: daveVote,
          rationale:
            daveVote === 'accept'
              ? 'consistent with my read of the literature'
              : 'underpowered, methodological concerns',
        },
      );
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }

    // CONTESTED: the no-effect excerpt the coalition wants to suppress.
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

    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Carol runs first, votes reject on contested.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    // Dave runs. Cluster signal silent (mixed pattern below both
    // thresholds), so the cross-stratum gate has nothing to enforce.
    // Dave is routed onto the contested slot and votes reject —
    // pushing the tally to 2 rejects, which converges reject.
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('rejected');
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(3);
    const erinVote = contestedVotes.find((v) => v.reviewer_id === erin.id);
    const carolVote = contestedVotes.find((v) => v.reviewer_id === carol.id);
    const daveVote = contestedVotes.find((v) => v.reviewer_id === dave.id);
    expect(erinVote?.decision).toBe('accept');
    expect(carolVote?.decision).toBe('reject');
    expect(daveVote?.decision).toBe('reject');
  });

  it('decline-pattern projection surfaces a reviewer who only declines outside their preferred shape', async () => {
    // PRD §Adversary testbed names "decline-pattern abuse" as a
    // distinct vector: declining everything outside the adversary's
    // preferred sub-topic to approximate selectivity even though
    // capacity is cause-level. The defense PRD commits to is
    // "decline-tracking + curator escalation": the system records
    // decline reasons (already wired at the assignment surface) and
    // the curator surface projects per-(cause, reviewer) decline
    // rates so a curator can investigate when a pattern surfaces.
    //
    // This test wires the projection end-to-end. Dave declines any
    // excerpt about "no effect" (a one-line stand-in for "outside
    // my preferred shape" — the effective signal is the same: high
    // decline rate within a cause). Erin accepts everything. Both
    // are offered assignments via the standard pull loop. The
    // curator-side projection ranks Dave at the top by decline
    // rate; Erin's rate is zero. The min_rate filter shows the
    // intended use — surface only patterns above a curator-chosen
    // threshold.
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
    const aliceCaller = { identity_id: alice.id };

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

    // Three "works" excerpts under paper 1, three "no effect"
    // excerpts under paper 2. Six staged review-tasks total.
    for (let i = 0; i < 3; i++) {
      await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor2Node.id,
        content: `treatment X has no effect for stage IV ${i}`,
        quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
      });
    }

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erinClient = await wireArchetype(server, erin.id);
    const daveClient = await wireArchetype(server, dave.id);

    // Erin runs first, accepts everything.
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 10,
      decide: acceptAllDecider,
    });

    // Dave's decline pattern: declines anything mentioning "no
    // effect" (returns null from decide → archetype calls
    // decline_assignment with reason "outside expertise"). Accepts
    // the rest. payloadDecliningDecider composes the predicate +
    // fallback so the abuse shape ("decline outside my preferred
    // shape, vote normally on the rest") is a one-line archetype.
    const decliner = payloadDecliningDecider({
      declineIf: (payload) => 'content' in payload && payload.content.includes('no effect'),
      fallback: acceptAllDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 10,
      decide: decliner,
    });

    // Curator-side projection: per-(cause, reviewer) decline rates,
    // sorted by rate desc.
    const patterns = server.curator.declinePatterns(cause.id);
    expect(patterns).toHaveLength(2);
    const davePattern = patterns.find((p) => p.identity_id === dave.id);
    const erinPattern = patterns.find((p) => p.identity_id === erin.id);
    expect(davePattern).toBeDefined();
    expect(erinPattern).toBeDefined();
    // Dave was offered all six excerpts and declined the three
    // "no effect" ones. Decline rate 0.5.
    expect(davePattern?.offers).toBeGreaterThanOrEqual(3);
    expect(davePattern?.declines).toBe(3);
    expect(davePattern?.decline_rate).toBeGreaterThan(0);
    // Erin declined nothing.
    expect(erinPattern?.declines).toBe(0);
    expect(erinPattern?.decline_rate).toBe(0);
    // Sorted: Dave first (higher rate).
    expect(patterns[0]?.identity_id).toBe(dave.id);

    // The min_rate filter cuts Erin out. The curator uses this
    // filter to surface only patterns worth investigating.
    const filtered = server.curator.declinePatterns(cause.id, { min_rate: 0.3 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.identity_id).toBe(dave.id);

    // The min_offers filter prevents small-sample false positives.
    // Setting min_offers above Dave's offer count hides him; below,
    // he surfaces. The exact threshold a curator uses is
    // operationally private (PRD §Verification engine, Rate limits and abuse signals).
    const tooHigh = server.curator.declinePatterns(cause.id, { min_offers: 999 });
    expect(tooHigh).toHaveLength(0);
  });

  it('archives stale staged proposals via the divergence-closure sweep', async () => {
    // PRD §Reviewer assignment commits divergence closure: "divergent
    // proposals are routed to richer review or carried forward as
    // parallel synthesis nodes / open_question, but not indefinitely:
    // divergences without further evidence within a tunable window
    // are archived (status `unresolved-archived`) rather than
    // perpetually re-routed." The contracts already commit the
    // unresolved-archived status; this is the path that produces it.
    //
    // Setup: three staged excerpts, each with one accept vote (the
    // pool can't reach votes_to_accept=5 — they sit divergent, the
    // shape PRD's closure mechanism is for). Time passes. One of
    // them gets a fresh vote (refreshing its activity timestamp).
    // The sweep runs with a window short enough that the older two
    // qualify but the freshly-voted one doesn't.
    //
    // Assertions: the older two flip to unresolved-archived, the
    // freshly-voted one stays staged, and a never-voted control
    // proposal stays staged regardless of age (a never-reviewed
    // proposal isn't divergent — it's just unstarted, and the
    // window logic explicitly skips it).
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      // High thresholds so single votes don't converge — the
      // divergence-closure mechanism only matters for proposals
      // stuck below the threshold.
      review: { votes_to_accept: 5, votes_to_reject: 5 },
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
    const anchor = await server.tools.proposeAnchor(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'paper 1',
      external_ref: { kind: 'pmid', value: '1' },
    });
    server.curator.acceptProposal(anchor.proposal_id);
    const anchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper 1',
    );
    if (!anchorNode) throw new Error('anchor not materialized');

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });

    // Three staged excerpts, each with a vote at roughly its
    // creation time.
    const stale1 = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorNode.id,
      content: 'treatment X works for stage III A',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
    });
    await server.tools.castReviewVote(
      { identity_id: erin.id },
      {
        proposal_id: stale1.proposal_id,
        decision: 'accept',
        rationale: 'spot-checked, looks correct',
      },
    );
    const fresh = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorNode.id,
      content: 'treatment X works for stage III B',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
    });
    await server.tools.castReviewVote(
      { identity_id: erin.id },
      {
        proposal_id: fresh.proposal_id,
        decision: 'accept',
        rationale: 'spot-checked, looks correct',
      },
    );
    const stale2 = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorNode.id,
      content: 'treatment X works for stage III C',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
    });
    await server.tools.castReviewVote(
      { identity_id: erin.id },
      {
        proposal_id: stale2.proposal_id,
        decision: 'accept',
        rationale: 'spot-checked, looks correct',
      },
    );
    // Control: never voted on. Should stay staged regardless of age
    // — divergence closure is for divergent proposals, not unstarted
    // ones.
    const unstarted = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorNode.id,
      content: 'treatment X works for stage III D',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
    });

    // Force-advance the clock by a large gap so the next vote sits
    // well after the early ones. Each clock.now() call advances by
    // tickMs=1000, so 100 calls = 100s.
    for (let i = 0; i < 100; i++) server.clock.now();

    // Refresh `fresh` with a vote from a different reviewer. This is
    // the "further evidence" PRD's closure mechanism is checking for.
    // Frank votes revise so the proposal stays staged (revise is
    // a no-op for convergence) — what matters is the activity
    // timestamp.
    await server.tools.castReviewVote(
      { identity_id: frank.id },
      {
        proposal_id: fresh.proposal_id,
        decision: 'revise',
        rationale: 'needs more context on the cohort',
      },
    );

    // Sweep with a window short enough that the early votes are
    // outside it but Frank's recent revise is inside.
    const archived = server.curator.archiveStaleProposals({
      window_seconds: 50,
      cause_id: cause.id,
    });
    expect(archived.sort()).toEqual([stale1.proposal_id, stale2.proposal_id].sort());

    expect(server.store.proposals.get(stale1.proposal_id)?.status).toBe('unresolved-archived');
    expect(server.store.proposals.get(stale2.proposal_id)?.status).toBe('unresolved-archived');
    expect(server.store.proposals.get(fresh.proposal_id)?.status).toBe('staged');
    expect(server.store.proposals.get(unstarted.proposal_id)?.status).toBe('staged');

    // Re-running the sweep is idempotent — already-archived proposals
    // are no longer staged and are skipped.
    const archivedAgain = server.curator.archiveStaleProposals({
      window_seconds: 50,
      cause_id: cause.id,
    });
    expect(archivedAgain).toEqual([]);
  });

  it('multi-proposal coalition: distributed lone-rejects with paired declines stall both contested targets, divergence-closure archives them', async () => {
    // The seam the mixed-strategy-coalition headline pinned by name:
    // "a coalition that avoids co-voting on any contentious item."
    // Co-voting on a contentious proposal is what every cluster-signal
    // refinement (agreement, anti-correlation, contention-weighted)
    // computes against; if the coalition never has both members vote
    // on the same contentious proposal, the cluster signal has nothing
    // to act on. The constraint that makes this *sound* tight —
    // suppressing the contested target inherently creates a contentious
    // item — is navigated by distribution: each coalition member
    // solo-rejects a *different* contested target and declines the
    // other. With paired-decline as the routing primitive, each
    // contested target sees one coalition reject and one honest
    // accept; neither converges; Carol and Dave share zero voting
    // history, so the cluster signal stays silent by construction.
    //
    // The wired closure stack does not catch this:
    //   - cluster signal (contention-weighted, anti-correlation 1.0,
    //     agreement 1.0): silent — Carol and Dave share no proposals,
    //     so no edge metric has data to fire.
    //   - calibration-aware convergence: silent — a single biased
    //     reject per target never builds up a weighted reject sum
    //     against the honest accept on that target.
    //   - assignment gates (recent / demonstrated): inert at the v0
    //     defaults this test runs; turning the demonstrated gate on
    //     would close a *fresh* multi-proposal coalition (the sybil-
    //     shaped variant), not a *patient* one primed first via
    //     contributor-initiated voting.
    //   - decline-pattern projection: surfaces both Carol and Dave to
    //     the curator (each declined half their offered review tasks),
    //     but the projection is a *visibility* surface, not an
    //     assignment-time gate.
    //
    // The terminal outcome is the divergence-closure sweep above:
    // both contested targets archive as `unresolved-archived` once
    // the window expires, which from the proposer's perspective is
    // the suppression result the coalition is driving toward —
    // neither target accepts.
    //
    // Candidate v0+ defenses that would close this seam (none wired):
    //   - pool-size enforcement: ensure the eligible-pool size for a
    //     proposal is large enough that a single biased lone-reject
    //     cannot persist a tie until the divergence window expires.
    //   - decline-pattern → assignment-gate: a curator-tunable
    //     threshold on `declinePatterns` that gates `request_assignment`
    //     rather than just surfacing a list (PRD §Capacity and
    //     assignment leaves the punitive consequence open in v0).
    //   - multi-proposal staling pattern: detect "the same identity is
    //     the lone rejecter on a stalled proposal across N proposals"
    //     as its own coalition signal, complementary to the per-pair
    //     cluster signal that needs co-occurrence to fire.
    //
    // None of these is in the v0 surface, so this scenario stands
    // alone rather than feeding an aggregate-ASR cube. Once one of
    // the candidate defenses lands, the cube template wraps this
    // pattern alongside the existing two cubes.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
      ['3', 'arm C: treatment X has no effect in stage IV patients across the second cohort'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('h'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        // Strongest cluster-signal stack on, to make the headline
        // load-bearing: this seam evades it not by tuning, but by
        // construction (no shared history → no edge data).
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_anti_correlation_threshold: 1.0,
        contention_weighted_edges: true,
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

    // Two anchors so each contested target has a distinct parent and
    // a distinct content shape the coalition deciders can key on.
    const anchorA = await server.tools.proposeAnchor(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'paper 2',
      external_ref: { kind: 'pmid', value: '2' },
    });
    server.curator.acceptProposal(anchorA.proposal_id);
    const anchorANode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper 2',
    );
    if (!anchorANode) throw new Error('paper 2 anchor not materialized');
    const anchorB = await server.tools.proposeAnchor(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'paper 3',
      external_ref: { kind: 'pmid', value: '3' },
    });
    server.curator.acceptProposal(anchorB.proposal_id);
    const anchorBNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper 3',
    );
    if (!anchorBNode) throw new Error('paper 3 anchor not materialized');

    // Two contested targets, distinguishable by cohort label. Each
    // member's decider keys on the cohort to take exactly one and
    // decline the other — the explicit "no co-voting on the
    // contentious item" rule.
    const targetA = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorANode.id,
      content: 'treatment X has no effect for stage IV cohort A',
      quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
    });
    const targetB = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorBNode.id,
      content: 'treatment X has no effect for stage IV cohort B',
      quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
    });

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erinClient = await wireArchetype(server, erin.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);

    // Carol takes cohort A (votes reject), declines cohort B. Dave
    // mirrors. Both fall through to the file-hoisted
    // calAwareBiasedDecider used by every other strategic-coalition
    // scenario in this file — same hidden objective ("bias against
    // 'no effect' findings"), expressed through the same primitive,
    // so the archetype reads as a multi-proposal *variant* of the
    // strategic-coalition family rather than a new bias model.
    const carolDecider = payloadDecliningDecider({
      declineIf: (payload) => 'content' in payload && payload.content.includes('cohort B'),
      fallback: calAwareBiasedDecider,
    });
    const daveDecider = payloadDecliningDecider({
      declineIf: (payload) => 'content' in payload && payload.content.includes('cohort A'),
      fallback: calAwareBiasedDecider,
    });

    // Erin runs first, accepts everything. Both targets sit at 1
    // accept, awaiting redundancy.
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: carolDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: daveDecider,
    });

    // Each contested target sits at 1 accept + 1 reject — tied below
    // both convergence thresholds (votes_to_accept=2, votes_to_reject=2).
    // No further honest capacity to break the tie: Erin already voted,
    // Dave declined targetA, Carol declined targetB, and the assignment
    // surface treats decline as a stable signal (no re-offer to the
    // same contributor — PRD §Capacity and assignment).
    expect(server.store.proposals.get(targetA.proposal_id)?.status).toBe('staged');
    expect(server.store.proposals.get(targetB.proposal_id)?.status).toBe('staged');
    const targetAVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === targetA.proposal_id,
    );
    const targetBVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === targetB.proposal_id,
    );
    expect(targetAVotes).toHaveLength(2);
    expect(targetBVotes).toHaveLength(2);
    // No co-voting on either contentious target: Dave never voted on
    // targetA, Carol never voted on targetB. This is the by-construction
    // condition that keeps the cluster signal silent.
    expect(targetAVotes.some((v) => v.reviewer_id === carol.id && v.decision === 'reject')).toBe(
      true,
    );
    expect(targetAVotes.some((v) => v.reviewer_id === erin.id && v.decision === 'accept')).toBe(
      true,
    );
    expect(targetAVotes.some((v) => v.reviewer_id === dave.id)).toBe(false);
    expect(targetBVotes.some((v) => v.reviewer_id === dave.id && v.decision === 'reject')).toBe(
      true,
    );
    expect(targetBVotes.some((v) => v.reviewer_id === erin.id && v.decision === 'accept')).toBe(
      true,
    );
    expect(targetBVotes.some((v) => v.reviewer_id === carol.id)).toBe(false);

    // Curator-side decline-pattern projection: each coalition member
    // was offered both targets and declined the partner's cohort,
    // landing at offers=2, declines=1 — a 0.5 decline rate. The
    // honest reviewer's rate is 0. The projection's *default*
    // small-sample floor (min_offers=3, the v0 default that filters
    // out reviewers whose decline-rate is statistically meaningless)
    // hides the coalition entirely at this scale: a 2-target run
    // sits below the floor by construction, and the curator-tunable
    // threshold a real instance would set is operationally private.
    // The visibility handle exists, but a small-N coalition lives
    // under it without a curator who has *also* dropped the
    // small-sample threshold to the small-N regime — and that drop
    // surfaces every casual decliner alongside the coalition.
    const defaultPatterns = server.curator.declinePatterns(cause.id);
    expect(defaultPatterns).toEqual([]);
    const surfaced = server.curator.declinePatterns(cause.id, {
      min_offers: 2,
      min_rate: 0.3,
    });
    expect(surfaced.map((p) => p.identity_id).sort()).toEqual([carol.id, dave.id].sort());
    for (const p of surfaced) {
      expect(p.offers).toBe(2);
      expect(p.declines).toBe(1);
      expect(p.decline_rate).toBeCloseTo(0.5);
    }

    // Time passes well past the divergence window, then the sweep
    // runs. Both stalled targets archive — the terminal outcome of
    // the seam. From the proposer's perspective neither target was
    // accepted; the coalition's distributed lone-reject succeeded at
    // suppression-by-archival.
    server.clock.advance(120_000);
    const archived = server.curator.archiveStaleProposals({
      window_seconds: 60,
      cause_id: cause.id,
    });
    expect(archived.sort()).toEqual([targetA.proposal_id, targetB.proposal_id].sort());
    expect(server.store.proposals.get(targetA.proposal_id)?.status).toBe('unresolved-archived');
    expect(server.store.proposals.get(targetB.proposal_id)?.status).toBe('unresolved-archived');
  });

  it('cluster signal with declines: paired-decline encounters form a co-stratum edge, cross-stratum gate routes the partner away', async () => {
    // The structural defense for the multi-proposal seam pinned by the
    // standalone scenario above. The vote-only cluster primitive is
    // silent against paired-decline because the coalition shares zero
    // vote-history by construction; widening the encounter domain to
    // include declines reads (vote, decline) and (decline, vote) on
    // the same proposal as pair-disagreement under the existing anti-
    // correlation primitive, and the cross-stratum gate then routes
    // the partner away from a target where one coalition member is
    // already assigned.
    //
    // Scenario:
    //   1. Two priming excerpts staged needs-review.
    //   2. Carol's request loop: vote on the first offer, decline the
    //      second. Dave's loop: decline the first, vote on the second.
    //      Frontier order delivers the same priming proposals to both
    //      so the actions land mirrored on the same target ids — the
    //      paired-decline shape by construction.
    //   3. A third "contested" excerpt is staged. Carol requests an
    //      assignment first and is routed to it (no co-stratum
    //      reviewer is routed yet, so the cross-stratum gate has
    //      nothing to enforce against). Dave then requests.
    //   4. With `stratum_include_declines: true`, Carol-Dave cluster
    //      (shared=2 encounters on the priming, both disagreeing → anti-
    //      correlation 1.0). Cross-stratum gate sees Carol routed to
    //      the contested target and skips it for Dave; with no other
    //      frontier candidates, Dave's request_assignment fails with
    //      `not_found`.
    //   5. Knob-off control: same setup with the knob off — cluster
    //      doesn't form (zero shared votes), Dave is offered the
    //      contested target normally.
    //
    // The test pins the knob's *structural* effect on the cluster
    // primitive. Whole-scenario closure (does the seam's archival
    // outcome flip?) is timing-dependent — the cross-stratum gate
    // fires at request_assignment, so it can only protect *future*
    // routings, and the minimal 2-target seam loses both lone-rejects
    // before any cluster-history accumulates. A multi-round closure
    // scenario where priming history is built first lands in a
    // follow-up cycle alongside an aggregate-ASR cube.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients across cohort A'],
      ['3', 'arm C: treatment X has no effect in stage IV patients across cohort B'],
      ['4', 'arm D: treatment X has no effect in stage IV patients across cohort C'],
    ]);

    async function setupAndRun(
      includeDeclines: boolean,
    ): Promise<{ daveContestedRequest: 'offered' | 'not_found' }> {
      const server = new Server({
        clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
        idGen: new SeededIdGen(`cd-${includeDeclines ? 'on' : 'off'}`),
        verifier: new FakeVerifier(new Set(), new Map(), sources),
        review: {
          // Cluster-signal stack at the same strength the standalone
          // multi-proposal scenario uses; only the new knob varies
          // across the two halves of this test.
          stratification_enabled: true,
          stratum_min_shared_proposals: 2,
          stratum_agreement_threshold: 1.0,
          stratum_anti_correlation_threshold: 1.0,
          stratum_contention_weighted: true,
          stratum_target_count: 2,
          stratification_degraded_extra: 1,
          stratum_include_declines: includeDeclines,
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

      // Three anchors, one per priming target + one for the contested
      // target. Anchor proposals are accepted by the curator so the
      // excerpts below have a parent to attach to.
      const anchorIds: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const ap = await server.tools.proposeAnchor(aliceCaller, {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          content: `paper ${i}`,
          external_ref: { kind: 'pmid', value: String(i + 1) },
        });
        server.curator.acceptProposal(ap.proposal_id);
        const node = [...server.store.nodes.values()].find(
          (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
        );
        if (!node) throw new Error(`anchor ${i} not materialized`);
        anchorIds.push(node.id);
      }

      // Two priming excerpts (the targets the coalition pairs declines
      // on) and one contested excerpt (the cross-stratum probe). Use
      // distinct quoted-span text per target so the verifier passes
      // each independently.
      const primingA = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorIds[0]!,
        content: 'priming target A',
        quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
      });
      const primingB = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorIds[1]!,
        content: 'priming target B',
        quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
      });
      const contested = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorIds[2]!,
        content: 'contested target',
        quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
      });

      const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
      const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
      const carolCaller = { identity_id: carol.id };
      const daveCaller = { identity_id: dave.id };
      await server.tools.setCapacity(carolCaller, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });
      await server.tools.setCapacity(daveCaller, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });

      // Carol's priming: vote on the first offer, decline the second.
      // Frontier order yields A then B (created first → first), so
      // Carol's vote lands on A and her decline on B.
      const carolFirst = await server.tools.requestAssignment(carolCaller, {
        cause_id: cause.id,
      });
      if (carolFirst.task.kind !== 'review') throw new Error('expected review task');
      expect(carolFirst.task.proposal_id).toBe(primingA.proposal_id);
      await server.tools.castReviewVote(carolCaller, {
        proposal_id: carolFirst.task.proposal_id,
        decision: 'reject',
        rationale: 'priming reject',
        assignment_id: carolFirst.assignment_id,
      });
      const carolSecond = await server.tools.requestAssignment(carolCaller, {
        cause_id: cause.id,
      });
      if (carolSecond.task.kind !== 'review') throw new Error('expected review task');
      expect(carolSecond.task.proposal_id).toBe(primingB.proposal_id);
      await server.tools.declineAssignment(carolCaller, {
        assignment_id: carolSecond.assignment_id,
        reason: 'priming decline',
      });

      // Dave's priming: mirror — decline the first, vote on the second.
      const daveFirst = await server.tools.requestAssignment(daveCaller, {
        cause_id: cause.id,
      });
      if (daveFirst.task.kind !== 'review') throw new Error('expected review task');
      expect(daveFirst.task.proposal_id).toBe(primingA.proposal_id);
      await server.tools.declineAssignment(daveCaller, {
        assignment_id: daveFirst.assignment_id,
        reason: 'priming decline',
      });
      const daveSecond = await server.tools.requestAssignment(daveCaller, {
        cause_id: cause.id,
      });
      if (daveSecond.task.kind !== 'review') throw new Error('expected review task');
      expect(daveSecond.task.proposal_id).toBe(primingB.proposal_id);
      await server.tools.castReviewVote(daveCaller, {
        proposal_id: daveSecond.task.proposal_id,
        decision: 'reject',
        rationale: 'priming reject',
        assignment_id: daveSecond.assignment_id,
      });

      // Carol routes to the contested target first — she's still the
      // only candidate for it (Dave hasn't requested yet), so the
      // cross-stratum gate has no co-stratum reviewer to enforce
      // against and lets her through regardless of the knob.
      const carolContested = await server.tools.requestAssignment(carolCaller, {
        cause_id: cause.id,
      });
      if (carolContested.task.kind !== 'review') throw new Error('expected review task');
      expect(carolContested.task.proposal_id).toBe(contested.proposal_id);

      // Dave now requests. With include_declines on: cluster forms
      // (Carol-Dave shared = 2 priming encounters, both disagreeing →
      // anti-correlation 1.0 → edge), Carol is routed to the contested
      // target, cross-stratum gate skips it for Dave, no other
      // frontier candidates remain → request fails with `not_found`.
      // With the knob off: cluster doesn't form (shared vote-only = 0),
      // Dave is offered the contested target normally.
      try {
        const daveContested = await server.tools.requestAssignment(daveCaller, {
          cause_id: cause.id,
        });
        if (daveContested.task.kind !== 'review') throw new Error('expected review task');
        expect(daveContested.task.proposal_id).toBe(contested.proposal_id);
        return { daveContestedRequest: 'offered' };
      } catch (err) {
        if (err instanceof ServerError && err.code === 'not_found') {
          return { daveContestedRequest: 'not_found' };
        }
        throw err;
      }
    }

    // Knob off: vote-only cluster sees zero shared history, no edge
    // forms, Dave gets the contested target.
    const off = await setupAndRun(false);
    expect(off.daveContestedRequest).toBe('offered');

    // Knob on: declines enter the encounter domain, paired-decline
    // shape lights up the anti-correlation edge, Dave is gated out
    // by the cross-stratum draw. The structural seam is closed at
    // the cluster primitive.
    const on = await setupAndRun(true);
    expect(on.daveContestedRequest).toBe('not_found');
  });

  it('cluster signal with declines, multi-round: paired-decline priming flips a contested target from rejected to accepted', async () => {
    // The whole-scenario closure the standalone decline-extension test
    // above pinned as "timing-dependent" and parked. The standalone
    // test demonstrates the *primitive* — once paired-decline priming
    // builds the cluster, a future request_assignment refuses the
    // partner. It does not show that the seam's *outcome* flips,
    // because in the minimal seam the suppression votes land before
    // any cluster history accumulates.
    //
    // This scenario splits the timeline so the cluster has time to
    // form before suppression begins:
    //
    //   Round 1 (priming, separate proposals from the contested
    //   target). Two priming excerpts staged. Carol's loop accepts
    //   the first and declines the second; Dave's loop mirrors —
    //   decline the first, accept the second. Erin votes accept on
    //   both. Both priming proposals reach 2 accepts and converge.
    //   The encounter ledger now records (Carol vote, Dave decline)
    //   on priming A and (Carol decline, Dave vote) on priming B —
    //   shared = 2, both disagreement under the decline-aware
    //   encounter domain. Carol+Dave cluster. Erin shares one
    //   agreement and one disagreement with each coalition member,
    //   and Frank/Hank haven't appeared yet, so the rest of the pool
    //   stays in singleton strata.
    //
    //   Round 2 (suppression on a fresh contested target). The
    //   contested excerpt is staged with the bias-zone content
    //   ("treatment X has no effect") that calAwareBiasedDecider
    //   rejects. Carol's loop runs first and votes reject. Dave's
    //   loop runs next; the suppression attempt is the second reject
    //   that would land status=rejected under v0 thresholds
    //   (votes_to_accept=2, votes_to_reject=2). Frank and Hank then
    //   request and vote accept.
    //
    // Closure observed at the proposal status (not just the gate
    // primitive):
    //   - Knob OFF: Carol+Dave's paired declines never produce shared
    //     vote-history, the cluster signal is silent, Dave's request
    //     in round 2 is offered the contested target, Dave's reject
    //     lands as the second reject, status flips to 'rejected'
    //     before Frank or Hank can vote — suppression succeeds.
    //   - Knob ON: declines enter the encounter domain, Carol+Dave
    //     anti-correlate at 1.0 across the priming round, the cluster
    //     forms before round 2 begins. Dave's request_assignment in
    //     round 2 is gated (Carol's stratum already routed to the
    //     contested target), Dave idles. Frank and Hank then vote
    //     accept; the contested target reaches 2 accepts against 1
    //     reject and converges 'accepted' — suppression fails.
    //
    // The same defense stack runs in both halves; only the
    // `stratum_include_declines` knob varies. The test pins the
    // outcome flip on the proposal's terminal status, the
    // observable a real proposer sees. The downstream cluster-decline
    // sweep cube reuses the same `runMultiRoundDeclineClosureScenario`
    // helper that powers this test, so the cube and the standalone
    // assertion stay in lockstep on the closure they both observe.
    const off = await runMultiRoundDeclineClosureScenario({
      stratum_include_declines: false,
    });
    expect(off.contested_status).toBe('rejected');
    const on = await runMultiRoundDeclineClosureScenario({
      stratum_include_declines: true,
    });
    expect(on.contested_status).toBe('accepted');
  });

  it('contention-weighted + decline-aware: a single asymmetric decline false-clusters honest reviewers; the paired-decline floor closes it', async () => {
    // The interaction the multi-round closure isolated to a single
    // load-bearing knob (its runner kept stratum_contention_weighted
    // off precisely because composition with decline-aware turns a
    // load-bearing closure into a false-positive trap). Under
    // decline-aware + contention-weighted, the rule that counts
    // decline-involved encounters at full weight (=1) is what keeps
    // the paired-decline closure firing — but it also lets a *single*
    // asymmetric decline-involved encounter dominate a pair whose
    // entire vote-vote history sits on unanimous-easy items
    // (contention 0 → weight 0). The pair's weighted-disagreement
    // ratio collapses to 1.0 against an honest pair that shared no
    // coalition signal, the anti-correlation edge fires, and the
    // honest pool false-clusters with itself. The cross-stratum gate
    // then strangles honest review on the next contested target.
    //
    // The refinement is `stratum_decline_min_paired` (default 2): the
    // full-weight rule for declines only applies when the pair has at
    // least N decline-involved shared encounters. The paired-decline
    // closure has 2 by construction (Carol votes A and declines B;
    // Dave declines A and votes B), so a floor of 2 closes the over-
    // clustering pathology without weakening the closure.
    //
    // Scenario:
    //   Round 1 (priming). Three honest reviewers — Carol, Dave, Erin
    //   — vote accept on two unanimous-easy excerpts. Both proposals
    //   converge accepted at 3 accepts apiece; per-proposal contention
    //   is 0 across the priming, so every vote-vote agreement
    //   contributes 0 weight to the cluster signal.
    //
    //   Round 2 (asymmetric-decline event). A third "trigger" excerpt
    //   is staged. Carol's decider declines payloads tagged
    //   "trigger"; Dave and Erin vote accept normally. Trigger
    //   converges accepted at 2 accepts. The encounter ledger now
    //   records (Carol decline, Dave vote) and (Carol decline, Erin
    //   vote) on trigger — single decline-involved encounters between
    //   Carol and each of the other two honest reviewers.
    //
    //   Round 3 (contested target). A fresh excerpt is staged. All
    //   three honest reviewers run with acceptAllDecider; under any
    //   non-pathological cluster computation, the contested target
    //   converges accepted at the second vote.
    //
    // Outcome flip on the proposal's terminal status:
    //   - Floor 1 (no floor — the buggy regime). Carol-Dave pair
    //     has 1 decline-involved encounter; weighted_shared = 1,
    //     weighted_agreed = 0, disagreement ratio 1.0, anti-
    //     correlation edge fires. Same for Carol-Erin. Dave-Erin has
    //     no decline-involved encounters and all vote agreements at
    //     contention 0, so no edge. The graph has Carol-Dave and
    //     Carol-Erin edges → all three honest reviewers collapse into
    //     one connected component. The contested target's eligible
    //     pool covers 1 stratum (below stratum_target_count=2), so
    //     the proposal is flagged stratification-degraded and votes_
    //     to_accept tightens to 3. The first reviewer's request is
    //     routed to the contested target; the other two are gated by
    //     the cross-stratum rule (co-stratum already routed) and
    //     their request_assignment returns not_found. The proposal
    //     sits at 1 accept, the divergence-closure sweep archives it.
    //   - Floor 2 (default). Carol-Dave / Carol-Erin each have 1
    //     decline-involved encounter, below the floor → contributes
    //     0 weight. weighted_shared collapses to 0 across the priming
    //     and the trigger (all vote agreements at contention 0, the
    //     decline encounter zeroed by the floor). signalAvailable is
    //     false for every pair, no edges form, all three honest
    //     reviewers stay in singleton strata. The contested target is
    //     not degraded, votes_to_accept stays at 2, all three vote
    //     accept and the proposal converges accepted at the second
    //     vote.
    //
    // The test pins the closure on terminal status — the observable a
    // real proposer sees — same shape as the multi-round closure
    // above. Same defense stack runs in both halves; only
    // `stratum_decline_min_paired` varies. The runner
    // (`runOverClusteringScenario`, lifted alongside the multi-round
    // closure runner below) is shared with the cluster-decline ×
    // floor sweep cube downstream so the cube and this standalone
    // observation run the same scenario.
    const buggy = await runOverClusteringScenario({
      stratum_contention_weighted: true,
      stratum_decline_min_paired: 1,
    });
    expect(buggy.contested_status).toBe('unresolved-archived');
    const fixed = await runOverClusteringScenario({
      stratum_contention_weighted: true,
      stratum_decline_min_paired: 2,
    });
    expect(fixed.contested_status).toBe('accepted');
  });

  it('contention-weighted + anti-correlation together close the mixed-strategy gap', async () => {
    // Companion to the mixed-strategy-coalition test above. The
    // standalone mixed strategy defeats each refinement individually
    // because both reduce to a single ratio: with raw edges, a 50/50
    // pattern lands at agreement=0.5 and disagreement=0.5, sitting
    // below threshold 1.0 in either direction. The composition
    // closes the gap.
    //
    // Contention weighting reweights the pair-stat by per-proposal
    // contention (2*min(a,r)/total). For the mixed-strategy priming:
    //   (accept, accept): a=2, r=0 → contention 0, contributes 0.
    //   (accept, reject): a=1, r=1 → contention 1, contributes 1.
    //   (reject, accept): a=1, r=1 → contention 1, contributes 1.
    //   (reject, reject): a=0, r=2 → contention 0, contributes 0.
    // So weighted_shared = 2, weighted_agreed = 0,
    // weighted_disagreed = 2. The disagreement metric collapses to
    // 1.0 even though the raw mix is 50/50 — the agreement on
    // unanimous-easy items contributes 0 weight, leaving only the
    // contentious disagreements to define the relationship. Anti-
    // correlation at threshold 1.0 then fires the edge, Carol+Dave
    // cluster, and the cross-stratum gate trips Dave away from the
    // contested slot.
    //
    // Headline: contested stays staged. The mixed-strategy gap that
    // each defense couldn't close alone is closed by the
    // composition. The seam moves: a coalition adapting against
    // this regime would need to avoid co-voting on any contentious
    // item, which constrains them sharply (suppressing the
    // contested target inherently *creates* a contentious item, and
    // priming with non-contentious co-votes either lights up the
    // positive-agreement edge or fails to inflate shared history).
    // Further adaptations are testbed targets, not regressions of
    // this seam.
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
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_anti_correlation_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        // The composition: contention-weighted edges *and*
        // anti-correlation together. Either alone leaves the gap
        // open against the 50/50 pattern.
        stratum_contention_weighted: true,
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

    // PRIMING with the same 50/50 mixed pattern that defeated each
    // refinement alone.
    const carolDavePattern: Array<['accept' | 'reject', 'accept' | 'reject']> = [
      ['accept', 'accept'],
      ['accept', 'reject'],
      ['reject', 'accept'],
      ['reject', 'reject'],
    ];
    for (let i = 0; i < carolDavePattern.length; i++) {
      const excerpt = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      const cell = carolDavePattern[i];
      if (!cell) throw new Error('pattern out of range');
      const [carolVote, daveVote] = cell;
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: carolVote,
          rationale:
            carolVote === 'accept'
              ? 'consistent with my read of the literature'
              : 'underpowered, methodological concerns',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: daveVote,
          rationale:
            daveVote === 'accept'
              ? 'consistent with my read of the literature'
              : 'underpowered, methodological concerns',
        },
      );
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }

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

    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    // Dave's request_assignment hits the cross-stratum gate: Carol
    // already voted on contested; with contention-weighted edges
    // and anti-correlation enabled, Carol+Dave's mixed pattern
    // collapses to weighted disagreement 1.0 and the negative edge
    // fires. Same cluster. Skip.
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    expect(target?.status).toBe('staged');
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contested.proposal_id,
    );
    expect(contestedVotes).toHaveLength(2);
    expect(contestedVotes.map((v) => v.reviewer_id).sort()).toEqual([carol.id, erin.id].sort());
  });

  it('patient-adversary archetype: two-component bookkeeping exposes the recent-activity drain that assignment-gating will consume (PRD §Reputation)', async () => {
    // PRD §Adversary taxonomy (Patient adversary): "Strategic
    // adversary with a long horizon — builds reputation honestly for
    // months before drift attempts. Tests whether per-(cause, sub-
    // topic) reputation tracking and review-as-staking prevent slow
    // drift." PRD §Reputation names the defenses: two-component
    // reputation — a slow-decay demonstrated-competence component
    // gating eligibility tiers, plus a fast-decay recent-activity
    // component gating assignment.
    //
    // Two-component bookkeeping is now wired (PRD §Reputation):
    // every reputation event moves both components together; on
    // read, each component decays exponentially per its own half-
    // life. What is *not* yet wired is the gating layer on top of
    // either component — eligibility tiers driven by demonstrated,
    // assignment draws filtered by recent. Those land when the
    // testbed picks thresholds; this scenario is the regression
    // handle that says "the lever the next slice consumes is real."
    //
    // Setup: the same calibration-aware predicate the existing
    // calibration-aware-coalition tests use (accept anchors and
    // bias-aligned excerpts, reject only bias-misaligned excerpts).
    // Carol is the patient adversary running solo. Bob honestly
    // generates four well-grounded "works"-aligned priming excerpts
    // and one "no effect" contested excerpt. Carol reviews first —
    // she accepts every priming item, passes every calibration item
    // (the calibration corpus is the curator-accepted anchor pool,
    // which her predicate accepts because it gates on "treatment"),
    // and drifts on the contested excerpt (rejects). Then two
    // honest reviewers Erin and Frank accept everything, including
    // the contested target.
    //
    // Defenses on: calibration injection + calibration-aware
    // convergence — the convergence half closed in the strategic-
    // coalition tests above. Plus finite recent-component half-life
    // so the drain is observable inside the test horizon;
    // demonstrated half-life stays Infinity so the long-priming
    // buffer is unambiguous. Stratification is left off so the
    // measurement is on the rep ledger and decay layer, not on the
    // cluster-signal layer.
    //
    // Headline assertions:
    //   - Contested target converges to accepted: distinct-count +
    //     weighted-sum gates absorb Carol's lone reject when two
    //     honest reviewers accept.
    //   - Immediately after the drift, Carol's demonstrated and
    //     recent are both strongly positive and approximately equal
    //     — the bookkeeping is symmetric on bump.
    //   - After a quiet window passes (Carol stops being recently
    //     active between drift attempts, which is the patient-
    //     adversary's defining signature), her recent component
    //     decays toward zero while demonstrated is preserved. The
    //     gap is the measurement an assignment-gating slice will
    //     read against.
    //   - Carol's calibration record is all-passes; her vote weight
    //     at convergence stays well above the fresh-reviewer floor
    //     of 1.
    //
    // This scenario is bookkeeping-only — it intentionally leaves
    // `assignment_min_recent` at 0 so the *gate* that consumes the
    // recent-component drain doesn't fire, and the cumulative-buffer
    // drift bandwidth pins the pre-gate baseline. The companion
    // scenario below ("assignment gate refuses a drained adversary")
    // turns the gate on and shows drift bandwidth tightening to 1.
    // Splitting the two keeps the bookkeeping pin readable as a
    // standalone invariant — change the bookkeeping math and this
    // test catches it without the gate-scenario noise.
    //
    // Class-aware thresholds (PRD §Reputation, "review-credit
    // normalized by claim difficulty") and demonstrated-component
    // eligibility-tier gating remain future iterations.
    const PRIMING_COUNT = 4;
    const sources = new Map<string, string>();
    for (let i = 1; i <= PRIMING_COUNT; i++) {
      sources.set(
        String(i),
        `arm A${i}: treatment X works in stage III patients across the cohort`,
      );
    }
    sources.set('99', 'arm B: treatment X has no effect in stage IV patients');

    // tickMs=0 — auto-advance per now() call would otherwise eat
    // into the recent half-life across the dozen-odd clock reads each
    // tool call performs. The scenario only cares about deliberate
    // clock advances between bookkeeping phases; the ordering needs
    // are met by SeededIdGen tiebreakers.
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const RECENT_HALF_LIFE_SECONDS = 60;
    const server = new Server({
      clock,
      idGen: new SeededIdGen('p'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
        // Demonstrated stays put across the test horizon — the long-
        // priming buffer is unambiguous. Recent halves on a 60s
        // clock so the drain is observable on a small number of
        // deliberate advances.
        demonstrated_half_life_seconds: Infinity,
        recent_half_life_seconds: RECENT_HALF_LIFE_SECONDS,
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
    for (let i = 1; i <= PRIMING_COUNT; i++) {
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
    const contestedAnchorProp = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper contested',
        external_ref: { kind: 'pmid', value: '99' },
      },
    );
    server.curator.acceptProposal(contestedAnchorProp.proposal_id);
    const contestedAnchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper contested',
    );
    if (!contestedAnchorNode) throw new Error('contested anchor not materialized');
    const contestedAnchorId = contestedAnchorNode.id;

    // Bob — honest-strong proposer. Generates one excerpt per orphan
    // anchor; the contested anchor gets the "no effect" content,
    // every other anchor gets the "works" content.
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);
    const provider: ContentProvider = {
      forAnchor: (anchorId) =>
        anchorId === contestedAnchorId
          ? {
              content: 'treatment X has no effect for stage IV',
              quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
            }
          : {
              content: 'treatment X works for stage III',
              quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
            },
    };
    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 10,
      kinds: ['excerpt'],
      content: provider,
    });

    // Carol — patient adversary. Calibration-aware predicate:
    // accept anything not mentioning "treatment" (the anchor
    // calibration corpus) and any excerpt mentioning "works"; reject
    // only the bias-misaligned "no effect" excerpt. Same predicate
    // shape the calibration-aware-coalition tests use, applied solo.
    // Runs first so all of Bob's priming excerpts are still staged
    // when she votes — she gets to accept each one and her votes
    // count toward the eventual accept convergence.
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const carolClient = await wireArchetype(server, carol.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 20,
      decide: calAwareBiasedDecider,
    });

    // Erin and Frank — two honest reviewers. Each accepts every
    // proposal they see. Together they reach the distinct-count +
    // weighted-sum gate against Carol's lone reject on contested.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 20,
      decide: acceptAllDecider,
    });
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const frankClient = await wireArchetype(server, frank.id);
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 20,
      decide: acceptAllDecider,
    });

    // The contested target survives Carol's drift: Erin + Frank's
    // accepts hit accept count = 2 and accept weight = 2 before
    // Carol's reject finds a coalition partner. The defenses absorb
    // a single biased vote on a 3-reviewer pool by construction.
    const contestedExcerpt = [...server.store.proposals.values()].find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    expect(contestedExcerpt?.status).toBe('accepted');

    // Carol's reputation is strongly positive in this (cause, sub-
    // topic). Buffer composition: +1 per priming excerpt where her
    // accept matched the converged accept (PRIMING_COUNT items),
    // +calibration_pass_gain per calibration item her predicate
    // matched ground-truth on, -reviewer_inaccurate_loss for the one
    // drift. The PRD §Reputation §244 contributor-initiated factor
    // doesn't apply — these are reviewer rep movements, not
    // proposer ones. Both components see the same bumps; with no
    // time advanced yet, demonstrated and recent should be equal
    // (recent decay over the auto-tick=0 clock is identity).
    const carolRep = await carolClient.queryReputation({ cause_id: cause.id });
    const carolEntry = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id);
    const carolDemonstrated = carolEntry?.demonstrated ?? 0;
    const carolRecent = carolEntry?.recent ?? 0;
    expect(carolDemonstrated).toBeGreaterThan(0);
    expect(carolDemonstrated).toBeGreaterThan(server.review.reviewer_inaccurate_loss * 2);
    expect(carolRecent).toBe(carolDemonstrated);

    // Carol's calibration record is all-passes — her predicate
    // matches every anchor calibration item ("paper N" content
    // doesn't include "treatment", so the predicate's first clause
    // accepts). Vote weight = max(0, 1 + passes - fails) stays well
    // above the fresh-reviewer floor of 1. Read directly from the
    // store — calibration records are an internal observability
    // surface (no public tool exposes them in v0); the testbed
    // accepts that contract because the alternative (a query tool)
    // would leak the seam to clients before Phase 2 is ready to
    // commit it.
    const calKey = `${carol.id}|${cause.id}|${subTopic.id}` as const;
    const carolCal = server.store.calibrationRecords.get(calKey);
    expect(carolCal?.passes ?? 0).toBeGreaterThan(0);
    expect(carolCal?.fails ?? 0).toBe(0);
    const carolWeight = Math.max(0, 1 + (carolCal?.passes ?? 0) - (carolCal?.fails ?? 0));
    expect(carolWeight).toBeGreaterThan(1);

    // Cumulative buffer over per-drift cost: Carol's drift bandwidth
    // measured by the slow-decay component is the same as a single
    // cumulative tally would give. No live gate yet *consumes* the
    // demonstrated component to deny her further assignment, so this
    // pin remains exactly as wide as before the two-component slice
    // landed — and intentionally so. Eligibility tiers gating on
    // demonstrated and assignment filters gating on recent are the
    // next testbed iteration; their landing should be what tightens
    // this number, not the bookkeeping change underneath them.
    const driftBandwidth = Math.floor(carolDemonstrated / server.review.reviewer_inaccurate_loss);
    expect(driftBandwidth).toBeGreaterThan(1);

    // The new measurement: advance the clock past several recent
    // half-lives (Carol stops being recently active — the patient-
    // adversary's defining behavior between drift attempts) and re-
    // read. Demonstrated should be unchanged; recent should fall
    // toward zero. The gap is the lever. A future assignment-gating
    // slice that requires recent ≥ some threshold for a draw closes
    // the patient-adversary loop on this side: Carol can keep
    // demonstrated high indefinitely, but cannot keep recent high
    // without continuing to vote — and the votes themselves are
    // observable.
    const QUIET_HALF_LIVES = 6;
    clock.advance(RECENT_HALF_LIFE_SECONDS * QUIET_HALF_LIVES * 1000);
    const carolRepAfter = await carolClient.queryReputation({ cause_id: cause.id });
    const carolEntryAfter = carolRepAfter.entries.find((e) => e.sub_topic_id === subTopic.id);
    expect(carolEntryAfter?.demonstrated ?? 0).toBe(carolDemonstrated);
    // After 6 half-lives, recent has fallen by 2^6 = 64x. A 1% margin
    // of error is generous against floating-point precision but
    // bites if decay accidentally degenerates back to identity.
    const expectedRecent = carolRecent * 0.5 ** QUIET_HALF_LIVES;
    expect(carolEntryAfter?.recent ?? 0).toBeCloseTo(expectedRecent, 8);
    expect(carolEntryAfter?.recent ?? 0).toBeLessThan(carolDemonstrated * 0.05);
  });

  it('patient-adversary archetype: assignment gate refuses a drained adversary on the fresh drift attempt (PRD §Reputation, recent-activity gates assignment)', async () => {
    // Closes the loop the bookkeeping scenario above named as the
    // next slice. With `assignment_min_recent > 0` set, the recent-
    // activity component is now consumed at request_assignment time:
    // a caller whose decayed recent has fallen below threshold (and
    // who has any rep entries in the cause — fresh-reviewer bypass
    // still applies) is refused. The patient-adversary signature is
    // exactly this state — high cumulative competence buffer,
    // drained recent, attempting a fresh drift after a quiet window.
    //
    // Setup mirrors the bookkeeping scenario: same calibration-aware
    // predicate, same priming + drift on a first contested target.
    // Threshold is set above what a 6-half-life-decayed recent leaves
    // behind, so the gate fires after the quiet window. Demonstrated
    // half-life stays Infinity so the cumulative-buffer narrative
    // holds — the closure is purely on recent.
    //
    // Pin: Carol's second drift attempt fails at request_assignment
    // with `not_found`. Drift bandwidth tightens from "many"
    // (cumulative buffer) to 1 (the drift she landed before the
    // quiet window). Honest contributors who keep voting (whose
    // recent stays topped up) remain assignable; the contributor-
    // initiated review path also bypasses the gate, so a drained-
    // but-honest contributor has a recovery path PRD names.
    const PRIMING_COUNT = 4;
    const sources = new Map<string, string>();
    for (let i = 1; i <= PRIMING_COUNT; i++) {
      sources.set(
        String(i),
        `arm A${i}: treatment X works in stage III patients across the cohort`,
      );
    }
    sources.set('99', 'arm B: treatment X has no effect in stage IV patients');
    // A second contested source, used for the fresh drift attempt
    // after the quiet window. Same shape as the first contested
    // anchor — different external_ref so the verifier accepts both.
    sources.set('100', 'arm C: treatment X has no effect in stage IV patients');

    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const RECENT_HALF_LIFE_SECONDS = 60;
    const server = new Server({
      clock,
      idGen: new SeededIdGen('pg'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
        demonstrated_half_life_seconds: Infinity,
        recent_half_life_seconds: RECENT_HALF_LIFE_SECONDS,
        // Threshold chosen below what one priming bump produces but
        // well above what 6 half-lives leave of any reasonable buffer.
        // Carol/Erin/Frank all sit comfortably above it during the
        // priming phase; after the quiet window, all three are below
        // — but only Carol is the one we test here, since the
        // patient-adversary signature is precisely "stops being
        // active after priming." Erin and Frank's gate behavior
        // after the window is the same as Carol's by symmetry; the
        // distinguishing feature is *the choice not to be active*,
        // which is a population-level model decision, not a server-
        // visible one.
        assignment_min_recent: 0.5,
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

    // Priming anchors + first contested anchor (same as bookkeeping
    // scenario).
    for (let i = 1; i <= PRIMING_COUNT; i++) {
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
    const contestedAnchorProp = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper contested',
        external_ref: { kind: 'pmid', value: '99' },
      },
    );
    server.curator.acceptProposal(contestedAnchorProp.proposal_id);
    const firstContestedAnchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper contested',
    );
    if (!firstContestedAnchorNode) throw new Error('first contested anchor not materialized');
    const firstContestedAnchorId = firstContestedAnchorNode.id;

    // Bob proposes priming excerpts + the first contested excerpt.
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobClient = await wireArchetype(server, bob.id);
    const provider: ContentProvider = {
      forAnchor: (anchorId) =>
        anchorId === firstContestedAnchorId
          ? {
              content: 'treatment X has no effect for stage IV',
              quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
            }
          : {
              content: 'treatment X works for stage III',
              quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
            },
    };
    await runHonestStrong(bobClient, {
      cause_id: cause.id,
      rate: 10,
      kinds: ['excerpt'],
      content: provider,
    });

    // Carol — patient adversary, runs first so all priming excerpts
    // are still staged when she votes.
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const carolClient = await wireArchetype(server, carol.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 20,
      decide: calAwareBiasedDecider,
    });

    // Erin and Frank — honest reviewers.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 20,
      decide: acceptAllDecider,
    });
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const frankClient = await wireArchetype(server, frank.id);
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 20,
      decide: acceptAllDecider,
    });

    // First contested target lands accepted: Erin + Frank's accepts
    // hit the gate before Carol's reject finds a partner. Same
    // outcome as the bookkeeping scenario — convergence holds
    // independently of the gate.
    const firstContestedExcerpt = [...server.store.proposals.values()].find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    expect(firstContestedExcerpt?.status).toBe('accepted');

    // Snapshot Carol's recent immediately post-drift — comfortably
    // above threshold from the priming + calibration accumulation.
    const carolRepBefore = await carolClient.queryReputation({ cause_id: cause.id });
    const carolRecentBefore =
      carolRepBefore.entries.find((e) => e.sub_topic_id === subTopic.id)?.recent ?? 0;
    expect(carolRecentBefore).toBeGreaterThan(server.review.assignment_min_recent);

    // The quiet window — six recent half-lives. Carol stops being
    // active by definition of the patient-adversary archetype.
    const QUIET_HALF_LIVES = 6;
    clock.advance(RECENT_HALF_LIFE_SECONDS * QUIET_HALF_LIVES * 1000);

    // Carol's recent has now fallen below threshold. Confirm before
    // the gate-firing assertion.
    const carolRepAfter = await carolClient.queryReputation({ cause_id: cause.id });
    const carolRecentAfter =
      carolRepAfter.entries.find((e) => e.sub_topic_id === subTopic.id)?.recent ?? 0;
    expect(carolRecentAfter).toBeLessThan(server.review.assignment_min_recent);

    // Stage a fresh contested anchor + excerpt. Carol's drift target
    // for the second attempt — she'd vote `reject` if assigned, same
    // as the first contested item.
    const secondContestedAnchorProp = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper contested 2',
        external_ref: { kind: 'pmid', value: '100' },
      },
    );
    server.curator.acceptProposal(secondContestedAnchorProp.proposal_id);
    const secondContestedAnchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper contested 2',
    );
    if (!secondContestedAnchorNode) throw new Error('second contested anchor not materialized');
    await server.tools.proposeExcerpt(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: secondContestedAnchorNode.id,
        content: 'treatment X has no effect for stage IV again',
        quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
      },
    );

    // The gate fires: Carol's recent is below threshold and she has
    // rep entries in the cause, so the bypass doesn't apply.
    // request_assignment surfaces `not_found` over the wire.
    await expect(carolClient.requestAssignment({ cause_id: cause.id })).rejects.toMatchObject({
      code: 'not_found',
    });

    // Drift bandwidth: 1, not the cumulative-buffer figure the
    // bookkeeping scenario pinned. Carol can no longer pull a fresh
    // assignment to drift on. The gate replaces the cumulative-
    // buffer ceiling with a recent-activity floor.
    const driftAttempts = [...server.store.reviewVotes.values()].filter(
      (v) => v.reviewer_id === carol.id && v.decision === 'reject',
    );
    expect(driftAttempts).toHaveLength(1);
  });

  it('eligibility-tier gate: a fresh identity is refused at request_assignment, the contributor-initiated path graduates them (PRD §Reputation, demonstrated gates eligibility tiers)', async () => {
    // Companion gate to assignment_min_recent — same seam
    // (request_assignment), opposite null-policy. The recent gate
    // bypasses callers with no rep entries because they have no
    // recent activity yet (fresh-reviewer bootstrap on the assigned
    // path). The demonstrated gate *fires against* callers with no
    // rep entries: the demonstrated tier is "have you proven yourself
    // yet?" and an unproven identity is by construction not in the
    // pool. Bootstrap is contributor-initiated voting / direct
    // proposing — both earn rep without going through the gate.
    //
    // The architectural property: the cost a fresh-identity coalition
    // pays. PRD §Adversary taxonomy (sybil-amplified coalition)
    // names the seam — behavior-dependent defenses (cluster signal,
    // calibration record, reputation) all need accumulated history
    // per identity, so a freshly minted identity used exactly once
    // routes around them. The demonstrated-tier gate forces each
    // fresh identity to first traverse the contributor-initiated
    // path, building visible activity before becoming assignable.
    // The identity-binding-cost / rate-limited-issuance defenses PRD
    // §Identity names live below this layer (the freshness-bypass
    // scenario above pins that); this gate is the read-side that
    // surfaces unproven identities to the assignment surface.
    //
    // Pin: the gate fires before bootstrap (fresh identity refused
    // with not_found) and lets her in after enough contributor-
    // initiated rep accrues. The gate threshold and per-vote rep
    // gain together set the bootstrap traversal length the testbed
    // sweeps; this scenario locks in the shape, not specific values.
    const sources = new Map<string, string>();
    for (let i = 1; i <= 4; i++) {
      sources.set(
        String(i),
        `arm A${i}: treatment X works in stage III patients across the cohort`,
      );
    }
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('etg'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        // Threshold reachable after two accurate contributor-initiated
        // accept votes (reviewer_accurate_gain = 1 each, no factor on
        // reviewer rep), but blocking a zero-rep identity. The exact
        // value is a testbed knob; what's pinned here is the shape.
        assignment_min_demonstrated: 1.5,
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

    // Stage anchors and excerpts. Anchors are accepted by the
    // curator (`paper 1..4`), excerpts are staged directly by alice
    // — going through an honest-strong proposer here would itself
    // hit the gate (a fresh identity calling request_assignment for
    // a propose-task is gated the same way Eve's review-task call
    // is). Proposing via the contributor-initiated path is the
    // bootstrap that the gate is designed to leave open; the test
    // just exercises that path on alice's end as fixture setup.
    for (let i = 1; i <= 4; i++) {
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
    const anchorNodes = [...server.store.nodes.values()].filter((n) => n.kind === 'anchor');
    expect(anchorNodes).toHaveLength(4);
    for (const anchor of anchorNodes) {
      await server.tools.proposeExcerpt(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          parent_anchor_id: anchor.id,
          content: `treatment X works for stage III (${anchor.id})`,
          quoted_span: {
            text: 'treatment X works in stage III patients',
            offset: 0,
          },
        },
      );
    }

    // Eve mints fresh, declares cause-level capacity, and tries to
    // pull an assignment. The gate fires: zero rep entries in the
    // cause means the demonstrated max is null, which fails the
    // gate at any threshold > 0.
    const eve = server.bootstrap.mintIdentity({ display_name: 'eve' });
    const eveClient = await wireArchetype(server, eve.id);
    await eveClient.setCapacity({
      cause_id: cause.id,
      rate: 10,
      kinds: ['review', 'excerpt'],
    });
    await expect(eveClient.requestAssignment({ cause_id: cause.id })).rejects.toMatchObject({
      code: 'not_found',
    });

    // Bootstrap path: contributor-initiated cast_review_vote. Eve
    // votes on staged excerpts directly (no assignment_id). She needs
    // a partner accept on each so the proposal converges and reviewer
    // rep is awarded — Erin, who has set capacity but is also fresh
    // and so also subject to the gate, votes alongside Eve via the
    // same contributor-initiated path. Both graduate symmetrically;
    // we focus the assertion on Eve.
    const stagedExcerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt' && p.status === 'staged',
    );
    expect(stagedExcerpts.length).toBeGreaterThanOrEqual(2);
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    for (let i = 0; i < 2; i++) {
      const target = stagedExcerpts[i];
      if (!target) throw new Error(`expected staged excerpt at index ${i}`);
      const proposalId = target.id;
      await eveClient.castReviewVote({
        proposal_id: proposalId,
        decision: 'accept',
        rationale: 'well-grounded; quoted span matches the source',
      });
      await erinClient.castReviewVote({
        proposal_id: proposalId,
        decision: 'accept',
        rationale: 'agrees',
      });
    }

    // Two convergences against Eve's accurate accepts → demonstrated
    // = 2.0, above the 1.5 threshold. The bootstrap path neither
    // requires nor consumes an assignment.
    const eveRep = await eveClient.queryReputation({ cause_id: cause.id });
    const eveDemonstrated = eveRep.entries.reduce(
      (m, e) => Math.max(m, e.demonstrated),
      Number.NEGATIVE_INFINITY,
    );
    expect(eveDemonstrated).toBeGreaterThanOrEqual(server.review.assignment_min_demonstrated);

    // Gate now opens. Eve graduates and pulls her first assignment.
    const assignment = await eveClient.requestAssignment({ cause_id: cause.id });
    expect(assignment.assignment_id).toBeDefined();
  });

  it('decline-pattern assignment gate: cumulative decline rate above threshold refuses further assignments (PRD §Capacity and assignment, decline-pattern abuse signal)', async () => {
    // First defense knob for the multi-proposal coalition seam pinned
    // by the standalone scenario above. The seam evades the cluster
    // signal by paired-decline (no co-voting → no shared history → no
    // edge metric to fire); the curator-side decline-pattern projection
    // already surfaces the coalition by per-cause rate, and this gate
    // elevates the same signal — same numerator, same denominator,
    // same per-cause scope — into an assignment-time enforcement
    // primitive at the rep-gate seam in `request_assignment`. The
    // closure on the seam is throughput-mediated, not retroactive: the
    // gate doesn't undo a lone-reject that already landed, it caps the
    // rate at which the coalition can place new ones — for a
    // coalition that paired-declines half its offers, the gate fires
    // after the second decline and locks the member out of further
    // routing. The orthogonal-defenses ASR cube against the cluster
    // signal lands in the next cycle; this test pins the gate's
    // mechanics standalone first.
    //
    // Properties pinned:
    //   1. Above threshold + above min_offers → request_assignment refused.
    //   2. Above threshold but below min_offers → bypass (small-sample
    //      floor — the same min_offers role on `declinePatterns`).
    //   3. Fresh reviewer (zero offers) → bypass (bootstrap path, same
    //      null-policy as the recent-activity gate).
    //   4. Contributor-initiated path (cast_review_vote without
    //      assignment_id) → bypass: a contributor whose decline rate
    //      has spiked retains the recovery path PRD §Capacity and
    //      assignment names ("Declining individual assignments is
    //      non-punitive on its own").
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('dg'),
      verifier: new FakeVerifier(),
      review: {
        // Threshold below which the gate stays inert. Carol declines
        // every offer, so her rate is 1.0 once any offer lands; the
        // 0.5 threshold catches that, the 2.0 min_offers floor delays
        // the catch by one offer so Property 2 has something to pin.
        assignment_max_decline_rate: 0.5,
        assignment_decline_min_offers: 2,
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

    // Stage four anchor proposals so the frontier has enough
    // distinct review tasks to offer Carol multiple times — declines
    // are a stable signal so the same target won't be re-offered to
    // the same contributor.
    for (let i = 0; i < 4; i++) {
      await server.tools.proposeAnchor(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `paper ${i}`,
        external_ref: { kind: 'pmid', value: String(100 + i) },
      });
    }

    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const carolClient = await wireArchetype(server, carol.id);
    await carolClient.setCapacity({ cause_id: cause.id, rate: 5, kinds: ['review'] });

    // Property 3: zero-offer bypass. Carol's first request goes
    // through — she has no decline history, so the gate has no
    // signal to fire on.
    const a1 = await carolClient.requestAssignment({ cause_id: cause.id });
    await carolClient.declineAssignment({ assignment_id: a1.assignment_id, reason: 'not now' });
    // After: offers=1, declines=1, rate=1.0. Above threshold, below
    // min_offers floor.

    // Property 2: rate above threshold but offers below min_offers
    // → bypass. The same numerator and denominator the curator-side
    // projection projects — at min_offers=2 the gate ignores Carol
    // for the same reason a curator running `declinePatterns` with
    // its v0 default min_offers=3 wouldn't surface her yet.
    const a2 = await carolClient.requestAssignment({ cause_id: cause.id });
    await carolClient.declineAssignment({ assignment_id: a2.assignment_id, reason: 'still not' });
    // After: offers=2, declines=2, rate=1.0. At/above min_offers
    // floor now.

    // Property 1: gate fires. Carol's third request is refused with
    // `not_found` — same refusal mode the rep gates use, so the
    // contributor-facing surface stays structurally indistinguishable
    // from "no work available."
    await expect(carolClient.requestAssignment({ cause_id: cause.id })).rejects.toMatchObject({
      code: 'not_found',
    });

    // Confirm the gate's view of Carol's stats matches the curator-
    // side projection's view byte-for-byte: same offers, same
    // declines, same rate. The point of this gate is to operate on
    // the projection's signal, not a separate one — verifying parity
    // here keeps the contract honest.
    const patterns = server.curator.declinePatterns(cause.id, { min_offers: 1 });
    const carolPattern = patterns.find((p) => p.identity_id === carol.id);
    if (!carolPattern) throw new Error('expected carol in decline-pattern projection');
    expect(carolPattern.offers).toBe(2);
    expect(carolPattern.declines).toBe(2);
    expect(carolPattern.decline_rate).toBe(1.0);

    // Property 3 again, in the gate-on regime: a fresh reviewer with
    // zero offers walks through. The bootstrap path stays open; the
    // gate fires only against a built-up decline history.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await erinClient.setCapacity({ cause_id: cause.id, rate: 5, kinds: ['review'] });
    const erinAssignment = await erinClient.requestAssignment({ cause_id: cause.id });
    expect(erinAssignment.task.kind).toBe('review');

    // Property 4: contributor-initiated path bypasses the gate.
    // Carol is locked out of `request_assignment` but can still cast
    // a contributor-initiated vote on a proposal she didn't author —
    // PRD §Capacity and assignment names this as the recovery path
    // and the conflict-of-interest gate (caller != proposer) doesn't
    // trip since Alice proposed all four anchors. Carol's vote is
    // recorded, with the contributor-initiated rep factor applied
    // (PRD §Reputation). The gate lives inside `request_assignment`,
    // not on the vote-cast path, so this bypass is by construction.
    if (erinAssignment.task.kind !== 'review') throw new Error('expected review task');
    const targetProposalId = erinAssignment.task.proposal_id;
    const carolVote = await carolClient.castReviewVote({
      proposal_id: targetProposalId,
      decision: 'accept',
      rationale: 'looks fine on the contributor-initiated path',
    });
    expect(carolVote).toBeDefined();
    const recorded = [...server.store.reviewVotes.values()].find(
      (v) => v.reviewer_id === carol.id && v.proposal_id === targetProposalId,
    );
    expect(recorded?.decision).toBe('accept');
  });

  // Parameter sweep over the (coalition pattern, anti-correlation
  // threshold, contention-weighted) cube. PRD §Adversary testbed
  // (Architecture, "Parameter sweeps") commits this shape as the
  // Phase 1 exit-criterion piece. The cells assert the per-cell
  // outcome directly so the matrix is locked in as an invariant
  // a contributor can verify by reading the test names alone.
  //
  // The scenario is the same as the standalone decorrelation /
  // mixed-strategy / composition tests, parametrized on the priming
  // pattern (Carol+Dave's vote pairs across four shared proposals)
  // and on the two cluster-signal knobs:
  //   - mixed (50/50 agreement/disagreement on priming): defeats
  //     each single-ratio refinement alone, closes only under the
  //     composition of contention weighting + anti-correlation.
  //   - decorrelating (perfect anti-correlation on priming):
  //     defeats raw clustering, closes under any positive
  //     anti-correlation threshold ≤ 1.0.
  //
  // Expected outcomes follow the cluster-signal logic: threshold
  // 0 disables anti-correlation (bypass open at any pattern);
  // threshold 0.5 catches both patterns; threshold 1.0 catches
  // perfect decorrelation directly, and catches the mixed pattern
  // *only* when contention weighting collapses the weighted
  // disagreement to 1.0 by zeroing out the unanimous-easy cells.
  // The 12-cell cube exercises all four corners of the closure.
  type CarolDaveVote = 'accept' | 'reject';
  type PrimingPattern = Array<[CarolDaveVote, CarolDaveVote]>;
  const PATTERN_MIXED: PrimingPattern = [
    ['accept', 'accept'],
    ['accept', 'reject'],
    ['reject', 'accept'],
    ['reject', 'reject'],
  ];
  const PATTERN_DECORRELATED: PrimingPattern = [
    ['accept', 'reject'],
    ['accept', 'reject'],
    ['accept', 'reject'],
    ['accept', 'reject'],
  ];
  // Run the decorrelation/mixed-strategy scenario end-to-end with
  // the given knobs, returning the contested proposal's status.
  // Same identities, anchors, priming, contested excerpt, and
  // archetype runs as the standalone tests; only the parametrized
  // bits vary.
  // Shared runner for the multi-round paired-decline closure scenario
  // (the standalone test above) and the cluster-decline sweep cube
  // below. PRD §Reviewer assignment commits the encounter-domain
  // widening; this scenario is the whole-scenario closure that lands
  // on the proposal's terminal status rather than the cluster
  // primitive in isolation.
  //
  // Round 1 (priming on separate excerpts). Carol+Dave run paired
  // declines: Carol accepts primingA + declines primingB, Dave
  // mirrors. Erin closes both priming proposals at the second accept.
  // After this sub-block both priming proposals are accepted and the
  // encounter ledger has the paired-decline shape that lights up
  // anti-correlation under the decline-aware encounter domain.
  //
  // Round 2 (suppression on a fresh contested target). Carol's loop
  // votes reject first, then Dave's loop attempts the suppression:
  // knob-off → Dave is offered contested, votes the second reject,
  // status flips to 'rejected' before Frank/Hank can vote;
  // knob-on → cross-stratum gate fires (Carol's stratum already
  // routed), Dave idles, Frank/Hank walk in fresh-singleton and the
  // proposal converges 'accepted'. The two halves run on the same
  // defense stack; only `stratum_include_declines` varies.
  //
  // Contention-weighted edges default *off* in this runner. Under
  // decline-aware + contention-weighted at threshold 1.0 with a
  // floor of 1, a single decline-involved disagreement between an
  // honest reviewer and a coalition member outweighs every
  // unanimous-easy vote-agreement (contention 0 → weight 0), and
  // honest reviewers false-cluster with the coalition. That
  // interaction is exercised standalone by the over-clustering
  // scenario above and joined to this runner in the cluster-decline
  // × floor sweep cube downstream; for the multi-round closure
  // standalone test the stack stays at raw weights with the floor
  // default so the honest pool reads as singletons and the
  // decline-aware primitive's effect on outcome is isolated.
  async function runMultiRoundDeclineClosureScenario(params: {
    stratum_include_declines: boolean;
    stratum_contention_weighted?: boolean;
    stratum_decline_min_paired?: number;
  }): Promise<{ contested_status: 'staged' | 'accepted' | 'rejected' | 'unresolved-archived' }> {
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients across cohort A'],
      ['3', 'arm C: treatment X has no effect in stage IV patients across cohort B'],
    ]);
    const cw = params.stratum_contention_weighted ?? false;
    const floor = params.stratum_decline_min_paired ?? 2;
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen(
        `mr-${params.stratum_include_declines ? 'on' : 'off'}-cw${cw ? '1' : '0'}-f${floor}`,
      ),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_anti_correlation_threshold: 1.0,
        stratum_contention_weighted: cw,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        stratum_include_declines: params.stratum_include_declines,
        stratum_decline_min_paired: floor,
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

    // Three anchors: one per priming target + one for the contested
    // target. Curator-accepted so the excerpts have a parent.
    const anchorIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const ap = await server.tools.proposeAnchor(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `paper ${i}`,
        external_ref: { kind: 'pmid', value: String(i + 1) },
      });
      server.curator.acceptProposal(ap.proposal_id);
      const node = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
      );
      if (!node) throw new Error(`anchor ${i} not materialized`);
      anchorIds.push(node.id);
    }

    // Round 1: two priming excerpts. Distinct content tags
    // ("primingA" / "primingB") let the per-member decliner key on
    // payload to take exactly one and decline the other. Quoted-span
    // text is the bias-zone phrase so the verifier accepts each
    // independently.
    await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorIds[0]!,
      content: 'primingA: treatment X has no effect in stage IV cohort A',
      quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
    });
    await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorIds[1]!,
      content: 'primingB: treatment X has no effect in stage IV cohort B',
      quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
    });

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const hank = server.bootstrap.mintIdentity({ display_name: 'hank' });
    const erinClient = await wireArchetype(server, erin.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    const frankClient = await wireArchetype(server, frank.id);
    const hankClient = await wireArchetype(server, hank.id);

    // Priming-round deciders. Carol accepts primingA, declines
    // primingB. Dave mirrors. Fallback is acceptAllDecider so the
    // priming behavior is benign on whichever target each takes
    // (no biased votes during priming — the only signal that forms
    // the cluster is the paired-decline shape).
    const carolPrimerDecider = payloadDecliningDecider({
      declineIf: (payload) => 'content' in payload && payload.content.includes('primingB'),
      fallback: acceptAllDecider,
    });
    const davePrimerDecider = payloadDecliningDecider({
      declineIf: (payload) => 'content' in payload && payload.content.includes('primingA'),
      fallback: acceptAllDecider,
    });

    // Run priming. Order matters: Carol first lays down vote-on-A +
    // decline-on-B, Dave then mirrors as decline-on-A + vote-on-B
    // (frontier FIFO returns A then B for each), Erin closes both
    // priming proposals at the second accept apiece. After this
    // sub-block, both priming proposals are accepted and the
    // encounter ledger has the paired-decline shape.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: carolPrimerDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: davePrimerDecider,
    });
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    // Priming-round soft sanity: under the standalone runner config
    // (cw=off, floor=2) the priming proposals reliably converge
    // accepted because the cluster signal stays decline-blind in the
    // raw-weight regime until both pair encounters are recorded. The
    // cube downstream exercises (cw=on, floor=1) regimes where the
    // over-clustering pathology causes Erin's vote to retroactively
    // expand the false cluster and stratification-degraded
    // tightening blocks priming itself. The runner does not throw on
    // priming failure: the cube reads contested_status directly, and
    // a contested target that never converges (because the priming
    // infrastructure broke) reads identically to suppression-by-
    // archival from the proposer's perspective. Cell expectations
    // encode whether each (cw, floor) combination is supposed to
    // keep the priming infrastructure intact.

    // Round 2: stage the contested target. Bias-zone content so
    // calAwareBiasedDecider rejects ("treatment" + no "works").
    const contested = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorIds[2]!,
      content: 'contested: treatment X has no effect in stage IV cohort C',
      quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
    });

    // Suppression attempt. Carol votes reject first. Dave's loop
    // then runs — knob-off: gets contested, votes the second
    // reject, status flips before Frank/Hank vote; knob-on: gated
    // out, idles, leaving room for Frank+Hank to converge accept.
    // Frank and Hank are introduced fresh in round 2 so each lands
    // in a singleton stratum at the gate's eyes.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(hankClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    if (!target) throw new Error('contested proposal vanished');
    return { contested_status: target.status };
  }

  // Shared runner for the contention-weighted + decline-aware
  // over-clustering scenario (the standalone test above) and the
  // cluster-decline × floor sweep cube downstream. Three honest
  // reviewers prime on two unanimous-easy excerpts, one declines a
  // third "trigger" excerpt while the other two vote accept on it
  // (single asymmetric decline-involved encounter per honest pair),
  // and a contested target is then staged. PRD §Reviewer assignment
  // commits the paired-decline floor on contention-weighting's full-
  // weight rule for declines; this runner exposes how that floor
  // composes with `stratum_contention_weighted`. Declines stay on
  // throughout — the scenario is defined on the decline-aware
  // encounter domain, and the cube reads the (cw, floor) interaction
  // under that fixed regime.
  async function runOverClusteringScenario(params: {
    stratum_contention_weighted: boolean;
    stratum_decline_min_paired: number;
  }): Promise<{ contested_status: 'staged' | 'accepted' | 'rejected' | 'unresolved-archived' }> {
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X works in stage III patients across cohort A'],
      ['3', 'arm C: treatment X works in stage III patients across cohort B'],
      ['4', 'arm D: treatment X works in stage III patients across cohort C'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen(
        `oc-cw${params.stratum_contention_weighted ? '1' : '0'}-f${params.stratum_decline_min_paired}`,
      ),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_anti_correlation_threshold: 1.0,
        stratum_contention_weighted: params.stratum_contention_weighted,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        stratum_include_declines: true,
        stratum_decline_min_paired: params.stratum_decline_min_paired,
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

    const anchorIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const ap = await server.tools.proposeAnchor(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `paper ${i}`,
        external_ref: { kind: 'pmid', value: String(i + 1) },
      });
      server.curator.acceptProposal(ap.proposal_id);
      const node = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
      );
      if (!node) throw new Error(`anchor ${i} not materialized`);
      anchorIds.push(node.id);
    }

    const primingA = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorIds[0]!,
      content: 'primingA: treatment X works in stage III cohort A',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
    });
    const primingB = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorIds[1]!,
      content: 'primingB: treatment X works in stage III cohort B',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
    });

    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    const erinClient = await wireArchetype(server, erin.id);

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
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    if (server.store.proposals.get(primingA.proposal_id)?.status !== 'accepted') {
      throw new Error('primingA did not converge accepted in priming round');
    }
    if (server.store.proposals.get(primingB.proposal_id)?.status !== 'accepted') {
      throw new Error('primingB did not converge accepted in priming round');
    }

    const trigger = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorIds[2]!,
      content: 'trigger: treatment X works in stage III cohort C',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
    });
    const carolTriggerDecider = payloadDecliningDecider({
      declineIf: (payload) => 'content' in payload && payload.content.includes('trigger'),
      fallback: acceptAllDecider,
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: carolTriggerDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    if (server.store.proposals.get(trigger.proposal_id)?.status !== 'accepted') {
      throw new Error('trigger did not converge accepted in event round');
    }

    const contested = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchorIds[3]!,
      content: 'contested: treatment X works in stage III cohort D',
      quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
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
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    server.clock.advance(120_000);
    server.curator.archiveStaleProposals({ window_seconds: 60, cause_id: cause.id });

    const target = server.store.proposals.get(contested.proposal_id);
    if (!target) throw new Error('contested proposal vanished');
    return { contested_status: target.status };
  }

  async function runDecorrelationScenario(params: {
    pattern: PrimingPattern;
    anti_correlation_threshold: number;
    contention_weighted: boolean;
    // Decline-aware encounter domain (PRD §Reviewer assignment, "the
    // encounter domain becomes {accept, reject, decline}"). Default
    // off so the legacy 12 cells continue to exercise vote-only
    // semantics; the cluster-decline cube downstream toggles this on
    // alongside the paired-decline runner to assert the widening is
    // non-regressive against a pure co-voting pattern.
    stratum_include_declines?: boolean;
  }): Promise<{ contested_status: 'staged' | 'accepted' | 'rejected' | 'unresolved-archived' }> {
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
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_anti_correlation_threshold: params.anti_correlation_threshold,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        stratum_contention_weighted: params.contention_weighted,
        stratum_include_declines: params.stratum_include_declines ?? false,
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
    for (let i = 0; i < params.pattern.length; i++) {
      const excerpt = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      const cell = params.pattern[i];
      if (!cell) throw new Error('pattern out of range');
      const [carolVote, daveVote] = cell;
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: carolVote,
          rationale:
            carolVote === 'accept'
              ? 'consistent with my read of the literature'
              : 'underpowered, methodological concerns',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: excerpt.proposal_id,
          decision: daveVote,
          rationale:
            daveVote === 'accept'
              ? 'consistent with my read of the literature'
              : 'underpowered, methodological concerns',
        },
      );
      const after = server.store.proposals.get(excerpt.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(excerpt.proposal_id);
      }
    }
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
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    const target = server.store.proposals.get(contested.proposal_id);
    if (!target) throw new Error('contested proposal vanished');
    return { contested_status: target.status };
  }

  interface SweepCell {
    name: string;
    pattern: PrimingPattern;
    anti_correlation_threshold: number;
    contention_weighted: boolean;
    expected_status: 'staged' | 'rejected';
  }
  const sweepCells: SweepCell[] = [
    // anti-corr disabled: bypass open in every cell.
    {
      name: 'mixed pattern, threshold=0, raw edges (bypass open)',
      pattern: PATTERN_MIXED,
      anti_correlation_threshold: 0,
      contention_weighted: false,
      expected_status: 'rejected',
    },
    {
      name: 'mixed pattern, threshold=0, contention-weighted (bypass open)',
      pattern: PATTERN_MIXED,
      anti_correlation_threshold: 0,
      contention_weighted: true,
      expected_status: 'rejected',
    },
    {
      name: 'decorrelated pattern, threshold=0, raw edges (bypass open)',
      pattern: PATTERN_DECORRELATED,
      anti_correlation_threshold: 0,
      contention_weighted: false,
      expected_status: 'rejected',
    },
    {
      name: 'decorrelated pattern, threshold=0, contention-weighted (bypass open)',
      pattern: PATTERN_DECORRELATED,
      anti_correlation_threshold: 0,
      contention_weighted: true,
      expected_status: 'rejected',
    },
    // threshold=0.5 catches both patterns regardless of weighting.
    {
      name: 'mixed pattern, threshold=0.5, raw edges (boundary fires)',
      pattern: PATTERN_MIXED,
      anti_correlation_threshold: 0.5,
      contention_weighted: false,
      expected_status: 'staged',
    },
    {
      name: 'mixed pattern, threshold=0.5, contention-weighted (boundary fires)',
      pattern: PATTERN_MIXED,
      anti_correlation_threshold: 0.5,
      contention_weighted: true,
      expected_status: 'staged',
    },
    {
      name: 'decorrelated pattern, threshold=0.5, raw edges (fires)',
      pattern: PATTERN_DECORRELATED,
      anti_correlation_threshold: 0.5,
      contention_weighted: false,
      expected_status: 'staged',
    },
    {
      name: 'decorrelated pattern, threshold=0.5, contention-weighted (fires)',
      pattern: PATTERN_DECORRELATED,
      anti_correlation_threshold: 0.5,
      contention_weighted: true,
      expected_status: 'staged',
    },
    // threshold=1.0: closes the decorrelated pattern outright; only
    // closes the mixed pattern when contention-weighted reweights
    // the disagreement ratio back to 1.0.
    {
      name: 'mixed pattern, threshold=1.0, raw edges (gap, bypass open)',
      pattern: PATTERN_MIXED,
      anti_correlation_threshold: 1.0,
      contention_weighted: false,
      expected_status: 'rejected',
    },
    {
      name: 'mixed pattern, threshold=1.0, contention-weighted (composition closes)',
      pattern: PATTERN_MIXED,
      anti_correlation_threshold: 1.0,
      contention_weighted: true,
      expected_status: 'staged',
    },
    {
      name: 'decorrelated pattern, threshold=1.0, raw edges (closes)',
      pattern: PATTERN_DECORRELATED,
      anti_correlation_threshold: 1.0,
      contention_weighted: false,
      expected_status: 'staged',
    },
    {
      name: 'decorrelated pattern, threshold=1.0, contention-weighted (closes)',
      pattern: PATTERN_DECORRELATED,
      anti_correlation_threshold: 1.0,
      contention_weighted: true,
      expected_status: 'staged',
    },
  ];
  it.each(sweepCells)('parameter sweep: $name → contested $expected_status', async ({
    pattern,
    anti_correlation_threshold,
    contention_weighted,
    expected_status,
  }) => {
    const result = await runDecorrelationScenario({
      pattern,
      anti_correlation_threshold,
      contention_weighted,
    });
    expect(result.contested_status).toBe(expected_status);
  });

  it('parameter sweep cube: attack-success-rate aggregates by defense config', () => {
    // PRD §Adversary testbed (Architecture, "Parameter sweeps"):
    // "attack-success rates measured" — the Phase-1 exit-criterion
    // artifact is a table of attack-success-rate per defense config
    // across attack populations. The per-cell `it.each` above locks
    // each individual outcome as an invariant; this test layers on
    // the *aggregate* shape — the metric the published results post
    // would tabulate. Together: the per-cell tests ground the
    // observations; the aggregate test grounds the claim about what
    // those observations sum to.
    //
    // The aggregator groups sweepCells by (anti_correlation_threshold,
    // contention_weighted) — the two defense knobs in the v0 cube —
    // and counts how many of the {mixed, decorrelated} attack
    // patterns reach `rejected` (attack succeeded: the contested
    // well-grounded excerpt was suppressed). Computed off the static
    // expected_status fields, not by re-running the scenario, so the
    // test is fast and the aggregate stays a *derived* metric over
    // observations the per-cell tests already validated.
    //
    // Future sweeps will widen this shape — more attack patterns,
    // more knob axes, finer attack-success-rate resolution — and the
    // assertion shape (named defense config → expected ASR) is the
    // template they'll follow.
    interface AsrCell {
      anti_correlation_threshold: number;
      contention_weighted: boolean;
      total: number;
      attacks_succeeded: number;
    }
    const grouped = new Map<string, AsrCell>();
    for (const cell of sweepCells) {
      const key = `${cell.anti_correlation_threshold}|${cell.contention_weighted}`;
      const g = grouped.get(key) ?? {
        anti_correlation_threshold: cell.anti_correlation_threshold,
        contention_weighted: cell.contention_weighted,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_status === 'rejected') g.attacks_succeeded += 1;
      grouped.set(key, g);
    }
    const asr = (key: string): number => {
      const g = grouped.get(key);
      if (!g) throw new Error(`missing defense config: ${key}`);
      return g.attacks_succeeded / g.total;
    };

    // Anti-correlation disabled: every attack pattern in the cube
    // succeeds at suppressing the contested target (ASR = 100%),
    // regardless of contention weighting. This is the floor the
    // refinements lift off.
    expect(asr('0|false')).toBe(1);
    expect(asr('0|true')).toBe(1);
    // Anti-correlation at the boundary threshold of 0.5 catches both
    // attack patterns in this cube — perfect decorrelation trips it
    // outright, and the mixed pattern's weighted disagreement also
    // crosses 0.5. ASR = 0%.
    expect(asr('0.5|false')).toBe(0);
    expect(asr('0.5|true')).toBe(0);
    // Anti-correlation at threshold 1.0 alone catches only the
    // perfect-decorrelation pattern; the mixed pattern's raw
    // disagreement ratio sits at 0.5 and slips through. ASR = 50%
    // — the gap that motivated contention weighting.
    expect(asr('1|false')).toBe(0.5);
    // Composition (anti-correlation 1.0 + contention-weighted edges)
    // closes the gap: contention weighting collapses the mixed
    // pattern's weighted disagreement back to 1.0, both patterns
    // trip. Full defense → ASR = 0%.
    expect(asr('1|true')).toBe(0);

    // Coverage invariant: every (threshold, contention) pair in the
    // cube has both attack patterns. If a future cell expansion
    // breaks this symmetry the assertion fires, forcing the aggregate
    // to be re-keyed rather than silently averaging over uneven
    // groups.
    for (const cell of grouped.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Second parameter sweep cube: assignment-gate thresholds against
  // the patient-adversary and sybil-amplified-coalition archetypes.
  // PRD §Adversary testbed (Architecture, "Parameter sweeps") names
  // the shape — named defense config to expected attack-success-rate,
  // computed off static expected fields the per-cell tests already
  // validated. Same template as the decorrelation cube above; the
  // axes change but the assertion shape doesn't.
  //
  // Defense knobs in this cube:
  //   - assignment_min_recent (PRD §Reputation): the recent-activity
  //     gate. Fires on a caller whose decayed recent has fallen below
  //     threshold, with fresh-reviewer bypass so first-assignment
  //     bootstrap stays open. Closes the patient-adversary loop —
  //     once-active-now-quiet is the archetype's signature, and the
  //     gate makes drift bandwidth = 1 instead of cumulative.
  //   - assignment_min_demonstrated (PRD §Reputation): the
  //     eligibility-tier gate. Fires on a caller with no rep entries
  //     in the cause when threshold > 0; opposite null-policy from
  //     the recent gate, and the architectural cost a fresh-identity
  //     coalition pays before being drawn for review.
  //
  // Attack patterns in this cube:
  //   - patient: solo calibration-aware biased reviewer who primes,
  //     drifts on a first contested target, sits out a quiet window
  //     past several recent-half-lives, and tries a fresh drift on a
  //     second contested target. Attack succeeds if the second drift
  //     vote lands.
  //   - sybil: established Carol+Dave coalition with shared priming
  //     history (cluster signal detects), recruits fresh Eve. Carol
  //     votes the contested target, Dave is gated out by the cross-
  //     stratum draw, Eve walks in if the demo gate doesn't fire.
  //     Attack succeeds if the contested target ends rejected.
  //
  // Expected ASR shape: each gate closes its named pattern
  // independent of the other knob. Both gates off → 100% (both
  // attacks succeed); recent gate alone → 50% (patient closes,
  // sybil bypasses); demo gate alone → 50% (sybil closes, patient
  // bypasses); both on → 0%. The orthogonality is the headline.
  type GateAttackPattern = 'patient' | 'sybil';

  // Patient-adversary runner: bootstrap-honestly + prime + first
  // drift + quiet window + second drift attempt. Mirrors the
  // standalone "assignment gate refuses a drained adversary"
  // scenario above; the standalone test pins the within-cell
  // invariants this runner would otherwise hide. attack_succeeded
  // is "did Carol's second drift vote land", measured by counting
  // her reject votes (1 = first drift only, gate worked; 2 = both
  // drifts landed, gate did not).
  //
  // The bootstrap phase is what makes the patient archetype
  // *patient*: real-world patient adversaries build reputation
  // honestly over months before drift attempts (PRD §Adversary
  // taxonomy, Patient adversary). The standalone gate scenario
  // skips this phase because it has the demo gate at 0 — Carol
  // walks into request_assignment from zero rep without trouble.
  // Once the demo gate is non-zero, fresh identities fail at
  // request_assignment regardless of intent (PRD §Reputation,
  // demonstrated gates eligibility tiers); a runner that doesn't
  // bootstrap collapses patient-adversary into fresh-coalition,
  // which conflates the two archetypes the cube is trying to
  // separate. The bootstrap rotation pairs each reviewer with two
  // others across three contributor-initiated convergences, so
  // each ends with demonstrated=2.0 (cleared at any threshold ≤
  // 1.5) before the assignment-driven phase begins.
  async function runPatientAdversaryGateScenario(params: {
    assignment_min_recent: number;
    assignment_min_demonstrated: number;
    review_credit_contention_alpha?: number;
  }): Promise<{
    attack_succeeded: boolean;
    carol_demonstrated: number;
    carol_recent: number;
    false_positive_lockout: boolean;
  }> {
    const BOOTSTRAP_COUNT = 3;
    const PRIMING_COUNT = 4;
    const TOTAL_PRIMING = BOOTSTRAP_COUNT + PRIMING_COUNT;
    const sources = new Map<string, string>();
    for (let i = 1; i <= TOTAL_PRIMING; i++) {
      sources.set(
        String(i),
        `arm A${i}: treatment X works in stage III patients across the cohort`,
      );
    }
    sources.set('99', 'arm B: treatment X has no effect in stage IV patients');
    sources.set('100', 'arm C: treatment X has no effect in stage IV patients');

    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const RECENT_HALF_LIFE_SECONDS = 60;
    const server = new Server({
      clock,
      idGen: new SeededIdGen('pgs'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
        demonstrated_half_life_seconds: Infinity,
        recent_half_life_seconds: RECENT_HALF_LIFE_SECONDS,
        assignment_min_recent: params.assignment_min_recent,
        assignment_min_demonstrated: params.assignment_min_demonstrated,
        review_credit_contention_alpha: params.review_credit_contention_alpha ?? 1,
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
    const primingAnchorIds: string[] = [];
    for (let i = 1; i <= TOTAL_PRIMING; i++) {
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
      const anchorNode = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
      );
      if (!anchorNode) throw new Error(`priming anchor ${i} not materialized`);
      primingAnchorIds.push(anchorNode.id);
    }
    const firstContestedAnchorProp = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper contested',
        external_ref: { kind: 'pmid', value: '99' },
      },
    );
    server.curator.acceptProposal(firstContestedAnchorProp.proposal_id);
    const firstContestedAnchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper contested',
    );
    if (!firstContestedAnchorNode) throw new Error('first contested anchor not materialized');
    const firstContestedAnchorId = firstContestedAnchorNode.id;

    // Mint reviewers up front so the bootstrap phase can address
    // them by id without going through the runHonestReviewer loop
    // (which itself would hit the demo gate before they have rep).
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const carolClient = await wireArchetype(server, carol.id);
    const erinClient = await wireArchetype(server, erin.id);
    const frankClient = await wireArchetype(server, frank.id);

    // Alice proposes all priming + contested excerpts directly.
    // The original runner used an honest-strong proposer; replacing
    // it with direct proposes sidesteps the demo gate on the
    // proposer-side request_assignment, which would otherwise also
    // need bootstrapping. Span content matches the verifier sources
    // so excerpts pass the verify step.
    const stagedExcerptIds: string[] = [];
    for (const anchorId of primingAnchorIds) {
      const e = await server.tools.proposeExcerpt(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          parent_anchor_id: anchorId,
          content: `treatment X works for stage III on ${anchorId}`,
          quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
        },
      );
      stagedExcerptIds.push(e.proposal_id);
    }
    const firstContestedExcerptProp = await server.tools.proposeExcerpt(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: firstContestedAnchorId,
        content: 'treatment X has no effect for stage IV',
        quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
      },
    );
    const firstContestedProposalId = firstContestedExcerptProp.proposal_id;

    // Bootstrap rotation: three convergences, each with two
    // contributor-initiated accept votes. Each reviewer appears in
    // two of the three pairs and ends with demonstrated=2.0. Pairs
    // are carol+erin, carol+frank, erin+frank. After this, all
    // three clear any demo-gate threshold ≤ 1.5.
    const bootstrapPairs: Array<[typeof carol, typeof carol]> = [
      [carol, erin],
      [carol, frank],
      [erin, frank],
    ];
    for (let i = 0; i < BOOTSTRAP_COUNT; i++) {
      const proposalId = stagedExcerptIds[i];
      if (!proposalId) throw new Error(`bootstrap excerpt ${i} missing`);
      const pair = bootstrapPairs[i];
      if (!pair) throw new Error(`bootstrap pair ${i} missing`);
      for (const voter of pair) {
        await server.tools.castReviewVote(
          { identity_id: voter.id },
          {
            proposal_id: proposalId,
            decision: 'accept',
            rationale: 'consistent with prevailing evidence',
          },
        );
      }
    }

    // Assignment-driven phase. Carol runs first so the remaining
    // priming excerpts and the first contested target are still
    // staged when she votes — same ordering as the standalone
    // patient-adversary scenario. Calibration injection and
    // calibration-aware convergence are on, the strongest
    // composition the rep ledger has against bias.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 20,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 20,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 20,
      decide: acceptAllDecider,
    });

    // The first contested target should converge to accepted under
    // the canonical patient-adversary scenario (Erin + Frank's
    // accepts dominate Carol's reject). Under cube #2's alpha=1
    // thresholds, this always holds. Under the alpha cube's
    // re-baseline with cube-#2 thresholds at alpha < 1, the demo
    // gate's value-comparison can false-positive on honest
    // reviewers whose bootstrap demonstrated shrinks proportionally
    // — Erin/Frank get locked out at first request_assignment, the
    // first contested target stalls staged, and the runner reports
    // `false_positive_lockout` so the alpha cube can distinguish
    // "attack closed by gate" from "honest review collapsed at the
    // same gate." Cube #2's cells still observe lockout=false
    // because their thresholds were calibrated for alpha=1.
    const firstContested = server.store.proposals.get(firstContestedProposalId);
    const false_positive_lockout = firstContested?.status !== 'accepted';

    // Quiet window: Carol stops being recently active, by definition
    // of the patient-adversary archetype. Six recent half-lives
    // drains her recent by 64x — enough to fall below any reasonable
    // threshold the gate is set to.
    const QUIET_HALF_LIVES = 6;
    clock.advance(RECENT_HALF_LIFE_SECONDS * QUIET_HALF_LIVES * 1000);

    const secondContestedAnchorProp = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper contested 2',
        external_ref: { kind: 'pmid', value: '100' },
      },
    );
    server.curator.acceptProposal(secondContestedAnchorProp.proposal_id);
    const secondContestedAnchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper contested 2',
    );
    if (!secondContestedAnchorNode) throw new Error('second contested anchor not materialized');
    await server.tools.proposeExcerpt(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: secondContestedAnchorNode.id,
        content: 'treatment X has no effect for stage IV again',
        quoted_span: { text: 'treatment X has no effect in stage IV patients', offset: 0 },
      },
    );

    // Carol attempts the second drift. honest-reviewer absorbs the
    // not_found surface as an idle action when the gate fires, so
    // the loop terminates gracefully either way and the count of her
    // reject votes is the observable signal.
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 20,
      decide: calAwareBiasedDecider,
    });

    const carolRejects = [...server.store.reviewVotes.values()].filter(
      (v) => v.reviewer_id === carol.id && v.decision === 'reject',
    );
    // Read Carol's rep at the post-quiet-window tick the gate
    // consumed. The cube layered on this runner uses these to make
    // the alpha-driven shrinkage of the demonstrated buffer visible
    // alongside the attack-success outcome — the lift the difficulty-
    // normalization wedge produces is mostly accounted for by the
    // change in the demonstrated number, not a separate mechanism.
    const carolRep = await server.tools.queryReputation(
      { identity_id: carol.id },
      { cause_id: cause.id },
    );
    const carolRow = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id);
    return {
      attack_succeeded: carolRejects.length >= 2,
      carol_demonstrated: carolRow?.demonstrated ?? 0,
      carol_recent: carolRow?.recent ?? 0,
      false_positive_lockout,
    };
  }

  // Sybil-amplified-coalition runner: established Carol+Dave priming
  // + fresh Eve recruit. Mirrors the standalone "fresh recruit slips
  // past stratification" scenario above. attack_succeeded is "did
  // the contested target end rejected", which it does iff Eve walks
  // in past whatever gate is set.
  async function runSybilAmplifiedGateScenario(params: {
    assignment_min_recent: number;
    assignment_min_demonstrated: number;
    review_credit_contention_alpha?: number;
  }): Promise<{ attack_succeeded: boolean }> {
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('sgs'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
        // Half-lives stay at Infinity (the default): no time-decay
        // semantics are needed here, this scenario exercises the
        // fresh-vs-established identity contrast at a single tick.
        // With Infinity half-life the recent gate behaves as an
        // absolute floor on bumps received — Carol/Dave clear it
        // from priming, Eve has no rep so the recent-gate bypass
        // applies regardless of threshold, and the demo gate is
        // what closes the attack pattern.
        assignment_min_recent: params.assignment_min_recent,
        assignment_min_demonstrated: params.assignment_min_demonstrated,
        review_credit_contention_alpha: params.review_credit_contention_alpha ?? 1,
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

    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const eve = server.bootstrap.mintIdentity({ display_name: 'eve' });
    const erinClient = await wireArchetype(server, erin.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    const eveClient = await wireArchetype(server, eve.id);
    for (const c of [
      { identity_id: carol.id },
      { identity_id: dave.id },
      { identity_id: eve.id },
    ]) {
      await server.tools.setCapacity(c, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });
    }
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
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });
    await runHonestReviewer(eveClient, {
      cause_id: cause.id,
      rate: 5,
      decide: calAwareBiasedDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    return { attack_succeeded: target?.status === 'rejected' };
  }

  interface GateSweepCell {
    name: string;
    pattern: GateAttackPattern;
    assignment_min_recent: number;
    assignment_min_demonstrated: number;
    expected_attack_succeeded: boolean;
  }
  const gateSweepCells: GateSweepCell[] = [
    // Both gates off — neither archetype hits a defense. Floor row.
    {
      name: 'patient adversary, recent=0, demo=0 (no defenses)',
      pattern: 'patient',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
    },
    {
      name: 'sybil-amplified coalition, recent=0, demo=0 (no defenses)',
      pattern: 'sybil',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
    },
    // Recent gate only — closes patient-adversary, sybil bypasses
    // (Eve has no rep so the recent-gate bypass applies; Carol/Dave
    // sit at full bump because no time advances).
    {
      name: 'patient adversary, recent=0.5, demo=0 (recent gate fires)',
      pattern: 'patient',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: false,
    },
    {
      name: 'sybil-amplified coalition, recent=0.5, demo=0 (gate inert against fresh recruit)',
      pattern: 'sybil',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
    },
    // Demo gate only — closes sybil-amplified, patient bypasses
    // (Carol's demonstrated stays high through the quiet window, so
    // the eligibility-tier gate has no edge against her).
    {
      name: 'patient adversary, recent=0, demo=1.5 (gate inert against demonstrated buffer)',
      pattern: 'patient',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: true,
    },
    {
      name: 'sybil-amplified coalition, recent=0, demo=1.5 (demo gate fires on Eve)',
      pattern: 'sybil',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
    },
    // Composition — both gates closed against their named patterns.
    {
      name: 'patient adversary, recent=0.5, demo=1.5 (composition closes)',
      pattern: 'patient',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
    },
    {
      name: 'sybil-amplified coalition, recent=0.5, demo=1.5 (composition closes)',
      pattern: 'sybil',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
    },
  ];
  it.each(
    gateSweepCells,
  )('gate-threshold sweep: $name → attack_succeeded=$expected_attack_succeeded', async ({
    pattern,
    assignment_min_recent,
    assignment_min_demonstrated,
    expected_attack_succeeded,
  }) => {
    const result =
      pattern === 'patient'
        ? await runPatientAdversaryGateScenario({
            assignment_min_recent,
            assignment_min_demonstrated,
          })
        : await runSybilAmplifiedGateScenario({
            assignment_min_recent,
            assignment_min_demonstrated,
          });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
  });

  it('gate-threshold sweep cube: attack-success-rate aggregates by defense config', () => {
    // Same aggregate-ASR shape the decorrelation cube above pins:
    // group cells by (defense knobs), tally attack-pattern wins,
    // assert per-config ASR. The metric is computed off the static
    // `expected_attack_succeeded` fields the per-cell tests already
    // validated, so the aggregate is a fast read over locked
    // observations rather than a re-run of the cube.
    interface AsrCell {
      assignment_min_recent: number;
      assignment_min_demonstrated: number;
      total: number;
      attacks_succeeded: number;
    }
    const grouped = new Map<string, AsrCell>();
    for (const cell of gateSweepCells) {
      const key = `${cell.assignment_min_recent}|${cell.assignment_min_demonstrated}`;
      const g = grouped.get(key) ?? {
        assignment_min_recent: cell.assignment_min_recent,
        assignment_min_demonstrated: cell.assignment_min_demonstrated,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      grouped.set(key, g);
    }
    const asr = (key: string): number => {
      const g = grouped.get(key);
      if (!g) throw new Error(`missing defense config: ${key}`);
      return g.attacks_succeeded / g.total;
    };

    // No defenses: both attacks succeed. Floor.
    expect(asr('0|0')).toBe(1);
    // Recent gate alone: closes patient-adversary; sybil bypasses
    // because the gate has fresh-reviewer bypass and Eve sits at
    // zero rep. ASR = 50% — half the surface remains.
    expect(asr('0.5|0')).toBe(0.5);
    // Demo gate alone: closes sybil-amplified; patient bypasses
    // because Carol's demonstrated component is preserved across
    // the quiet window (slow-decay) and clears any reasonable
    // eligibility threshold from priming alone. ASR = 50% — the
    // mirror image of the row above.
    expect(asr('0|1.5')).toBe(0.5);
    // Composition: each gate closes its named pattern, neither
    // attack lands. ASR = 0%.
    expect(asr('0.5|1.5')).toBe(0);

    // Coverage invariant: every defense config in the cube has both
    // attack patterns. A future cell expansion that breaks this
    // symmetry trips the assertion and forces the aggregate to be
    // re-keyed rather than silently averaging over uneven groups.
    for (const cell of grouped.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Third parameter sweep cube: the decline-aware encounter-domain
  // extension joined with the existing vote-only cluster-signal stack.
  // PRD §Reviewer assignment commits the encounter-domain widening
  // ({accept, reject, decline}); this cube measures what that
  // widening buys the defense in attack-success-rate terms across two
  // attack patterns:
  //
  //   - co-voting decorrelated: Carol+Dave both vote on every priming
  //     proposal but with perfect pairwise disagreement. The vote-
  //     only cluster signal at anti-correlation threshold 1.0 catches
  //     this — it's the original closure the first sweep cube above
  //     pinned. Re-running it here under the include-declines axis
  //     asserts the widening is non-regressive: turning declines on
  //     does not break the existing closure for pure co-voting
  //     coalitions.
  //   - paired-decline multi-round: Carol+Dave never co-vote;
  //     instead they pair declines across two priming proposals so
  //     no shared vote-history forms (the multi-round closure
  //     scenario above). The vote-only cluster signal is blind to
  //     this by construction; only the decline-aware extension
  //     widens the encounter domain enough to detect the pair.
  //
  // The defense knob in this cube is `stratum_include_declines`. The
  // cluster-signal stack stays at the same strength the multi-round
  // closure pins (anti-correlation 1.0, agreement 1.0, contention-
  // weighted off — the contention-weighting interaction is its own
  // follow-up, see ROADMAP §Status). The headline is *additive*, not
  // orthogonal: declines extend the encounter domain on top of votes,
  // and the cube reads the lift the extension provides.
  //
  // Expected ASR shape — vote-only: 50% (co-voting closed, paired-
  // decline open); decline-aware: 0% (both closed). The widening
  // closes one named pattern without weakening the other.
  type ClusterDeclineAttackPattern = 'co-voting-decorrelated' | 'paired-decline-multi-round';

  interface ClusterDeclineSweepCell {
    name: string;
    pattern: ClusterDeclineAttackPattern;
    stratum_include_declines: boolean;
    expected_attack_succeeded: boolean;
  }
  const clusterDeclineSweepCells: ClusterDeclineSweepCell[] = [
    // Vote-only stack: declines do not enter the encounter domain.
    // Co-voting decorrelated is closed by the anti-correlation
    // threshold on the vote signal alone (the prior sweep cube's
    // 'decorrelated, threshold=1.0' result, replicated here as a
    // regression handle for the include-declines knob).
    {
      name: 'co-voting decorrelated, declines off (vote-only catches)',
      pattern: 'co-voting-decorrelated',
      stratum_include_declines: false,
      expected_attack_succeeded: false,
    },
    // Vote-only blind to a paired-decline coalition: zero shared
    // vote-history → no edge → no cluster → cross-stratum gate has
    // nothing to enforce against → suppression succeeds. This is the
    // open seam the decline-aware extension is wired to close.
    {
      name: 'paired-decline multi-round, declines off (vote-only blind, suppression succeeds)',
      pattern: 'paired-decline-multi-round',
      stratum_include_declines: false,
      expected_attack_succeeded: true,
    },
    // Decline-aware widening + co-voting decorrelated: the widening
    // is non-regressive against this pattern. Carol+Dave never
    // decline anything in the decorrelated runner, so the encounter
    // ledger has no decline records to add; the vote-only closure
    // for co-voting carries through unchanged.
    {
      name: 'co-voting decorrelated, declines on (widening is non-regressive)',
      pattern: 'co-voting-decorrelated',
      stratum_include_declines: true,
      expected_attack_succeeded: false,
    },
    // Decline-aware widening + paired-decline: the closure the multi-
    // round scenario lands on the proposal status. Paired-decline
    // priming forms the cluster, the cross-stratum gate fires during
    // the suppression round, fresh honest reviewers walk in and the
    // contested target converges accepted.
    {
      name: 'paired-decline multi-round, declines on (decline-aware closes seam)',
      pattern: 'paired-decline-multi-round',
      stratum_include_declines: true,
      expected_attack_succeeded: false,
    },
  ];
  it.each(
    clusterDeclineSweepCells,
  )('cluster-decline sweep: $name → attack_succeeded=$expected_attack_succeeded', async ({
    pattern,
    stratum_include_declines,
    expected_attack_succeeded,
  }) => {
    const contested_status =
      pattern === 'co-voting-decorrelated'
        ? (
            await runDecorrelationScenario({
              pattern: PATTERN_DECORRELATED,
              anti_correlation_threshold: 1.0,
              contention_weighted: false,
              stratum_include_declines,
            })
          ).contested_status
        : (
            await runMultiRoundDeclineClosureScenario({
              stratum_include_declines,
            })
          ).contested_status;
    // attack_succeeded is "did the contested target end suppressed"
    // — the proposer's-perspective failure mode the cluster-signal
    // refinements exist to prevent. 'rejected' is convergence
    // suppression; the cube doesn't produce 'unresolved-archived'
    // outcomes (no time advances past the divergence window in
    // these runners), so 'rejected' is the only attack-success
    // signal here.
    const attack_succeeded = contested_status === 'rejected';
    expect(attack_succeeded).toBe(expected_attack_succeeded);
  });

  it('cluster-decline sweep cube: attack-success-rate aggregates by defense config', () => {
    // Same aggregate-ASR shape the prior cubes pin: group cells by
    // the defense knob, tally attack-pattern wins, assert per-config
    // ASR. The metric is computed off the static
    // `expected_attack_succeeded` fields the per-cell tests already
    // validated, so the aggregate stays a fast read over locked
    // observations rather than a re-run of the cube.
    interface AsrCell {
      stratum_include_declines: boolean;
      total: number;
      attacks_succeeded: number;
    }
    const grouped = new Map<string, AsrCell>();
    for (const cell of clusterDeclineSweepCells) {
      const key = `${cell.stratum_include_declines}`;
      const g = grouped.get(key) ?? {
        stratum_include_declines: cell.stratum_include_declines,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      grouped.set(key, g);
    }
    const asr = (key: string): number => {
      const g = grouped.get(key);
      if (!g) throw new Error(`missing defense config: ${key}`);
      return g.attacks_succeeded / g.total;
    };

    // Vote-only stack: co-voting decorrelated is closed by the
    // anti-correlation threshold on votes; paired-decline slips
    // through. Half the named patterns suppress the contested
    // target → ASR 50%. This is the gap the decline-aware extension
    // is wired to close.
    expect(asr('false')).toBe(0.5);
    // Decline-aware: the encounter-domain widening lands the multi-
    // round closure on the paired-decline pattern while leaving the
    // vote-only closure for co-voting unchanged. Both named patterns
    // close → ASR 0%. The lift is the headline.
    expect(asr('true')).toBe(0);

    // Coverage invariant: every defense config in the cube has both
    // attack patterns. A future cell expansion that breaks this
    // symmetry trips the assertion and forces the aggregate to be
    // re-keyed rather than silently averaging over uneven groups.
    for (const cell of grouped.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Fourth parameter sweep cube: the contention-weighting + paired-
  // decline-floor interaction joined to the cluster-decline cube. The
  // prior cube widened the encounter domain along
  // `stratum_include_declines` and pinned the additive lift; this one
  // holds declines on and widens along the two knobs that govern how
  // decline-involved encounters are weighted under contention-
  // weighted edges:
  //
  //   - `stratum_contention_weighted` ∈ {off, on}: under raw weights
  //     each shared encounter contributes 1; under contention
  //     weighting vote-vote agreements at unanimous-easy items
  //     contribute 0 and decline-involved encounters fall under the
  //     full-weight rule (gated by the floor).
  //   - `stratum_decline_min_paired` ∈ {1, 2}: PRD §Reviewer
  //     assignment commits the floor (default 2) on contention-
  //     weighting's full-weight rule for declines so a single
  //     asymmetric decline-involved encounter cannot dominate a pair
  //     whose vote-vote history sits on unanimous-easy items.
  //
  // The two attack patterns the cube exercises:
  //
  //   - paired-decline multi-round: the runner the prior cube wired
  //     against the include-declines knob. Carol+Dave coordinate
  //     across two priming proposals (paired declines), the cluster
  //     forms before the contested round, and the cross-stratum gate
  //     fires against Dave during suppression. The closure must
  //     survive every (cw, floor) combination — the floor is meant
  //     to suppress over-clustering, not the legitimate paired-
  //     decline edge. Under (cw=on, floor=1) the runner exposes a
  //     partial over-clustering artifact (primingB stalls because
  //     Erin's vote retroactively expands the false cluster) but
  //     contested still closes through Frank+Hank, who walk in
  //     fresh in Round 2 and pass below the min-shared filter on
  //     their first contested vote.
  //   - over-clustering false-positive: three honest reviewers prime
  //     on unanimous-easy items, one declines a single trigger
  //     excerpt, contested staged. Under cw=on + floor=1 the lone
  //     decline-involved encounter at full weight against vote-vote
  //     agreements at contention 0 false-clusters all three honest
  //     reviewers; the cross-stratum gate then strangles honest
  //     review on contested. Floor=2 closes the false-positive; cw=
  //     off side-steps it entirely (the full-weight rule is a cw=on
  //     branch).
  //
  // The over-clustering pattern is not adversarial — the "attack
  // succeeded" axis here measures *suppression by archival* on a
  // contested target honest reviewers should have closed. From the
  // proposer's perspective the failure mode is identical to a
  // coalition's suppression-by-archival, which is why it sits in
  // the same cube and reads on the same metric.
  //
  // Expected ASR shape — (cw=off, floor=any): 0% (decline-aware
  // raw-weight regime closes paired-decline; over-clustering does
  // not trigger because the full-weight rule is a cw=on branch).
  // (cw=on, floor=1): 50% (paired-decline still closes through
  // Frank/Hank, but the over-clustering scenario lands the false-
  // positive directly on contested — three honest reviewers in the
  // pool with no fresh-singleton fallback). (cw=on, floor=2): 0%
  // (the composition is the stable point — paired-decline closure
  // survives, over-clustering closed by the floor). The headline:
  // the floor is what makes the cw + decline-aware composition
  // safe against the small-honest-pool case where there's no
  // fresh-singleton bypass.
  type ClusterDeclineFloorAttackPattern =
    | 'paired-decline-multi-round'
    | 'over-clustering-false-positive';
  interface ClusterDeclineFloorSweepCell {
    name: string;
    pattern: ClusterDeclineFloorAttackPattern;
    stratum_contention_weighted: boolean;
    stratum_decline_min_paired: number;
    expected_attack_succeeded: boolean;
  }
  const clusterDeclineFloorSweepCells: ClusterDeclineFloorSweepCell[] = [
    // Raw-weight regime, paired-decline multi-round. Carol+Dave's
    // paired declines form an anti-correlation edge under the raw-
    // weight signal (2 shared decline-involved encounters, both
    // disagreements at weight 1 each). Honest pairs (Carol-Erin,
    // Dave-Erin) have one decline-involved encounter and one vote-
    // vote agreement; raw ratios sit at 0.5/0.5 and neither edge
    // fires. Closure works.
    {
      name: 'paired-decline, cw=off, floor=1 (raw-weight closure)',
      pattern: 'paired-decline-multi-round',
      stratum_contention_weighted: false,
      stratum_decline_min_paired: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'paired-decline, cw=off, floor=2 (raw-weight closure; floor inert)',
      pattern: 'paired-decline-multi-round',
      stratum_contention_weighted: false,
      stratum_decline_min_paired: 2,
      expected_attack_succeeded: false,
    },
    // Contention-weighted, floor=1: the over-clustering pathology
    // partially fires on priming — primingB ends staged because
    // Erin's accept on it causes the Carol-Dave-Erin false cluster
    // to lock in (now both pairs have shared=2 ≥ min_shared) and
    // the degraded threshold tightens to 3 before her vote can
    // push the count past it. primingA already converged before
    // Erin's second vote (only 1 shared encounter with Dave at
    // that point so the false-cluster edge hadn't formed yet). In
    // Round 2 the contested target still gets through: Carol's
    // reject lands but Dave is gated, Frank walks in fresh and
    // votes accept (1+1), then Hank walks in fresh and votes
    // accept (now 1 reject + 2 accepts). At Hank's vote, only
    // 1 contested-encounter stands between him and any other
    // reviewer (below min_shared) so {CDEF} + {H} = 2 strata, not
    // degraded, threshold stays at 2 and contested converges
    // accepted. The closure fires on outcome — the over-clustering
    // pathology costs primingB but not contested. The attack does
    // not succeed.
    {
      name: 'paired-decline, cw=on, floor=1 (over-clusters honest pool but Frank/Hank carry)',
      pattern: 'paired-decline-multi-round',
      stratum_contention_weighted: true,
      stratum_decline_min_paired: 1,
      expected_attack_succeeded: false,
    },
    // Contention-weighted, floor=2: Carol-Dave clusters cleanly (2
    // paired declines meet the floor); honest pairs stay singletons
    // (1 decline-involved encounter < floor). Closure works without
    // honest-pool over-clustering.
    {
      name: 'paired-decline, cw=on, floor=2 (clean closure under composition)',
      pattern: 'paired-decline-multi-round',
      stratum_contention_weighted: true,
      stratum_decline_min_paired: 2,
      expected_attack_succeeded: false,
    },
    // Over-clustering, raw weights. Carol-Dave and Carol-Erin each
    // have 2 vote-vote agreements + 1 decline-involved disagreement;
    // raw 2/3 agreement, 1/3 disagreement, neither edge fires.
    // Dave-Erin is 3-for-3 vote-vote agreement → positive-cluster
    // edge fires (raw agreement = 1.0). Two strata: {Carol},
    // {Dave, Erin}. Round 3: Carol → singleton admitted votes
    // accept, Dave → {D,E} not yet routed admitted votes accept.
    // Converged accepted at the second vote.
    {
      name: 'over-clustering, cw=off, floor=1 (raw-weight regime, full-weight rule inert)',
      pattern: 'over-clustering-false-positive',
      stratum_contention_weighted: false,
      stratum_decline_min_paired: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'over-clustering, cw=off, floor=2 (raw-weight regime, full-weight rule inert)',
      pattern: 'over-clustering-false-positive',
      stratum_contention_weighted: false,
      stratum_decline_min_paired: 2,
      expected_attack_succeeded: false,
    },
    // Contention-weighted + floor=1: the named pathology. Carol-
    // Dave's single decline-involved encounter at full weight
    // against priming agreements at contention 0 lights up the
    // anti-correlation edge against an honest pair; same for Carol-
    // Erin. Carol-Dave-Erin collapse to one stratum, contested is
    // stratification-degraded with votes_to_accept=3, only Carol is
    // admitted (votes accept = 1), Dave/Erin gated. Sweep archives
    // → unresolved-archived → suppression succeeds.
    {
      name: 'over-clustering, cw=on, floor=1 (false-positive lockout, contested archives)',
      pattern: 'over-clustering-false-positive',
      stratum_contention_weighted: true,
      stratum_decline_min_paired: 1,
      expected_attack_succeeded: true,
    },
    // Floor=2 closes the false-positive: each honest pair has 1
    // decline-involved encounter < floor → contributes 0 weight,
    // every vote-vote agreement at contention 0, weighted_shared=0,
    // signalAvailable=false, no edges. All three stay singletons,
    // contested converges accepted at the second vote.
    {
      name: 'over-clustering, cw=on, floor=2 (composition closes the false-positive)',
      pattern: 'over-clustering-false-positive',
      stratum_contention_weighted: true,
      stratum_decline_min_paired: 2,
      expected_attack_succeeded: false,
    },
  ];
  it.each(
    clusterDeclineFloorSweepCells,
  )('cluster-decline floor sweep: $name → attack_succeeded=$expected_attack_succeeded', async ({
    pattern,
    stratum_contention_weighted,
    stratum_decline_min_paired,
    expected_attack_succeeded,
  }) => {
    const contested_status =
      pattern === 'paired-decline-multi-round'
        ? (
            await runMultiRoundDeclineClosureScenario({
              stratum_include_declines: true,
              stratum_contention_weighted,
              stratum_decline_min_paired,
            })
          ).contested_status
        : (
            await runOverClusteringScenario({
              stratum_contention_weighted,
              stratum_decline_min_paired,
            })
          ).contested_status;
    // attack_succeeded is the proposer's-perspective failure mode:
    // anything other than 'accepted' on a target honest reviewers
    // should have closed. The cube exercises three suppression
    // modes: 'rejected' (convergence in the wrong direction —
    // paired-decline closure failing under (cw=off) regimes wired
    // by the prior cube but kept here as a regression handle on
    // the broader read), 'unresolved-archived' (the over-
    // clustering scenario archives contested after the divergence
    // window when stratification-degraded threshold tightening
    // blocks convergence), and 'staged' (the paired-decline
    // runner under cw=on + floor=1: priming itself breaks, the
    // suppression round can't push contested past its degraded
    // threshold either, the runner does not advance time so the
    // archival sweep doesn't fire and the proposal stays staged).
    // All three read as suppression on the proposer's side.
    const attack_succeeded = contested_status !== 'accepted';
    expect(attack_succeeded).toBe(expected_attack_succeeded);
  });

  it('cluster-decline floor sweep cube: attack-success-rate aggregates by defense config', () => {
    // Same aggregate-ASR shape the prior three cubes pin: group
    // cells by the defense config, tally attack-pattern wins, assert
    // per-config ASR. The metric is computed off the static
    // expected_attack_succeeded fields the per-cell tests already
    // validated, so the aggregate stays a fast read over locked
    // observations rather than a re-run of the cube.
    interface AsrCell {
      stratum_contention_weighted: boolean;
      stratum_decline_min_paired: number;
      total: number;
      attacks_succeeded: number;
    }
    const grouped = new Map<string, AsrCell>();
    for (const cell of clusterDeclineFloorSweepCells) {
      const key = `${cell.stratum_contention_weighted ? 1 : 0}|${cell.stratum_decline_min_paired}`;
      const g = grouped.get(key) ?? {
        stratum_contention_weighted: cell.stratum_contention_weighted,
        stratum_decline_min_paired: cell.stratum_decline_min_paired,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      grouped.set(key, g);
    }
    const asr = (key: string): number => {
      const g = grouped.get(key);
      if (!g) throw new Error(`missing defense config: ${key}`);
      return g.attacks_succeeded / g.total;
    };

    // Raw-weight regime: the contention-weighting full-weight rule
    // for declines is inactive, so the floor parameter has no
    // effect. Both cells in each row close on outcome (paired-
    // decline via raw anti-correlation on the 2 paired declines;
    // over-clustering via the cluster-disabling raw-weight reading
    // of the asymmetric trigger encounter).
    expect(asr('0|1')).toBe(0);
    expect(asr('0|2')).toBe(0);
    // Contention-weighted with floor=1 (the unsafe composition):
    // the over-clustering false-positive lands the contested
    // target in 'unresolved-archived' (three honest reviewers with
    // no fresh-singleton fallback all gated out). The paired-
    // decline runner has the same false-clustering happen on
    // priming but Frank+Hank walk in fresh in Round 2 and carry
    // contested through. ASR = 50% — the gap the floor closes on
    // the small-honest-pool case.
    expect(asr('1|1')).toBe(0.5);
    // Contention-weighted with floor=2 (the stable composition):
    // both attack patterns close. ASR = 0%. This is the headline —
    // the floor is what makes the cw + decline-aware composition
    // safe against the small-honest-pool case. cw=off side-steps
    // the issue (the full-weight rule is a cw=on branch); cw=on
    // requires the floor.
    expect(asr('1|2')).toBe(0);

    // Coverage invariant: every defense config in the cube has both
    // attack patterns. A future cell expansion that breaks this
    // symmetry trips the assertion and forces the aggregate to be
    // re-keyed rather than silently averaging over uneven groups.
    for (const cell of grouped.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Fifth parameter sweep cube: re-baseline cube #2 (the assignment-
  // gate threshold cube) under the difficulty-aware regime that
  // `review_credit_contention_alpha < 1` enables. PRD §Reputation
  // commits the alpha primitive: reviewer rep deltas scale by
  // `alpha + (1-alpha) * contention`, so unanimous-easy convergences
  // earn `alpha` of the base delta and contentious convergences earn
  // the full delta. Calibration credit (PRD §Calibration batches)
  // flows through `bumpReputation` directly without going through
  // the convergence-driven `applyReputationUpdates`, so it is *not*
  // alpha-scaled — the calibration path is ground-truth-individual,
  // not convergence-derived, and stays a pure-honesty channel.
  //
  // What the alpha primitive shrinks: the convergence-path reviewer
  // credit, which dominates an honest reviewer's bootstrap
  // demonstrated buffer in the patient runner. Specifically the
  // 3-rotation bootstrap gives each reviewer demonstrated = 2 *
  // alpha after the contributor-initiated ramp:
  //   alpha=1.0 → bootstrap demonstrated = 2.0  (cube-#2 baseline)
  //   alpha=0.5 → bootstrap demonstrated = 1.0  (half-credit ramp)
  //
  // The cube reads the same (recent, demo) gate composition cube #2
  // pinned at alpha=1 — same thresholds (recent=0.5, demo=1.5),
  // same archetype, same defense knobs — and observes that the
  // thresholds calibrated for alpha=1 *false-positive-lock-out
  // honest reviewers* under alpha=0.5: their bootstrap demonstrated
  // (1.0) falls below the demo gate's value-comparison threshold
  // (1.5), they fail at first request_assignment, the first
  // contested target stalls staged, and the patient archetype's
  // drift never starts. Cube reports both `attack_succeeded` and
  // `false_positive_lockout` so "attack closed by the gate's
  // designed mechanism" can be distinguished from "honest review
  // collapsed at the same gate" — the second is a defense
  // failure, not a defense success, even though attack_succeeded
  // reads false in both cases.
  //
  // Re-tuned thresholds: cube #2's (recent=0.5, demo=1.5) was
  // calibrated against the alpha=1 bootstrap demonstrated of 2.0,
  // leaving 0.5 of headroom. To preserve that headroom under
  // alpha=0.5 (bootstrap = 1.0), the demo gate must come down to
  // 0.75 (half the cube-#2 value, half the cube-#2 headroom). The
  // recent gate's quiet-window decay is dominated by calibration
  // credit (alpha-invariant), so the recent threshold scales less.
  // The re-tuned cell pins (recent=0.5, demo=0.75) under alpha=0.5:
  // honest reviewers pass (1.0 > 0.75), Carol's drift gets routed,
  // her recent decays through the quiet window, the recent gate
  // fires on the second drift, and the headroom-on-honest-pool
  // invariant is preserved.
  //
  // Sybil-amplified is dropped from this cube — the demo gate's
  // closure on Eve is alpha-invariant (null-policy fires regardless
  // of accumulation rate), and the sybil runner's curator-fallback
  // priming path doesn't accrue applyReputationUpdates rep, so
  // alpha doesn't change Carol/Dave's demonstrated either. Cube #2
  // pins the sybil orthogonality at alpha=1; this cube is patient-
  // only, focused on the alpha-driven re-tuning question.
  type AlphaCubeConfig =
    | 'off'
    | 'cube2-thresholds'
    | 'retuned-thresholds';
  interface AlphaGateSweepCell {
    name: string;
    review_credit_contention_alpha: number;
    config: AlphaCubeConfig;
    assignment_min_recent: number;
    assignment_min_demonstrated: number;
    expected_attack_succeeded: boolean;
    expected_false_positive_lockout: boolean;
  }
  const alphaGateSweepCells: AlphaGateSweepCell[] = [
    // Alpha=1.0, no defense — the v0-baseline floor row. Patient
    // archetype lands its drift, no honest-pool collapse.
    {
      name: 'alpha=1.0, gates off (no defense, attack lands)',
      review_credit_contention_alpha: 1.0,
      config: 'off',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    // Alpha=1.0, cube-#2 thresholds — the cube-#2 result preserved.
    // Recent gate fires on Carol's quiet-window-drained recent;
    // demo gate doesn't fire (her demonstrated buffer holds).
    // Honest pool clears the demo gate (bootstrap demonstrated=2.0
    // > 1.5).
    {
      name: 'alpha=1.0, cube-#2 thresholds (cube-#2 result preserved)',
      review_credit_contention_alpha: 1.0,
      config: 'cube2-thresholds',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
    // Alpha=0.5, no defense — same floor row at the difficulty-
    // aware regime. Alpha shrinks the rep buffer Carol builds, but
    // with no gate consuming it the attack still lands.
    {
      name: 'alpha=0.5, gates off (no defense, attack lands)',
      review_credit_contention_alpha: 0.5,
      config: 'off',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    // Alpha=0.5, cube-#2 thresholds (untuned re-baseline) — the
    // failure mode the re-tuning is meant to address. Honest
    // reviewers' bootstrap demonstrated (1.0) falls below cube-#2's
    // demo gate (1.5), they're locked out at first request_
    // assignment, the first contested target stalls staged, and the
    // patient archetype's drift never starts. attack_succeeded
    // reads false but only because honest review collapsed —
    // false_positive_lockout=true.
    {
      name: 'alpha=0.5, cube-#2 thresholds (untuned: false-positive on honest reviewers)',
      review_credit_contention_alpha: 0.5,
      config: 'cube2-thresholds',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: true,
    },
    // Alpha=0.5, re-tuned thresholds — the headline. Demo gate
    // comes down from 1.5 to 0.75 (half cube-#2's value, scaled by
    // alpha to preserve the same honest-pool headroom). Recent
    // gate stays at 0.5 because the recent decay through the quiet
    // window is dominated by calibration credit, which is alpha-
    // invariant. With these thresholds, Erin/Frank's bootstrap
    // demonstrated (1.0) clears the demo gate (1.0 > 0.75), the
    // first contested target converges accepted, the quiet window
    // drains Carol's recent, the recent gate fires on her second
    // drift, and the patient archetype's drift bandwidth stays at
    // 1 — same closure as cube-#2's alpha=1 cell.
    {
      name: 'alpha=0.5, re-tuned thresholds (closure recovered, no false-positive)',
      review_credit_contention_alpha: 0.5,
      config: 'retuned-thresholds',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 0.75,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
  ];
  it.each(alphaGateSweepCells)(
    'difficulty-aware gate sweep: $name',
    async ({
      review_credit_contention_alpha,
      assignment_min_recent,
      assignment_min_demonstrated,
      expected_attack_succeeded,
      expected_false_positive_lockout,
    }) => {
      const result = await runPatientAdversaryGateScenario({
        assignment_min_recent,
        assignment_min_demonstrated,
        review_credit_contention_alpha,
      });
      expect(result.attack_succeeded).toBe(expected_attack_succeeded);
      expect(result.false_positive_lockout).toBe(expected_false_positive_lockout);
    },
  );

  it('difficulty-aware gate sweep cube: attack-success-rate and lockout-rate aggregate by (alpha, config)', () => {
    // Same aggregate shape the prior four cubes pin, with one
    // refinement: the metric is now {ASR, lockout-rate} rather than
    // ASR alone. The lockout-rate is what makes the alpha cube
    // distinguishable from cube #2: a cell with ASR=0% and lockout=
    // 100% is *not* a defense success — honest review collapsed
    // alongside the attack, and a real instance under those
    // thresholds would be unable to function. Computed off the
    // static expected fields the per-cell tests already validated,
    // so the aggregate stays a fast read over locked observations.
    interface AsrCell {
      review_credit_contention_alpha: number;
      config: AlphaCubeConfig;
      total: number;
      attacks_succeeded: number;
      lockouts: number;
    }
    const grouped = new Map<string, AsrCell>();
    for (const cell of alphaGateSweepCells) {
      const key = `${cell.review_credit_contention_alpha}|${cell.config}`;
      const g = grouped.get(key) ?? {
        review_credit_contention_alpha: cell.review_credit_contention_alpha,
        config: cell.config,
        total: 0,
        attacks_succeeded: 0,
        lockouts: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      if (cell.expected_false_positive_lockout) g.lockouts += 1;
      grouped.set(key, g);
    }
    const asr = (key: string): number => {
      const g = grouped.get(key);
      if (!g) throw new Error(`missing defense config: ${key}`);
      return g.attacks_succeeded / g.total;
    };
    const lockoutRate = (key: string): number => {
      const g = grouped.get(key);
      if (!g) throw new Error(`missing defense config: ${key}`);
      return g.lockouts / g.total;
    };

    // Floor: gates off → attack succeeds, no false-positive on
    // honest reviewers (the gate isn't fired, so it can't false-
    // positive). Both alphas read identically here.
    expect(asr('1|off')).toBe(1);
    expect(lockoutRate('1|off')).toBe(0);
    expect(asr('0.5|off')).toBe(1);
    expect(lockoutRate('0.5|off')).toBe(0);
    // Cube-#2 thresholds at alpha=1: the v0-baseline result
    // preserved — gate closes the patient archetype, no false-
    // positive on honest pool.
    expect(asr('1|cube2-thresholds')).toBe(0);
    expect(lockoutRate('1|cube2-thresholds')).toBe(0);
    // Cube-#2 thresholds at alpha=0.5: ASR=0% and lockout=100%.
    // The "defense closed the attack" observation is false here —
    // honest review collapsed at the same gate. This is the failure
    // mode the re-tuning addresses.
    expect(asr('0.5|cube2-thresholds')).toBe(0);
    expect(lockoutRate('0.5|cube2-thresholds')).toBe(1);
    // Re-tuned thresholds at alpha=0.5: ASR=0% and lockout=0%.
    // The same closure cube #2 achieved at alpha=1 is recovered
    // under alpha=0.5 by scaling the demo threshold to the new
    // bootstrap demonstrated rate. This is the headline.
    expect(asr('0.5|retuned-thresholds')).toBe(0);
    expect(lockoutRate('0.5|retuned-thresholds')).toBe(0);
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
