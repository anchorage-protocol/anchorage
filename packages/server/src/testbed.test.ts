import type { NodeId, ProposalId } from '@anchorage/contracts';
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
  const mcp = buildMcpServer(server, { token: identity_id });
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

// Adversary-budget model — PRD §Adversary testbed §Architecture: the
// harness-side fiction the testbed needs because issuance is a layer
// below MCP (the server sees only the issued identity record, not the
// cost paid for it, and has no surface for the issuance-frequency
// cap). The primitive holds the adversary's numeric budget B and
// operationalizes the three deductions PRD §Identity composes
// multiplicatively against an adversary: minting an identity at
// attestation level α costs α (binding-cost layer; mirrors the
// server-side `min_attestation_level` gate, which fires on the same
// α as a refusal at the write surface); the harness rejects mints
// that would exceed `issuance_cap_per_epoch` for the current epoch
// (issuance-frequency-cap layer; testbed-only, no server surface);
// per-(identity, epoch) action counts are tracked at
// `action_cap_per_epoch` (T) so the testbed can frame the per-sybil-
// throughput axis as a sweep dimension on top of the server's
// `rate_limit_actions_per_epoch` enforcement.
//
// Epochs are indices passed in by the caller rather than derived from
// a clock — the testbed knows what epoch each action sits in by
// construction (issuance is a deliberate harness-side decision; per-
// action accounting is paired with a known wall-clock advance), and
// keeping the primitive arithmetic-only avoids coupling it to the
// server's `clock.now()` tick semantics. The same epoch space is
// reused for both issuance and per-action accounting; in practice the
// production cap shapes can differ (PRD §Identity scopes the issuance
// cap to "per-(IdP, IP, ASN, …) per-epoch") but for the testbed
// fiction a single epoch axis is the simplest readable expression.
//
// Specific cap shapes remain operationally private at the IdP per PRD
// §Identity bullet 2; the testbed exposes them as tunable knobs so
// parameter sweeps measure ASR as a function of `coalition-affordable-
// identities-per-epoch` directly. The clustering projection (slice 4)
// costs the adversary nothing in this primitive — that layer surfaces
// at the curator surface as visibility, not as budget consumption.
class AdversaryBudget {
  private remaining: number;
  private mintedByEpoch = new Map<number, number>();
  private actionsByIdentityEpoch = new Map<string, Map<number, number>>();

  constructor(
    private readonly opts: {
      initial: number;
      attestation_cost: number;
      issuance_cap_per_epoch: number;
      action_cap_per_epoch?: number;
    },
  ) {
    if (opts.initial < 0) throw new Error(`AdversaryBudget: negative initial (${opts.initial})`);
    if (opts.attestation_cost < 0) {
      throw new Error(`AdversaryBudget: negative attestation_cost (${opts.attestation_cost})`);
    }
    if (opts.issuance_cap_per_epoch < 0) {
      throw new Error(
        `AdversaryBudget: negative issuance_cap_per_epoch (${opts.issuance_cap_per_epoch})`,
      );
    }
    this.remaining = opts.initial;
  }

  get budgetRemaining(): number {
    return this.remaining;
  }

  mintedInEpoch(epoch: number): number {
    return this.mintedByEpoch.get(epoch) ?? 0;
  }

  // Try to mint a sybil at α=attestation_cost in the given epoch. Two
  // failure modes spec'd in PRD §Architecture's adversary budget
  // model: 'budget' (B < α — adversary cannot afford the binding cost
  // for another identity) and 'issuance_cap' (already minted N in
  // this epoch — IdP-level rate the server does not see). On
  // 'issuance_cap' the budget is *not* deducted; the cap is a refusal
  // upstream of any cost being charged, matching how a real IdP
  // refuses the mint request before the operator pays anything.
  tryMint(epoch: number): { ok: true } | { ok: false; reason: 'budget' | 'issuance_cap' } {
    if (this.remaining < this.opts.attestation_cost) {
      return { ok: false, reason: 'budget' };
    }
    const minted = this.mintedByEpoch.get(epoch) ?? 0;
    if (minted >= this.opts.issuance_cap_per_epoch) {
      return { ok: false, reason: 'issuance_cap' };
    }
    this.remaining -= this.opts.attestation_cost;
    this.mintedByEpoch.set(epoch, minted + 1);
    return { ok: true };
  }

  // Account a per-(identity, epoch) write action against T. Returns
  // false when the cap is reached. Mirrors the server-side
  // `accountWriteAction` arithmetic (slice 3) on the testbed side so
  // the harness can read coalition-throughput directly without
  // observing every server refusal — useful when a sweep dimension
  // operates on coalition-affordable-actions-per-epoch as the headline
  // metric. The action cap is per-identity (the cost-multiplier reads
  // K × T at the coalition level); with K identities each capped at
  // T, the coalition's per-epoch budget is K × T.
  tryAct(identityId: string, epoch: number): boolean {
    const cap = this.opts.action_cap_per_epoch ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(cap)) return true;
    const perEpoch = this.actionsByIdentityEpoch.get(identityId) ?? new Map<number, number>();
    const current = perEpoch.get(epoch) ?? 0;
    if (current + 1 > cap) return false;
    perEpoch.set(epoch, current + 1);
    this.actionsByIdentityEpoch.set(identityId, perEpoch);
    return true;
  }
}

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
    const anchorIds: NodeId[] = [];
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
    const anchorIds: NodeId[] = [];
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
        // configured source text. ContentProvider.forAnchor's
        // parameter is plain string by design (the testbed package
        // doesn't depend on contracts), so we re-brand at the
        // boundary to match the locally-typed NodeId arrays.
        const branded = anchorId as NodeId;
        const idx = anchorIds.indexOf(branded);
        if (idx < 0) return null;
        const pmid = String(idx + 1);
        if (weakSpots.has(branded)) {
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
    // the honest reviewer is punished for voting honestly.
    //
    // Calibration injection (PRD §Calibration batches) and
    // calibration-aware convergence (PRD §Reviewer assignment) are
    // the v0-wired defenses that close this attack: the next two
    // scenarios below exercise the attack with each defense enabled
    // and pin the closure (calibration injection costs the coalition
    // rep on bias-misaligned calibration items; calibration-aware
    // convergence weights votes by per-(cause, sub-topic) calibration
    // record so the bias-aligned suppression cannot reach the
    // weighted-sum threshold). This scenario is the baseline that
    // those closures read against — defaults disable both layers
    // (calibration_inject_every_n: 0, calibration_aware_convergence:
    // false), so the attack lands as the regression handle for the
    // un-defended config. A defense that closes the attack at the
    // baseline-config level (rather than as a layer added on top)
    // would make this scenario fail.
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
    // X while passing calibration"); wired explicitly below as the
    // calibration-aware-coalition scenario (bias zone narrow enough
    // to pass the calibration corpus by construction), with
    // structural closures (pool-size scaling at K+1 honest reviewers;
    // stratified-by-history assignment for the small-pool case)
    // landing in the two scenarios after.
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

    // Convergence still flips with the bias — calibration alone does
    // not close the convergence-layer surface, only the rep-ledger
    // one. The convergence-layer closure (calibration-aware-
    // convergence weighting votes by per-(cause, sub-topic)
    // calibration record) lands in the next scenario; this
    // assertion is the regression handle on the calibration-only
    // config so the convergence-still-flips observation stays
    // observable when calibration alone is the only defense.
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
    // Strategic adversary). That archetype is wired as the next
    // scenario's regression handle on this seam, and the closure
    // stack lands in the two scenarios after — pool-size scaling
    // at K+1 honest reviewers and stratified-by-history assignment
    // for the small-pool case (PRD §Reviewer assignment, ROADMAP
    // §Status).
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
    // This scenario stays as the regression handle on the
    // calibration-bypassed config; the closures the same describe-
    // block wires below — pool-size scaling at K+1 honest reviewers
    // (next scenario) and stratified-by-history assignment for the
    // small-pool case (scenario after) — close it from above (PRD
    // §Reviewer assignment, ROADMAP §Status).
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
    // stayed staged. This is the regression handle on the
    // calibration-bypassed config — the closure stack (pool-size
    // scaling at K+1 honest reviewers, stratified-by-history
    // assignment for the small-pool case) lands in the next two
    // scenarios.
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
    // Erin's. The honest-dominance property the calibration-injection
    // scenario above established does not hold against this archetype
    // — the rep-ledger half is also bypassed.
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
    // larger pools and tighter thresholds. The previous test pins
    // the calibration-bypassed config:
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
    // coalition rejects when the threshold is 3. This is the
    // K+1-honest-reviewer regime ROADMAP §Status names ("K+1
    // honest reviewers outvote a K-member coalition").
    //
    // What the lever doesn't do: it doesn't help on small sub-topics
    // where the eligible pool can't furnish K+1 honest reviewers
    // (PRD §Adversary taxonomy, Coalition bullet — "how the regime
    // degrades on small sub-topics where the floor isn't reached").
    // The closure for that degradation is stratified-by-history
    // assignment (PRD §Reviewer assignment, ROADMAP §Status —
    // v0 stratum primitive + cross-stratum draw rule + the
    // stratification-degraded flag that tightens convergence
    // thresholds when fewer than N strata are reachable); the
    // closure scenario sits separately in the same describe-block
    // (calibration-aware coalition bypassing both calibration
    // defenses fails once Carol+Dave have built shared vote-history
    // and the cross-stratum draw routes Dave away from the contested
    // proposal). This pool-size scenario stays as the regression
    // handle on the lever-by-itself: the pool-size lever and the
    // stratification stack compose, and pinning each in isolation
    // is what keeps both legible when their composition gets edited.
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
    // honest reviewers. The calibration-aware-coalition test above
    // pins the calibration-bypassed config at this pool size; this
    // test closes that config from above with stratification_enabled,
    // demonstrating the cross-stratum draw rule closing the
    // bias-suppression vector.
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
    // the coalition costs the operator nothing at the configured
    // defaults — PRD §Identity specs four sybil-resistance layers
    // (binding cost, issuance-frequency cap, per-identity rate-
    // limit accounting, cross-cause identity-clustering) composing
    // multiplicatively against an adversary budget per the
    // §Adversary testbed adversary-budget model. The binding-cost
    // gate (`min_attestation_level`), per-identity rate-limit
    // accounting (`rate_limit_actions_per_epoch`), and cross-cause
    // identity-clustering (`server.curator.identityClusters`) are
    // all wired; this scenario keeps the two enforcement gates
    // inert (defaults 0 / Infinity) and mints all identities at
    // attestation 0 to preserve its role as the regression handle
    // for the seam — each gate's standalone refusal scenario pins
    // the closure under non-default settings. Cross-cause
    // identity-clustering is a curator-side surveillance projection
    // (no enforcement gate fires from it directly), so its presence
    // is invisible to the scenario's outcome unless the curator
    // explicitly invokes the projection. The fourth layer
    // (issuance-frequency cap) lives below the MCP layer and is
    // wired on the testbed side as the `AdversaryBudget` primitive
    // (see slice 5 scenario downstream); the harness fiction
    // operationalizes the per-epoch issuance cap as a refusal mode
    // distinct from binding-cost-budget exhaustion, but no server
    // gate fires from it (the cap is enforced upstream of the MCP
    // surface in production). This scenario keeps every identity-
    // layer knob inert (defaults) so it stays the regression handle
    // for the seam those layers close — each layer's standalone
    // refusal scenario pins the closure under non-default settings.
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

  it('binding-cost gate: identities below min_attestation_level refuse with `unauthorized` at every write seam (PRD §Identity bullet 1)', async () => {
    // PRD §Identity bullet 1 (binding cost) — the first of the four
    // sybil-resistance layers PRD §Identity specs. The IdP records
    // `attestation_level` on the identity at mint, opaque to the
    // server; the server gates all 13 write tools on the
    // `min_attestation_level` threshold and refuses with
    // `unauthorized` rather than the rep gates' `not_found` opacity
    // (binding cost is identity-level, not work-availability-opaque,
    // so the refusal accurately names the mismatch instead of
    // masking it as "no work available"). Read-path tools are not
    // gated. The scenario pins the contract on a representative
    // cross-section of write seams: capacity declaration,
    // assignment pull, contributor-initiated propose, contributor-
    // initiated review. Each seam shares the same
    // `requireMinAttestation` helper, so a refusal here is the gate
    // firing before any tool-specific logic runs.
    //
    // The seam this scenario closes is the one the sybil-amplified-
    // coalition scenario above is the regression handle for: a fresh
    // recruit walks past behavior-based defenses by construction
    // because cluster signal, calibration record, and reputation
    // gates all need accumulated per-identity history. The
    // binding-cost gate fires before any history accrues, so a
    // fresh sybil minted at attestation 0 cannot start the
    // accumulation that would let those layers engage. Cost lives
    // at the IdP (not in the testbed); the harness's adversary-
    // budget model expresses it (PRD §Adversary testbed: adversary
    // budget model).
    const sources = new Map([['1', 'arm A: stage III treatment X works in the cohort']]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('att'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: { min_attestation_level: 1 },
    });
    const alice = server.bootstrap.mintIdentity({
      display_name: 'alice',
      attestation_level: 1,
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const sub = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'st',
      description: 'x',
      scope_query: 'x',
    });
    // alice (attestation 1) seeds a staged proposal so
    // cast_review_vote has a real proposal_id to target. The gate
    // fires before the proposal is even resolved regardless.
    const seedR = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: sub.id,
        content: 'paper 1',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );

    // Eve mints at attestation 0 — below threshold.
    const eve = server.bootstrap.mintIdentity({
      display_name: 'eve',
      attestation_level: 0,
    });
    const cEve = { identity_id: eve.id };

    // Each write seam refuses with `unauthorized`. The error code
    // (not just the throw) is what's load-bearing: a future
    // refactor that conflates this gate's refusal with another
    // mode (e.g. `not_found`) would silently drop the
    // architecturally-load-bearing distinction between
    // identity-layer mismatch and work-availability opacity.
    await expect(
      server.tools.setCapacity(cEve, {
        cause_id: cause.id,
        rate: 1,
        kinds: ['excerpt'],
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      server.tools.requestAssignment(cEve, { cause_id: cause.id }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      server.tools.proposeAnchor(cEve, {
        cause_id: cause.id,
        home_sub_topic_id: sub.id,
        content: 'paper 2',
        external_ref: { kind: 'pmid', value: '2' },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      server.tools.castReviewVote(cEve, {
        proposal_id: seedR.proposal_id,
        decision: 'accept',
        rationale: 'fine',
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });

    // Erin mints at threshold and the same seams pass — both
    // set_capacity and a contributor-initiated propose_anchor
    // succeed without throwing, confirming that for an above-
    // threshold identity the gate doesn't fire and each tool's own
    // logic runs to completion. The successful set_capacity is
    // load-bearing: the gate fires before set_capacity's body, so
    // a return without throw is direct evidence the gate was
    // inert. The successful propose_anchor exercises a different
    // write seam (contributor-initiated propose) for the same
    // shape of evidence.
    const erin = server.bootstrap.mintIdentity({
      display_name: 'erin',
      attestation_level: 1,
    });
    const cErin = { identity_id: erin.id };
    await server.tools.setCapacity(cErin, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['excerpt', 'review'],
    });
    const erinR = await server.tools.proposeAnchor(cErin, {
      cause_id: cause.id,
      home_sub_topic_id: sub.id,
      content: 'paper 3',
      external_ref: { kind: 'pmid', value: '3' },
    });
    expect(erinR.proposal_id).toBeDefined();
  });

  it('rate-limit accounting: per-identity write-action budget refuses with `rate_limited` after cap, resets on epoch boundary (PRD §Identity bullet 3)', async () => {
    // PRD §Identity bullet 3 (per-identity rate-limit accounting) —
    // the third of the four sybil-resistance layers PRD §Identity
    // specs. Per-(identity, epoch) counters cap each identity's
    // write-action throughput; when the counter hits the cap, the
    // tool refuses with the new `rate_limited` mode (parallel to
    // `not_found` and `unauthorized` but with a distinct recovery
    // path: "wait for the next epoch"). The cap is on *total* write
    // actions per identity per epoch, not per-tool, so the
    // cost-multiplier reads as the per-sybil-throughput axis
    // directly: at K sybils with cap T, the coalition's per-epoch
    // budget is K × T.
    //
    // The scenario pins the contract end-to-end: a single
    // identity's first 3 actions land, the 4th refuses, the same
    // refusal fires across different write tools (proving the cap
    // is global rather than per-tool), and the counter resets at
    // the epoch boundary so the same identity can act again.
    const sources = new Map([
      ['1', 'arm A: stage III treatment X works in the cohort'],
      ['2', 'arm B: stage IV treatment Y has no effect'],
      ['3', 'arm C: combination Z'],
      ['4', 'arm D: control'],
    ]);
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('rl'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        rate_limit_actions_per_epoch: 3,
        rate_limit_epoch_seconds: 60,
      },
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const sub = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'st',
      description: 'x',
      scope_query: 'x',
    });
    const eve = server.bootstrap.mintIdentity({ display_name: 'eve' });
    const cEve = { identity_id: eve.id };

    // Action 1: set_capacity (budget 1/3).
    await server.tools.setCapacity(cEve, {
      cause_id: cause.id,
      rate: 5,
      kinds: ['anchor', 'excerpt', 'review'],
    });
    // Action 2-3: propose_anchor (budget 2/3, then 3/3).
    await server.tools.proposeAnchor(cEve, {
      cause_id: cause.id,
      home_sub_topic_id: sub.id,
      content: 'paper 1',
      external_ref: { kind: 'pmid', value: '1' },
    });
    await server.tools.proposeAnchor(cEve, {
      cause_id: cause.id,
      home_sub_topic_id: sub.id,
      content: 'paper 2',
      external_ref: { kind: 'pmid', value: '2' },
    });

    // Action 4: refuses with `rate_limited`. The cap fires at the
    // shared accountWriteAction helper, before tool-specific
    // business logic; the same refusal would surface at any write
    // tool the caller invokes next.
    await expect(
      server.tools.proposeAnchor(cEve, {
        cause_id: cause.id,
        home_sub_topic_id: sub.id,
        content: 'paper 3',
        external_ref: { kind: 'pmid', value: '3' },
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    // Cross-tool: a *different* write tool hits the same cap. Pins
    // the global-throughput semantic — the cap is on total
    // per-identity write actions, not per-tool.
    await expect(
      server.tools.requestAssignment(cEve, { cause_id: cause.id }),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    // Advance past the epoch boundary (60 seconds + a tick to be
    // safe). The counter resets lazily on the next gate fire.
    clock.advance(61 * 1000);
    await server.tools.proposeAnchor(cEve, {
      cause_id: cause.id,
      home_sub_topic_id: sub.id,
      content: 'paper 4',
      external_ref: { kind: 'pmid', value: '4' },
    });

    // Server state: 3 anchor proposals successfully landed (papers
    // 1, 2, 4 — paper 3 was refused). The refused calls left no
    // proposal record, matching the contract that rate-limit
    // refusal happens before tool-specific state changes.
    const anchors = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'anchor' && p.proposer_id === eve.id,
    );
    expect(anchors).toHaveLength(3);
  });

  it('cross-cause identity-clustering: pairs voting together across causes surface; single-cause pairs do not (PRD §Identity bullet 4)', async () => {
    // PRD §Identity bullet 4 (cross-cause identity-clustering) —
    // the fourth of the four sybil-resistance layers. Curator-side
    // projection parallel to `declinePatterns` but on a different
    // signal: per-(reviewer pair) count of distinct causes where
    // both reviewers cast votes on the same proposal. Honest
    // reviewers typically work in one cause (per-cause reputation);
    // a pair appearing on shared proposals across multiple causes
    // is the cross-cause behavioral fingerprint a sybil farm
    // working multiple causes lights up and a single-cause
    // coalition does not. Two metrics: `cross_cause_count` (the
    // headline signal, default `min_signal=2`) and
    // `shared_proposal_count` (visibility tiebreaker the curator
    // weighs).
    //
    // The scenario pins the projection's contract: a sybil pair
    // (Alice+Bob) coordinates across two causes (CRC and AMR), an
    // honest pair (Carol+Dave) coordinates within one cause only;
    // identityClusters() with default `min_signal=2` returns the
    // sybil pair only — Carol+Dave's `cross_cause_count=1` is
    // below threshold, even though they share one proposal each.
    // Filtering by `min_signal=1` returns both pairs, confirming
    // the threshold mechanic.
    const sources = new Map([
      ['1', 'crc paper 1'],
      ['2', 'crc paper 2'],
      ['3', 'amr paper 1'],
      ['4', 'amr paper 2'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('cl'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
    });
    // Two causes, each with one sub-topic.
    const crc = server.bootstrap.createCause({ name: 'CRC', description: 'colorectal' });
    const amr = server.bootstrap.createCause({ name: 'AMR', description: 'antibiotic' });
    const crcSt = server.bootstrap.seedSubTopic({
      cause_id: crc.id,
      name: 'crc-st',
      description: 'x',
      scope_query: 'x',
    });
    const amrSt = server.bootstrap.seedSubTopic({
      cause_id: amr.id,
      name: 'amr-st',
      description: 'y',
      scope_query: 'y',
    });
    // alice seeds proposals; bob is the proposer for the second
    // sybil-pair-shared proposal (mixing proposers ensures the
    // cluster signal isn't an artifact of a single proposer).
    const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
    const proposalCrc1 = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: crc.id,
        home_sub_topic_id: crcSt.id,
        content: 'crc 1',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    const proposalAmr1 = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: amr.id,
        home_sub_topic_id: amrSt.id,
        content: 'amr 1',
        external_ref: { kind: 'pmid', value: '3' },
      },
    );
    // Alice + Bob: the sybil pair. Both vote on both proposals
    // (one CRC, one AMR) → cross_cause_count = 2,
    // shared_proposal_count = 2.
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    for (const id of [alice.id, bob.id]) {
      await server.tools.castReviewVote(
        { identity_id: id },
        { proposal_id: proposalCrc1.proposal_id, decision: 'accept', rationale: 'r' },
      );
      await server.tools.castReviewVote(
        { identity_id: id },
        { proposal_id: proposalAmr1.proposal_id, decision: 'accept', rationale: 'r' },
      );
    }
    // Carol + Dave: the honest pair. Both vote on a CRC proposal
    // only → cross_cause_count = 1, shared_proposal_count = 1.
    const proposalCrc2 = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: crc.id,
        home_sub_topic_id: crcSt.id,
        content: 'crc 2',
        external_ref: { kind: 'pmid', value: '2' },
      },
    );
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    for (const id of [carol.id, dave.id]) {
      await server.tools.castReviewVote(
        { identity_id: id },
        { proposal_id: proposalCrc2.proposal_id, decision: 'accept', rationale: 'r' },
      );
    }

    // Default `min_signal=2` returns Alice+Bob only — the sybil
    // pair is the headline signal, the honest single-cause pair is
    // filtered out by construction.
    const defaultClusters = server.curator.identityClusters();
    expect(defaultClusters).toHaveLength(1);
    const sybilOnly = defaultClusters[0];
    if (!sybilOnly) throw new Error('expected sybil cluster');
    expect(sybilOnly).toMatchObject({
      cross_cause_count: 2,
      shared_proposal_count: 2,
    });
    // Pair canonicalization: identity_a < identity_b.
    expect(sybilOnly.identity_a < sybilOnly.identity_b).toBe(true);
    expect([sybilOnly.identity_a, sybilOnly.identity_b].sort()).toEqual([alice.id, bob.id].sort());

    // Lowering `min_signal=1` brings Carol+Dave in too. Sybil pair
    // sorts first by `cross_cause_count desc`.
    const allClusters = server.curator.identityClusters({ min_signal: 1 });
    expect(allClusters).toHaveLength(2);
    const sybilCluster = allClusters[0];
    const honestCluster = allClusters[1];
    if (!sybilCluster || !honestCluster) throw new Error('expected two clusters');
    expect(sybilCluster.cross_cause_count).toBe(2);
    expect(honestCluster.cross_cause_count).toBe(1);
    expect([honestCluster.identity_a, honestCluster.identity_b].sort()).toEqual(
      [carol.id, dave.id].sort(),
    );
  });

  it('cross-cause reputation independence: rep accrued in cause A does not surface in cause B; demo gate in cause B fires against a cause-A-only identity by null-policy (PRD §Reputation, per-(cause, sub-topic) keying)', async () => {
    // PRD §Reputation commits per-(cause, sub-topic)-keyed reputation
    // accrued from work landed in that cause. The architectural
    // claim is *no transfer*: an identity who has built rep through
    // contributor-initiated work in cause A starts at zero in cause B
    // and must bootstrap there independently. The storage model
    // (`reputations` keyed by `${IdentityId}|${CauseId}|${SubTopicId}`)
    // makes this structural-by-construction, but a CI-checked
    // regression catches a future cross-cause fold or transfer
    // mechanism that would silently break the per-cause defense the
    // demo gate's null-policy depends on.
    //
    // The scenario pins both halves of the contract: Carol builds
    // contributor-initiated demo in cause A through two convergences
    // (Carol+Erin pairs on accept-all targets, demonstrated +=
    // contributor_initiated_factor per accurate review per the
    // alpha=1 default). She then queries her rep in cause B
    // (separate cause, separate sub-topic) and gets an empty
    // result. With `assignment_min_demonstrated`=1.5 active in
    // cause B, her `request_assignment` in cause B refuses with
    // `not_found` — the demo gate's null-policy fires (no rep entries
    // in the requested cause → fail when threshold > 0), exactly the
    // closure that protects against a sybil farm rep-laundering
    // through a low-defense cause to leverage in a high-defense one.
    const sources = new Map([
      ['1', 'cause A paper 1: treatment X works for stage III patients'],
      ['2', 'cause A paper 2: treatment X works for stage IV patients'],
      ['3', 'cause B paper 1: antibiotic Y resistance pattern observed'],
      ['4', 'cause A paper 3: treatment X works for stage III patients in confirmation'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('xc'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        // Demo gate active at cube #2's calibrated value. The gate
        // is per-cause by construction (it queries the caller's rep
        // entries in the requested cause); the regression here is
        // that a fresh-in-cause-B identity fails the gate even when
        // they have a stockpile in cause A.
        assignment_min_demonstrated: 1.5,
      },
    });
    const causeA = server.bootstrap.createCause({ name: 'CRC', description: 'cause A' });
    const causeB = server.bootstrap.createCause({ name: 'AMR', description: 'cause B' });
    const subTopicA = server.bootstrap.seedSubTopic({
      cause_id: causeA.id,
      name: 'a-topic',
      description: 'a',
      scope_query: 'a',
    });
    const subTopicB = server.bootstrap.seedSubTopic({
      cause_id: causeB.id,
      name: 'b-topic',
      description: 'b',
      scope_query: 'b',
    });
    const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });

    // Cause A bootstrap: two contributor-initiated convergences via
    // Carol+Erin accept votes on accept-all targets in cause A.
    // After two convergences, Carol's demonstrated in cause A clears
    // 1.5 (each convergence gives reviewer_accurate_gain *
    // contributor_initiated_factor = 1 * 0.5 = 0.5; two of them
    // give demonstrated = 1.0, plus the proposer's accept moves
    // both reviewers' rep on convergence path). The exact value
    // doesn't matter — what matters is that Carol has rep in cause
    // A but not cause B.
    for (let i = 1; i <= 2; i++) {
      const a = await server.tools.proposeAnchor(
        { identity_id: seeder.id },
        {
          cause_id: causeA.id,
          home_sub_topic_id: subTopicA.id,
          content: `cause A paper ${i}`,
          external_ref: { kind: 'pmid', value: String(i) },
        },
      );
      server.curator.acceptProposal(a.proposal_id);
      const anchorNode = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `cause A paper ${i}`,
      );
      if (!anchorNode) throw new Error(`cause A paper ${i} anchor not materialized`);
      const e = await server.tools.proposeExcerpt(
        { identity_id: seeder.id },
        {
          cause_id: causeA.id,
          home_sub_topic_id: subTopicA.id,
          parent_anchor_id: anchorNode.id,
          content: `cause A excerpt ${i}`,
          quoted_span: {
            text: `treatment X works for stage ${i === 1 ? 'III' : 'IV'} patients`,
            offset: 0,
          },
        },
      );
      for (const voterId of [carol.id, erin.id]) {
        await server.tools.castReviewVote(
          { identity_id: voterId },
          {
            proposal_id: e.proposal_id,
            decision: 'accept',
            rationale: 'consistent with prevailing evidence',
          },
        );
      }
    }

    // Carol's rep in cause A: at least one entry, demonstrated > 0.
    const carolRepA = await server.tools.queryReputation(
      { identity_id: carol.id },
      { cause_id: causeA.id },
    );
    expect(carolRepA.entries.length).toBeGreaterThan(0);
    const carolDemoA = carolRepA.entries.reduce(
      (max, entry) => Math.max(max, entry.demonstrated),
      0,
    );
    expect(carolDemoA).toBeGreaterThan(0);

    // Carol's rep in cause B: empty by construction. The
    // `reputations` map is keyed by (identity, cause, sub_topic);
    // no work in cause B → no entries. This is the structural
    // claim the regression pins as a CI-checked invariant.
    const carolRepB = await server.tools.queryReputation(
      { identity_id: carol.id },
      { cause_id: causeB.id },
    );
    expect(carolRepB.entries).toEqual([]);

    // Cause B has work available: a fresh excerpt staged for review.
    // Without this, request_assignment would refuse for "no work
    // available" rather than "demo gate fires" — the test would
    // pass for the wrong reason.
    const anchorB = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: causeB.id,
        home_sub_topic_id: subTopicB.id,
        content: 'cause B paper 1',
        external_ref: { kind: 'pmid', value: '3' },
      },
    );
    server.curator.acceptProposal(anchorB.proposal_id);
    const anchorBNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'cause B paper 1',
    );
    if (!anchorBNode) throw new Error('cause B anchor not materialized');
    await server.tools.proposeExcerpt(
      { identity_id: seeder.id },
      {
        cause_id: causeB.id,
        home_sub_topic_id: subTopicB.id,
        parent_anchor_id: anchorBNode.id,
        content: 'cause B excerpt 1',
        quoted_span: { text: 'antibiotic Y resistance pattern', offset: 0 },
      },
    );

    // Carol declares capacity in cause B (the gate is consulted at
    // request_assignment, not at set_capacity).
    await server.tools.setCapacity(
      { identity_id: carol.id },
      { cause_id: causeB.id, rate: 1, kinds: ['review'] },
    );

    // Carol's request_assignment in cause B refuses with `not_found`
    // — the demo gate's null-policy fires (no rep entries in cause
    // B → fail when threshold > 0). Her cause-A demonstrated does
    // *not* transfer; the storage's per-cause keying makes the
    // gate's per-cause defense structural-by-construction. The same
    // closure protects against a sybil farm building rep in a low-
    // defense cause to leverage in a high-defense one.
    await expect(
      server.tools.requestAssignment(
        { identity_id: carol.id },
        { cause_id: causeB.id, kind: 'review' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Symmetric counter-check: Carol's request_assignment in cause
    // A succeeds (her cause-A demo clears 1.5). The contrast pins
    // that the cause-B refusal is *because* of the per-cause null-
    // policy, not because of an unrelated configuration error that
    // would also affect cause A. Stage a fresh cause-A excerpt
    // Carol hasn't voted on so the assignment loop has eligible
    // work — the bootstrap excerpts are conflict-of-interest-
    // filtered (already voted on) and would otherwise produce the
    // wrong refusal mode (no-work-available rather than gate-passes).
    const freshAnchorA = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: causeA.id,
        home_sub_topic_id: subTopicA.id,
        content: 'cause A paper 3',
        external_ref: { kind: 'pmid', value: '4' },
      },
    );
    server.curator.acceptProposal(freshAnchorA.proposal_id);
    const freshAnchorANode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'cause A paper 3',
    );
    if (!freshAnchorANode) throw new Error('cause A paper 3 anchor not materialized');
    await server.tools.proposeExcerpt(
      { identity_id: seeder.id },
      {
        cause_id: causeA.id,
        home_sub_topic_id: subTopicA.id,
        parent_anchor_id: freshAnchorANode.id,
        content: 'cause A excerpt 3',
        quoted_span: { text: 'treatment X works for stage III patients', offset: 0 },
      },
    );
    await server.tools.setCapacity(
      { identity_id: carol.id },
      { cause_id: causeA.id, rate: 1, kinds: ['review'] },
    );
    const causeAAssignment = await server.tools.requestAssignment(
      { identity_id: carol.id },
      { cause_id: causeA.id, kind: 'review' },
    );
    expect(causeAAssignment.task.kind).toBe('review');
  });

  it('adversary-budget model: K identities cost K × α; issuance cap caps mints per epoch; per-identity throughput cap caps actions per epoch (PRD §Adversary testbed: adversary budget model)', () => {
    // Slice 5 of the identity-cost design pass — the testbed-side
    // budget arithmetic that closes the loop on the four-layer sybil-
    // resistance architecture PRD §Identity composes multiplicatively.
    // Slices 2/3/4 wired the MCP-side primitives: binding-cost gate
    // (`min_attestation_level`, refusing with `unauthorized`), per-
    // identity rate-limit accounting (`rate_limit_actions_per_epoch`,
    // refusing with `rate_limited`), and the cross-cause clustering
    // projection (`server.curator.identityClusters`, surfacing
    // coordination at the curator surface). The fourth layer
    // (issuance-frequency cap) lives below the MCP layer — the server
    // does not mint identities and has no surface to enforce it
    // directly — so it lands as a testbed-side fiction in the
    // `AdversaryBudget` primitive declared at module scope.
    //
    // This regression pins the three deductions arithmetic-only,
    // matching the cube template's per-cell-shape practice (assert
    // the named pathology directly; don't rely on downstream
    // composition to read out the primitive's behavior). Composing
    // the budget axis as a sweep dimension on top of the existing
    // parameter-sweep cubes — the sweep dimension PRD §Identity
    // names "coalition-affordable-identities-per-epoch" — is the
    // follow-up that lands once the primitive is in place.
    const budget = new AdversaryBudget({
      initial: 3,
      attestation_cost: 1,
      issuance_cap_per_epoch: 1,
      action_cap_per_epoch: 2,
    });

    // Binding-cost layer: minting deducts α=1 from B=3.
    expect(budget.tryMint(0)).toEqual({ ok: true });
    expect(budget.budgetRemaining).toBe(2);
    expect(budget.mintedInEpoch(0)).toBe(1);

    // Issuance-frequency cap: second mint in the *same* epoch refuses
    // with `issuance_cap`. Budget is unchanged because the IdP
    // refuses upstream of any cost being charged.
    expect(budget.tryMint(0)).toEqual({ ok: false, reason: 'issuance_cap' });
    expect(budget.budgetRemaining).toBe(2);
    expect(budget.mintedInEpoch(0)).toBe(1);

    // Advancing to epoch 1 — the same mint succeeds. The cap is the
    // *time* primitive on the cost-multiplier: the adversary cannot
    // mint K sybils all in one epoch even if budget would allow it,
    // which buys behavior-based defenses (cluster signal, calibration
    // record, reputation gates) the per-identity history they need.
    expect(budget.tryMint(1)).toEqual({ ok: true });
    expect(budget.budgetRemaining).toBe(1);

    // Epoch 2: third mint succeeds and drains the budget to zero.
    expect(budget.tryMint(2)).toEqual({ ok: true });
    expect(budget.budgetRemaining).toBe(0);

    // Epoch 3: budget exhausted before issuance cap is consulted —
    // refusal mode is `budget`, not `issuance_cap`. The two failure
    // modes are distinct: `budget` is "the operator cannot afford
    // another sybil at any rate," `issuance_cap` is "the operator
    // could afford it but the IdP refuses to mint another in this
    // epoch." The distinction matters when sweeps measure ASR as a
    // function of coalition-affordable-identities-per-epoch — the
    // budget axis caps the total K, the issuance cap shapes its
    // distribution across epochs.
    expect(budget.tryMint(3)).toEqual({ ok: false, reason: 'budget' });

    // Per-(identity, epoch) throughput cap (T=2). Identity 'a' acts
    // twice in epoch 0 — both succeed; the third action refuses
    // (cap reached). Mirrors the server-side `accountWriteAction`
    // arithmetic on the testbed side so the harness reads coalition
    // throughput as K × T directly without observing every server
    // refusal.
    expect(budget.tryAct('a', 0)).toBe(true);
    expect(budget.tryAct('a', 0)).toBe(true);
    expect(budget.tryAct('a', 0)).toBe(false);

    // Identity 'b' is independent — each identity has its own
    // per-epoch counter, so the K × T composition holds (one
    // identity's exhaustion does not consume another's budget).
    expect(budget.tryAct('b', 0)).toBe(true);
    expect(budget.tryAct('b', 0)).toBe(true);
    expect(budget.tryAct('b', 0)).toBe(false);

    // Epoch boundary resets the per-identity counter, matching the
    // server-side rate-limiter's wall-clock-window semantics: the
    // cap is per-(identity, epoch), so a fresh epoch is a fresh
    // counter.
    expect(budget.tryAct('a', 1)).toBe(true);
    expect(budget.tryAct('a', 1)).toBe(true);
    expect(budget.tryAct('a', 1)).toBe(false);

    // Default action cap is Infinity (gate inert) — a budget
    // configured without an action cap models "binding cost +
    // issuance frequency only," for sweeps that hold throughput
    // unbounded and isolate the identity-creation axis.
    const inertActionCap = new AdversaryBudget({
      initial: 1,
      attestation_cost: 1,
      issuance_cap_per_epoch: 1,
    });
    expect(inertActionCap.tryAct('x', 0)).toBe(true);
    expect(inertActionCap.tryAct('x', 0)).toBe(true);
    expect(inertActionCap.tryAct('x', 0)).toBe(true);
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
    // staged: the v0 positive-only cluster signal is co-occurrence-
    // based and lossy in this direction. The closure that shipped is
    // anti-correlation detection (PRD §Reviewer assignment, ROADMAP
    // §Status) — treating perfect anti-correlation as a co-stratum
    // edge alongside agreement, scenarioed separately at threshold
    // 1.0 in the same describe-block; this test stays as the
    // regression handle on the *bypassed* config (anti-correlation
    // off / threshold 0) so accidentally closing the bypass at this
    // baseline trips a named invariant rather than silently moving
    // the seam.
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
    // bypass — orthogonal failure mode to over-aggregation, vote-
    // pattern-shaped instead of unanimous-priming-shaped — is
    // scenarioed in the same describe-block above and closes
    // separately under the anti-correlation refinement scenarioed
    // below (PRD §Reviewer assignment, ROADMAP §Status); the
    // mixed-strategy variant that sits in the gap between either
    // refinement alone closes only under the composition of both,
    // also pinned separately.
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
    // honest false positives. The mixed-strategy variant that
    // sits in the gap between either refinement alone — agreement
    // 0.5 / disagreement 0.5 across shared priming, below threshold
    // 1.0 in both directions — is scenarioed separately in the
    // same describe-block and closes under the *composition* of
    // contention-weighted edges + anti-correlation: contention
    // weighting reweights the pair-stat so the weighted disagreement
    // ratio collapses back to 1.0 and the anti-correlation edge
    // fires.
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
    // vector reopens against either refinement alone — agreement-
    // only or anti-correlation-only — and the wired closure is the
    // *composition* (contention-weighted edges + anti-correlation,
    // both on at threshold 1.0): contention weighting reweights the
    // pair-stat so agreement on unanimous-easy items contributes
    // 0 weight and disagreement on contentious items contributes
    // the full weight, collapsing the weighted disagreement ratio
    // back to 1.0 and tripping the anti-correlation edge that the
    // raw mix sat below. PRD §Reviewer assignment commits the
    // composition closure and ROADMAP §Status pins it as a CI-
    // checked invariant; this test stays as the regression handle
    // on each refinement-alone config so the gap between thresholds
    // remains observable when the composition is unwired. The
    // seam beyond the composition closure — a coalition that
    // avoids co-voting on any contentious item — has its concrete
    // instance in the multi-proposal paired-decline coalition,
    // closed structurally by the encounter-domain extension
    // (`stratum_include_declines`) + paired-decline floor and
    // operationally by the divergence-closure archival sweep
    // (PRD §Reviewer assignment, ROADMAP §Status). Adaptations
    // that route around both closures — coordinating off-platform
    // so coalition members share no encounter at all — remain
    // testbed targets if they surface; PRD §Reviewer assignment
    // names calibration-item-specific agreement and payload-
    // feature vote patterns as the candidate refinements for
    // those.
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
    // capacity is cause-level. PRD §Capacity and assignment commits
    // two surfaces on the same per-(cause, reviewer) cumulative-rate
    // signal: a curator-side projection (`declinePatterns`) for
    // visibility, and an assignment-time gate
    // (`assignment_max_decline_rate`) for enforcement. This scenario
    // wires the projection end-to-end; the assignment-time gate has
    // its own scenario downstream.
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
    // The vote-only closure stack does not catch this:
    //   - cluster signal at the vote-only encounter domain
    //     (contention-weighted, anti-correlation 1.0, agreement 1.0):
    //     silent — Carol and Dave share no *vote* proposals, so no
    //     edge metric has data to fire.
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
    //     but the projection is a *visibility* surface, not the
    //     assignment-time gate.
    //
    // The terminal outcome is the divergence-closure sweep above:
    // both contested targets archive as `unresolved-archived` once
    // the window expires, which from the proposer's perspective is
    // the suppression result the coalition is driving toward —
    // neither target accepts.
    //
    // Wired closures kept off in this scenario as the regression
    // handle on the vote-only baseline (each is exercised in its
    // own scenario with the closure on):
    //   - encounter-domain widening (`stratum_include_declines`,
    //     PRD §Reviewer assignment, ROADMAP §Status): widens the
    //     cluster primitive's encounter domain to {accept, reject,
    //     decline}; with the knob on, "Carol rejects target1 +
    //     declines target2; Dave declines target1 + rejects target2"
    //     reads as 100% pair-disagreement on 2 shared encounters
    //     under the existing anti-correlation primitive at threshold
    //     1.0 and the cross-stratum gate fires against the partner.
    //   - decline-pattern → assignment-gate (`assignment_max_decline_rate`,
    //     `assignment_decline_min_offers`, PRD §Capacity and
    //     assignment, ROADMAP §Status): the operational form of the
    //     curator-side `declinePatterns` projection — refuses
    //     assignment when the per-(cause, reviewer) cumulative
    //     decline rate clears the threshold and the offers floor.
    //
    // Candidate v0+ defenses still not wired that would close
    // adjacent cases this scenario does not cover:
    //   - pool-size enforcement: refuse to start review on a
    //     proposal until the eligible-pool size clears a floor, so
    //     a single biased lone-reject cannot persist a tie until
    //     the divergence window expires — distinct from the wired
    //     pool-size *scaling* lever (raising votes_to_X to N), which
    //     this scenario already runs into the small-pool case of.
    //   - multi-proposal staling pattern: detect "the same identity
    //     is the lone rejecter on a stalled proposal across N
    //     proposals" as its own coalition signal, complementary to
    //     the per-pair cluster signal that needs co-occurrence
    //     (vote *or* decline-aware) to fire.
    //
    // The wired closures above carry the multi-round paired-decline
    // pattern through cube #3 (`stratum_include_declines`) and cube
    // #4 (contention-weighting × paired-decline-floor) already; this
    // scenario stays as a standalone regression handle on the
    // refinement-bypassed config (declines off) and the divergence-
    // closure-by-archival outcome shape, which the cubes don't
    // exercise on this exact contested-target-decline geometry.
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
      ['3', 'arm C: treatment X has no effect in stage IV patients across the second cohort'],
    ]);
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
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
        stratum_contention_weighted: true,
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
    clock.advance(120_000);
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
    // before any cluster-history accumulates. The next scenario
    // wires the multi-round closure with priming history built first,
    // and cube #3 (`stratum_include_declines`) joins both halves to
    // the aggregate-ASR property downstream.
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
      const anchorIds: NodeId[] = [];
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

  it('patient-adversary archetype: two-component bookkeeping exposes the recent-activity drain that assignment-gating consumes (PRD §Reputation)', async () => {
    // PRD §Adversary taxonomy (Patient adversary): "Strategic
    // adversary with a long horizon — builds reputation honestly for
    // months before drift attempts. Tests whether per-(cause, sub-
    // topic) reputation tracking and review-as-staking prevent slow
    // drift." PRD §Reputation names the defenses: two-component
    // reputation — a slow-decay demonstrated-competence component
    // gating eligibility tiers, plus a fast-decay recent-activity
    // component gating assignment.
    //
    // Two-component bookkeeping is wired (PRD §Reputation): every
    // reputation event moves both components together; on read,
    // each component decays exponentially per its own half-life.
    // The gating layers on top — `assignment_min_recent` (fast-decay,
    // recent-activity gating assignment) and the slow-decay
    // `assignment_min_demonstrated` (demonstrated-competence gating
    // eligibility tiers) — are also wired and have their own
    // scenarios below (the recent-gate scenario downstream pins
    // Carol failing the gate after a quiet window; the demo-gate
    // scenario pins fresh identities being refused at
    // request_assignment until they bootstrap via contributor-
    // initiated voting). This scenario stays focused on the
    // bookkeeping and decay layer in isolation: gates default to 0
    // here so the rep-ledger movement is what's observed, not the
    // gate behavior layered on top.
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
    //     gap is the measurement the assignment-gating companion
    //     scenario below reads against.
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
    // The two refinements adjacent to this scenario *are* wired and
    // covered by their own scenarios — difficulty-normalized review
    // credit (PRD §Reputation, "review-credit normalized by claim
    // difficulty") via the global `review_credit_contention_alpha`,
    // and demonstrated-component gating via the wired
    // `assignment_min_demonstrated` knob. What remains as future
    // iterations is class-aware *variation* of those primitives:
    // per-proposal-kind / per-sub-topic alpha values, and the named
    // eligibility tiers (PRD §Reputation, "Eligibility tiers public;
    // numeric reputation private") the demonstrated gate would feed
    // once tiers are defined.
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
    // drift. The PRD §Reputation contributor-initiated factor
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
    // cumulative tally would give. The gates that *consume* the
    // components (assignment_min_demonstrated for eligibility tiers,
    // assignment_min_recent for assignment draws) are both wired and
    // exercised in the gate-scenario right below — but they default
    // to 0 in this scenario, so this pin reads the bookkeeping-only
    // cumulative buffer (the lever the gate scenario consumes), not
    // the gated drift bandwidth. The gate scenario tightens this
    // number from cumulative-buffer to 1; this scenario locks in the
    // upstream lever it consumes.
    const driftBandwidth = Math.floor(carolDemonstrated / server.review.reviewer_inaccurate_loss);
    expect(driftBandwidth).toBeGreaterThan(1);

    // The new measurement: advance the clock past several recent
    // half-lives (Carol stops being recently active — the patient-
    // adversary's defining behavior between drift attempts) and re-
    // read. Demonstrated should be unchanged; recent should fall
    // toward zero. The gap is the lever. The wired assignment-gating
    // (assignment_min_recent > 0, exercised in the gate scenario
    // below) closes the patient-adversary loop on this side: Carol
    // can keep demonstrated high indefinitely, but cannot keep
    // recent high without continuing to vote — and the votes
    // themselves are observable.
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
    // The companion scenario the bookkeeping scenario above points
    // at: with `assignment_min_recent > 0` set, the recent-activity
    // component is consumed at request_assignment time:
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
    // edge metric to fire); PRD §Capacity and assignment commits two
    // surfaces against it on the same per-(cause, reviewer) cumulative-
    // rate signal — the curator-side `declinePatterns` projection
    // (visibility) and this gate (operational enforcement at the rep-
    // gate seam in `request_assignment`). Same numerator, same
    // denominator, same per-cause scope, so the projection and the
    // gate operate on a single signal. The closure on the seam is
    // throughput-mediated, not retroactive: the gate doesn't undo a
    // lone-reject that already landed, it caps the rate at which the
    // coalition can place new ones — for a coalition that paired-
    // declines half its offers, the gate fires after the second
    // decline and locks the member out of further routing. The
    // structural closure on the same seam (the encounter-domain
    // extension via `stratum_include_declines` reading paired-decline
    // encounters as 100% disagreement under the existing anti-
    // correlation primitive) is wired alongside this gate, and cube
    // #3 (the cluster-signal-decline-aware ASR cube against the co-
    // voting decorrelated and paired-decline multi-round coalitions
    // earlier in this file) reads the structural closure's *additive
    // lift* declines provide on top of the vote-only signal: 50% ASR
    // vote-only, 0% ASR decline-aware. This test pins the gate's
    // mechanics standalone — the gate operates on the cumulative-
    // rate signal at request_assignment time, the structural closure
    // operates on the per-encounter cluster primitive at vote-cast
    // time; the two surfaces are complementary on a single signal.
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
    const anchorIds: NodeId[] = [];
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
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
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

    const anchorIds: NodeId[] = [];
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

    clock.advance(120_000);
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
    // Subsequent sweeps follow this template (named defense config
    // → expected ASR, derived off the per-cell expected_status
    // fields). Cubes #2–5 (assignment-gate thresholds; the
    // encounter-domain widening; the contention-weighting × paired-
    // decline-floor interaction; the difficulty-aware re-baseline)
    // each layered on this shape, and cube #5 generalized the
    // single-ASR aggregate to the (ASR, lockout-rate) two-metric
    // split that closes the honest-pool-collapse vs attack-landed
    // conflation when a defense's failure mode is the former — that
    // refinement was retrofitted into cube #4 in turn.
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
    // Cube #15 (decay-cadence) overrides. Default of 60 / 360 preserves
    // the (recent_half_life=60s, quiet=6 half-lives) configuration cubes
    // #2 and #5 are calibrated against — changing the defaults
    // silently de-calibrates those cubes' lockout cells, so callers
    // sweeping the decay axis pass both explicitly.
    recent_half_life_seconds?: number;
    quiet_window_seconds?: number;
    // Cube #17 (demo-decay-cadence) override. Default Infinity
    // preserves the slow-decay-stockpile-holds behavior cubes #2,
    // #5, and #15 are calibrated against (Carol's demonstrated
    // stockpile holds across the quiet window because the demo
    // half-life is infinite by default); finite values opt the demo
    // component into the same exponential-decay regime cube #15
    // sweeps for the recent component, exposing the demo gate's
    // firing axis on the patient archetype.
    demonstrated_half_life_seconds?: number;
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
    const RECENT_HALF_LIFE_SECONDS = params.recent_half_life_seconds ?? 60;
    const QUIET_WINDOW_SECONDS = params.quiet_window_seconds ?? RECENT_HALF_LIFE_SECONDS * 6;
    const server = new Server({
      clock,
      idGen: new SeededIdGen('pgs'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
        demonstrated_half_life_seconds: params.demonstrated_half_life_seconds ?? Infinity,
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
    const primingAnchorIds: NodeId[] = [];
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
    const stagedExcerptIds: ProposalId[] = [];
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
    // two of the three pairs and ends with demonstrated = 2 *
    // alpha (each unanimous-easy convergence earns alpha credit
    // under PRD §Reputation's review_credit_contention_alpha
    // primitive). Pairs are carol+erin, carol+frank, erin+frank.
    // The post-bootstrap demonstrated value is load-bearing for the
    // alpha re-baseline cube (cube #5): cube-#2 thresholds at
    // alpha=1 expect demonstrated=2.0 (clears demo=1.5); the alpha-
    // shrinkage at alpha=0.5 produces demonstrated=1.0 (fails
    // demo=1.5 → false-positive lockout); the re-tuned demo=0.75
    // recovers the closure with honest-pool headroom of 0.25.
    // Changing BOOTSTRAP_COUNT or the pair structure changes the
    // bootstrap demonstrated value and silently de-calibrates
    // cube #5's re-tuned threshold — keep the rotation as-is or
    // re-derive the cube's expected lockout cells.
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
    // of the patient-adversary archetype. The default (six recent
    // half-lives) drains her recent by 64x — enough to fall below any
    // reasonable threshold the gate is set to. Cube #15 overrides
    // QUIET_WINDOW_SECONDS independently of RECENT_HALF_LIFE_SECONDS to
    // sweep the W/T ratio directly.
    clock.advance(QUIET_WINDOW_SECONDS * 1000);

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
  //
  // Honest-pool bootstrap: three fresh-honest reviewers (Erin, Frank,
  // George) prime via contributor-initiated rotating pairs on three
  // disjoint excerpts BEFORE the Carol+Dave coalition priming, the
  // same shape `runPatientAdversaryGateScenario` uses to clear its
  // honest pool past the demo gate without false-clustering. Each
  // pair shares exactly one bootstrap proposal (below
  // `stratum_min_shared_proposals: 2`) so the honest reviewers stay
  // singletons in the cluster signal; Carol+Dave's coalition priming
  // happens on separate excerpts so the honest bootstrap and the
  // coalition cluster don't share any vote-history. The honest pool
  // ends with demonstrated = 2 * alpha at alpha=1 (clears any demo
  // threshold ≤ 1.5), and the demo-gate sybil-side closure now
  // routes Carol-rejects + Erin-and-Frank-accepts to converge accepted
  // — honest defense rather than the lockout the prior bootstrap-less
  // shape produced. At alpha < 1 the honest bootstrap demonstrated
  // shrinks proportionally and the demo gate can re-trip on the
  // honest pool; the cube #5 sybil alpha-invariance regression below
  // pins where that re-baseline lands.
  async function runSybilAmplifiedGateScenario(params: {
    assignment_min_recent: number;
    assignment_min_demonstrated: number;
    review_credit_contention_alpha?: number;
    // Cube #20 ((alpha × stratification) re-baseline) overrides this
    // to sweep the cluster-signal closure axis. Default `true`
    // preserves the freshness-bypass scenario cubes #2 and #5 are
    // built on (the cross-stratum gate closes Dave, the demo gate's
    // null-policy closes Eve, and the honest pool's bootstrap
    // rotation converges contested across singleton strata). With it
    // off, Dave is never cross-stratum-gated, so Carol+Dave's two
    // rejects converge contested directly at vto=2 — the coalition
    // captures by arithmetic regardless of the demo gate (their
    // priming demonstrated clears it at both alphas the cube
    // sweeps), and the demo gate's only effect is the eligibility-
    // tier lockout on the honest pool at alpha < 1.
    stratification_enabled?: boolean;
  }): Promise<{
    attack_succeeded: boolean;
    false_positive_lockout: boolean;
    carol_demonstrated: number;
  }> {
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
        stratification_enabled: params.stratification_enabled ?? true,
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
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    const george = server.bootstrap.mintIdentity({ display_name: 'george' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const eve = server.bootstrap.mintIdentity({ display_name: 'eve' });
    const erinClient = await wireArchetype(server, erin.id);
    const frankClient = await wireArchetype(server, frank.id);
    const georgeClient = await wireArchetype(server, george.id);
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    const eveClient = await wireArchetype(server, eve.id);
    for (const c of [
      { identity_id: carol.id },
      { identity_id: dave.id },
      { identity_id: eve.id },
      { identity_id: erin.id },
      { identity_id: frank.id },
      { identity_id: george.id },
    ]) {
      await server.tools.setCapacity(c, {
        cause_id: cause.id,
        rate: 5,
        kinds: ['review'],
      });
    }

    // Honest-pool bootstrap excerpts — three disjoint excerpts on
    // anchor1 that the rotating pairs converge below. Same anchor as
    // the coalition priming so they share verifier source '1', but
    // Carol/Dave never vote on these and the honest pool never votes
    // on the coalition priming, so the cluster signal sees zero
    // shared vote-history across the two halves of the priming phase.
    const bootstrapExcerptIds: ProposalId[] = [];
    for (let i = 0; i < 3; i++) {
      const excerpt = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `bootstrap stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      bootstrapExcerptIds.push(excerpt.proposal_id);
    }

    // Rotating pairs — same shape as the patient runner. Each
    // honest reviewer appears in two of the three pairs and ends
    // with demonstrated = 2 * alpha (the contention-0 unanimous
    // priming earns alpha credit per vote under
    // `review_credit_contention_alpha`). Pairs sharing one proposal
    // sit below `stratum_min_shared_proposals: 2`, so no edges form
    // among the honest pool — Erin, Frank, George remain singletons
    // in the cluster signal at the time the contested target is
    // staged.
    const bootstrapPairs: Array<[typeof erin, typeof erin]> = [
      [erin, frank],
      [erin, george],
      [frank, george],
    ];
    for (let i = 0; i < bootstrapPairs.length; i++) {
      const proposalId = bootstrapExcerptIds[i];
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
    const erinResult = await runHonestReviewer(erinClient, {
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
    // Frank and George run after the coalition has had its shot at
    // contested, so the cube can read what the honest pool delivers
    // once the bootstrap-fix routes the second accept past Eve's
    // demo-gate closure (alpha=1) or fails to (alpha < 1, where the
    // bootstrap demonstrated shrinks below the gate and Erin/Frank/
    // George get locked out alongside Eve).
    await runHonestReviewer(frankClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });
    await runHonestReviewer(georgeClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    const target = server.store.proposals.get(contested.proposal_id);
    // Lockout reading per cube #5's two-metric template: honest
    // review collapsed at the gate. The honest pool is now Erin,
    // Frank, George; if any of them had its requestAssignment loop
    // end on `not_found` before casting a vote and the contested
    // target didn't reach 'accepted', the closure is lockout-driven
    // (the demo gate fired on the honest pool alongside Eve) rather
    // than honest defense. Reading on Erin is sufficient because the
    // bootstrap rotation is symmetric — at any alpha, Erin, Frank,
    // and George share the same demonstrated value, so the demo gate
    // either fires on all three or on none.
    const erinIdleNotFound = erinResult.actions.some(
      (a) => a.kind === 'idle' && a.reason === 'not_found',
    );
    const erinVoted = erinResult.actions.some((a) => a.kind === 'voted');
    const false_positive_lockout = erinIdleNotFound && !erinVoted && target?.status !== 'accepted';
    // Surface Carol's demonstrated for the sybil alpha-invariance
    // regression to pin: the structural sybil close (Eve null-policy
    // demo gate) depends on Carol+Dave clearing the same gate, and
    // their post-coalition-priming demonstrated lands exactly on the
    // strict-less-than predicate at alpha=0.5 (3 unanimous accepts ×
    // 0.5 = 1.5, equal to demo=1.5 → passes). The regression below
    // pins the value so a change to the priming count, alpha, or the
    // gate predicate trips a named invariant rather than silently
    // shifting the closure mechanism.
    const carolRep = await server.tools.queryReputation(
      { identity_id: carol.id },
      { cause_id: cause.id },
    );
    const carolRow = carolRep.entries.find((e) => e.sub_topic_id === subTopic.id);
    return {
      attack_succeeded: target?.status === 'rejected',
      false_positive_lockout,
      carol_demonstrated: carolRow?.demonstrated ?? 0,
    };
  }

  interface GateSweepCell {
    name: string;
    pattern: GateAttackPattern;
    assignment_min_recent: number;
    assignment_min_demonstrated: number;
    expected_attack_succeeded: boolean;
    expected_false_positive_lockout: boolean;
  }
  const gateSweepCells: GateSweepCell[] = [
    // Both gates off — neither archetype hits a defense. Floor row.
    {
      name: 'patient adversary, recent=0, demo=0 (no defenses)',
      pattern: 'patient',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    {
      name: 'sybil-amplified coalition, recent=0, demo=0 (no defenses)',
      pattern: 'sybil',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
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
      expected_false_positive_lockout: false,
    },
    {
      name: 'sybil-amplified coalition, recent=0.5, demo=0 (gate inert against fresh recruit)',
      pattern: 'sybil',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    // Demo gate only — closes patient via no path (demonstrated
    // buffer holds, attack lands). Closes sybil via honest defense:
    // Eve fails the demo gate by null-policy (zero rep), the honest
    // pool's bootstrap rotation lifts Erin/Frank/George to
    // demonstrated=2.0 (clears the 1.5 threshold) before contested,
    // Carol gets routed and rejects, Dave is cross-stratum-gated, and
    // Erin+Frank's accepts converge contested accepted across
    // singleton strata. The bootstrap rotation is what lifts the
    // sybil closure off the prior lockout-driven reading: without
    // it, the demo gate would fire on Erin too and contested would
    // stall 'staged' for the wrong reason. Cube #5's two-metric
    // template surfaces this distinction (ASR vs lockout-rate);
    // here the closure is honest defense at both metrics.
    {
      name: 'patient adversary, recent=0, demo=1.5 (gate inert against demonstrated buffer)',
      pattern: 'patient',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    {
      name: 'sybil-amplified coalition, recent=0, demo=1.5 (demo gate fires on Eve; honest pool clears via bootstrap)',
      pattern: 'sybil',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
    // Composition — patient closes by recent-gate honest defense
    // (Carol drains, Erin/Frank pass with bootstrap demonstrated=
    // 2.0); sybil closes by the demo gate firing on Eve while the
    // honest-pool bootstrap (Erin/Frank/George at demonstrated=2.0)
    // clears the same gate, Carol gets routed and rejects, Dave is
    // cross-stratum-gated, and Erin+Frank's accepts converge the
    // contested target — honest defense at both metrics.
    {
      name: 'patient adversary, recent=0.5, demo=1.5 (composition closes)',
      pattern: 'patient',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
    {
      name: 'sybil-amplified coalition, recent=0.5, demo=1.5 (composition closes via honest pool)',
      pattern: 'sybil',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
  ];
  it.each(gateSweepCells)('gate-threshold sweep: $name', async ({
    pattern,
    assignment_min_recent,
    assignment_min_demonstrated,
    expected_attack_succeeded,
    expected_false_positive_lockout,
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
    expect(result.false_positive_lockout).toBe(expected_false_positive_lockout);
  });

  it('gate-threshold sweep cube: attack-success-rate and lockout-rate aggregate by defense config', () => {
    // Two-metric aggregate per cube #5's template (PRD §Adversary
    // testbed, Architecture, "Parameter sweeps"): group cells by
    // (defense knobs), read both ASR and lockout-rate. Computed
    // off the static expected fields the per-cell tests already
    // validated, so the aggregate stays a fast read over locked
    // observations.
    // The lockout-rate split distinguishes "defense closed an
    // attack" from "defense closed because honest review collapsed
    // at the same gate"; with the sybil runner's honest-pool
    // bootstrap rotation in place, the demo gate's sybil-side
    // closure now reads as honest defense (Erin/Frank reach
    // demonstrated=2.0 ahead of contested, Carol gets routed and
    // rejects, Dave is cross-stratum-gated, Eve fails the demo
    // gate, the honest pool's two accepts converge contested
    // accepted) and lockout-rate sits at zero across the cube at
    // alpha=1.
    interface AsrCell {
      assignment_min_recent: number;
      assignment_min_demonstrated: number;
      total: number;
      attacks_succeeded: number;
      lockouts: number;
    }
    const grouped = new Map<string, AsrCell>();
    for (const cell of gateSweepCells) {
      const key = `${cell.assignment_min_recent}|${cell.assignment_min_demonstrated}`;
      const g = grouped.get(key) ?? {
        assignment_min_recent: cell.assignment_min_recent,
        assignment_min_demonstrated: cell.assignment_min_demonstrated,
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

    // No defenses: both attacks succeed, no gate to lockout.
    expect(asr('0|0')).toBe(1);
    expect(lockoutRate('0|0')).toBe(0);
    // Recent gate alone: closes patient-adversary; sybil bypasses
    // because the gate has fresh-reviewer bypass and Eve sits at
    // zero rep. No lockout — recent-gate's null-policy bypasses
    // fresh reviewers, so Erin walks in and votes accept.
    expect(asr('0.5|0')).toBe(0.5);
    expect(lockoutRate('0.5|0')).toBe(0);
    // Demo gate alone: ASR=50% — patient is inert against the
    // demonstrated buffer (Carol's priming demonstrated holds
    // above the threshold), sybil closes by the demo gate firing
    // on Eve. The honest-pool bootstrap rotation lifts the sybil
    // closure off the prior lockout-driven reading: Erin/Frank/
    // George each reach demonstrated=2.0 (clears 1.5) before
    // contested, so the demo gate fires on Eve alone and Erin's
    // accept + Frank's accept (across singleton strata) lands the
    // 2-vote convergence past Carol's reject and Dave's cross-
    // stratum gating. Lockout rate = 0%.
    expect(asr('0|1.5')).toBe(0.5);
    expect(lockoutRate('0|1.5')).toBe(0);
    // Composition: ASR=0%, lockout=0% — both attacks close by
    // honest defense. Patient closes by recent-gate (Carol's
    // recent drains past the quiet window, the gate refuses her
    // second drift). Sybil closes by the same honest-pool
    // bootstrap pattern the demo-only row already exercises, with
    // the recent gate adding nothing because Erin/Frank/George's
    // bootstrap recent matches their demonstrated above any
    // threshold ≤ 0.5 at alpha=1.
    expect(asr('0.5|1.5')).toBe(0);
    expect(lockoutRate('0.5|1.5')).toBe(0);

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
  // weighted off — the contention-weighting × paired-decline-floor
  // interaction is wired as cube #4 below). The headline is
  // *additive*, not orthogonal: declines extend the encounter domain
  // on top of votes, and the cube reads the lift the extension
  // provides.
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
  // The over-clustering pattern is not adversarial — there is no
  // coalition in that runner, only three honest reviewers. The
  // failure mode (contested ≠ accepted) is honest-pool collapse
  // by the cluster gate, not an attack landing. From the proposer's
  // perspective the *outcome* is the same shape as a coalition
  // suppression-by-archival, which is why the patterns sit in one
  // cube; but the *cause* is opposite, and reading both under one
  // attack_succeeded metric would conflate "defense closed an
  // attack" with "defense closed because honest review collapsed."
  // Cube #5's two-metric template (PRD §Adversary testbed
  // (Architecture, "Parameter sweeps")) names exactly this
  // distinction: ASR for real attacks
  // landing, lockout-rate for honest-pool collapse, and "a defense
  // that closes by collapsing the honest pool is not a defense."
  // This cube reads on both: paired-decline contributes to ASR,
  // over-clustering contributes to lockout-rate.
  //
  // Expected shape — (cw=off, floor=any): ASR=0%, lockout=0%
  // (decline-aware raw-weight closes paired-decline; over-
  // clustering does not trigger because the full-weight rule is a
  // cw=on branch). (cw=on, floor=1): ASR=0%, lockout=50%
  // (paired-decline still closes through Frank/Hank, but the over-
  // clustering scenario lands the false-positive lockout on
  // contested — three honest reviewers in the pool with no fresh-
  // singleton fallback). (cw=on, floor=2): ASR=0%, lockout=0%
  // (the stable composition — paired-decline closure survives,
  // over-clustering false-positive closed by the floor). The
  // headline: the floor is what makes the cw + decline-aware
  // composition safe against the small-honest-pool case where
  // there's no fresh-singleton bypass — and what makes that
  // visible is the lockout-rate metric, not ASR.
  type ClusterDeclineFloorAttackPattern =
    | 'paired-decline-multi-round'
    | 'over-clustering-false-positive';
  interface ClusterDeclineFloorSweepCell {
    name: string;
    pattern: ClusterDeclineFloorAttackPattern;
    stratum_contention_weighted: boolean;
    stratum_decline_min_paired: number;
    expected_attack_succeeded: boolean;
    expected_false_positive_lockout: boolean;
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
      expected_false_positive_lockout: false,
    },
    {
      name: 'paired-decline, cw=off, floor=2 (raw-weight closure; floor inert)',
      pattern: 'paired-decline-multi-round',
      stratum_contention_weighted: false,
      stratum_decline_min_paired: 2,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
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
      expected_false_positive_lockout: false,
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
      expected_false_positive_lockout: false,
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
      expected_false_positive_lockout: false,
    },
    {
      name: 'over-clustering, cw=off, floor=2 (raw-weight regime, full-weight rule inert)',
      pattern: 'over-clustering-false-positive',
      stratum_contention_weighted: false,
      stratum_decline_min_paired: 2,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
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
      expected_attack_succeeded: false,
      expected_false_positive_lockout: true,
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
      expected_false_positive_lockout: false,
    },
  ];
  it.each(clusterDeclineFloorSweepCells)('cluster-decline floor sweep: $name', async ({
    pattern,
    stratum_contention_weighted,
    stratum_decline_min_paired,
    expected_attack_succeeded,
    expected_false_positive_lockout,
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
    // The cube reads two metrics (per cube #5's template), keyed on
    // pattern. The paired-decline runner has a real adversary
    // (Carol+Dave) and contested ≠ accepted is suppression-by-
    // attack landing → ASR. The over-clustering runner has no
    // adversary and contested ≠ accepted is honest-pool collapse
    // by the cluster gate → lockout-rate. The cube exercises three
    // suppression modes ('rejected', 'unresolved-archived',
    // 'staged') under the paired-decline runner and the same
    // outcome shape under the over-clustering runner; what
    // changes between them is the *cause*, which is what the
    // pattern-keyed split makes visible.
    const attack_succeeded =
      pattern === 'paired-decline-multi-round' && contested_status !== 'accepted';
    const false_positive_lockout =
      pattern === 'over-clustering-false-positive' && contested_status !== 'accepted';
    expect(attack_succeeded).toBe(expected_attack_succeeded);
    expect(false_positive_lockout).toBe(expected_false_positive_lockout);
  });

  it('cluster-decline floor sweep cube: attack-success-rate and lockout-rate aggregate by defense config', () => {
    // Two-metric aggregate per cube #5's template (PRD §Adversary
    // testbed, Architecture, "Parameter sweeps"): group cells by
    // defense config and read both ASR and lockout-rate, computed
    // off the static expected fields the per-cell tests already
    // validated so the aggregate stays a fast read over locked
    // observations rather than a re-run of the cube. The split is
    // what distinguishes "defense closed an attack" from "defense
    // closed because honest review collapsed at the same gate."
    interface AsrCell {
      stratum_contention_weighted: boolean;
      stratum_decline_min_paired: number;
      total: number;
      attacks_succeeded: number;
      lockouts: number;
    }
    const grouped = new Map<string, AsrCell>();
    for (const cell of clusterDeclineFloorSweepCells) {
      const key = `${cell.stratum_contention_weighted ? 1 : 0}|${cell.stratum_decline_min_paired}`;
      const g = grouped.get(key) ?? {
        stratum_contention_weighted: cell.stratum_contention_weighted,
        stratum_decline_min_paired: cell.stratum_decline_min_paired,
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

    // Raw-weight regime: the contention-weighting full-weight rule
    // for declines is inactive, so the floor parameter has no
    // effect. Paired-decline closes via raw anti-correlation on
    // the 2 paired declines (no attacks land); over-clustering's
    // asymmetric trigger encounter at raw weights lights nothing
    // (no honest-pool collapse). Both metrics at 0%.
    expect(asr('0|1')).toBe(0);
    expect(lockoutRate('0|1')).toBe(0);
    expect(asr('0|2')).toBe(0);
    expect(lockoutRate('0|2')).toBe(0);
    // Contention-weighted with floor=1 (the unsafe composition):
    // the paired-decline runner lands no attack — Frank+Hank walk
    // in fresh in Round 2 and carry contested. The over-clustering
    // runner lands the false-positive lockout: three honest
    // reviewers in the small pool all false-cluster, no fresh-
    // singleton fallback, contested archives. ASR=0%, lockout=50%
    // — the gap the floor closes, made visible by the two-metric
    // split. (The previous one-metric aggregate read this cell as
    // ASR=50%, conflating honest-pool collapse with attack
    // landing.)
    expect(asr('1|1')).toBe(0);
    expect(lockoutRate('1|1')).toBe(0.5);
    // Contention-weighted with floor=2 (the stable composition):
    // both metrics at 0%. The headline — the floor is what makes
    // the cw + decline-aware composition safe against the small-
    // honest-pool case. cw=off side-steps the issue (the full-
    // weight rule is a cw=on branch); cw=on requires the floor.
    expect(asr('1|2')).toBe(0);
    expect(lockoutRate('1|2')).toBe(0);

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
  // Sybil-amplified is dropped from this cube. Eve's demo-gate
  // closure is alpha-invariant by null-policy (the gate fires on a
  // zero-rep identity at any alpha), and Carol/Dave's coalition
  // priming runs as contributor-initiated convergence so their
  // demonstrated does scale with alpha but lands at threshold (3
  // priming accepts × alpha = 1.5 at alpha=0.5, exactly equal to the
  // demo=1.5 gate's strict-less-than predicate, so they pass — pinned
  // explicitly by the post-priming-demonstrated regression below). The
  // sybil runner's honest-pool bootstrap follows the same shape the
  // patient runner uses and exhibits the same alpha-shrinkage failure
  // mode under cube-#2 thresholds — bootstrap demonstrated falls from
  // 2.0 to 1.0 and re-trips lockout. The sybil cells would reproduce
  // cube #5's patient headline (lockout-by-shrunken-bootstrap, recovered
  // by demo-threshold re-tuning) without surfacing a new closure
  // mechanism, so the sybil baseline at alpha=0.5 is pinned by two
  // dedicated regressions below rather than absorbed here: the
  // four-cell `sybilAlphaInvarianceCells` block re-runs cube #2's
  // configs at alpha=0.5 (recent-only invariant, demo>0 re-tripping
  // lockout), and a single re-tuned-thresholds cell pins that
  // (recent=0.5, demo=0.75) closes the sybil attack by honest
  // defense — the same shape cube #5's patient cell reads at the
  // same configuration.
  type AlphaCubeConfig = 'off' | 'cube2-thresholds' | 'retuned-thresholds';
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
  it.each(alphaGateSweepCells)('difficulty-aware gate sweep: $name', async ({
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
  });

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

  // Sybil-amplified at alpha=0.5: the runner is now partially
  // alpha-sensitive by mechanism. Eve's demo-gate closure remains
  // alpha-invariant — the gate's null-policy fires on a zero-rep
  // identity at any alpha — but the honest-pool bootstrap rotation
  // (Erin/Frank/George contributor-initiated accepts on disjoint
  // bootstrap excerpts) flows through the convergence-driven
  // `applyReputationUpdates` where alpha lives, so the bootstrap
  // demonstrated shrinks from 2.0 at alpha=1 to 1.0 at alpha=0.5.
  // On demo>0 cells the same demo gate that fires on Eve now also
  // fires on the honest pool, and the closure observation flips from
  // honest defense (alpha=1, cube #2) to lockout (alpha=0.5, this
  // regression). Recent-only cells stay alpha-invariant: no demo
  // gate fires on the honest pool at demo=0, and Eve's null-policy
  // close on the recent-gate cell still bypasses (fresh callers
  // bypass the recent gate by construction). The cells pin the
  // alpha=0.5 baseline directly rather than asserting equality with
  // alpha=1 — the partial-invariance shape is the load-bearing
  // observation, and cube #5 stays patient-only because the patient-
  // side re-tuning headline already covers the same shrinkage failure
  // mode at the same gate; adding sybil cells would reproduce the
  // patient cube's lockout-vs-defense split without surfacing a new
  // closure mechanism.
  const sybilAlphaInvarianceCells = [
    {
      name: 'sybil, recent=0, demo=0 (no defenses, alpha-invariant)',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    {
      name: 'sybil, recent=0.5, demo=0 (recent gate inert against fresh recruit, alpha-invariant)',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 0,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    {
      name: 'sybil, recent=0, demo=1.5 (Eve null-policy still closes; honest pool also locks out as bootstrap demonstrated shrinks)',
      assignment_min_recent: 0,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: true,
    },
    {
      name: 'sybil, recent=0.5, demo=1.5 (composition: Eve null-policy closes; honest pool locks out at the demo gate)',
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: true,
    },
  ];
  it.each(sybilAlphaInvarianceCells)('sybil-amplified at alpha=0.5: $name', async ({
    assignment_min_recent,
    assignment_min_demonstrated,
    expected_attack_succeeded,
    expected_false_positive_lockout,
  }) => {
    const result = await runSybilAmplifiedGateScenario({
      assignment_min_recent,
      assignment_min_demonstrated,
      review_credit_contention_alpha: 0.5,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.false_positive_lockout).toBe(expected_false_positive_lockout);
  });

  it('sybil-amplified at alpha=0.5: Carol+Dave post-priming demonstrated lands at the demo=1.5 gate threshold', async () => {
    // The structural sybil close at demo=1.5 depends on Carol+Dave
    // passing the gate by exactly the strict-less-than predicate (3
    // unanimous priming accepts × alpha=0.5 = 1.5, equal to the
    // threshold → passes). Without this knife-edge, Carol+Dave fail
    // the gate alongside Eve and the closure-by-attack vs closure-by-
    // lockout split that cube #2's two-metric template reads becomes
    // ambiguous on the sybil side. Run at the demo>0 regime (gates
    // open against fresh callers via null-policy is irrelevant here —
    // this assertion isolates the post-priming rep value, not the
    // gate behavior) so contested stalls 'staged' rather than
    // converging: Carol's reject lands but applyReputationUpdates
    // only fires on convergence, so her demonstrated reflects exactly
    // the 3 priming accepts × alpha. A change to the priming count,
    // alpha, or the contention-alpha credit formula trips this named
    // invariant rather than silently shifting Carol's demonstrated
    // off the gate threshold.
    const result = await runSybilAmplifiedGateScenario({
      assignment_min_recent: 0,
      assignment_min_demonstrated: 1.5,
      review_credit_contention_alpha: 0.5,
    });
    expect(result.carol_demonstrated).toBeCloseTo(1.5, 10);
  });

  it('sybil-amplified at alpha=0.5 under cube-#5 re-tuned thresholds: closes attack by honest defense', async () => {
    // Pins the claim cube #5's patient-only scoping rests on: the
    // sybil baseline at the re-tuned thresholds (recent=0.5, demo=
    // 0.75) reads honest defense at both metrics, the same shape
    // the patient cube reads at the same configuration. Under the
    // re-tuned demo gate, the honest pool's alpha-shrunken bootstrap
    // demonstrated (1.0) sits above the threshold (0.75) with the
    // same 0.25 headroom the patient cube's headroom-preserving
    // re-tuning is calibrated for, while Carol+Dave's coalition
    // demonstrated (1.5) and Eve's null-policy zero-rep close stay
    // alpha-invariant. Mechanism: Eve fails the demo gate by null-
    // policy; Carol gets routed and rejects; Dave is cross-stratum-
    // gated; Erin+Frank's accepts converge contested across
    // singleton strata. If a future change makes the sybil runner
    // diverge from the patient closure under the same re-tuned
    // thresholds, this fires and the cube #5 patient-only scoping
    // needs re-evaluation.
    const result = await runSybilAmplifiedGateScenario({
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 0.75,
      review_credit_contention_alpha: 0.5,
    });
    expect(result.attack_succeeded).toBe(false);
    expect(result.false_positive_lockout).toBe(false);
  });

  // Sixth parameter sweep cube: the testbed-side `AdversaryBudget`
  // primitive (slice 5) joined with the binding-cost gate (slice 2)
  // as the first sweep on the budget axis PRD §Identity names
  // "coalition-affordable-identities-per-epoch." Eight cells over
  // (budget B ∈ {2, 4}, attestation threshold T ∈ {1, 2}, issuance
  // cap N ∈ {1, 2}) drive `it.each` through
  // `runBudgetSybilSuppressionScenario` and read the contested-status
  // outcome of a one-epoch sybil-suppression attack: the coalition
  // tries to mint K* = 2 fresh sybils within budget, each casting a
  // contributor-initiated reject vote on a contested excerpt before
  // two honest accepts can land. K_eff = min(floor(B/T), N) caps the
  // sybils the coalition can actually field — the binding-cost layer
  // (T) sets the per-mint cost, the issuance-frequency cap (N) sets
  // the per-epoch ceiling, and the budget (B) caps the total across
  // all epochs. The attack lands iff K_eff ≥ K*; otherwise the honest
  // accepts converge first.
  //
  // The headline PRD §Adversary testbed §Architecture commits is "ASR
  // as a function of budget at each defense configuration." The
  // budget axis enters via two distinct mechanisms: the binding-cost
  // *cost* (higher T means each sybil costs more, reducing the K
  // affordable at fixed B) and the issuance-cap *time-distribution*
  // (higher N permits more mints in a single epoch, which a one-shot
  // attack needs by construction). The cube reads both: at (T=2, N=2)
  // the attack lands at B=4 but not B=2 — the cost-multiplier doubles
  // the budget needed vs (T=1, N=2). At N=1 the attack closes
  // uniformly at any (B, T) — the issuance cap is the *time*
  // primitive on the cost-multiplier and a one-epoch attack cannot
  // exceed N regardless of how much budget the operator commits.
  // PRD §Identity bullet 2 names this directly: "an adversary
  // affording K sybils still cannot mint them all in one epoch,
  // which buys behavior-based defenses the accumulated history they
  // need to fire" — the cube reads that closure on the suppression
  // pattern, where the attack opportunity is one-shot and the time
  // axis closes the attack outright.
  //
  // The cluster signal stays disabled in this runner (the per-sybil-
  // acts-once attack has no shared history to cluster on, so the
  // cluster signal is structurally inert here — disabling it isolates
  // the budget arithmetic from the cluster-signal closure path that
  // cubes #1/#3/#4 measure on coordinated-voting attacks). The
  // assignment-time gates (recent, demonstrated, decline-rate) are
  // also inert: the attack is contributor-initiated, which bypasses
  // assignment-time gates by construction, scoping the cube to the
  // identity layer. Cube #2 measured assignment-gate closure on the
  // sybil-amplified-coalition pattern; cube #6 measures binding-cost
  // and issuance-cap closure on a pure-budget pattern with no
  // assignment-driven dependencies, so the two cubes are siblings
  // covering complementary axes of the four-layer architecture.
  async function runBudgetSybilSuppressionScenario(params: {
    budget: number;
    attestation_threshold: number;
    issuance_cap_per_epoch: number;
  }): Promise<{
    attack_succeeded: boolean;
    sybils_minted: number;
    contested_status: string;
  }> {
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('bgs'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        min_attestation_level: params.attestation_threshold,
        // Cluster signal off — the cube measures the budget
        // arithmetic through the binding-cost gate, not the cluster
        // signal's closure path. The per-sybil-acts-once attack has
        // no shared history to cluster on, so the cluster signal is
        // inert here regardless of config; explicit disable keeps
        // the runner's scope honest.
        stratification_enabled: false,
      },
    });
    const alice = server.bootstrap.mintIdentity({
      display_name: 'alice',
      attestation_level: params.attestation_threshold,
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
    const anchorProp = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper 1',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(anchorProp.proposal_id);
    const anchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper 1',
    );
    if (!anchorNode) throw new Error('anchor not materialized');
    const contestedExcerpt = await server.tools.proposeExcerpt(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorNode.id,
        content: 'treatment X works for stage III',
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      },
    );
    const contestedId = contestedExcerpt.proposal_id;

    // Adversary phase: tryMint up to K* = 2 fresh sybils within
    // budget at epoch 0 (one-shot attack). Each affordable sybil
    // casts contributor-initiated reject on the contested target.
    // Sybils vote first so votes_to_reject = 2 can fire before honest
    // accepts come in if K_eff reaches K*. Budget refusal mode
    // ('budget' vs 'issuance_cap') is observable via
    // `budget.budgetRemaining` post-loop but the attack outcome
    // depends only on K_eff, so the runner returns sybils_minted as
    // the harness-side observable.
    const SUPPRESSION_THRESHOLD = 2;
    const budget = new AdversaryBudget({
      initial: params.budget,
      attestation_cost: params.attestation_threshold,
      issuance_cap_per_epoch: params.issuance_cap_per_epoch,
    });
    let sybilsMinted = 0;
    for (let i = 0; i < SUPPRESSION_THRESHOLD; i++) {
      const mintResult = budget.tryMint(0);
      if (!mintResult.ok) break;
      const sybil = server.bootstrap.mintIdentity({
        display_name: `sybil${i}`,
        attestation_level: params.attestation_threshold,
      });
      sybilsMinted += 1;
      await server.tools.castReviewVote(
        { identity_id: sybil.id },
        {
          proposal_id: contestedId,
          decision: 'reject',
          rationale: 'underpowered, methodological concerns',
        },
      );
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
    }

    // Honest phase: 2 honest reviewers cast accept on the contested
    // target. If the contested target already converged 'rejected'
    // above, the loop short-circuits — voting on a non-staged
    // proposal would error.
    for (const name of ['erin', 'frank']) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      const honest = server.bootstrap.mintIdentity({
        display_name: name,
        attestation_level: params.attestation_threshold,
      });
      await server.tools.castReviewVote(
        { identity_id: honest.id },
        {
          proposal_id: contestedId,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
    }

    const final = server.store.proposals.get(contestedId);
    if (!final) throw new Error('contested proposal not found');
    return {
      attack_succeeded: final.status === 'rejected',
      sybils_minted: sybilsMinted,
      contested_status: final.status,
    };
  }

  interface BudgetSweepCell {
    name: string;
    budget: number;
    attestation_threshold: number;
    issuance_cap_per_epoch: number;
    expected_attack_succeeded: boolean;
  }
  const budgetSweepCells: BudgetSweepCell[] = [
    // K_eff = min(floor(B/T), N); attack lands iff K_eff >= K* = 2.
    {
      name: 'B=2, T=1, N=1 (issuance cap caps K_eff=1)',
      budget: 2,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=2, T=1, N=2 (K_eff=2 — gates inert at minimum-affording budget)',
      budget: 2,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 2,
      expected_attack_succeeded: true,
    },
    {
      name: 'B=2, T=2, N=1 (binding cost and issuance cap both close; both excessive at this budget)',
      budget: 2,
      attestation_threshold: 2,
      issuance_cap_per_epoch: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=2, T=2, N=2 (binding cost caps K_eff=1; cost-multiplier exhausts budget)',
      budget: 2,
      attestation_threshold: 2,
      issuance_cap_per_epoch: 2,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=4, T=1, N=1 (issuance cap caps K_eff=1; budget abundance does not help against the time primitive)',
      budget: 4,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=4, T=1, N=2 (K_eff=2 — attack lands; budget headroom unused)',
      budget: 4,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 2,
      expected_attack_succeeded: true,
    },
    {
      name: 'B=4, T=2, N=1 (issuance cap caps K_eff=1 even with cost-multiplier-affording budget)',
      budget: 4,
      attestation_threshold: 2,
      issuance_cap_per_epoch: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=4, T=2, N=2 (K_eff=2 — cost-multiplier doubled the budget needed vs T=1)',
      budget: 4,
      attestation_threshold: 2,
      issuance_cap_per_epoch: 2,
      expected_attack_succeeded: true,
    },
  ];
  it.each(budgetSweepCells)('budget sweep: $name', async ({
    budget,
    attestation_threshold,
    issuance_cap_per_epoch,
    expected_attack_succeeded,
  }) => {
    const result = await runBudgetSybilSuppressionScenario({
      budget,
      attestation_threshold,
      issuance_cap_per_epoch,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
  });

  it('budget sweep cube: attack-success-rate aggregates by defense config and reads cost-multiplier directly', () => {
    // Aggregate per the cube template (PRD §Adversary testbed,
    // Architecture, "Parameter sweeps"): group cells by (T, N), read
    // ASR per group across the budget axis. The sweep dimension PRD
    // §Identity names — coalition-affordable-identities-per-epoch —
    // enters as B/T (the affordable-K count under the binding-cost
    // multiplier) capped by N (the issuance ceiling). The aggregate
    // is computed off the static expected fields the per-cell tests
    // already validated, so it stays a fast read over locked
    // observations rather than a re-run of the cube.
    interface BudgetAsrCell {
      attestation_threshold: number;
      issuance_cap_per_epoch: number;
      total: number;
      attacks_succeeded: number;
    }
    const grouped = new Map<string, BudgetAsrCell>();
    for (const cell of budgetSweepCells) {
      const key = `${cell.attestation_threshold}|${cell.issuance_cap_per_epoch}`;
      const g = grouped.get(key) ?? {
        attestation_threshold: cell.attestation_threshold,
        issuance_cap_per_epoch: cell.issuance_cap_per_epoch,
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

    // (T=1, N=1): ASR=0% — issuance cap closes the attack regardless
    // of budget. The time primitive is the load-bearing closure here:
    // a one-shot suppression attack that needs K*=2 fresh sybils in
    // one epoch cannot exceed N=1 mints in that epoch, no matter how
    // much budget the operator commits. The cube's headline reading
    // for this defense config: ASR is identically 0 across the
    // budget axis B ∈ {2, 4}.
    expect(asr('1|1')).toBe(0);
    // (T=1, N=2): ASR=100% — gates inert at the minimum-affording
    // budget and above. K_eff=min(B/1, 2)=2 for both B=2 and B=4, so
    // the attack lands at any budget ≥ K*α. This is the "no defense"
    // reading the cube needs as the regression handle on the
    // unaccompanied attack-success path.
    expect(asr('1|2')).toBe(1);
    // (T=2, N=1): ASR=0% — issuance cap closes regardless of cost-
    // multiplier. The N=1 cap dominates: even at B=4 the operator
    // can mint at most one sybil in epoch 0, and one reject does not
    // reach K*=2.
    expect(asr('2|1')).toBe(0);
    // (T=2, N=2): ASR=50% — the cost-multiplier readout. The
    // binding-cost threshold T=2 doubles the per-sybil cost vs T=1,
    // which doubles the budget needed to land the same K* attack:
    // B=2 fails (K_eff=floor(2/2)=1), B=4 lands (K_eff=floor(4/2)=2).
    // PRD §Identity's K × α arithmetic shows up as a 50% ASR read
    // off two budget cells where the threshold-budget for attack
    // feasibility is exactly 2× the gate-inert (T=1) baseline.
    expect(asr('2|2')).toBe(0.5);

    // Coverage invariant: every defense config in the cube has both
    // budget cells. A future cell expansion that breaks this
    // symmetry trips the assertion and forces the aggregate to be
    // re-keyed rather than silently averaging over uneven groups.
    for (const cell of grouped.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Seventh parameter sweep cube: the multi-epoch extension of cube
  // #6, joining the `AdversaryBudget` primitive with an epoch-
  // distribution sweep on the same one-shot suppression attack
  // pattern. PRD §Identity bullet 2 names the issuance cap as the
  // *time* primitive on the cost-multiplier — "an adversary affording
  // K sybils still cannot mint them all in one epoch" — and cube #6
  // measured the closure on the one-shot (epoch-0-only) case where
  // the cap fires as a binary stop on K. Cube #7 sweeps the epoch
  // axis to read what the cap actually does when an attack persists
  // across epochs: it shapes K's *distribution* across epochs rather
  // than capping K outright. K_eff = min(floor(B/T), N × E) — the
  // budget B caps the total identities the operator can ever afford,
  // the issuance cap N caps per-epoch mints, and the epoch count E
  // multiplies N into the attack window. The attack pattern is the
  // same one-shot contributor-initiated suppression cube #6 measured
  // (K* = 2 sybils race two honest accepts on a contested excerpt),
  // but with sybils spread across epochs rather than packed into
  // epoch 0.
  //
  // Eight cells over (budget B ∈ {1, 4}, epochs E ∈ {1, 2}, issuance
  // cap N ∈ {1, 2}) drive `it.each`. The binding-cost threshold T=1
  // is held — cube #6 already measured the cost-multiplier axis on
  // the (T=2, N=2) cell, and pinning T=1 here isolates the time
  // primitive from the cost-multiplier so the read on (E, N) is not
  // confounded by T's contribution to K_eff. The aggregate groups
  // cells by (E, N) and reads ASR per group across the budget axis:
  //
  //   (E=1, N=1) at 0% — cube #6's baseline at the minimum-cap
  //     defense config: the issuance cap closes the one-shot attack
  //     at any budget.
  //   (E=1, N=2) at 50% — cube #6's gates-inert reading recovered:
  //     the one-shot attack lands at B=4 (K_eff=2) but budget closes
  //     it at B=1 (K_eff=1).
  //   (E=2, N=1) at 50% — *the multi-epoch lift on the time
  //     primitive*. At B=4 the operator spreads K=2 across two
  //     epochs (one mint each) and the attack lands; the issuance
  //     cap as time primitive *delays* but does not *prevent* the
  //     multi-epoch suppression. At B=1 the budget axis still binds
  //     (one sybil affordable, period), closing the attack
  //     independent of how many epochs the operator commits to.
  //   (E=2, N=2) at 50% — issuance cap is non-binding (K_eff
  //     saturates at K*=2 in epoch 0 alone); only the budget axis
  //     constrains, same as (E=1, N=2).
  //
  // The headline reading is the (E=1, N=1) → (E=2, N=1) lift from
  // 0% to 50%. Cube #6's (T=1, N=1) defense config closed the attack
  // at 0% across both budget cells; cube #7 reads what *that same
  // defense config* does when the attack persists for two epochs:
  // it lifts to 50%. The remaining 50% is what the *budget* axis
  // closes (B=1 cannot afford a second sybil at any T), and that
  // bound is invariant to epoch count. The cube reads three load-
  // bearing claims off the same arithmetic: (a) the issuance cap is
  // a time primitive, not a hard K cap — its closure is bounded by
  // the attack window E; (b) the budget B is a hard K cap at fixed
  // T, invariant to E; (c) the cap composition K_eff = min(floor(B/T),
  // N × E) reads the same numbers off the runner's loop structure
  // that the harness fiction operationalizes.
  //
  // The cluster signal is disabled for the same reason as cube #6:
  // the per-sybil-acts-once attack has no shared history to cluster
  // on, so the cluster signal is structurally inert here regardless
  // of config. Honest reviewers do not bootstrap demonstrated rep
  // and the assignment-time gates default to inert — the attack is
  // contributor-initiated, which bypasses the assignment surface by
  // construction. Scope is the identity layer composed across the
  // time axis. The "buys time for behavior-based defenses" framing
  // PRD §Identity commits is what makes the time primitive
  // *operationally* load-bearing in production; cube #7 reads the
  // arithmetic of the time-buying without behavior defenses, leaving
  // the joined cluster-signal-with-budget-axis cube as a follow-up.
  async function runMultiEpochBudgetSybilSuppressionScenario(params: {
    budget: number;
    attestation_threshold: number;
    issuance_cap_per_epoch: number;
    epochs: number;
  }): Promise<{
    attack_succeeded: boolean;
    sybils_minted: number;
    contested_status: string;
  }> {
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('mebs'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        min_attestation_level: params.attestation_threshold,
        // Cluster signal off — same rationale as cube #6's runner:
        // the per-sybil-acts-once attack has no shared history, so
        // the cluster signal is structurally inert regardless of
        // config; explicit disable keeps the runner's scope honest.
        stratification_enabled: false,
      },
    });
    const alice = server.bootstrap.mintIdentity({
      display_name: 'alice',
      attestation_level: params.attestation_threshold,
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });
    const anchorProp = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper 1',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(anchorProp.proposal_id);
    const anchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper 1',
    );
    if (!anchorNode) throw new Error('anchor not materialized');
    const contestedExcerpt = await server.tools.proposeExcerpt(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorNode.id,
        content: 'treatment X works for stage III',
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      },
    );
    const contestedId = contestedExcerpt.proposal_id;

    // Adversary phase: spread up to K* = 2 sybil mints across E
    // epochs. Within each epoch the inner loop mints until issuance
    // cap fires (then advance to next epoch) or budget exhausts
    // (then stop entirely). K_eff is bounded above by both
    // floor(B/T) (budget axis) and N × E (issuance-cap × epoch
    // axis); whichever binds first determines the attack outcome.
    const SUPPRESSION_THRESHOLD = 2;
    const budget = new AdversaryBudget({
      initial: params.budget,
      attestation_cost: params.attestation_threshold,
      issuance_cap_per_epoch: params.issuance_cap_per_epoch,
    });
    let sybilsMinted = 0;
    outer: for (let e = 0; e < params.epochs; e++) {
      while (true) {
        const mintResult = budget.tryMint(e);
        if (!mintResult.ok) {
          if (mintResult.reason === 'budget') break outer;
          // issuance_cap: this epoch is exhausted; advance to the
          // next. The budget arithmetic mirrors how a real IdP
          // refuses upstream of any cost being charged — budget is
          // unchanged on `issuance_cap` refusals.
          break;
        }
        const sybil = server.bootstrap.mintIdentity({
          display_name: `sybil-e${e}-${sybilsMinted}`,
          attestation_level: params.attestation_threshold,
        });
        sybilsMinted += 1;
        await server.tools.castReviewVote(
          { identity_id: sybil.id },
          {
            proposal_id: contestedId,
            decision: 'reject',
            rationale: 'underpowered, methodological concerns',
          },
        );
        const post = server.store.proposals.get(contestedId);
        if (post?.status !== 'staged') break outer;
        if (sybilsMinted >= SUPPRESSION_THRESHOLD) break outer;
      }
    }

    // Honest phase: 2 honest reviewers cast accept on the contested
    // target. If sybilsMinted < K* the proposal is still staged and
    // the second honest accept converges it 'accepted'; if sybils
    // already converged it 'rejected' the loop short-circuits.
    for (const name of ['erin', 'frank']) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      const honest = server.bootstrap.mintIdentity({
        display_name: name,
        attestation_level: params.attestation_threshold,
      });
      await server.tools.castReviewVote(
        { identity_id: honest.id },
        {
          proposal_id: contestedId,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
    }

    const final = server.store.proposals.get(contestedId);
    if (!final) throw new Error('contested proposal not found');
    return {
      attack_succeeded: final.status === 'rejected',
      sybils_minted: sybilsMinted,
      contested_status: final.status,
    };
  }

  interface MultiEpochBudgetSweepCell {
    name: string;
    budget: number;
    attestation_threshold: number;
    issuance_cap_per_epoch: number;
    epochs: number;
    expected_attack_succeeded: boolean;
  }
  const multiEpochBudgetSweepCells: MultiEpochBudgetSweepCell[] = [
    // T=1 throughout; K_eff = min(floor(B/1), N × E); attack lands
    // iff K_eff >= K* = 2.
    {
      name: 'B=1, E=1, N=1 (budget caps K_eff=1)',
      budget: 1,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 1,
      epochs: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=1, E=1, N=2 (budget binds; issuance cap headroom unused)',
      budget: 1,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 2,
      epochs: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=1, E=2, N=1 (budget binds across epochs — invariant to epoch count)',
      budget: 1,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 1,
      epochs: 2,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=1, E=2, N=2 (budget binds; both N × E and B/T headroom unused)',
      budget: 1,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 2,
      epochs: 2,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=4, E=1, N=1 (issuance cap caps K_eff=1 in one shot — cube #6 baseline)',
      budget: 4,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 1,
      epochs: 1,
      expected_attack_succeeded: false,
    },
    {
      name: 'B=4, E=1, N=2 (gates inert at K*-affording budget — cube #6 baseline)',
      budget: 4,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 2,
      epochs: 1,
      expected_attack_succeeded: true,
    },
    {
      name: 'B=4, E=2, N=1 (multi-epoch lift: K_eff=2 across two epochs at fixed N=1)',
      budget: 4,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 1,
      epochs: 2,
      expected_attack_succeeded: true,
    },
    {
      name: 'B=4, E=2, N=2 (issuance cap saturates K_eff at K*=2 in epoch 0 alone)',
      budget: 4,
      attestation_threshold: 1,
      issuance_cap_per_epoch: 2,
      epochs: 2,
      expected_attack_succeeded: true,
    },
  ];
  it.each(multiEpochBudgetSweepCells)('multi-epoch budget sweep: $name', async ({
    budget,
    attestation_threshold,
    issuance_cap_per_epoch,
    epochs,
    expected_attack_succeeded,
  }) => {
    const result = await runMultiEpochBudgetSybilSuppressionScenario({
      budget,
      attestation_threshold,
      issuance_cap_per_epoch,
      epochs,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
  });

  it('multi-epoch budget sweep cube: ASR aggregates by (E, N) and reads issuance cap as time primitive', () => {
    // Aggregate per the cube template (PRD §Adversary testbed,
    // Architecture, "Parameter sweeps"): group cells by (E, N), read
    // ASR per group across the budget axis. The headline lift —
    // (E=1, N=1) at 0% → (E=2, N=1) at 50% — is what reads the
    // issuance cap as a *time* primitive: the cap closes a one-shot
    // attack outright at N=1, but a multi-epoch attack lifts K_eff to
    // 2 across two epochs at the same defense config, and the only
    // remaining closure on (E=2, N=1) is the budget axis B=1.
    interface MultiEpochAsrCell {
      epochs: number;
      issuance_cap_per_epoch: number;
      total: number;
      attacks_succeeded: number;
    }
    const grouped = new Map<string, MultiEpochAsrCell>();
    for (const cell of multiEpochBudgetSweepCells) {
      const key = `${cell.epochs}|${cell.issuance_cap_per_epoch}`;
      const g = grouped.get(key) ?? {
        epochs: cell.epochs,
        issuance_cap_per_epoch: cell.issuance_cap_per_epoch,
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

    // (E=1, N=1): ASR=0% — cube #6's baseline at the minimum-cap
    // defense config recovered. The issuance cap closes the one-shot
    // attack at any budget; K_eff caps at 1 in a single epoch.
    expect(asr('1|1')).toBe(0);
    // (E=1, N=2): ASR=50% — gates inert at the K*-affording budget.
    // K_eff=2 at B=4; budget binds at B=1. Same reading as cube #6's
    // (T=1, N=2) cell (here at 50% rather than 100% because cube #7
    // sweeps a smaller B-axis where B=1 binds, while cube #6 swept
    // B ∈ {2, 4} both above the K*-affording threshold at T=1).
    expect(asr('1|2')).toBe(0.5);
    // (E=2, N=1): ASR=50% — *the multi-epoch lift on the time
    // primitive*. Cube #6 at the same (T=1, N=1) defense config read
    // 0% across both budget cells; here, extending the attack window
    // to E=2 lifts K_eff to 2 at B=4 (one mint per epoch), and the
    // attack lands. B=1 still closes by the budget axis (one sybil
    // affordable, period — invariant to epoch count). The cap
    // *delays* the attack by one epoch but does not *prevent* it;
    // PRD §Identity's "buys behavior-based defenses the accumulated
    // history they need to fire" framing is what makes the delay
    // operationally load-bearing — without behavior defenses fired
    // in the gap, the time primitive only shapes K's distribution.
    expect(asr('2|1')).toBe(0.5);
    // (E=2, N=2): ASR=50% — issuance cap is non-binding (saturates
    // K_eff at K*=2 in epoch 0 alone, second epoch unused); only the
    // budget axis constrains. Same shape as (E=1, N=2): the multi-
    // epoch dimension adds nothing once N >= K* in a single epoch.
    expect(asr('2|2')).toBe(0.5);

    // Coverage invariant: every (E, N) defense config in the cube
    // has both budget cells. A future cell expansion that breaks
    // this symmetry trips the assertion and forces the aggregate to
    // be re-keyed rather than silently averaging over uneven groups.
    for (const cell of grouped.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Eighth parameter sweep cube: the action-axis sibling of cube #7.
  // Cubes #6 and #7 measure the K-axis of the four-layer sybil-
  // resistance architecture — cube #6 reads K_eff = floor(B/T) capped
  // at N (the binding-cost gate's cost-multiplier on a one-shot
  // suppression attack), cube #7 reads K_eff = N × E (the issuance
  // cap as time primitive on multi-epoch suppression). Both cubes
  // pin K=2 fresh sybils each acting *once* (one reject vote per
  // sybil); the per-(identity, epoch) rate-limit T (slice 3, server-
  // side `rate_limit_actions_per_epoch`) is structurally inert under
  // that pattern by construction — one action per identity per
  // epoch is below any T >= 1. The cap binds when one identity
  // *acts on many targets*, not when many identities each act once.
  // ROADMAP §Status names this directly: "exercising the per-
  // (identity, epoch) rate-limit T at the action axis (the cap
  // binds when one identity does many things, not the K-fresh-
  // sybils-each-acting-once pattern cubes #6 and #7 measure)."
  //
  // Cube #8's attack pattern is multi-target suppression: K=2 sybils
  // (no priming history; cluster signal disabled by construction
  // matching cubes #6/#7) try to suppress M contested targets.
  // votes_to_reject=2 so each suppressed target needs *both* sybils
  // to cast reject on it. Per sybil, the action throughput is capped
  // at T per epoch (server-side `rate_limit_actions_per_epoch`); the
  // adversary spreads votes across E epochs (clock advances past the
  // 60-second epoch boundary between rounds, resetting the per-
  // identity counter). The arithmetic: per_sybil_actions_landed =
  // T × E; suppressed_targets = min(per_sybil_actions_landed, M);
  // attack succeeds iff suppressed_targets == M (full suppression).
  // K × T × E is the coalition's total reject-vote budget across
  // epochs, and each suppressed target consumes 2 reject votes (one
  // per sybil), so the suppression capacity reduces to T × E
  // targets — the K=2 dimension cancels out because every suppressed
  // target needs every sybil to vote on it.
  //
  // Eight cells over (M ∈ {2, 4}, T ∈ {1, 2}, E ∈ {1, 2}) drive
  // `it.each`. The aggregate groups by (T, E) and reads ASR per
  // group across the M axis (the attack-scope axis):
  //
  //   (T=1, E=1) at 0% — minimum-cap defense config; T × E = 1
  //     suppresses 1 target at any M >= 1, never reaches M=2.
  //   (T=1, E=2) at 50% — the time-primitive lift on the rate cap:
  //     T × E = 2 suppresses M=2 fully but stops short of M=4. The
  //     issuance cap analog from cube #7 is exactly this — the cap
  //     delays but does not prevent multi-epoch suppression at small
  //     attack scope.
  //   (T=2, E=1) at 50% — the per-epoch-cap lift symmetric to the
  //     time-primitive lift: T × E = 2 same as (T=1, E=2). Reading
  //     T and E as interchangeable axes of the K × T × E
  //     coalition-throughput arithmetic, cube #8 confirms what the
  //     slice-3 "K × T = coalition's per-epoch budget" framing
  //     committed: the throughput axis is symmetric in T and E
  //     across the attack window.
  //   (T=2, E=2) at 100% — the saturating composition: T × E = 4
  //     covers any M <= 4; the cap is non-binding. The maximum-
  //     attack-scope cell M=4 is the threshold where the (T=2, E=2)
  //     defense config saturates; widening M to 6 would re-open the
  //     cell with same T × E = 4 < 6 closure.
  //
  // Cube #8 is the action-axis sibling of cube #7's K-axis: cube #7
  // reads K_eff = N × E (issuance cap × epochs); cube #8 reads
  // suppression_capacity_eff = T × E (rate-limit cap × epochs).
  // Same arithmetic shape on different axes — identical aggregate
  // numbers ((1, 1) at 0%, (1, 2)/(2, 1) at 50%, (2, 2) at 100%
  // when ASR-grouped by (cap, epoch)) reading two different
  // primitives on the four-layer architecture: cube #7 the
  // issuance-frequency cap (slice 2), cube #8 the per-(identity,
  // epoch) rate-limit (slice 3). Together they pin the K × N × T × E
  // coalition-budget arithmetic the four-layer architecture
  // composes against.
  //
  // The runner does *not* respect T harness-side — it tries every
  // (sybil, target) pair every epoch and lets the server's
  // `accountWriteAction` cap fire `rate_limited` errors directly.
  // This exercises the slice-3 server-side primitive end-to-end (the
  // adversary-budget-model's `tryAct` is the testbed-side mirror of
  // exactly this server-side enforcement; cube #8 reads the server
  // side directly so the wiring is what's measured, not the harness
  // arithmetic). Caught `rate_limited` errors signal "this sybil
  // exhausted this epoch" and the loop moves to the next sybil; the
  // next epoch advances the clock past the 60-second boundary so
  // the per-identity counter resets.
  async function runMultiTargetActionAxisSuppressionScenario(params: {
    targets_count: number;
    attestation_threshold: number;
    action_cap_per_epoch: number;
    epochs: number;
  }): Promise<{
    fully_suppressed: boolean;
    rejected_count: number;
    total_targets: number;
  }> {
    const sources = new Map<string, string>();
    for (let i = 1; i <= params.targets_count; i++) {
      sources.set(String(i), `arm ${i}: treatment X${i} works in stage III patients`);
    }
    const EPOCH_SECONDS = 60;
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('mata'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        min_attestation_level: params.attestation_threshold,
        // Cluster signal off — the cube measures the rate-limit
        // arithmetic. The 2-sybil coalition has no priming history
        // here, so the cluster signal would be inert anyway; explicit
        // disable keeps the runner's scope honest.
        stratification_enabled: false,
        rate_limit_actions_per_epoch: params.action_cap_per_epoch,
        rate_limit_epoch_seconds: EPOCH_SECONDS,
      },
    });
    const alice = server.bootstrap.mintIdentity({
      display_name: 'alice',
      attestation_level: params.attestation_threshold,
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });

    // alice will exhaust her own rate-limit while seeding M anchors
    // and M excerpts in epoch 0; cycle her clock past the epoch
    // boundary as needed during seeding so the adversary-phase
    // assertions are not contaminated by alice's residual counter
    // state. Simpler: seed in setup *before* the rate-limit gate
    // matters by configuring the cap loose enough — but the cap is
    // exactly what we're measuring, so instead, seed alice with
    // distinct epochs by advancing the clock between seeding rounds.
    // The cleanest path is to advance the clock once before the
    // adversary phase begins, after all seeding is done, so all
    // adversary-phase epochs are after seeding.
    const targetIds: ProposalId[] = [];
    for (let i = 0; i < params.targets_count; i++) {
      const pmid = String(i + 1);
      const anchorProp = await server.tools.proposeAnchor(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          content: `paper ${i + 1}`,
          external_ref: { kind: 'pmid', value: pmid },
        },
      );
      server.curator.acceptProposal(anchorProp.proposal_id);
      const anchorNode = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i + 1}`,
      );
      if (!anchorNode) throw new Error(`anchor ${i + 1} not materialized`);
      // Advance clock between alice's actions so her per-epoch
      // counter doesn't fire during seeding (alice has 2 actions per
      // target — propose_anchor + propose_excerpt; with cap T=1 that
      // would block her at the second target's anchor without an
      // epoch advance).
      clock.advance(EPOCH_SECONDS * 1000 + 1);
      const contestedExcerpt = await server.tools.proposeExcerpt(
        { identity_id: alice.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          parent_anchor_id: anchorNode.id,
          content: `treatment X${i + 1} works for stage III`,
          quoted_span: { text: 'treatment X', offset: 0 },
        },
      );
      targetIds.push(contestedExcerpt.proposal_id);
      clock.advance(EPOCH_SECONDS * 1000 + 1);
    }

    // K=2 sybils minted at attestation threshold (binding cost gate
    // passes by construction; cube #8's scope is the action axis,
    // not the binding-cost axis cube #6 measured).
    const sybils = ['s0', 's1'].map((name) =>
      server.bootstrap.mintIdentity({
        display_name: name,
        attestation_level: params.attestation_threshold,
      }),
    );

    // Adversary phase: across E epochs, each sybil iterates targets
    // in order and tries to cast reject. Server enforces T per
    // (identity, epoch); the runner catches `rate_limited` and moves
    // to the next sybil (this sybil exhausted this epoch). Between
    // epochs, advance the clock past the 60-second boundary so the
    // per-identity counter resets. Targets that have already
    // converged 'rejected' (both sybils landed reject) are skipped
    // by the proposal-status guard.
    for (let e = 0; e < params.epochs; e++) {
      if (e > 0) {
        // Advance the clock past the 60-second boundary. The
        // per-identity counter resets lazily on the next gate fire.
        clock.advance(EPOCH_SECONDS * 1000 + 1);
      }
      for (const sybil of sybils) {
        let exhausted = false;
        for (const targetId of targetIds) {
          if (exhausted) break;
          const post = server.store.proposals.get(targetId);
          if (post?.status !== 'staged') continue;
          // Skip if this sybil already voted on this target (cross-
          // epoch invariant: one vote per (reviewer, proposal)).
          const alreadyVoted = [...server.store.reviewVotes.values()].some(
            (v) => v.proposal_id === targetId && v.reviewer_id === sybil.id,
          );
          if (alreadyVoted) continue;
          try {
            await server.tools.castReviewVote(
              { identity_id: sybil.id },
              {
                proposal_id: targetId,
                decision: 'reject',
                rationale: 'underpowered, methodological concerns',
              },
            );
          } catch (err) {
            if (err instanceof ServerError && err.code === 'rate_limited') {
              // This sybil exhausted this epoch's cap. Stop iterating
              // targets for this sybil; the next epoch's cap reset
              // will let it pick up where it left off.
              exhausted = true;
            } else {
              throw err;
            }
          }
        }
      }
    }

    // Honest phase: 2 honest reviewers cast accept on each target
    // that is still 'staged'. votes_to_accept=2, so the second
    // accept converges the target. Honest reviewers each act on
    // multiple targets but get fresh per-epoch budgets per identity
    // (and we advance the clock between them to be safe). Honest
    // reviewers should not be rate-limited: a tight T might bind
    // them too, but the cube's defense scope is the cap *against
    // adversaries*; a separate observation (the test below the
    // aggregate) pins that the runner's honest phase advances the
    // clock between honest reviewers so each gets a fresh epoch.
    for (const name of ['erin', 'frank']) {
      clock.advance(EPOCH_SECONDS * 1000 + 1);
      const honest = server.bootstrap.mintIdentity({
        display_name: name,
        attestation_level: params.attestation_threshold,
      });
      for (const targetId of targetIds) {
        const post = server.store.proposals.get(targetId);
        if (post?.status !== 'staged') continue;
        try {
          await server.tools.castReviewVote(
            { identity_id: honest.id },
            {
              proposal_id: targetId,
              decision: 'accept',
              rationale: 'consistent with prevailing evidence',
            },
          );
        } catch (err) {
          // Honest reviewers should not be rate-limited within a
          // single epoch given the cube's parameter range (T >= 1,
          // M <= 4, advance-between-honest-reviewers); if this fires
          // the runner's parameter assumptions need re-checking.
          if (err instanceof ServerError && err.code === 'rate_limited') {
            clock.advance(EPOCH_SECONDS * 1000 + 1);
            // Retry once after epoch advance.
            await server.tools.castReviewVote(
              { identity_id: honest.id },
              {
                proposal_id: targetId,
                decision: 'accept',
                rationale: 'consistent with prevailing evidence',
              },
            );
          } else {
            throw err;
          }
        }
      }
    }

    let rejectedCount = 0;
    for (const targetId of targetIds) {
      const final = server.store.proposals.get(targetId);
      if (final?.status === 'rejected') rejectedCount += 1;
    }
    return {
      fully_suppressed: rejectedCount === params.targets_count,
      rejected_count: rejectedCount,
      total_targets: params.targets_count,
    };
  }

  interface ActionAxisSweepCell {
    name: string;
    targets_count: number;
    attestation_threshold: number;
    action_cap_per_epoch: number;
    epochs: number;
    expected_fully_suppressed: boolean;
    expected_rejected_count: number;
  }
  const actionAxisSweepCells: ActionAxisSweepCell[] = [
    // K=2 fixed; suppression_capacity = T × E targets; full
    // suppression iff T × E >= M.
    {
      name: 'M=2, T=1, E=1 (cap closes — T × E = 1 < M = 2)',
      targets_count: 2,
      attestation_threshold: 1,
      action_cap_per_epoch: 1,
      epochs: 1,
      expected_fully_suppressed: false,
      expected_rejected_count: 1,
    },
    {
      name: 'M=2, T=1, E=2 (multi-epoch lift on rate cap — T × E = 2 = M)',
      targets_count: 2,
      attestation_threshold: 1,
      action_cap_per_epoch: 1,
      epochs: 2,
      expected_fully_suppressed: true,
      expected_rejected_count: 2,
    },
    {
      name: 'M=2, T=2, E=1 (per-epoch lift on rate cap — T × E = 2 = M)',
      targets_count: 2,
      attestation_threshold: 1,
      action_cap_per_epoch: 2,
      epochs: 1,
      expected_fully_suppressed: true,
      expected_rejected_count: 2,
    },
    {
      name: 'M=2, T=2, E=2 (cap saturates — T × E = 4 > M = 2)',
      targets_count: 2,
      attestation_threshold: 1,
      action_cap_per_epoch: 2,
      epochs: 2,
      expected_fully_suppressed: true,
      expected_rejected_count: 2,
    },
    {
      name: 'M=4, T=1, E=1 (cap closes — T × E = 1 < M = 4)',
      targets_count: 4,
      attestation_threshold: 1,
      action_cap_per_epoch: 1,
      epochs: 1,
      expected_fully_suppressed: false,
      expected_rejected_count: 1,
    },
    {
      name: 'M=4, T=1, E=2 (cap closes at large attack scope — T × E = 2 < M = 4)',
      targets_count: 4,
      attestation_threshold: 1,
      action_cap_per_epoch: 1,
      epochs: 2,
      expected_fully_suppressed: false,
      expected_rejected_count: 2,
    },
    {
      name: 'M=4, T=2, E=1 (cap closes at large attack scope — T × E = 2 < M = 4)',
      targets_count: 4,
      attestation_threshold: 1,
      action_cap_per_epoch: 2,
      epochs: 1,
      expected_fully_suppressed: false,
      expected_rejected_count: 2,
    },
    {
      name: 'M=4, T=2, E=2 (composition saturates — T × E = 4 = M)',
      targets_count: 4,
      attestation_threshold: 1,
      action_cap_per_epoch: 2,
      epochs: 2,
      expected_fully_suppressed: true,
      expected_rejected_count: 4,
    },
  ];
  it.each(actionAxisSweepCells)('action-axis sweep: $name', async ({
    targets_count,
    attestation_threshold,
    action_cap_per_epoch,
    epochs,
    expected_fully_suppressed,
    expected_rejected_count,
  }) => {
    const result = await runMultiTargetActionAxisSuppressionScenario({
      targets_count,
      attestation_threshold,
      action_cap_per_epoch,
      epochs,
    });
    expect(result.fully_suppressed).toBe(expected_fully_suppressed);
    expect(result.rejected_count).toBe(expected_rejected_count);
  });

  it('action-axis sweep cube: ASR aggregates by (T, E) and reads the rate-limit cap as throughput primitive', () => {
    // Aggregate per the cube template: group cells by (T, E), read
    // ASR per group across the M (attack-scope) axis. The headline
    // is the symmetry cube #7's reading anticipated — at fixed K=2
    // sybils, the suppression-capacity arithmetic reduces to T × E
    // (per-sybil throughput across the attack window) because every
    // suppressed target consumes one reject vote per sybil. Cube #8
    // and cube #7's aggregates are numerically identical (0%, 50%,
    // 50%, 100% across (cap=1,E=1)/(cap=1,E=2)/(cap=2,E=1)/(cap=2,
    // E=2)) reading two different primitives — the issuance cap and
    // the rate-limit — on the four-layer architecture.
    interface ActionAxisAsrCell {
      action_cap_per_epoch: number;
      epochs: number;
      total: number;
      attacks_succeeded: number;
    }
    const grouped = new Map<string, ActionAxisAsrCell>();
    for (const cell of actionAxisSweepCells) {
      const key = `${cell.action_cap_per_epoch}|${cell.epochs}`;
      const g = grouped.get(key) ?? {
        action_cap_per_epoch: cell.action_cap_per_epoch,
        epochs: cell.epochs,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_fully_suppressed) g.attacks_succeeded += 1;
      grouped.set(key, g);
    }
    const asr = (key: string): number => {
      const g = grouped.get(key);
      if (!g) throw new Error(`missing defense config: ${key}`);
      return g.attacks_succeeded / g.total;
    };

    // (T=1, E=1): ASR=0% — minimum-cap defense config; T × E = 1
    // suppresses 1 target only, falls short of M=2 and M=4 alike.
    // The rate-limit closes any multi-target suppression in a single
    // epoch at the minimum cap.
    expect(asr('1|1')).toBe(0);
    // (T=1, E=2): ASR=50% — multi-epoch lift on the rate cap.
    // T × E = 2 fully suppresses M=2 (1 target per epoch), stops
    // short of M=4. The cap *delays* but does not *prevent*
    // suppression at small attack scope across epochs, exactly the
    // shape cube #7 read on the issuance-cap axis.
    expect(asr('1|2')).toBe(0.5);
    // (T=2, E=1): ASR=50% — per-epoch lift on the rate cap,
    // symmetric to the time-primitive lift. T × E = 2 same as
    // (T=1, E=2). The throughput axis is symmetric in T and E across
    // the attack window — the slice-3 "K × T = coalition's per-epoch
    // budget" framing extends to K × T × E across multi-epoch
    // attacks, with T and E interchangeable in the product.
    expect(asr('2|1')).toBe(0.5);
    // (T=2, E=2): ASR=100% — composition saturates at the maximum
    // attack scope cube #8 measures. T × E = 4 covers M=4 (the
    // saturating cell) and M=2 (where the cap is non-binding).
    // Widening M to 6 would re-open this cell with the same
    // T × E = 4 < 6 closure, sliding the composition's saturation
    // point with the attack scope.
    expect(asr('2|2')).toBe(1);

    // Coverage invariant: every (T, E) defense config in the cube
    // has both M cells. A future cell expansion that breaks this
    // symmetry trips the assertion and forces the aggregate to be
    // re-keyed rather than silently averaging over uneven groups.
    for (const cell of grouped.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Ninth parameter sweep cube: the cluster-signal × budget-axis
  // composition cube ROADMAP §Status named as the remaining
  // qualitative axis after cubes #6/#7/#8 wired the K-axis and
  // throughput-axis budget primitives. The headline is the
  // *composition* of two defense layers — identity layer (binding-
  // cost gate) and behavior layer (cluster signal) — against a
  // sybil-amplified-coordinated-voting attack pattern that defeats
  // either layer *alone*. Cubes #6/#7/#8 disable the cluster signal
  // (per-sybil-acts-once attack has no shared history to cluster
  // on, structurally inert by construction); cubes #1/#3/#4 read
  // the cluster signal but disable the identity-layer cost
  // primitives. Cube #9 is the first cube where both layers are
  // active and the budget axis sweeps how *much* fresh-recruit
  // capacity the operator can field against the cluster signal's
  // closure of the established coalition.
  //
  // Attack pattern: Carol+Dave coalition with 3 priming proposals
  // shared (cluster signal fires — Carol and Dave land in the same
  // co-stratum cluster after `stratum_min_shared_proposals: 2`).
  // After contested is staged, Carol requests assignment first and
  // is routed (no co-stratum reviewer yet routed); Dave requests
  // next and the cross-stratum gate refuses him with `not_found`
  // (Carol-already-routed + Carol-Dave co-stratum). The coalition
  // recruits Eve(s) — fresh identities with no shared history,
  // each in their own singleton stratum — until budget exhausts.
  // Each Eve mints (binding-cost gate fires server-side at
  // `min_attestation_level: T`; harness-side `AdversaryBudget`
  // mirrors the cost as α=T deducted from B per `tryMint`),
  // requests assignment (singleton stratum, walks past the cluster
  // signal), and casts reject. votes_to_reject=3 so Carol's lone
  // reject is insufficient and Eve(s) are decisive: K_eff(Eves) =
  // floor(B / T) when T > 0, else unbounded. Honest reviewers
  // (Erin, Frank, George) cast accept — votes_to_accept=2, so
  // their accepts converge contested 'accepted' if the rejects
  // don't reach K*=3 first.
  //
  // The composition reads:
  //   Identity layer alone (T=0, binding cost inert): Eves are
  //     free; the operator can mint K*-1=2 Eves at any budget. The
  //     cluster signal closes Dave but Carol+2 Eves = 3 rejects
  //     converge contested rejected. ASR=100% across all B at T=0
  //     — cluster signal alone is *insufficient*.
  //   Behavior layer alone (T=2, cluster signal off): hypothetical
  //     — without cluster signal, Dave walks in and casts reject
  //     too. Carol+Dave+1 Eve = 3. The binding-cost gate would
  //     then need to close Dave's *and* the Eve recruit, requiring
  //     B < T to refuse all of them. Cube #9 holds cluster signal
  //     *on* so the headline is the joint reading rather than the
  //     individual-layer reading; the cluster-off baseline is what
  //     cube #6 already measured, so cube #9's contribution is the
  //     joint axis.
  //   Composition (T=2, cluster signal on): the cluster signal
  //     closes Dave, the binding-cost gate refuses Eve(s) when
  //     B < T or when B affords fewer than K*-1 Eves. ASR=0% at
  //     B=1 (Eve unaffordable) and B=2 (one Eve affordable, only
  //     2 < K*=3 rejects); ASR=100% at B=4 (two Eves affordable,
  //     Carol+2 Eves = K*=3, attack lands).
  //
  // Six cells over (T ∈ {0, 2}, B ∈ {1, 2, 4}) drive `it.each`.
  // The aggregate groups by T (the defense-config axis) and reads
  // ASR per group across the budget axis: T=0 at 100% — identity
  // layer inert; cluster signal alone leaks at any budget. T=2 at
  // 33% — composition closes 2 of 3 budget cells; the (T=2, B=4)
  // cell is the leak where the budget axis defeats the composition.
  // The (B=2, T=2) cell is the *threshold-budget* for the (K*=3)
  // regime — one Eve affordable, but K*-1=2 needed; doubling
  // budget to B=4 lifts ASR to 100%. The threshold-budget reading
  // is the cost-multiplier signature cube #6 read at the (T=2,
  // N=2) cell on the K-axis: the budget needed for attack
  // feasibility scales with the binding-cost multiplier T and the
  // additional-recruits-required floor K*-1.
  //
  // Cube #9 is the first cube to read the four-layer architecture's
  // *full composition* under the named regression-handle attack
  // pattern (sybil-amplified coordinated-voting). PRD §Identity's
  // "the four identity-layer primitives are what closes the seam
  // the behavior-based stack cannot" framing reads here as: at the
  // (T=2, B<=2) cells the identity layer (binding-cost gate) is
  // what closes the freshness bypass the cluster signal cannot
  // reach; at the (T=2, B=4) cell the budget axis defeats the
  // identity-layer closure; at T=0 the identity layer is inert and
  // the cluster signal alone cannot close the recruit-amplification.
  // The full composition closes only when *every* axis (cluster
  // signal on, binding cost > 0, budget < K*-1 × T) aligns —
  // exactly the multiplicative composition PRD §Identity commits.
  async function runSybilAmplifiedCoordinatedSuppressionScenario(params: {
    budget: number;
    attestation_threshold: number;
    votes_to_reject: number;
  }): Promise<{
    attack_succeeded: boolean;
    contested_status: string;
    eves_minted: number;
    dave_gated: boolean;
  }> {
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('sacs'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: params.votes_to_reject,
        min_attestation_level: params.attestation_threshold,
        // Cluster signal on with default-shaped config; the cube's
        // headline is the joint reading of cluster signal + binding-
        // cost gate, so both must be active.
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
      },
    });
    const alice = server.bootstrap.mintIdentity({
      display_name: 'alice',
      attestation_level: params.attestation_threshold,
    });
    const carol = server.bootstrap.mintIdentity({
      display_name: 'carol',
      attestation_level: params.attestation_threshold,
    });
    const dave = server.bootstrap.mintIdentity({
      display_name: 'dave',
      attestation_level: params.attestation_threshold,
    });
    const erin = server.bootstrap.mintIdentity({
      display_name: 'erin',
      attestation_level: params.attestation_threshold,
    });
    const frank = server.bootstrap.mintIdentity({
      display_name: 'frank',
      attestation_level: params.attestation_threshold,
    });
    const george = server.bootstrap.mintIdentity({
      display_name: 'george',
      attestation_level: params.attestation_threshold,
    });

    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'treatment-X',
      description: 'x',
      scope_query: 'x',
    });

    for (const reviewer of [carol, dave, erin, frank, george]) {
      await server.tools.setCapacity(
        { identity_id: reviewer.id },
        { cause_id: cause.id, rate: 5, kinds: ['review'] },
      );
    }

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

    // Carol+Dave priming: 3 shared excerpts where they both vote
    // accept. With `stratum_min_shared_proposals: 2` and
    // `stratum_agreement_threshold: 1.0`, 3 unanimous shared votes
    // clears the floor and pushes them into the same cluster. Each
    // priming excerpt is curator-accepted post-vote so it doesn't
    // sit in the staged queue confounding subsequent assignments.
    for (let i = 0; i < 3; i++) {
      const primer = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `priming stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      const after = server.store.proposals.get(primer.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(primer.proposal_id);
      }
    }

    // Stage the contested target on a different anchor (paper 2)
    // so the priming history doesn't include the contested-pattern
    // span; the sybil farm's regression handle is the freshness
    // bypass on a contested target whose vote-pattern is opposite
    // to the priming-history pattern.
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
    const contestedId = contested.proposal_id;

    // Adversary phase 1: Carol requests assignment, gets routed
    // (no co-stratum reviewer yet routed for contested), casts
    // reject.
    const carolAssignment = await server.tools.requestAssignment(
      { identity_id: carol.id },
      { cause_id: cause.id },
    );
    if (carolAssignment.task.kind !== 'review') {
      throw new Error('expected carol to be routed to a review task');
    }
    if (carolAssignment.task.proposal_id !== contestedId) {
      throw new Error(
        `expected carol routed to contested ${contestedId}, got ${carolAssignment.task.proposal_id}`,
      );
    }
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      {
        proposal_id: contestedId,
        decision: 'reject',
        rationale: 'underpowered, methodological concerns',
        assignment_id: carolAssignment.assignment_id,
      },
    );

    // Adversary phase 2: Dave requests assignment, cluster signal
    // closure fires (Carol-already-routed + Carol-Dave co-stratum
    // → cross-stratum gate refuses Dave with `not_found`). This is
    // the cluster-signal closure of the established-coalition half
    // of the attack.
    let daveGated = false;
    try {
      const daveAssignment = await server.tools.requestAssignment(
        { identity_id: dave.id },
        { cause_id: cause.id },
      );
      if (
        daveAssignment.task.kind === 'review' &&
        daveAssignment.task.proposal_id === contestedId
      ) {
        // If Dave wasn't gated, he would cast reject too. The cube's
        // ASR readings are robust to this (Dave's reject would
        // contribute one more vote toward K*, but the budget-bound
        // cells still close because Eve(s) are also constrained), but
        // surface the not-gated state so a wiring regression that
        // disabled the cluster signal silently surfaces here rather
        // than only via downstream ASR drift.
        await server.tools.castReviewVote(
          { identity_id: dave.id },
          {
            proposal_id: contestedId,
            decision: 'reject',
            rationale: 'underpowered, methodological concerns',
            assignment_id: daveAssignment.assignment_id,
          },
        );
      }
    } catch (err) {
      if (err instanceof ServerError && err.code === 'not_found') {
        daveGated = true;
      } else {
        throw err;
      }
    }

    // Adversary phase 3: Eve loop. Mint Eves until either budget
    // exhausts or the contested target converges. Each Eve is a
    // singleton in the cluster signal (no shared history) and walks
    // past the cross-stratum gate. The harness-side budget mirrors
    // the server-side `min_attestation_level` arithmetic:
    // `tryMint(0)` deducts T from B (binding-cost layer); refusal
    // mode 'budget' fires when B < T (the operator cannot afford
    // another sybil at this rate). Issuance cap is held at infinity
    // — cube #7 already measured the time-axis on the issuance cap;
    // cube #9 isolates the binding-cost × cluster-signal composition.
    const budget = new AdversaryBudget({
      initial: params.budget,
      attestation_cost: params.attestation_threshold,
      issuance_cap_per_epoch: Number.POSITIVE_INFINITY,
    });
    const maxEvesNeeded = params.votes_to_reject - 1;
    let evesMinted = 0;
    while (evesMinted < maxEvesNeeded) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      const mintResult = budget.tryMint(0);
      if (!mintResult.ok) break;
      const eve = server.bootstrap.mintIdentity({
        display_name: `eve${evesMinted}`,
        attestation_level: params.attestation_threshold,
      });
      evesMinted += 1;
      await server.tools.setCapacity(
        { identity_id: eve.id },
        { cause_id: cause.id, rate: 5, kinds: ['review'] },
      );
      const eveAssignment = await server.tools.requestAssignment(
        { identity_id: eve.id },
        { cause_id: cause.id },
      );
      if (eveAssignment.task.kind !== 'review') {
        throw new Error('expected eve routed to a review task');
      }
      if (eveAssignment.task.proposal_id !== contestedId) {
        throw new Error(
          `expected eve routed to contested ${contestedId}, got ${eveAssignment.task.proposal_id}`,
        );
      }
      await server.tools.castReviewVote(
        { identity_id: eve.id },
        {
          proposal_id: contestedId,
          decision: 'reject',
          rationale: 'underpowered, methodological concerns',
          assignment_id: eveAssignment.assignment_id,
        },
      );
    }

    // Honest phase: Erin, Frank, George each request assignment
    // (singleton strata) and cast accept. votes_to_accept=2; if
    // contested is still staged after the adversary phase, the
    // second honest accept converges it 'accepted'. If contested
    // already converged 'rejected' (sybils reached K*), the loop
    // short-circuits.
    for (const honest of [erin, frank, george]) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      try {
        const honestAssignment = await server.tools.requestAssignment(
          { identity_id: honest.id },
          { cause_id: cause.id },
        );
        if (
          honestAssignment.task.kind !== 'review' ||
          honestAssignment.task.proposal_id !== contestedId
        ) {
          // No work or routed elsewhere — skip; the honest pool's
          // role is to converge contested if possible, not to drive
          // the runner.
          continue;
        }
        await server.tools.castReviewVote(
          { identity_id: honest.id },
          {
            proposal_id: contestedId,
            decision: 'accept',
            rationale: 'consistent with prevailing evidence',
            assignment_id: honestAssignment.assignment_id,
          },
        );
      } catch (err) {
        if (err instanceof ServerError && err.code === 'not_found') {
          // Honest reviewer also gated — the honest pool's stratum
          // is singleton by construction (no shared history with
          // anyone), so this should not fire. If it does, the cube's
          // assumption that honest reviewers are routable to
          // contested has been violated and the per-cell expectation
          // needs re-checking.
          continue;
        }
        throw err;
      }
    }

    const final = server.store.proposals.get(contestedId);
    if (!final) throw new Error('contested proposal not found');
    return {
      attack_succeeded: final.status === 'rejected',
      contested_status: final.status,
      eves_minted: evesMinted,
      dave_gated: daveGated,
    };
  }

  interface ClusterBudgetSweepCell {
    name: string;
    budget: number;
    attestation_threshold: number;
    votes_to_reject: number;
    expected_attack_succeeded: boolean;
    expected_eves_minted: number;
  }
  const clusterBudgetSweepCells: ClusterBudgetSweepCell[] = [
    // votes_to_reject=3 throughout; K* = 3 (Carol's 1 reject +
    // K*-1=2 Eve rejects). K_eff(Eves) = floor(B / T) when T > 0,
    // else unbounded (capped at K*-1=2 by the runner). Attack lands
    // iff K_eff(Eves) >= K*-1 = 2.
    {
      name: 'T=0, B=1 (binding cost inert; Eves free, attack lands)',
      budget: 1,
      attestation_threshold: 0,
      votes_to_reject: 3,
      expected_attack_succeeded: true,
      expected_eves_minted: 2,
    },
    {
      name: 'T=0, B=2 (binding cost inert; Eves free, attack lands)',
      budget: 2,
      attestation_threshold: 0,
      votes_to_reject: 3,
      expected_attack_succeeded: true,
      expected_eves_minted: 2,
    },
    {
      name: 'T=0, B=4 (binding cost inert; Eves free, attack lands)',
      budget: 4,
      attestation_threshold: 0,
      votes_to_reject: 3,
      expected_attack_succeeded: true,
      expected_eves_minted: 2,
    },
    {
      name: 'T=2, B=1 (binding cost refuses Eve at first mint; composition closes)',
      budget: 1,
      attestation_threshold: 2,
      votes_to_reject: 3,
      expected_attack_succeeded: false,
      expected_eves_minted: 0,
    },
    {
      name: 'T=2, B=2 (one Eve affordable; insufficient at K*=3)',
      budget: 2,
      attestation_threshold: 2,
      votes_to_reject: 3,
      expected_attack_succeeded: false,
      expected_eves_minted: 1,
    },
    {
      name: 'T=2, B=4 (two Eves affordable; budget defeats composition)',
      budget: 4,
      attestation_threshold: 2,
      votes_to_reject: 3,
      expected_attack_succeeded: true,
      expected_eves_minted: 2,
    },
  ];
  it.each(clusterBudgetSweepCells)('cluster × budget sweep: $name', async ({
    budget,
    attestation_threshold,
    votes_to_reject,
    expected_attack_succeeded,
    expected_eves_minted,
  }) => {
    const result = await runSybilAmplifiedCoordinatedSuppressionScenario({
      budget,
      attestation_threshold,
      votes_to_reject,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.eves_minted).toBe(expected_eves_minted);
    // Dave-gated invariant: the cluster signal must close Dave on
    // every cell. If a future change disables or weakens the
    // cluster signal, this assertion fires before the ASR readings
    // drift, surfacing the regression at its root rather than via
    // downstream ASR shift.
    expect(result.dave_gated).toBe(true);
  });

  it('cluster × budget sweep cube: ASR aggregates by T and reads the identity × behavior layer composition', () => {
    // Aggregate per the cube template: group cells by T (the
    // identity-layer defense knob), read ASR per group across the
    // budget axis. The headline is the *composition* — neither
    // layer alone closes the sybil-amplified-coordinated-voting
    // attack, both layers together close the threshold-budget
    // cells (T=2, B<=2), and the (T=2, B=4) cell is the leak where
    // the budget axis defeats the composition by affording K*-1=2
    // Eves.
    interface ClusterBudgetAsrCell {
      attestation_threshold: number;
      total: number;
      attacks_succeeded: number;
    }
    const groupedByT = new Map<number, ClusterBudgetAsrCell>();
    for (const cell of clusterBudgetSweepCells) {
      const g = groupedByT.get(cell.attestation_threshold) ?? {
        attestation_threshold: cell.attestation_threshold,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      groupedByT.set(cell.attestation_threshold, g);
    }
    const asrByT = (t: number): number => {
      const g = groupedByT.get(t);
      if (!g) throw new Error(`missing T=${t}`);
      return g.attacks_succeeded / g.total;
    };

    // T=0: ASR=100% across all 3 budget cells. Identity layer
    // inert; the cluster signal alone closes Dave but Eves walk
    // past as fresh singletons, and at any budget the operator can
    // mint K*-1=2 Eves at zero cost. The cluster signal alone is
    // insufficient against the freshness bypass — exactly the seam
    // the sybil-amplified-coalition scenario was the regression
    // handle on, now read on the budget axis.
    expect(asrByT(0)).toBe(1);
    // T=2: ASR=33% across 3 budget cells. Composition closes the
    // (B=1) cell (Eve unaffordable, binding-cost gate refuses) and
    // the (B=2) cell (one Eve affordable, but K*-1=2 needed —
    // composition closes by *insufficient-recruits*, not by
    // refusal-of-recruits). The (B=4) cell is the leak where the
    // budget axis affords two Eves and the composition fails.
    expect(asrByT(2)).toBeCloseTo(1 / 3);

    // Aggregate by B reads the cost-multiplier signature on the
    // joint axis: at each budget level, ASR averages over T=0 and
    // T=2 cells. The threshold-budget B=2 (where K*-1=2 Eves at
    // T=2 cost B=4 to afford, so B=2 closes by composition) reads
    // 50% — T=0 leaks (cluster signal alone), T=2 closes
    // (composition); doubling budget to B=4 lifts ASR to 100% (T=2
    // also leaks).
    interface ClusterBudgetAsrByBCell {
      budget: number;
      total: number;
      attacks_succeeded: number;
    }
    const groupedByB = new Map<number, ClusterBudgetAsrByBCell>();
    for (const cell of clusterBudgetSweepCells) {
      const g = groupedByB.get(cell.budget) ?? {
        budget: cell.budget,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      groupedByB.set(cell.budget, g);
    }
    const asrByB = (b: number): number => {
      const g = groupedByB.get(b);
      if (!g) throw new Error(`missing B=${b}`);
      return g.attacks_succeeded / g.total;
    };
    expect(asrByB(1)).toBe(0.5);
    expect(asrByB(2)).toBe(0.5);
    expect(asrByB(4)).toBe(1);

    // Coverage invariants: every T cell has 3 budget cells, every B
    // cell has 2 T cells. A future cell expansion that breaks the
    // symmetry trips the assertion and forces the aggregate to be
    // re-keyed rather than silently averaging over uneven groups.
    for (const cell of groupedByT.values()) {
      expect(cell.total).toBe(3);
    }
    for (const cell of groupedByB.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Tenth parameter sweep cube: the calibration-density × calibration-
  // aware-convergence composition cube. ROADMAP §Status records the
  // identity-cost design pass (cubes #6-#9) as closed at the cube
  // level; this cube opens the *calibration-density* design pass on a
  // non-identity axis the prior cubes left unswept. PRD §What's
  // deliberately not specified names "numeric calibration ratios (what
  // fraction of a reviewer's batch is calibration items)" as a knob
  // explicitly deferred to the testbed; the existing strategic-
  // coalition scenarios pin the rep-ledger and convergence-half
  // closures at a single density (every_n=2) without surveying the
  // axis. Cube #10 is the first cube to read the density axis
  // directly.
  //
  // Attack pattern: strategic-coalition (PRD §Adversary taxonomy,
  // Strategic adversary + Coalition). 2-of-3 biased reviewers
  // (Carol+Dave, naiveBiasedDecider — accept payloads containing
  // "works", reject otherwise) versus one honest reviewer (Erin,
  // accept-all on well-grounded excerpts), against two well-grounded
  // excerpts staged by Bob (one bias-aligned, one bias-misaligned).
  // The bias-misaligned excerpt (the "no effect" finding) is the
  // suppression target; attack_succeeded reads true iff it converges
  // 'rejected' (the coalition's two rejects beat Erin's lone accept
  // at votes_to_reject=2).
  //
  // Defense layers in scope:
  //   - calibration_inject_every_n (the swept density axis): every Nth
  //     review-task offer is replaced with a calibration draw from the
  //     accepted-from-history corpus (the two anchors Alice proposes,
  //     "paper 1" / "paper 2"). The naive bias predicate misfires on
  //     anchor content (neither contains "works") so Carol+Dave fail
  //     calibration on every item they see; Erin's accept-all passes.
  //     0 disables (frontier-only path); higher N is *lower* density.
  //   - calibration_aware_convergence (the toggled convergence-path
  //     defense): when on, vote weights at convergence are weighted by
  //     the reviewer's per-(cause, sub-topic) calibration record
  //     (`max(0, 1 + passes - fails)`), so a coalition member whose
  //     calibration record went sour contributes 0 to the weighted
  //     sum even when contributing 1 to the distinct count. Convergence
  //     requires both ≥N distinct reviewers AND ≥N weighted sum.
  //
  // The composition reads:
  //   aware=false: calibration injection moves the rep ledger but
  //     leaves convergence uncalibrated. The bias suppression converges
  //     'rejected' regardless of density — calibration alone is
  //     insufficient against the convergence half. ASR=100% across
  //     every_n.
  //   aware=true at every_n=0: the gate is on but the calibration
  //     corpus is never sampled, so every reviewer's calibration record
  //     stays at (0,0) and weights collapse to 1. Identical behavior
  //     to the count-only mode. ASR=100%.
  //   aware=true at every_n=4: the small-scale runner exhausts the
  //     two-excerpt frontier within ~3 review-task offers per
  //     reviewer; at every_n=4 the reviewer never reaches the 4th
  //     offer, so calibration items never materialize in the
  //     convergence window. The defense is *silent* — the calibration
  //     record stays empty and the gate behaves like every_n=0.
  //     ASR=100%. This is the density-floor reading: calibration-aware
  //     convergence has a structural minimum density below which the
  //     defense has no signal to operate on.
  //   aware=true at every_n=2: each coalition member sees ≥2
  //     calibration items during their review loop, fails them all
  //     (naive bias misfires on anchor content), and their weighted
  //     vote drops to 0 at convergence. The bias-misaligned excerpt's
  //     1 accept (Erin, weight ≥1) + 2 rejects (Carol+Dave, weight 0)
  //     fails the weighted-reject threshold despite meeting the count
  //     threshold. The proposal stays staged — neither accepted (only
  //     1 distinct accept) nor rejected (weighted sum 0 < 2). ASR=0%.
  //
  // Six cells over (every_n ∈ {0, 4, 2}, aware ∈ {false, true}) drive
  // `it.each`. The aggregate groups by (every_n, aware) and reads ASR
  // per group: aware=false at 100% across all every_n (calibration-
  // density-invariant on the convergence path); aware=true at 100%
  // for every_n ∈ {0, 4} and 0% at every_n=2. The headline reading is
  // the *density floor on the calibration-aware closure*: the defense
  // bites only when the calibration cadence is fast enough that the
  // calibration record moves before the contested target's
  // convergence window closes, and at fixed reviewer-pool size that
  // floor is a function of every_n alone. PRD §Calibration batches
  // commits "a coalition that misfires on calibration items pays
  // once on the rep ledger and once at convergence"; cube #10 is the
  // first cube to read the *and-once-at-convergence* half's
  // density-dependence directly, complementing the rep-ledger
  // inversion the standalone calibration-injection scenario already
  // pins (which is density-monotonic and not the load-bearing axis
  // here).
  //
  // The runner reuses the existing strategic-coalition setup (two
  // anchors, two excerpts, three reviewers) byte-identical to the
  // standalone scenarios above so the cube reads against the same
  // attack pattern those scenarios pin. The standalone scenarios
  // stay as-is for their additional observations (rep-ledger
  // inversion, materialization, etc.); the cube measures the
  // convergence-half ASR axis only.
  async function runStrategicCoalitionScenario(params: {
    calibration_inject_every_n: number;
    calibration_aware_convergence: boolean;
  }): Promise<{
    attack_succeeded: boolean;
    suppressed_status: string;
  }> {
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('cd'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: params.calibration_inject_every_n,
        calibration_aware_convergence: params.calibration_aware_convergence,
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
    // The two anchors are the calibration corpus — accepted-from-
    // history proposals the calibration-draw selects from. Naive bias
    // predicate rejects both ("paper N" doesn't include "works"), so
    // every coalition-member calibration draw is a fail; Erin's
    // accept-all passes them all.
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

    // Erin (honest, accept-all) runs first. She votes accept on both
    // excerpts; neither converges yet (1 accept each, threshold 2).
    // At every_n=2 she also sees ~2 calibration items and passes them
    // all (record (2, 0)); at every_n=4 she exits before reaching any.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 5,
      decide: acceptAllDecider,
    });

    // Coalition: Carol+Dave share the naive bias predicate (accept
    // payloads containing "works"; reject otherwise). Both run
    // sequentially; the second's reject on the bias-misaligned
    // excerpt converges it 'rejected' at votes_to_reject=2 unless
    // calibration-aware convergence has dropped their weights below
    // the weighted-sum threshold.
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

    const excerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    const noEffect = excerpts.find(
      (p) => p.payload.kind === 'excerpt' && p.payload.content.includes('no effect'),
    );
    if (!noEffect) throw new Error('bias-misaligned excerpt not materialized');
    return {
      attack_succeeded: noEffect.status === 'rejected',
      suppressed_status: noEffect.status,
    };
  }

  interface CalibrationDensitySweepCell {
    name: string;
    calibration_inject_every_n: number;
    calibration_aware_convergence: boolean;
    expected_attack_succeeded: boolean;
    expected_suppressed_status: 'rejected' | 'staged';
  }
  const calibrationDensitySweepCells: CalibrationDensitySweepCell[] = [
    // every_n=0 row: calibration injection disabled. Both aware
    // values land at the baseline ASR=100% — without calibration
    // data, the aware gate has nothing to weight votes by and behaves
    // like the count-only mode.
    {
      name: 'every_n=0, aware=false (baseline; no calibration, count-only convergence)',
      calibration_inject_every_n: 0,
      calibration_aware_convergence: false,
      expected_attack_succeeded: true,
      expected_suppressed_status: 'rejected',
    },
    {
      name: 'every_n=0, aware=true (gate inert without calibration data; weights collapse to 1)',
      calibration_inject_every_n: 0,
      calibration_aware_convergence: true,
      expected_attack_succeeded: true,
      expected_suppressed_status: 'rejected',
    },
    // every_n=4 row: density floor. The two-excerpt runner exhausts
    // the frontier within ~3 review-task offers per reviewer; at
    // every_n=4 the reviewer exits before reaching the 4th offer, so
    // calibration items never materialize in the convergence window
    // and the calibration record stays empty for every reviewer.
    // Both aware values land at ASR=100% — the aware gate is silent
    // by construction at this density.
    {
      name: 'every_n=4, aware=false (below density floor; no calibration items reach reviewers)',
      calibration_inject_every_n: 4,
      calibration_aware_convergence: false,
      expected_attack_succeeded: true,
      expected_suppressed_status: 'rejected',
    },
    {
      name: 'every_n=4, aware=true (below density floor; aware gate silent — empty calibration record)',
      calibration_inject_every_n: 4,
      calibration_aware_convergence: true,
      expected_attack_succeeded: true,
      expected_suppressed_status: 'rejected',
    },
    // every_n=2 row: calibration fires within the convergence window.
    // Each coalition member sees ≥2 calibration items during their
    // review loop, fails them all (naive bias misfires on anchor
    // content), and their weighted vote drops to 0. aware=false still
    // leaks (rep ledger moves but convergence is uncalibrated);
    // aware=true closes the convergence half — the bias-misaligned
    // excerpt's weighted reject sum fails the threshold and the
    // proposal stays 'staged' rather than converging 'rejected'.
    {
      name: 'every_n=2, aware=false (calibration moves rep ledger; convergence uncalibrated, attack lands)',
      calibration_inject_every_n: 2,
      calibration_aware_convergence: false,
      expected_attack_succeeded: true,
      expected_suppressed_status: 'rejected',
    },
    {
      name: 'every_n=2, aware=true (calibration record drops coalition weights to 0; convergence half closes)',
      calibration_inject_every_n: 2,
      calibration_aware_convergence: true,
      expected_attack_succeeded: false,
      expected_suppressed_status: 'staged',
    },
  ];
  it.each(calibrationDensitySweepCells)('calibration density × aware sweep: $name', async ({
    calibration_inject_every_n,
    calibration_aware_convergence,
    expected_attack_succeeded,
    expected_suppressed_status,
  }) => {
    const result = await runStrategicCoalitionScenario({
      calibration_inject_every_n,
      calibration_aware_convergence,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.suppressed_status).toBe(expected_suppressed_status);
  });

  it('calibration density × aware sweep cube: ASR aggregates by aware and reads the density floor', () => {
    // Aggregate per the cube template: group cells by aware (the
    // convergence-path defense knob) and read ASR per group across
    // the density axis. The headline is the *density floor on the
    // calibration-aware closure* — aware=false reads ASR=100% across
    // all every_n (calibration alone never closes the convergence
    // half, regardless of density), and aware=true reads ASR=100% at
    // every_n ∈ {0, 4} (gate silent — no calibration data) and 0% at
    // every_n=2 (gate fires, weights drop, convergence half closes).
    interface CalibrationAsrCell {
      aware: boolean;
      total: number;
      attacks_succeeded: number;
    }
    const groupedByAware = new Map<boolean, CalibrationAsrCell>();
    for (const cell of calibrationDensitySweepCells) {
      const g = groupedByAware.get(cell.calibration_aware_convergence) ?? {
        aware: cell.calibration_aware_convergence,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      groupedByAware.set(cell.calibration_aware_convergence, g);
    }
    const asrByAware = (aware: boolean): number => {
      const g = groupedByAware.get(aware);
      if (!g) throw new Error(`missing aware=${aware}`);
      return g.attacks_succeeded / g.total;
    };

    // aware=false: ASR=100% across all 3 density cells. Calibration
    // injection moves the rep ledger but leaves convergence
    // uncalibrated; the bias-suppression vector lands regardless of
    // density. This row is the regression handle on PRD §Calibration
    // batches' "calibration alone does not close the convergence
    // layer" framing — without aware=true, more calibration is not
    // more closure.
    expect(asrByAware(false)).toBe(1);
    // aware=true: ASR=67% — the gate fires only at every_n=2 (1/3
    // cells closes); at every_n ∈ {0, 4} the calibration record
    // stays empty and the gate is silent (2/3 cells leak). The
    // density-floor reading: above the floor (every_n=2) the
    // composition closes; below it (every_n ∈ {0, 4}) the defense
    // has no signal to operate on.
    expect(asrByAware(true)).toBeCloseTo(2 / 3);

    // Aggregate by every_n reads the density axis directly: at
    // every_n=0 ASR=100% (both aware values leak — no calibration
    // data); at every_n=4 ASR=100% (both leak — calibration items
    // never materialize); at every_n=2 ASR=50% (aware=true closes,
    // aware=false leaks). The lift from every_n=4 to every_n=2 at
    // aware=true is the load-bearing observation: doubling
    // calibration density in this two-excerpt runner crosses the
    // density floor, and the closure goes from silent to active.
    interface CalibrationAsrByDensityCell {
      every_n: number;
      total: number;
      attacks_succeeded: number;
    }
    const groupedByDensity = new Map<number, CalibrationAsrByDensityCell>();
    for (const cell of calibrationDensitySweepCells) {
      const g = groupedByDensity.get(cell.calibration_inject_every_n) ?? {
        every_n: cell.calibration_inject_every_n,
        total: 0,
        attacks_succeeded: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      groupedByDensity.set(cell.calibration_inject_every_n, g);
    }
    const asrByDensity = (every_n: number): number => {
      const g = groupedByDensity.get(every_n);
      if (!g) throw new Error(`missing every_n=${every_n}`);
      return g.attacks_succeeded / g.total;
    };
    expect(asrByDensity(0)).toBe(1);
    expect(asrByDensity(4)).toBe(1);
    expect(asrByDensity(2)).toBe(0.5);

    // Coverage invariants: every aware cell has 3 density cells,
    // every density cell has 2 aware cells. A future cell expansion
    // that breaks the symmetry trips the assertion and forces the
    // aggregate to be re-keyed rather than silently averaging over
    // uneven groups (the same invariant cubes #6-#9 carry).
    for (const cell of groupedByAware.values()) {
      expect(cell.total).toBe(3);
    }
    for (const cell of groupedByDensity.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Eleventh parameter sweep cube: the stratification × honest-pool-
  // size cube on the cluster-signal-eligible coalition. PRD §What's
  // deliberately not specified names "Reviewer pool sizes (N for a
  // given proposal class)" as a knob explicitly deferred to the
  // testbed, and PRD §Reviewer assignment commits the closure
  // property: "small-sub-topic case slower to close but not
  // capturable by the pool-fits-the-coalition dynamic." Existing
  // scenarios pin the closure at one pool size (the 1749 scenario,
  // 'stratification closes the calibration-aware coalition on the
  // small-pool case') without surveying the pool-size axis. Cube #11
  // is the first cube to read the pool-size axis directly and
  // measure the *quality* of the closure across pool sizes via the
  // two-metric template cube #5 introduced (ASR + stall-rate).
  //
  // Attack pattern: the cluster-signal-eligible coalition (Carol+
  // Dave with 3 priming proposals shared so the cluster signal fires
  // after `stratum_min_shared_proposals: 2` + `stratum_agreement_
  // threshold: 1.0`). The coalition uses calAwareBiasedDecider —
  // bias zone narrow enough to pass calibration items and the
  // calibration-aware-convergence weighting, so the only defense in
  // scope is stratification. Coalition runs *first* so the strat=off
  // baseline reads ASR=100% across all H (the regression handle on
  // "pool size alone is not a defense at fixed ordering" — without
  // stratification, the coalition's two rejects converge before the
  // honest pool can vote). Then the honest pool of H reviewers
  // (using acceptAllDecider) runs sequentially. votes_to_accept=2
  // and votes_to_reject=2 throughout.
  //
  // Defense layers in scope:
  //   - stratification_enabled (the toggled axis): when on, the
  //     cluster signal computes vote-pattern co-occurrence clusters
  //     after the priming, and the cross-stratum draw rule routes
  //     Dave away from the contested target once Carol-already-
  //     routed (Carol-Dave co-stratum). Dave never votes; the
  //     coalition's effective leverage drops to Carol's lone reject.
  //   - honest_pool_size H ∈ {1, 2, 3} (the swept pool axis): the
  //     number of honest reviewers running after the coalition.
  //     Each contributes one accept; convergence requires votes_to_
  //     accept=2 honest votes plus Carol's lone reject doesn't reach
  //     votes_to_reject=2.
  //
  // The composition reads:
  //   strat=off (cluster signal disabled, Dave votes): coalition's
  //     2 rejects converge contested 'rejected' before honest pool
  //     can vote. ASR=100% across all H — pool size alone is not a
  //     defense at coalition-first ordering. The K+1-honest dynamic
  //     PRD §Reviewer assignment names is order-dependent and does
  //     not apply when the coalition reaches votes_to_reject before
  //     the honest pool reaches votes_to_accept.
  //   strat=on (cluster signal closes Dave at request_assignment):
  //     Carol's lone reject + H honest accepts. The closure quality
  //     depends on H:
  //       H=1: 1 accept (Erin) + 1 reject (Carol) → staged. Honest
  //         pool below votes_to_accept; the proposal stalls (the
  //         divergence-closure sweep eventually archives it). ASR=0%
  //         (no capture) but stall_rate=100% (no full closure).
  //       H=2: 2 accepts (Erin+Frank) + 1 reject (Carol) →
  //         converges 'accepted' at votes_to_accept=2. ASR=0%,
  //         stall_rate=0% — full closure.
  //       H=3: same as H=2 with George's request finding no work
  //         (contested already converged). The H=3 cell is the
  //         saturation pin: closure stabilizes at H ≥ votes_to_
  //         accept and doesn't improve further; a future change that
  //         broke saturation (e.g. raised votes_to_accept implicitly)
  //         would surface here before downstream ASR drift.
  //
  // Six cells over (H ∈ {1, 2, 3}) × (stratification ∈ {off, on})
  // drive `it.each`. The aggregate groups by stratification (the
  // defense knob) and reads both metrics per group across the pool-
  // size axis: strat=off at (ASR=100%, stall=0%) — the regression
  // handle on coalition-first capture; strat=on at (ASR=0%, stall=
  // 33%) — cluster signal never captures, only the small-pool case
  // (H=1, 1/3 cells) stalls. The complementary aggregate by H reads
  // (ASR=50%, stall=*) — strat=off captures, strat=on stalls or
  // closes depending on H.
  //
  // The headline is *graceful degradation*: PRD §Reviewer assignment
  // commits "slower to close but not capturable by the pool-fits-
  // the-coalition dynamic"; cube #11 reads this property directly.
  // strat=on at H=1 lands the slower-but-not-capturable outcome
  // (staged → archived after divergence-closure window); strat=on
  // at H ≥ 2 lands the full closure (accepted). The pool-size axis
  // does not buy *capture-resistance* (that's the cluster signal's
  // job at any H); it buys *closure-quality* — the difference
  // between "the proposal stalls in the staged state" and "the
  // proposal converges accepted." The two-metric template cube #5
  // introduced (a defense that closes by stalling honest review is
  // partial; full closure requires the honest pool to drive
  // convergence) reads here on the pool-size axis directly: at
  // small pools the cluster signal closes the *capture* but the
  // honest pool can't drive the *convergence*.
  //
  // The cube uses the same priming-then-contested-then-honest
  // pattern as the existing 1749 standalone scenario byte-identical
  // for the H=1, strat=on cell; cells beyond that extend the
  // pattern with additional honest reviewers (Frank at H ≥ 2,
  // George at H = 3) and a stratification_enabled=false twin for
  // each H. The standalone scenario stays as-is for its additional
  // observations (vote-roster, no node materialization); the cube
  // measures the per-cell contested status and stall outcomes.
  async function runStratifiedPoolSizeScenario(params: {
    honest_pool_size: number;
    stratification_enabled: boolean;
  }): Promise<{
    attack_succeeded: boolean;
    stalled: boolean;
    contested_status: string;
    dave_voted: boolean;
  }> {
    if (params.honest_pool_size < 1 || params.honest_pool_size > 3) {
      throw new Error(
        `runStratifiedPoolSizeScenario: H=${params.honest_pool_size} out of range [1,3]`,
      );
    }
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('sps'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        // Calibration channels off — the cube isolates the
        // stratification × pool-size composition. Calibration density
        // (cube #10) and calibration-aware convergence (cubes #5/#10)
        // are separate axes pinned by their own cubes.
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: params.stratification_enabled,
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

    // Reviewer identities. Coalition (Carol+Dave) plus the honest
    // pool sized by H (Erin always, Frank at H ≥ 2, George at H = 3).
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const honestIdentities: Array<{ id: typeof erin.id; name: string }> = [
      { id: erin.id, name: 'erin' },
    ];
    if (params.honest_pool_size >= 2) {
      const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
      honestIdentities.push({ id: frank.id, name: 'frank' });
    }
    if (params.honest_pool_size >= 3) {
      const george = server.bootstrap.mintIdentity({ display_name: 'george' });
      honestIdentities.push({ id: george.id, name: 'george' });
    }
    for (const id of [carol.id, dave.id, ...honestIdentities.map((h) => h.id)]) {
      await server.tools.setCapacity(
        { identity_id: id },
        { cause_id: cause.id, rate: 5, kinds: ['review'] },
      );
    }

    // PRIMING: three bias-aligned excerpts. Carol and Dave both vote
    // accept on each via direct cast_review_vote — bypassing the
    // assignment loop so priming doesn't itself trigger cross-stratum
    // routing decisions. The first auto-converges on Carol+Dave's
    // unanimous accept; the second and third stay staged after the
    // cluster forms (stratification-degraded tightens convergence
    // past their two accepts) and are curator-accepted to clear the
    // frontier.
    for (let i = 0; i < 3; i++) {
      const primer = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      const after = server.store.proposals.get(primer.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(primer.proposal_id);
      }
    }

    // CONTESTED: the bias-misaligned excerpt under paper 2 — the
    // proposal the coalition wants to suppress.
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
    const contestedId = contested.proposal_id;

    // ADVERSARY PHASE. Carol requests assignment first, gets routed
    // (no co-stratum reviewer yet routed for contested), votes reject.
    const carolAssignment = await server.tools.requestAssignment(
      { identity_id: carol.id },
      { cause_id: cause.id },
    );
    if (carolAssignment.task.kind !== 'review') {
      throw new Error('expected carol to be routed to a review task');
    }
    if (carolAssignment.task.proposal_id !== contestedId) {
      throw new Error(
        `expected carol routed to contested ${contestedId}, got ${carolAssignment.task.proposal_id}`,
      );
    }
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      {
        proposal_id: contestedId,
        decision: 'reject',
        rationale: 'underpowered, methodological concerns',
        assignment_id: carolAssignment.assignment_id,
      },
    );

    // Dave requests assignment. With stratification on, the cross-
    // stratum gate fires (Carol-already-routed + Carol-Dave co-
    // stratum from priming) and refuses with `not_found`. With
    // stratification off, Dave is routed to contested and votes
    // reject — the second reject converges contested 'rejected'
    // before the honest pool can vote.
    let daveVoted = false;
    try {
      const daveAssignment = await server.tools.requestAssignment(
        { identity_id: dave.id },
        { cause_id: cause.id },
      );
      if (
        daveAssignment.task.kind === 'review' &&
        daveAssignment.task.proposal_id === contestedId
      ) {
        await server.tools.castReviewVote(
          { identity_id: dave.id },
          {
            proposal_id: contestedId,
            decision: 'reject',
            rationale: 'underpowered, methodological concerns',
            assignment_id: daveAssignment.assignment_id,
          },
        );
        daveVoted = true;
      }
    } catch (err) {
      if (err instanceof ServerError && err.code === 'not_found') {
        // Dave gated by the cross-stratum draw rule. Expected at
        // strat=on.
      } else {
        throw err;
      }
    }

    // HONEST PHASE. Honest reviewers run sequentially and vote
    // accept. Each contributes one accept toward votes_to_accept=2.
    // If contested already converged 'rejected' (strat=off), the
    // loop short-circuits per request_assignment / cast_review_vote
    // refusing on a non-staged proposal. The honest pool's role here
    // is to drive convergence to 'accepted' when the cluster signal
    // has closed Dave; without enough honest reviewers, the proposal
    // stalls at 'staged'.
    for (const honest of honestIdentities) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      try {
        const honestAssignment = await server.tools.requestAssignment(
          { identity_id: honest.id },
          { cause_id: cause.id },
        );
        if (
          honestAssignment.task.kind !== 'review' ||
          honestAssignment.task.proposal_id !== contestedId
        ) {
          continue;
        }
        await server.tools.castReviewVote(
          { identity_id: honest.id },
          {
            proposal_id: contestedId,
            decision: 'accept',
            rationale: 'consistent with prevailing evidence',
            assignment_id: honestAssignment.assignment_id,
          },
        );
      } catch (err) {
        if (err instanceof ServerError && err.code === 'not_found') {
          // Honest reviewer also gated — the honest pool's stratum
          // is singleton by construction (no shared history with
          // anyone), so this should not fire. If it does, the cube's
          // assumption that honest reviewers are routable to contested
          // has been violated.
          continue;
        }
        throw err;
      }
    }

    const final = server.store.proposals.get(contestedId);
    if (!final) throw new Error('contested proposal not found');
    return {
      attack_succeeded: final.status === 'rejected',
      stalled: final.status === 'staged',
      contested_status: final.status,
      dave_voted: daveVoted,
    };
  }

  interface PoolSizeSweepCell {
    name: string;
    honest_pool_size: number;
    stratification_enabled: boolean;
    expected_attack_succeeded: boolean;
    expected_stalled: boolean;
    expected_dave_voted: boolean;
  }
  const poolSizeSweepCells: PoolSizeSweepCell[] = [
    // strat=off row: cluster signal disabled, Dave votes alongside
    // Carol, coalition reaches votes_to_reject=2 before honest pool
    // can vote. ASR=100% across all H — pool size alone is not a
    // defense at coalition-first ordering.
    {
      name: 'H=1, strat=off (coalition-first captures; pool size alone insufficient)',
      honest_pool_size: 1,
      stratification_enabled: false,
      expected_attack_succeeded: true,
      expected_stalled: false,
      expected_dave_voted: true,
    },
    {
      name: 'H=2, strat=off (coalition-first captures; honest pool comes too late)',
      honest_pool_size: 2,
      stratification_enabled: false,
      expected_attack_succeeded: true,
      expected_stalled: false,
      expected_dave_voted: true,
    },
    {
      name: 'H=3, strat=off (coalition-first captures; honest pool comes too late)',
      honest_pool_size: 3,
      stratification_enabled: false,
      expected_attack_succeeded: true,
      expected_stalled: false,
      expected_dave_voted: true,
    },
    // strat=on row: cluster signal closes Dave (cross-stratum gate);
    // closure quality depends on H. H=1 stalls (1 accept + 1 reject,
    // below either threshold); H ≥ 2 = votes_to_accept converges
    // 'accepted'.
    {
      name: 'H=1, strat=on (cluster closes Dave; honest pool below votes_to_accept, stalls staged)',
      honest_pool_size: 1,
      stratification_enabled: true,
      expected_attack_succeeded: false,
      expected_stalled: true,
      expected_dave_voted: false,
    },
    {
      name: 'H=2, strat=on (cluster closes Dave; honest pool reaches votes_to_accept, full closure)',
      honest_pool_size: 2,
      stratification_enabled: true,
      expected_attack_succeeded: false,
      expected_stalled: false,
      expected_dave_voted: false,
    },
    {
      name: 'H=3, strat=on (saturation: H ≥ votes_to_accept, full closure stable)',
      honest_pool_size: 3,
      stratification_enabled: true,
      expected_attack_succeeded: false,
      expected_stalled: false,
      expected_dave_voted: false,
    },
  ];
  it.each(poolSizeSweepCells)('pool-size × stratification sweep: $name', async ({
    honest_pool_size,
    stratification_enabled,
    expected_attack_succeeded,
    expected_stalled,
    expected_dave_voted,
  }) => {
    const result = await runStratifiedPoolSizeScenario({
      honest_pool_size,
      stratification_enabled,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.stalled).toBe(expected_stalled);
    // dave_voted invariant: at strat=off Dave votes; at strat=on
    // Dave is gated by the cross-stratum draw rule. A future change
    // that disabled or weakened the cluster signal would surface
    // here before downstream ASR drift.
    expect(result.dave_voted).toBe(expected_dave_voted);
  });

  it('pool-size × stratification sweep cube: ASR + stall-rate aggregate by stratification', () => {
    // Aggregate per the two-metric template cube #5 introduced: ASR
    // (capture rate) + stall_rate (staged-instead-of-converged
    // rate). The two-metric shape distinguishes "defense closes the
    // attack" from "defense closes by stalling honest review" — at
    // strat=on H=1 the cluster signal closes the *capture* but the
    // honest pool can't drive the *convergence*, so the stalled
    // outcome surfaces as a closure-quality measurement rather than
    // a closure-success measurement.
    interface PoolSizeAsrCell {
      stratification_enabled: boolean;
      total: number;
      attacks_succeeded: number;
      stalled: number;
    }
    const groupedByStrat = new Map<boolean, PoolSizeAsrCell>();
    for (const cell of poolSizeSweepCells) {
      const g = groupedByStrat.get(cell.stratification_enabled) ?? {
        stratification_enabled: cell.stratification_enabled,
        total: 0,
        attacks_succeeded: 0,
        stalled: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      if (cell.expected_stalled) g.stalled += 1;
      groupedByStrat.set(cell.stratification_enabled, g);
    }
    const asrByStrat = (s: boolean): number => {
      const g = groupedByStrat.get(s);
      if (!g) throw new Error(`missing strat=${s}`);
      return g.attacks_succeeded / g.total;
    };
    const stallByStrat = (s: boolean): number => {
      const g = groupedByStrat.get(s);
      if (!g) throw new Error(`missing strat=${s}`);
      return g.stalled / g.total;
    };

    // strat=off: ASR=100% across all 3 pool-size cells, stall_rate=
    // 0%. The regression handle on coalition-first capture: pool
    // size alone is not a defense at fixed ordering, even at H=3
    // where the K+1-honest pool would in principle outvote the
    // coalition under interleaved ordering. The K+1-honest dynamic
    // PRD §Reviewer assignment names is order-dependent and does
    // not apply to the coalition-first attack pattern this cube
    // measures.
    expect(asrByStrat(false)).toBe(1);
    expect(stallByStrat(false)).toBe(0);
    // strat=on: ASR=0% across all 3 pool-size cells, stall_rate=33%
    // (H=1 stalls; H ≥ 2 closes). The cluster signal never captures
    // — the closure is *capture-resistant* at any pool size, which
    // is the load-bearing PRD §Reviewer assignment commitment "not
    // capturable by the pool-fits-the-coalition dynamic." The
    // stall_rate reads the *closure-quality* axis: at H=1 the
    // proposal stalls (slower-to-close, the divergence-closure sweep
    // archives it as `unresolved-archived`); at H ≥ 2 the honest
    // pool reaches votes_to_accept and the proposal converges.
    expect(asrByStrat(true)).toBe(0);
    expect(stallByStrat(true)).toBeCloseTo(1 / 3);

    // Aggregate by H reads the pool-size axis directly: each H value
    // averages over (strat=off captures, strat=on stalls or closes).
    interface PoolSizeAsrByHCell {
      honest_pool_size: number;
      total: number;
      attacks_succeeded: number;
      stalled: number;
    }
    const groupedByH = new Map<number, PoolSizeAsrByHCell>();
    for (const cell of poolSizeSweepCells) {
      const g = groupedByH.get(cell.honest_pool_size) ?? {
        honest_pool_size: cell.honest_pool_size,
        total: 0,
        attacks_succeeded: 0,
        stalled: 0,
      };
      g.total += 1;
      if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
      if (cell.expected_stalled) g.stalled += 1;
      groupedByH.set(cell.honest_pool_size, g);
    }
    const asrByH = (h: number): number => {
      const g = groupedByH.get(h);
      if (!g) throw new Error(`missing H=${h}`);
      return g.attacks_succeeded / g.total;
    };
    const stallByH = (h: number): number => {
      const g = groupedByH.get(h);
      if (!g) throw new Error(`missing H=${h}`);
      return g.stalled / g.total;
    };

    // H=1: ASR=50% (strat=off captures), stall_rate=50% (strat=on
    // stalls). The small-pool cell where the closure quality is
    // *partial*.
    expect(asrByH(1)).toBe(0.5);
    expect(stallByH(1)).toBe(0.5);
    // H=2: ASR=50%, stall_rate=0%. The threshold H = votes_to_
    // accept where strat=on closes fully ('accepted'); strat=off
    // still captures.
    expect(asrByH(2)).toBe(0.5);
    expect(stallByH(2)).toBe(0);
    // H=3: same as H=2 — saturation pin. A future change that
    // raised votes_to_accept implicitly (or otherwise broke the
    // saturation property) would land here before downstream ASR
    // drift.
    expect(asrByH(3)).toBe(0.5);
    expect(stallByH(3)).toBe(0);

    // Coverage invariants: every strat cell has 3 H cells, every H
    // cell has 2 strat cells. Same shape cubes #6-#10 carry; a
    // future cell expansion that breaks the symmetry trips the
    // assertion and forces the aggregate to be re-keyed rather than
    // silently averaging over uneven groups.
    for (const cell of groupedByStrat.values()) {
      expect(cell.total).toBe(3);
    }
    for (const cell of groupedByH.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Twelfth parameter sweep cube: the vote-aggregation thresholds
  // cube on the K=2 coalition at coalition-first ordering. PRD
  // §What's deliberately not specified names "Vote-aggregation
  // thresholds (what counts as convergent vs divergent)" as a knob
  // explicitly deferred to the testbed — `votes_to_accept` and
  // `votes_to_reject` are direct config knobs that all prior cubes
  // held at the (2, 2) default. Cube #12 is the first cube to read
  // the threshold axes directly and measure how threshold tightening
  // composes with pool size under the two-metric template.
  //
  // Attack pattern: K=2 coalition (Carol+Dave with naiveBiasedDecider
  // applied to a single contested excerpt; stratification disabled
  // and no priming, so the cluster signal is structurally inert and
  // both coalition members vote freely on the contested target). The
  // coalition runs *first* so the threshold-arithmetic reads cleanly
  // — at votes_to_reject=2 the coalition's two rejects converge
  // 'rejected' before the honest pool can vote; at votes_to_reject=3
  // the coalition can't reach the threshold (K=2 < 3) and the
  // proposal stays staged for the honest pool to drive convergence
  // (or stall, if the honest pool can't reach votes_to_accept).
  // Calibration channels off to isolate the threshold axes.
  //
  // Defense layers in scope:
  //   - votes_to_reject ∈ {2, 3} (the coalition-capture axis):
  //     tightening from 2 to 3 makes the K=2 coalition arithmetically
  //     unable to reach the threshold, closing the capture half of
  //     the attack outright. The cost is paid on the honest side
  //     too (a tighter reject threshold means honest reviewers also
  //     need 3 distinct rejects to suppress a genuinely bad
  //     proposal), but that cost is invisible to this cube which
  //     measures suppression of well-grounded content.
  //   - votes_to_accept ∈ {2, 3} (the honest-convergence axis):
  //     tightening from 2 to 3 requires more honest reviewers to
  //     drive convergence. At fixed H, raising vta lifts stall_rate
  //     when H < vta; the proposal sits staged with neither side
  //     reaching their threshold.
  //   - honest pool size H ∈ {2, 3} (the closure-quality axis from
  //     cube #11): the number of honest reviewers running after the
  //     coalition. Each contributes one accept toward votes_to_
  //     accept; H ≥ vta is the saturation point for full closure.
  //
  // The composition reads:
  //   vto=2 row: coalition's two rejects converge contested
  //     'rejected' before honest pool votes. ASR=100% across all
  //     (vta, H) combinations (4 cells). The vto=2 axis is the
  //     "default-threshold capture" baseline — at K = vto, the
  //     coalition wins by arithmetic regardless of how the honest
  //     pool is configured downstream.
  //   vto=3 row: coalition can't reach the threshold (K=2 < 3); the
  //     honest pool drives convergence or stalls based on (vta, H).
  //     - (vta=2, H=2): 2 accepts ≥ vta. Closes 'accepted'. ASR=0%,
  //       stall=0%.
  //     - (vta=2, H=3): same — 2nd accept already converges before
  //       3rd reviewer votes. Closes 'accepted'. ASR=0%, stall=0%.
  //     - (vta=3, H=2): 2 accepts < vta=3. Stalls 'staged'. ASR=0%,
  //       stall=100%. The closure-quality failure mode at the
  //       tighter accept threshold without proportional pool growth.
  //     - (vta=3, H=3): 3 accepts = vta. Closes 'accepted'. ASR=0%,
  //       stall=0%. The K+1-honest-reviewer dynamic PRD §Reviewer
  //       assignment names — at H = vta = K+1, the honest pool
  //       reaches the threshold the coalition cannot.
  //
  // Eight cells over (vto ∈ {2, 3}) × (vta ∈ {2, 3}) × (H ∈ {2, 3})
  // drive `it.each`. The aggregate groups by vto (the coalition-
  // capture knob) and reads (ASR + stall_rate) per group across
  // (vta, H): vto=2 at (ASR=100%, stall=0%) — the regression handle
  // on coalition-first capture at K = vto; vto=3 at (ASR=0%, stall=
  // 25%) — capture is closed by arithmetic, stall fires only at
  // (vta=3, H=2) where H < vta. The complementary aggregate by vta
  // reads (ASR=50%, stall=0%) at vta=2 (vto=2 captures, vto=3
  // closes; pool size never below vta) and (ASR=50%, stall=25%) at
  // vta=3 (vto=2 still captures, vto=3 splits between closure at H=3
  // and stall at H=2). The aggregate by H reads (ASR=50%, stall=25%)
  // at H=2 (vto=2 captures, vto=3 closes at vta=2 / stalls at vta=3)
  // and (ASR=50%, stall=0%) at H=3 (vto=2 still captures, vto=3
  // closes at any vta).
  //
  // The headline is the *threshold-axis decomposition*:
  //   - vto controls capture rate (tightening vto from K to K+1
  //     closes the coalition by arithmetic; this is capture-
  //     resistance bought purely by threshold).
  //   - vta + H jointly control stall rate (tightening vta without
  //     proportional pool growth lifts stalls; H = vta is the
  //     saturation point for full closure).
  //   - The (vta=3, H=2) stall is the *cost* of the closure-quality
  //     axis — the operator who tightens vta without growing the
  //     honest pool buys closure-quality failures, the same shape
  //     cube #5 read on the alpha-recalibrated demo gate.
  //
  // The two-metric template generalizes here to the *threshold-pool
  // interaction*: a defense knob that closes the attack by raising
  // the convergence bar pays its closure-quality cost on the honest
  // side at the same threshold, and the pool-size axis is what
  // amortizes that cost. PRD §Reviewer assignment commits "the
  // small-sub-topic case slower to close but not capturable by the
  // pool-fits-the-coalition dynamic"; cube #11 read this on the
  // stratification axis (cluster signal closes capture, pool size
  // buys closure quality), cube #12 reads the analog on the
  // threshold axis (vto closes capture, vta + H interaction buys
  // closure quality). The two cubes cover complementary defenses
  // against the same K=2 coalition at coalition-first ordering, and
  // the (ASR, stall) numerical readings are structurally similar —
  // the architecture generalizes across closure mechanisms.
  async function runVoteThresholdScenario(params: {
    votes_to_accept: number;
    votes_to_reject: number;
    honest_pool_size: number;
  }): Promise<{
    attack_succeeded: boolean;
    stalled: boolean;
    contested_status: string;
  }> {
    if (params.honest_pool_size < 2 || params.honest_pool_size > 3) {
      throw new Error(`runVoteThresholdScenario: H=${params.honest_pool_size} out of range [2,3]`);
    }
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('vt'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: params.votes_to_accept,
        votes_to_reject: params.votes_to_reject,
        // Calibration channels off — the cube isolates the
        // threshold × pool-size composition.
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        // Stratification disabled — the cube isolates threshold
        // arithmetic from cluster-signal closure (cube #11 reads
        // the stratification axis on a complementary attack
        // pattern).
        stratification_enabled: false,
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

    // Reviewers. K=2 coalition (Carol+Dave) plus H honest reviewers
    // (Erin always, Frank at H ≥ 2, George at H = 3).
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const honestIdentities: Array<{ id: typeof erin.id; name: string }> = [
      { id: erin.id, name: 'erin' },
    ];
    const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
    honestIdentities.push({ id: frank.id, name: 'frank' });
    if (params.honest_pool_size >= 3) {
      const george = server.bootstrap.mintIdentity({ display_name: 'george' });
      honestIdentities.push({ id: george.id, name: 'george' });
    }
    for (const id of [carol.id, dave.id, ...honestIdentities.map((h) => h.id)]) {
      await server.tools.setCapacity(
        { identity_id: id },
        { cause_id: cause.id, rate: 5, kinds: ['review'] },
      );
    }

    // CONTESTED: bias-misaligned excerpt. The coalition's
    // naive bias predicate ("accept payloads containing 'works'")
    // rejects "no effect" content; honest acceptAllDecider accepts.
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
    const contestedId = contested.proposal_id;

    // ADVERSARY PHASE. Coalition runs first, both members vote
    // reject via the assignment loop. Stratification is off so no
    // gate fires; both rejects land. At votes_to_reject=2 the second
    // reject converges contested 'rejected' before the honest pool
    // votes; at votes_to_reject=3 the proposal stays staged.
    for (const adv of [carol, dave]) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      const assignment = await server.tools.requestAssignment(
        { identity_id: adv.id },
        { cause_id: cause.id },
      );
      if (assignment.task.kind !== 'review') {
        throw new Error('expected adversary routed to review task');
      }
      if (assignment.task.proposal_id !== contestedId) {
        throw new Error(
          `expected adversary routed to contested ${contestedId}, got ${assignment.task.proposal_id}`,
        );
      }
      await server.tools.castReviewVote(
        { identity_id: adv.id },
        {
          proposal_id: contestedId,
          decision: 'reject',
          rationale: 'underpowered, methodological concerns',
          assignment_id: assignment.assignment_id,
        },
      );
    }

    // HONEST PHASE. Honest reviewers run sequentially and vote
    // accept. Each contributes one accept toward votes_to_accept.
    // Loop short-circuits if contested already converged.
    for (const honest of honestIdentities) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      try {
        const assignment = await server.tools.requestAssignment(
          { identity_id: honest.id },
          { cause_id: cause.id },
        );
        if (assignment.task.kind !== 'review' || assignment.task.proposal_id !== contestedId) {
          continue;
        }
        await server.tools.castReviewVote(
          { identity_id: honest.id },
          {
            proposal_id: contestedId,
            decision: 'accept',
            rationale: 'consistent with prevailing evidence',
            assignment_id: assignment.assignment_id,
          },
        );
      } catch (err) {
        if (err instanceof ServerError && err.code === 'not_found') {
          continue;
        }
        throw err;
      }
    }

    const final = server.store.proposals.get(contestedId);
    if (!final) throw new Error('contested proposal not found');
    return {
      attack_succeeded: final.status === 'rejected',
      stalled: final.status === 'staged',
      contested_status: final.status,
    };
  }

  interface VoteThresholdSweepCell {
    name: string;
    votes_to_accept: number;
    votes_to_reject: number;
    honest_pool_size: number;
    expected_attack_succeeded: boolean;
    expected_stalled: boolean;
  }
  const voteThresholdSweepCells: VoteThresholdSweepCell[] = [
    // vto=2 row: K = vto, coalition reaches the threshold by
    // arithmetic before honest pool votes. ASR=100% across all (vta,
    // H). Pool size and accept threshold are irrelevant to capture
    // when the coalition converges first.
    {
      name: 'vto=2, vta=2, H=2 (K=vto, coalition-first captures; baseline default-threshold capture)',
      votes_to_accept: 2,
      votes_to_reject: 2,
      honest_pool_size: 2,
      expected_attack_succeeded: true,
      expected_stalled: false,
    },
    {
      name: 'vto=2, vta=2, H=3 (K=vto, coalition-first captures; H buys nothing at coalition-first ordering)',
      votes_to_accept: 2,
      votes_to_reject: 2,
      honest_pool_size: 3,
      expected_attack_succeeded: true,
      expected_stalled: false,
    },
    {
      name: 'vto=2, vta=3, H=2 (K=vto, coalition-first captures; vta=3 irrelevant when capture happens first)',
      votes_to_accept: 3,
      votes_to_reject: 2,
      honest_pool_size: 2,
      expected_attack_succeeded: true,
      expected_stalled: false,
    },
    {
      name: 'vto=2, vta=3, H=3 (K=vto, coalition-first captures; vta=3 irrelevant)',
      votes_to_accept: 3,
      votes_to_reject: 2,
      honest_pool_size: 3,
      expected_attack_succeeded: true,
      expected_stalled: false,
    },
    // vto=3 row: K=2 < vto=3, coalition cannot reach the threshold
    // by arithmetic. Closure quality depends on (vta, H).
    {
      name: 'vto=3, vta=2, H=2 (K<vto: capture closed; H=vta=2 reaches accept threshold, full closure)',
      votes_to_accept: 2,
      votes_to_reject: 3,
      honest_pool_size: 2,
      expected_attack_succeeded: false,
      expected_stalled: false,
    },
    {
      name: 'vto=3, vta=2, H=3 (K<vto: capture closed; H>vta, full closure with margin)',
      votes_to_accept: 2,
      votes_to_reject: 3,
      honest_pool_size: 3,
      expected_attack_succeeded: false,
      expected_stalled: false,
    },
    {
      name: 'vto=3, vta=3, H=2 (K<vto: capture closed; H<vta, stalls — closure-quality failure)',
      votes_to_accept: 3,
      votes_to_reject: 3,
      honest_pool_size: 2,
      expected_attack_succeeded: false,
      expected_stalled: true,
    },
    {
      name: 'vto=3, vta=3, H=3 (K+1-honest-reviewer dynamic: H=vta=K+1, full closure)',
      votes_to_accept: 3,
      votes_to_reject: 3,
      honest_pool_size: 3,
      expected_attack_succeeded: false,
      expected_stalled: false,
    },
  ];
  it.each(voteThresholdSweepCells)('vote-threshold sweep: $name', async ({
    votes_to_accept,
    votes_to_reject,
    honest_pool_size,
    expected_attack_succeeded,
    expected_stalled,
  }) => {
    const result = await runVoteThresholdScenario({
      votes_to_accept,
      votes_to_reject,
      honest_pool_size,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.stalled).toBe(expected_stalled);
  });

  it('vote-threshold sweep cube: ASR + stall-rate aggregate by vto, vta, and H', () => {
    // Aggregate per the two-metric template: ASR (capture rate) +
    // stall_rate (staged-instead-of-converged rate). The cube has
    // three axes (vto, vta, H) and reads how each contributes to
    // the (capture, closure-quality) tradeoff.
    interface VoteThresholdAsrCell {
      key: number;
      total: number;
      attacks_succeeded: number;
      stalled: number;
    }
    function group(
      keyOf: (cell: VoteThresholdSweepCell) => number,
    ): Map<number, VoteThresholdAsrCell> {
      const m = new Map<number, VoteThresholdAsrCell>();
      for (const cell of voteThresholdSweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { key: k, total: 0, attacks_succeeded: 0, stalled: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        if (cell.expected_stalled) g.stalled += 1;
        m.set(k, g);
      }
      return m;
    }
    const groupedByVto = group((c) => c.votes_to_reject);
    const groupedByVta = group((c) => c.votes_to_accept);
    const groupedByH = group((c) => c.honest_pool_size);
    const asrOf = (m: Map<number, VoteThresholdAsrCell>, k: number): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.attacks_succeeded / g.total;
    };
    const stallOf = (m: Map<number, VoteThresholdAsrCell>, k: number): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.stalled / g.total;
    };

    // vto axis (the coalition-capture knob). Tightening vto from K
    // to K+1 closes the capture by arithmetic — the headline
    // capture-resistance reading. The vto=3 row is structurally
    // free of capture; closure quality depends on (vta, H).
    expect(asrOf(groupedByVto, 2)).toBe(1); // K = vto: coalition wins all 4 cells.
    expect(stallOf(groupedByVto, 2)).toBe(0);
    expect(asrOf(groupedByVto, 3)).toBe(0); // K < vto: coalition can't capture any cell.
    expect(stallOf(groupedByVto, 3)).toBeCloseTo(1 / 4); // 1/4 cells stalls — (vta=3, H=2).

    // vta axis (the honest-convergence knob). At fixed vta, the
    // ASR averages over (vto, H). Tightening vta lifts stall_rate
    // because the honest pool needs more accepts.
    expect(asrOf(groupedByVta, 2)).toBe(0.5); // 2/4 (vto=2 cells capture).
    expect(stallOf(groupedByVta, 2)).toBe(0); // vta=2 always reachable at H ≥ 2.
    expect(asrOf(groupedByVta, 3)).toBe(0.5);
    expect(stallOf(groupedByVta, 3)).toBeCloseTo(1 / 4); // 1/4 cells stalls — (vto=3, H=2).

    // H axis (the closure-quality axis from cube #11). At fixed H,
    // ASR averages over (vto, vta). H=3 eliminates stalls because
    // 3 honest reviewers can always reach vta ≤ 3.
    expect(asrOf(groupedByH, 2)).toBe(0.5); // 2/4 (vto=2 cells capture).
    expect(stallOf(groupedByH, 2)).toBeCloseTo(1 / 4); // 1/4 stalls — (vto=3, vta=3).
    expect(asrOf(groupedByH, 3)).toBe(0.5);
    expect(stallOf(groupedByH, 3)).toBe(0); // H=3 saturates at vta=3.

    // Coverage invariants: every axis-key has 4 cells. A future
    // cell expansion that breaks the symmetry trips the assertion
    // and forces the aggregate to be re-keyed.
    for (const m of [groupedByVto, groupedByVta, groupedByH]) {
      for (const cell of m.values()) {
        expect(cell.total).toBe(4);
      }
    }
  });

  // Thirteenth parameter sweep cube: the deeper calibration-density
  // sweep on a 4-excerpt runner — direct extension of cube #10
  // validating its load-bearing framing that "the density floor is
  // a function of (excerpt count × reviewer count × every_n) at
  // fixed runner shape, not a property of every_n alone." Cube #10
  // measured the floor between every_n=4 (silent) and every_n=2
  // (closed) on a 2-excerpt runner; cube #13 doubles the excerpt
  // count and predicts the floor halves to between every_n=8
  // (silent) and every_n=4 (closed).
  //
  // Attack pattern: same strategic-coalition shape as cube #10
  // (Carol+Dave with naiveBiasedDecider, Erin with acceptAllDecider)
  // but the runner stages 4 excerpts (vs cube #10's 2). All four
  // excerpts are bias-misaligned ("no effect" findings, one per
  // anchor); the coalition's naive bias predicate rejects all four
  // alongside every anchor calibration item. Keeping the corpus
  // anchor-only is load-bearing: if any excerpts were bias-aligned
  // ("works" content), they would converge accepted during Carol's
  // loop and enter the calibration corpus, and Dave's subsequent
  // calibration draws on those works-excerpts would *pass* the
  // coalition's bias-aligned vote (vote accept matches accepted-
  // from-history ground truth), restoring Dave's weight and
  // breaking the closure. The all-no-effect runner avoids that
  // corpus-contamination dynamic by construction so the density-
  // floor scaling law reads cleanly here; the avoided dynamic itself
  // is wired downstream as `runCorpusContaminationScenario`, where
  // 2 of 4 excerpts are bias-aligned and Dave's reject on the second
  // bias-misaligned target lands at contaminated weight=2 to
  // converge rejected. The structural closure on that bypass is now
  // wired as `corpus_confirmation_depth_floor` (PRD §Calibration
  // batches) and CI-checked at cube #16 — the contamination runner
  // extended with the floor knob, six cells over (floor ∈ {0, 2, 3})
  // × (contaminate ∈ {off, on}), the closure crossing exactly at
  // floor > votes_to_accept. ASR reads true iff any excerpt converges 'rejected';
  // no_effect_rejected_count reads 0/4 (full closure), 4/4 (full
  // capture), or any partial in between.
  //
  // The runner stages excerpts via direct `proposeExcerpt` rather
  // than `runHonestStrong` (the cube #10 path) — runHonestStrong
  // proposes one excerpt per anchor offer, which works at 2 anchors
  // but the wider runner needs the proposer-control to map each
  // anchor to a specific bias-aligned-or-misaligned content
  // deterministically. Using direct proposeExcerpt keeps the
  // anchor-to-content mapping in plain sight; alice (the anchor
  // proposer) doubles as the excerpt proposer here, so excerpts
  // and anchors share a proposer — calibration draws skip the
  // proposer's own proposals (no self-review), which doesn't
  // matter for this cube because calibration draws come from the
  // accepted-from-history pool (the four anchors), and reviewers
  // are not alice.
  //
  // The composition reads:
  //   aware=false: calibration injection moves the rep ledger but
  //     leaves convergence uncalibrated. Bias suppression converges
  //     'rejected' regardless of density. ASR=100% across all
  //     every_n cells (4 cells).
  //   aware=true at every_n=0: gate on but no calibration data;
  //     weights collapse to 1; identical to count-only mode.
  //     ASR=100%.
  //   aware=true at every_n=8: each reviewer exhausts the 4-excerpt
  //     frontier within 4-5 review-task offers; the 8th calibration
  //     offer never fires. Calibration record stays empty for every
  //     reviewer; aware gate silent. ASR=100%. The density-floor
  //     reading at the wider runner — at every_n=8, density is
  //     below the floor in the same way cube #10's every_n=4 was
  //     below the floor in the 2-excerpt runner.
  //   aware=true at every_n=4: each reviewer's 4th call is
  //     calibration. Carol fires calibration on call 4 (after
  //     voting accept on excerpts 1, 1b and reject on 2a — order
  //     depends on frontier sequencing); naive bias misfires on
  //     anchor content → calibration record (0, 1) → weight 0
  //     thereafter. Subsequent reject votes carry weight 0 and
  //     fail the weighted-reject threshold despite meeting the
  //     count threshold. ASR=0%. The density-floor crossing at
  //     the wider runner — at every_n=4, calibration items reach
  //     reviewers within the convergence window in the same way
  //     cube #10's every_n=2 did in the 2-excerpt runner.
  //   aware=true at every_n=2: each reviewer hits multiple
  //     calibration items; the closure path is similar but more
  //     pronounced (Carol's weight drops on call 2; Dave's weight
  //     drops on call 2). ASR=0%.
  //
  // Eight cells over (every_n ∈ {0, 8, 4, 2}) × (aware ∈ {false,
  // true}) drive `it.each`. The aggregate groups by aware (the
  // convergence-path defense knob) and reads ASR per group across
  // the density axis: aware=false at 100% across all 4 density
  // cells (calibration alone never closes convergence — same
  // regression handle as cube #10's aware=false row, validated at
  // higher resolution); aware=true at 50% (the gate fires at
  // every_n ∈ {2, 4}; at every_n ∈ {0, 8} the calibration record
  // stays empty and the gate is silent).
  //
  // The complementary aggregate by density reads every_n ∈ {0, 8}
  // at 100% and every_n ∈ {2, 4} at 50% — the density floor
  // crosses between every_n=8 and every_n=4. Cube #10 placed the
  // floor between every_n=4 and every_n=2 in the 2-excerpt runner;
  // cube #13 places it between every_n=8 and every_n=4 in the
  // 4-excerpt runner. The floor *halved* in every_n value when
  // the excerpt count doubled — exactly the (excerpt_count ×
  // every_n) ≈ const relationship cube #10's framing predicted.
  // The headline is the density-floor scaling law: at fixed
  // reviewer count, the floor every_n* satisfies every_n* ≈
  // excerpt_count + 1 (each reviewer needs at least one calibration
  // item to reach them before exhausting the frontier; with N
  // excerpts, that requires every_n ≤ N+1 since the calibration
  // condition fires at priorOffers % every_n == 0 on the
  // (every_n)th offer).
  //
  // Cube #13 is the *resolution refinement* of cube #10 — same
  // attack pattern, same defense knobs, wider runner. The two
  // cubes together pin the density-floor scaling law as a CI-
  // checked invariant: cube #10 reads the floor in the 2-excerpt
  // regime, cube #13 reads it in the 4-excerpt regime, and the
  // ratio (every_n* / excerpt_count) ≈ 1 holds across both. The
  // architecture commitment "calibration density must be high
  // enough relative to the convergence window for the calibration-
  // aware closure to fire" is operationally framed as: every_n
  // must be ≤ excerpt_count for at least one calibration item to
  // reach each reviewer.
  async function runWideStrategicCoalitionScenario(params: {
    calibration_inject_every_n: number;
    calibration_aware_convergence: boolean;
  }): Promise<{
    attack_succeeded: boolean;
    no_effect_rejected_count: number;
  }> {
    // All four anchors are "no effect" findings; all four staged
    // excerpts are bias-misaligned (the coalition's naive bias —
    // "accept content containing 'works'" — rejects every excerpt
    // and every calibration item, since neither anchor content
    // ("paper N") nor excerpt content contains "works"). This is
    // load-bearing for the runner: if any excerpts were "works"
    // content, they would converge accepted during Carol's loop and
    // enter the calibration corpus, and Dave's subsequent
    // calibration draws on those works-excerpts would *pass* (bias
    // matches "works" → vote accept → matches accepted-from-history
    // ground truth), restoring Dave's weight and breaking the
    // closure. Keeping all excerpts bias-misaligned ensures the
    // calibration corpus stays anchor-only throughout the run, so
    // the coalition consistently fails calibration as cube #10's
    // 2-excerpt runner intended.
    const sources = new Map<string, string>([
      ['1', 'study A: treatment X has no effect in stage I patients across the cohort'],
      ['2', 'study B: treatment X has no effect in stage II patients across the cohort'],
      ['3', 'study C: treatment X has no effect in stage III patients across the cohort'],
      ['4', 'study D: treatment X has no effect in stage IV patients across the cohort'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('cd4'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        calibration_inject_every_n: params.calibration_inject_every_n,
        calibration_aware_convergence: params.calibration_aware_convergence,
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

    // Four anchors as the calibration corpus. Naive bias predicate
    // ("accept payloads containing 'works'") rejects all four
    // ("paper N" content doesn't include "works"), so every
    // coalition-member calibration draw is a fail; Erin's accept-
    // all passes them all.
    const anchorNodeIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const a = await server.tools.proposeAnchor(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `paper ${i}`,
        external_ref: { kind: 'pmid', value: String(i) },
      });
      server.curator.acceptProposal(a.proposal_id);
      const anchorNode = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
      );
      if (!anchorNode) throw new Error(`paper ${i} anchor not materialized`);
      anchorNodeIds.push(anchorNode.id);
    }

    // Four excerpts staged via direct proposeExcerpt (alice as
    // proposer): anchors 1, 3 → "works" content (bias-aligned);
    // anchors 2, 4 → "no effect" content (bias-misaligned). The
    // bias-aligned excerpts converge accepted at coalition+honest
    // accept; the bias-misaligned excerpts are the suppression
    // target.
    // Four bias-misaligned excerpts, one per anchor. All "no
    // effect" findings (matching their anchor's source text); the
    // coalition's bias predicate rejects all four. The honest
    // reviewer (Erin, acceptAllDecider) accepts all four; without
    // the calibration-aware closure, the coalition's two rejects
    // converge each excerpt 'rejected' (the attack succeeds at
    // votes_to_reject=2). With the closure firing, the coalition's
    // weighted reject sum drops below threshold and excerpts stay
    // staged.
    const stageNames = ['I', 'II', 'III', 'IV'] as const;
    const excerptIds: ProposalId[] = [];
    for (let i = 0; i < 4; i++) {
      const stage = stageNames[i]!;
      const result = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorNodeIds[i]! as never,
        content: `treatment X has no effect for stage ${stage}`,
        quoted_span: {
          text: `treatment X has no effect in stage ${stage} patients`,
          offset: 0,
        },
      });
      excerptIds.push(result.proposal_id);
    }

    // Erin (honest, accept-all) runs first via the assignment loop.
    // She accepts all 4 excerpts and any calibration items the
    // server injects; her accept-all passes calibration on every
    // accepted-from-history item.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 10,
      decide: acceptAllDecider,
    });

    // Coalition: Carol+Dave with naive bias predicate. Both run
    // sequentially via the assignment loop; their reject votes on
    // bias-misaligned excerpts drive convergence at votes_to_
    // reject=2 unless calibration-aware convergence has dropped
    // their weights below the weighted-sum threshold.
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 10,
      decide: naiveBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 10,
      decide: naiveBiasedDecider,
    });

    let rejectedCount = 0;
    for (const id of excerptIds) {
      const p = server.store.proposals.get(id);
      if (p?.status === 'rejected') rejectedCount += 1;
    }
    return {
      attack_succeeded: rejectedCount > 0,
      no_effect_rejected_count: rejectedCount,
    };
  }

  interface WideCalibrationDensitySweepCell {
    name: string;
    calibration_inject_every_n: number;
    calibration_aware_convergence: boolean;
    expected_attack_succeeded: boolean;
    expected_no_effect_rejected_count: number;
  }
  const wideCalibrationDensitySweepCells: WideCalibrationDensitySweepCell[] = [
    // every_n=0 row: calibration disabled. Both aware values land
    // at the baseline ASR=100% — without calibration data, the
    // aware gate has nothing to weight votes by and behaves like
    // count-only mode.
    {
      name: 'wide every_n=0, aware=false (baseline; no calibration, count-only convergence; both no-effect rejected)',
      calibration_inject_every_n: 0,
      calibration_aware_convergence: false,
      expected_attack_succeeded: true,
      expected_no_effect_rejected_count: 4,
    },
    {
      name: 'wide every_n=0, aware=true (gate inert without calibration data; weights collapse to 1; both rejected)',
      calibration_inject_every_n: 0,
      calibration_aware_convergence: true,
      expected_attack_succeeded: true,
      expected_no_effect_rejected_count: 4,
    },
    // every_n=8 row: density floor at the wider runner. The
    // 4-excerpt frontier exhausts within 4-5 review-task offers
    // per reviewer; at every_n=8 the 8th calibration offer never
    // fires. Calibration record stays empty; aware gate silent.
    // ASR=100% across both aware values.
    {
      name: 'wide every_n=8, aware=false (below density floor in 4-excerpt runner; no calibration items reach reviewers)',
      calibration_inject_every_n: 8,
      calibration_aware_convergence: false,
      expected_attack_succeeded: true,
      expected_no_effect_rejected_count: 4,
    },
    {
      name: 'wide every_n=8, aware=true (below density floor; aware gate silent — empty calibration record)',
      calibration_inject_every_n: 8,
      calibration_aware_convergence: true,
      expected_attack_succeeded: true,
      expected_no_effect_rejected_count: 4,
    },
    // every_n=4 row: density-floor crossing at the wider runner.
    // Each reviewer's 4th call is calibration; Carol's calibration
    // fires before her vote on the second bias-misaligned excerpt,
    // dropping her weight to 0. Subsequent reject votes carry
    // weight 0 and fail the weighted-reject threshold.
    {
      name: 'wide every_n=4, aware=false (calibration moves rep ledger; convergence uncalibrated, both rejected)',
      calibration_inject_every_n: 4,
      calibration_aware_convergence: false,
      expected_attack_succeeded: true,
      expected_no_effect_rejected_count: 4,
    },
    {
      name: 'wide every_n=4, aware=true (above density floor; calibration drops coalition weights, both no-effect stay staged)',
      calibration_inject_every_n: 4,
      calibration_aware_convergence: true,
      expected_attack_succeeded: false,
      expected_no_effect_rejected_count: 0,
    },
    // every_n=2 row: well above the density floor. Each reviewer
    // sees ≥2 calibration items; coalition weights drop fast.
    {
      name: 'wide every_n=2, aware=false (calibration moves rep ledger; convergence uncalibrated, both rejected)',
      calibration_inject_every_n: 2,
      calibration_aware_convergence: false,
      expected_attack_succeeded: true,
      expected_no_effect_rejected_count: 4,
    },
    {
      name: 'wide every_n=2, aware=true (well above floor; coalition weights drop to 0; both no-effect stay staged)',
      calibration_inject_every_n: 2,
      calibration_aware_convergence: true,
      expected_attack_succeeded: false,
      expected_no_effect_rejected_count: 0,
    },
  ];
  it.each(
    wideCalibrationDensitySweepCells,
  )('wide calibration density × aware sweep: $name', async ({
    calibration_inject_every_n,
    calibration_aware_convergence,
    expected_attack_succeeded,
    expected_no_effect_rejected_count,
  }) => {
    const result = await runWideStrategicCoalitionScenario({
      calibration_inject_every_n,
      calibration_aware_convergence,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.no_effect_rejected_count).toBe(expected_no_effect_rejected_count);
  });

  it('wide calibration density × aware sweep cube: ASR aggregates by aware and density, validating the density-floor scaling law', () => {
    // Aggregate per the cube template: group cells by aware and by
    // density and read ASR per group. The headline is the *density-
    // floor scaling law*: cube #10 placed the floor between
    // every_n=4 and every_n=2 in the 2-excerpt runner; cube #13
    // places it between every_n=8 and every_n=4 in the 4-excerpt
    // runner. The floor halved when the excerpt count doubled —
    // every_n* ≈ excerpt_count, validated at two resolutions.
    interface WideAsrCell {
      key: number | string;
      total: number;
      attacks_succeeded: number;
    }
    function group<K extends number | string>(
      keyOf: (cell: WideCalibrationDensitySweepCell) => K,
    ): Map<K, WideAsrCell> {
      const m = new Map<K, WideAsrCell>();
      for (const cell of wideCalibrationDensitySweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { key: k, total: 0, attacks_succeeded: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        m.set(k, g);
      }
      return m;
    }
    const groupedByAware = group<number>((c) => (c.calibration_aware_convergence ? 1 : 0));
    const groupedByDensity = group<number>((c) => c.calibration_inject_every_n);
    const asrOf = (m: Map<number, WideAsrCell>, k: number): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.attacks_succeeded / g.total;
    };

    // aware=false: ASR=100% across all 4 density cells. Validates
    // cube #10's aware=false-row regression at the wider runner —
    // calibration injection moves the rep ledger but leaves
    // convergence uncalibrated, regardless of density.
    expect(asrOf(groupedByAware, 0)).toBe(1);
    // aware=true: ASR=50% — the gate fires at every_n ∈ {2, 4}
    // (2/4 cells close); at every_n ∈ {0, 8} the calibration record
    // stays empty and the gate is silent (2/4 cells leak). Cube
    // #10's aware=true row read 67% (1/3 cells closing); cube #13's
    // 50% (2/4) is consistent — the new closure cell is every_n=4
    // (silent in cube #10's 2-excerpt runner, active here in the
    // 4-excerpt runner) and the new silent cell is every_n=8
    // (which cube #10 didn't measure).
    expect(asrOf(groupedByAware, 1)).toBe(0.5);

    // every_n axis: the density-floor scaling law lands here.
    // every_n=0 at 100% (no calibration data; baseline);
    // every_n=8 at 100% (below floor in 4-excerpt runner — *the
    // density-floor scaling-law new datum*: cube #10 didn't measure
    // every_n=8 at all, and the silent reading here confirms the
    // floor scales with excerpt count); every_n=4 at 50% (above
    // floor in the 4-excerpt runner — *the new closure cell*: cube
    // #10's every_n=4 was below the floor in the 2-excerpt runner;
    // here it crosses); every_n=2 at 50% (well above floor, same
    // as cube #10).
    expect(asrOf(groupedByDensity, 0)).toBe(1);
    expect(asrOf(groupedByDensity, 8)).toBe(1);
    expect(asrOf(groupedByDensity, 4)).toBe(0.5);
    expect(asrOf(groupedByDensity, 2)).toBe(0.5);

    // Coverage invariants: every aware cell has 4 density cells,
    // every density cell has 2 aware cells. Same shape cubes #6-#12
    // carry; a future cell expansion that breaks the symmetry
    // trips the assertion and forces the aggregate to be re-keyed.
    for (const cell of groupedByAware.values()) {
      expect(cell.total).toBe(4);
    }
    for (const cell of groupedByDensity.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // Corpus-contamination scenario — the dynamic cube #13's wide runner
  // avoided by construction (all four excerpts kept bias-misaligned so
  // the calibration corpus stays anchor-only throughout the run). PRD
  // §Calibration batches commits the corpus as "validated history" —
  // accepted-from-history proposals routed to the requested sub-topic,
  // recency-biased; PRD §Adversary taxonomy commits the strategic-
  // adversary "passing calibration" bypass. The seam this scenario
  // closes is the *intra-run* version of that bypass: a strategic
  // adversary whose bias predicate aligns with what the corpus turns
  // *into* during the run — bias-aligned excerpts that converge accepted
  // mid-run join the corpus, and downstream coalition members who draw
  // those contaminated items as calibration vote with their bias and
  // pass, keeping their calibration record clean and lifting their
  // convergence weight back above the aware-gate threshold. The aware-
  // closure cube #13 reads holds when the corpus is anchor-only by
  // construction; this scenario reads what happens when it isn't.
  //
  // Setup mirrors cube #13's wide runner (4 anchors as the calibration
  // corpus, every_n=2 well above the density floor, aware=true,
  // naiveBiasedDecider on the coalition) with one change: 2 of the 4
  // staged excerpts are bias-aligned ("treatment X works for stage I/II"
  // — content the naive bias predicate accepts) and 2 are bias-
  // misaligned ("treatment X has no effect for stage III/IV" — the
  // suppression target). Run order is Erin (acceptAllDecider, primer)
  // → Carol → Dave. Erin votes accept on all 4 excerpts (1 accept each,
  // none converge yet). Carol votes accept on the 2 bias-aligned (each
  // reaches 2 accepts, weighted_accept = Erin(weight ≥ 2 after her cal
  // priming) + Carol(0 after she fails anchor calibration), converges
  // accepted — bias-aligned excerpts now in the corpus). Carol votes
  // reject on the 2 bias-misaligned (count=1 reject each, stays
  // staged). Then Dave runs against a corpus that contains 4 anchors +
  // 2 bias-aligned excerpts.
  //
  // Dave's call sequence is what makes the closure break visible. With
  // every_n=2 the first call is always real review (priorReviewOffers
  // starts at 0); Dave's first reject on bias-mis #1 lands at weight=1
  // (empty calibration record), the weighted_reject = Carol(0) +
  // Dave(1) = 1 < 2 falls below the aware threshold, and bias-mis #1
  // stalls. Dave's call 2 is calibration; recency-biased draw pulls
  // bias-aligned #2 (later created_at than the anchors and Dave hasn't
  // voted on it), Dave's bias accepts "works", matches the accepted-
  // from-history ground truth, calibration record (1, 0) → weight=2.
  // Dave's call 3 is real review on bias-mis #2: his reject lands at
  // weight=2, weighted_reject = Carol(0) + Dave(2) = 2 ≥ 2, converges
  // rejected. The aware closure breaks on the second target.
  //
  // The headline is *partial closure breakage*, not full bypass: the
  // first target Dave touches still holds (his weight hasn't been
  // contaminated yet); the second target falls (his weight has). The
  // closure-quality reading is *order-dependent* — once the corpus
  // contains items the bias passes, every reject Dave casts after
  // touching one of them counts at full weight. A coalition that timed
  // its rejections to follow a calibration draw on each could suppress
  // every target after the first; the runner doesn't model that
  // optimization (the assignment loop drives the order, not the
  // adversary), but the dynamic is visible at the proposer-observable
  // outcome (rejected vs staged) on the second target.
  //
  // Baseline comparison: the same runner with `contaminate=false`
  // stages 0 bias-aligned + 2 bias-misaligned excerpts (matching cube
  // #13's wide runner shape on a 2-target reduction). The corpus stays
  // anchor-only throughout the run; Dave's calibration draws all hit
  // anchors and his bias rejects them, calibration record (0, fails),
  // weight=0. His reject on bias-mis #2 lands at weight=0, weighted_
  // reject = 0 < 2, stays staged. 0 of 2 suppressed — full closure,
  // matching cube #13's aware=true reading at every_n=2.
  //
  // The lift from 0/2 (baseline) to 1/2 (contaminated) at the same
  // defense config is the load-bearing observation: the aware closure's
  // strength is a function of corpus composition over the run, not a
  // static property of the (every_n × aware) configuration. PRD
  // §Calibration batches' "biased toward fresh-but-validated history"
  // is what makes this dynamic structurally inevitable rather than a
  // tuning quirk: recency-bias guarantees that recently-converged
  // excerpts dominate calibration draws, so a bias-aligned coalition
  // member can recover their weight as soon as one bias-aligned excerpt
  // converges into the corpus mid-run. The mitigation is not a
  // calibration-knob change (cube #13 already shows the density floor
  // is well below the runner's offer count); the structural mitigation
  // is the corpus-composition rule wired as
  // `corpus_confirmation_depth_floor` — a depth-floor filter on
  // `fetchCalibrationBatch` that excludes accepted-from-history items
  // whose distinct-reviewer count sits below the floor (anchors and
  // other curator-accepted items have reviewer count 0 and bypass —
  // they are the ground-truth substrate, not synthesis-from-review,
  // so the "first review session" framing doesn't apply). At v0
  // votes_to_accept=2, floor=3 requires at least one independent
  // confirmation past the original convergence pair before the item
  // enters the corpus. The scenario stays as the regression handle for
  // both halves: the contamination dynamic at floor=0 (default,
  // inert), and the closure restored at floor > votes_to_accept; cube
  // #16 sweeps the floor axis directly to read the boundary.
  async function runCorpusContaminationScenario(params: {
    contaminate: boolean;
    corpus_confirmation_depth_floor?: number;
  }): Promise<{
    attack_succeeded: boolean;
    bias_misaligned_statuses: string[];
    bias_misaligned_rejected_count: number;
  }> {
    // Anchors are bias-misaligned ("paper N" content — naive bias
    // predicate rejects them, so coalition calibration draws on
    // anchors fail). Excerpt mix is what the contaminate knob controls:
    // 2 bias-aligned ("works") + 2 bias-misaligned ("no effect") when
    // on, 2 bias-misaligned only when off. Sources for span verification
    // mirror the excerpt content per anchor.
    const sources = new Map<string, string>(
      params.contaminate
        ? [
            ['1', 'study A: treatment X works for stage I patients across the cohort'],
            ['2', 'study B: treatment X works for stage II patients across the cohort'],
            ['3', 'study C: treatment X has no effect for stage III patients across the cohort'],
            ['4', 'study D: treatment X has no effect for stage IV patients across the cohort'],
          ]
        : [
            ['1', 'study C: treatment X has no effect for stage III patients across the cohort'],
            ['2', 'study D: treatment X has no effect for stage IV patients across the cohort'],
          ],
    );
    const floor = params.corpus_confirmation_depth_floor ?? 0;
    const seedSuffix = floor === 0 ? '' : `-f${floor}`;
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen(`${params.contaminate ? 'cc-on' : 'cc-off'}${seedSuffix}`),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        // Above cube #13's density floor for the runner's offer count
        // (4 anchors + N excerpts), so the aware gate fires; the cube
        // already pins density-floor behavior, and this scenario is
        // about corpus composition at fixed density.
        calibration_inject_every_n: 2,
        calibration_aware_convergence: true,
        corpus_confirmation_depth_floor: floor,
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

    // Anchor count matches the source count so every staged excerpt
    // routes to a real anchor for span verification.
    const anchorCount = sources.size;
    const anchorNodeIds: string[] = [];
    for (let i = 1; i <= anchorCount; i++) {
      const a = await server.tools.proposeAnchor(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `paper ${i}`,
        external_ref: { kind: 'pmid', value: String(i) },
      });
      server.curator.acceptProposal(a.proposal_id);
      const anchorNode = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
      );
      if (!anchorNode) throw new Error(`paper ${i} anchor not materialized`);
      anchorNodeIds.push(anchorNode.id);
    }

    // Excerpt staging order matters: bias-aligned excerpts proposed
    // before bias-misaligned ones get lower id-tiebreak ranks but later
    // reach the corpus (they converge during Carol's loop, picking up
    // their accepted timestamp). The recency-biased calibration draw
    // sorts by created_at, not proposal id, so the staging order is
    // load-bearing for the dynamic only via convergence timing —
    // lowest-id excerpts are reviewed first by the frontier and (for
    // bias-aligned) converge first. Pinning bias-aligned at the front
    // ensures the corpus contamination happens as early as possible.
    interface ExcerptSpec {
      kind: 'bias_aligned' | 'bias_misaligned';
      stage: string;
      anchor_index: number;
    }
    const excerptSpecs: ExcerptSpec[] = params.contaminate
      ? [
          { kind: 'bias_aligned', stage: 'I', anchor_index: 0 },
          { kind: 'bias_aligned', stage: 'II', anchor_index: 1 },
          { kind: 'bias_misaligned', stage: 'III', anchor_index: 2 },
          { kind: 'bias_misaligned', stage: 'IV', anchor_index: 3 },
        ]
      : [
          { kind: 'bias_misaligned', stage: 'III', anchor_index: 0 },
          { kind: 'bias_misaligned', stage: 'IV', anchor_index: 1 },
        ];
    const biasMisalignedIds: ProposalId[] = [];
    for (const spec of excerptSpecs) {
      const verb = spec.kind === 'bias_aligned' ? 'works for' : 'has no effect for';
      const spanVerb = spec.kind === 'bias_aligned' ? 'works for' : 'has no effect for';
      const result = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorNodeIds[spec.anchor_index]! as never,
        content: `treatment X ${verb} stage ${spec.stage}`,
        quoted_span: {
          text: `treatment X ${spanVerb} stage ${spec.stage} patients`,
          offset: 0,
        },
      });
      if (spec.kind === 'bias_misaligned') biasMisalignedIds.push(result.proposal_id);
    }

    // Erin runs first as the honest primer — accept-all gives every
    // staged excerpt its first accept and accumulates passes on the
    // anchor calibration corpus, lifting her weight enough that Carol's
    // bias-aligned accept can converge through the aware threshold.
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const erinClient = await wireArchetype(server, erin.id);
    await runHonestReviewer(erinClient, {
      cause_id: cause.id,
      rate: 10,
      decide: acceptAllDecider,
    });

    // Coalition: Carol+Dave with naive bias. Carol runs second so her
    // accept on bias-aligned excerpts contributes the second vote that
    // converges them into the corpus before Dave's loop. Dave runs
    // third — his calibration draws then pull from the contaminated
    // corpus, lifting his weight off the floor between consecutive
    // reject votes on bias-misaligned targets.
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolClient = await wireArchetype(server, carol.id);
    const daveClient = await wireArchetype(server, dave.id);
    await runHonestReviewer(carolClient, {
      cause_id: cause.id,
      rate: 10,
      decide: naiveBiasedDecider,
    });
    await runHonestReviewer(daveClient, {
      cause_id: cause.id,
      rate: 10,
      decide: naiveBiasedDecider,
    });

    const statuses: string[] = [];
    let rejectedCount = 0;
    for (const id of biasMisalignedIds) {
      const p = server.store.proposals.get(id);
      const status = p?.status ?? 'missing';
      statuses.push(status);
      if (status === 'rejected') rejectedCount += 1;
    }
    return {
      // ASR semantics for cube #16: any bias-misaligned target
      // converged 'rejected' is a coalition win on the contamination
      // axis. The baseline (anchor-only corpus) leaves both targets
      // staged; the contaminated corpus reopens at least one target
      // unless the depth-floor closes it.
      attack_succeeded: rejectedCount > 0,
      bias_misaligned_statuses: statuses,
      bias_misaligned_rejected_count: rejectedCount,
    };
  }

  it('corpus-contamination breaks the aware closure on the second target: bias-aligned excerpts converging mid-run lift the coalition weight (PRD §Calibration batches, "fresh-but-validated history" recency bias)', async () => {
    // Baseline: corpus stays anchor-only (no bias-aligned excerpts to
    // contaminate it). Coalition fails calibration on every anchor
    // draw, weight collapses to 0, both bias-misaligned targets stay
    // staged — full closure, matching cube #13's aware=true reading at
    // every_n=2.
    const off = await runCorpusContaminationScenario({ contaminate: false });
    expect(off.bias_misaligned_rejected_count).toBe(0);
    expect(off.bias_misaligned_statuses).toEqual(['staged', 'staged']);

    // Contaminated: 2 bias-aligned excerpts converge accepted during
    // Carol's loop and join the corpus. Dave's first reject on bias-
    // misaligned #1 lands at empty-calibration weight=1 (the call-1-is-
    // always-real-review constraint at every_n=2), so weighted_reject
    // falls below the aware threshold and that target stalls. Dave's
    // call 2 is calibration; recency-biased draw pulls bias-aligned
    // #2 (he hasn't voted on it), bias accepts "works", calibration
    // record (1, 0) → weight=2. Dave's call 3 reject on bias-
    // misaligned #2 lands at weight=2, weighted_reject = 2 ≥ 2,
    // converges rejected. The closure breaks on the second target.
    const on = await runCorpusContaminationScenario({ contaminate: true });
    expect(on.bias_misaligned_rejected_count).toBeGreaterThan(0);
    // The first bias-misaligned target stalls (Dave's empty-weight
    // reject); the second converges rejected (Dave's contaminated-
    // weight reject). The (staged, rejected) shape pins the order-
    // dependent dynamic — order-flipping the bias-misaligned ids
    // would shift which target falls but not whether one falls.
    expect(on.bias_misaligned_statuses).toEqual(['staged', 'rejected']);

    // The headline lift: at the same (every_n=2, aware=true) defense
    // configuration cube #13 reads as full closure on the anchor-only
    // corpus (ASR=0% in the wide runner's aware=true row), corpus
    // contamination by mid-run convergences re-opens the closure on a
    // fraction of the targets. The aware closure's strength is a
    // function of corpus composition over the run, not a static
    // property of the (every_n × aware) configuration.
    expect(on.bias_misaligned_rejected_count).toBeGreaterThan(off.bias_misaligned_rejected_count);
  });

  // Sixteenth parameter sweep cube: the corpus-composition cube on
  // the corpus-contamination scenario, joining the new
  // `corpus_confirmation_depth_floor` knob (PRD §Calibration batches,
  // corpus-composition closure rule) with the contaminate-axis the
  // standalone scenario above already pins. Cube #13's resolution-
  // refinement of cube #10 closed the *density-floor* axis on the
  // calibration-aware closure and named the corpus-contamination
  // dynamic as the next seam — bias-aligned excerpts converging
  // accepted mid-run join the calibration corpus before independent
  // confirmation has accumulated, so a coalition member's recency-
  // biased calibration draw on subsequent reviewers' loops pulls
  // contaminated items, passes calibration on bias, and lifts their
  // weighted-vote back above the aware threshold. Cube #13's wide
  // runner avoided the dynamic by construction (anchor-only corpus);
  // the corpus-contamination scenario above pins the dynamic and is
  // the regression handle the depth-floor closes against.
  //
  // The depth-floor primitive is structural: a proposal with review
  // history (reviewer count > 0) is eligible as a calibration item
  // only when its distinct-reviewer count meets the floor. At v0
  // votes_to_accept=2, a freshly-converged proposal carries exactly 2
  // distinct reviewers (the convergence pair), so the floor's
  // closure boundary sits at floor > votes_to_accept — floor=3
  // requires at least one *post-convergence* confirmation before the
  // item enters the corpus. Anchors and other curator-accepted items
  // have reviewer count 0 and bypass the floor by construction (the
  // "first review session" framing doesn't apply to the ground-truth
  // substrate). Default 0 leaves the filter inert — the (default,
  // contaminate=on) cell is the regression handle on the dynamic.
  //
  // Six cells over (contaminate ∈ {off, on}) × (depth_floor ∈ {0, 2,
  // 3}) drive `it.each` through the same `runCorpusContaminationScenario`
  // helper the standalone scenario uses, with the floor knob plumbed
  // through to the server's `corpus_confirmation_depth_floor` config
  // and `attack_succeeded` reading any bias-misaligned target
  // converged 'rejected' on the contaminated runner. The runner's
  // bias-aligned excerpts converge with exactly 2 distinct reviewers
  // (Erin's accept primes them at 1; Carol's bias-aligned accept
  // converges at 2), so the floor's effect on the contamination axis
  // reads as a binary closure exactly at the votes_to_accept boundary.
  //
  // The aggregate by depth_floor reads:
  //   floor=0: ASR=50% — the (off=baseline, on=regression) split, the
  //     filter inert by default and the contamination dynamic active.
  //   floor=2: ASR=50% — floor admits items at exactly the convergence
  //     threshold, the contamination dynamic still active. The cell
  //     pins the *boundary*: the floor must exceed votes_to_accept,
  //     not equal it; setting floor = votes_to_accept reads as
  //     intuitively-protective but is structurally equivalent to
  //     floor=0 on this dynamic, since the bias-aligned excerpts
  //     converge with exactly the threshold count.
  //   floor=3: ASR=0% — the closure restored. Bias-aligned excerpts
  //     have 2 reviewers, fail the floor (2 < 3), are excluded from
  //     calibration draws; Dave's recency-biased draws on the
  //     contaminated corpus pull only anchors (which bypass the floor
  //     at reviewer count 0), bias misfires on every draw, calibration
  //     record stays (0, fails), weight stays at 0 — both bias-
  //     misaligned targets stay staged exactly as in the anchor-only
  //     baseline. The closure restored under the same defense stack
  //     cube #13 read as full at the every_n=2 cell, now also under
  //     contaminate=on rather than only the anchor-only corpus.
  //
  // The aggregate by contaminate reads:
  //   off: ASR=0% across all 3 floors — the baseline-not-locked-out
  //     invariant. The depth-floor must not lock out the legitimate
  //     anchor-only corpus at any floor value, since anchors bypass
  //     the floor at reviewer count 0; the off rows pin this
  //     structurally rather than by inspection.
  //   on: ASR=67% — 2 of 3 floors leak (floor=0 default and floor=2
  //     boundary cell), 1 closes (floor=3 above the boundary).
  //
  // The headline reading is the *closure boundary at floor >
  // votes_to_accept*: cube #16 pins the depth-floor's structural role
  // as a corpus-composition rule that closes the contamination
  // dynamic exactly when items must accumulate post-convergence
  // confirmation before entering the corpus. Cube #13 + the
  // contamination scenario read the calibration-aware closure's
  // dependence on corpus composition over the run; cube #16 reads
  // the depth-floor as the corpus-side closure of that dependence.
  // Together cubes #10, #13, and #16 close the calibration-density
  // design pass at three layers: cube #10 the density-floor axis at
  // 2 excerpts, cube #13 the density-floor scaling law at 4 excerpts,
  // cube #16 the corpus-composition closure on the contamination
  // bypass that density alone cannot reach.
  interface CorpusDepthFloorSweepCell {
    name: string;
    contaminate: boolean;
    corpus_confirmation_depth_floor: number;
    expected_attack_succeeded: boolean;
    expected_bias_misaligned_statuses: string[];
  }
  const corpusDepthFloorSweepCells: CorpusDepthFloorSweepCell[] = [
    // floor=0 row (default, filter inert): the off cell is the
    // anchor-only baseline (both targets staged); the on cell is the
    // regression handle on the contamination dynamic the standalone
    // scenario above pins (one target converges rejected).
    {
      name: 'contaminate=off, floor=0 (default; anchor-only baseline)',
      contaminate: false,
      corpus_confirmation_depth_floor: 0,
      expected_attack_succeeded: false,
      expected_bias_misaligned_statuses: ['staged', 'staged'],
    },
    {
      name: 'contaminate=on, floor=0 (filter inert; contamination dynamic active)',
      contaminate: true,
      corpus_confirmation_depth_floor: 0,
      expected_attack_succeeded: true,
      expected_bias_misaligned_statuses: ['staged', 'rejected'],
    },
    // floor=2 row (boundary cell): floor admits items at exactly
    // votes_to_accept=2. The off cell still reads the baseline (no
    // items would be filtered anyway); the on cell still leaks
    // because bias-aligned excerpts pass the floor at reviewer
    // count 2.
    {
      name: 'contaminate=off, floor=2 (boundary; baseline unaffected — anchors bypass)',
      contaminate: false,
      corpus_confirmation_depth_floor: 2,
      expected_attack_succeeded: false,
      expected_bias_misaligned_statuses: ['staged', 'staged'],
    },
    {
      name: 'contaminate=on, floor=2 (boundary; floor admits at convergence threshold, dynamic still active)',
      contaminate: true,
      corpus_confirmation_depth_floor: 2,
      expected_attack_succeeded: true,
      expected_bias_misaligned_statuses: ['staged', 'rejected'],
    },
    // floor=3 row (above the boundary): the off cell pins the
    // baseline-not-locked-out invariant (anchors bypass the floor
    // at reviewer count 0, baseline closure unchanged); the on cell
    // is the closure — bias-aligned excerpts at reviewer count 2
    // are excluded, Dave's calibration draws pull only anchors,
    // bias misfires on all of them, calibration weight stays 0,
    // both bias-misaligned targets stay staged.
    {
      name: 'contaminate=off, floor=3 (above boundary; anchor bypass preserves baseline)',
      contaminate: false,
      corpus_confirmation_depth_floor: 3,
      expected_attack_succeeded: false,
      expected_bias_misaligned_statuses: ['staged', 'staged'],
    },
    {
      name: 'contaminate=on, floor=3 (above boundary; bias-aligned items excluded, closure restored)',
      contaminate: true,
      corpus_confirmation_depth_floor: 3,
      expected_attack_succeeded: false,
      expected_bias_misaligned_statuses: ['staged', 'staged'],
    },
  ];
  it.each(corpusDepthFloorSweepCells)('corpus depth-floor × contaminate sweep: $name', async ({
    contaminate,
    corpus_confirmation_depth_floor,
    expected_attack_succeeded,
    expected_bias_misaligned_statuses,
  }) => {
    const result = await runCorpusContaminationScenario({
      contaminate,
      corpus_confirmation_depth_floor,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.bias_misaligned_statuses).toEqual(expected_bias_misaligned_statuses);
  });

  it('corpus depth-floor × contaminate sweep cube: ASR aggregates by floor and by contaminate, reads closure boundary at floor > votes_to_accept', () => {
    interface CorpusAsrCell {
      total: number;
      attacks_succeeded: number;
    }
    function group(keyOf: (c: CorpusDepthFloorSweepCell) => number | string) {
      const m = new Map<number | string, CorpusAsrCell>();
      for (const cell of corpusDepthFloorSweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { total: 0, attacks_succeeded: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        m.set(k, g);
      }
      return m;
    }

    // Aggregate by depth_floor reads the closure boundary directly:
    // floor=0 (default, filter inert) at 50% — the (off=baseline,
    // on=regression) split, the contamination dynamic active by
    // default; floor=2 (boundary) at 50% — floor admits items at
    // exactly votes_to_accept and the dynamic stays active, the
    // boundary-pin cell that names floor > votes_to_accept (not
    // floor >= votes_to_accept) as the structural requirement;
    // floor=3 (above boundary) at 0% — closure restored, bias-aligned
    // items excluded, calibration weight stays at 0, both targets
    // stay staged. The crossing between floor=2 and floor=3 reads the
    // *closure boundary at floor > votes_to_accept* — the headline
    // observation cube #16 pins.
    const byFloor = group((c) => c.corpus_confirmation_depth_floor);
    const asrByFloor = (floor: number): number => {
      const g = byFloor.get(floor);
      if (!g) throw new Error(`missing floor=${floor}`);
      return g.attacks_succeeded / g.total;
    };
    expect(asrByFloor(0)).toBe(0.5);
    expect(asrByFloor(2)).toBe(0.5);
    expect(asrByFloor(3)).toBe(0);

    // Aggregate by contaminate reads the baseline-not-locked-out
    // invariant on the off side and the closure-coverage on the on
    // side: off at 0% across all 3 floors (anchors bypass the floor
    // at reviewer count 0; the depth-floor must never lock out the
    // legitimate anchor-only corpus, regardless of floor value); on
    // at 67% (2 of 3 floors leak — floor=0 default and floor=2
    // boundary; floor=3 above the boundary closes).
    const byContaminate = group((c) => (c.contaminate ? 'on' : 'off'));
    const asrByContaminate = (key: 'on' | 'off'): number => {
      const g = byContaminate.get(key);
      if (!g) throw new Error(`missing contaminate=${key}`);
      return g.attacks_succeeded / g.total;
    };
    expect(asrByContaminate('off')).toBe(0);
    expect(asrByContaminate('on')).toBeCloseTo(2 / 3);

    // Coverage invariant: every (contaminate × floor) pair appears
    // exactly once. Catches uneven cell counts per group that would
    // make the per-config aggregates above silently misleading (the
    // pattern cube #1's coverage invariant introduced).
    const expectedPairs = new Set<string>();
    for (const contaminate of [false, true]) {
      for (const floor of [0, 2, 3]) {
        expectedPairs.add(`${contaminate}|${floor}`);
      }
    }
    const actualPairs = new Set<string>();
    for (const cell of corpusDepthFloorSweepCells) {
      actualPairs.add(`${cell.contaminate}|${cell.corpus_confirmation_depth_floor}`);
    }
    expect(actualPairs).toEqual(expectedPairs);
    expect(corpusDepthFloorSweepCells.length).toBe(expectedPairs.size);
  });

  // Fourteenth parameter sweep cube: the (stratification × threshold)
  // composition cube on the K=2 coalition with priming, joining cube
  // #11's stratification axis with cube #12's vote-to-reject axis on
  // a single attack pattern. PRD §What's deliberately not specified
  // names "Vote-aggregation thresholds" as a knob deferred to the
  // testbed; PRD §Reviewer assignment commits stratification as the
  // structural closure for the small-pool-eligible regime. Cubes #11
  // and #12 measured each axis against the same K=2 coalition at
  // coalition-first ordering but with disjoint runners (cube #11
  // primes so the cluster signal can fire; cube #12 omits priming so
  // threshold arithmetic reads cleanly). Cube #14 unifies the two
  // axes on a single primed runner and reads the *orthogonality* of
  // the two closure mechanisms — the load-bearing question is whether
  // tightening vto on top of stratification buys any additional
  // closure, or whether the two defenses are independently sufficient
  // at the same K=2 attack.
  //
  // Attack pattern: K=2 coalition (Carol+Dave with naiveBiasedDecider)
  // on a single contested excerpt, with three bias-aligned priming
  // proposals on which Carol and Dave both vote accept (so the
  // cluster signal has shared history to fire on when strat=on). The
  // coalition runs first — Carol requests assignment and votes reject
  // on the contested target, then Dave requests assignment. With
  // strat=on, Dave is gated by the cross-stratum draw rule (Carol-
  // already-routed + Carol-Dave co-stratum from priming) and the
  // request fails with `not_found`; with strat=off, Dave is routed
  // and votes reject. The honest pool then runs sequentially.
  // Calibration channels off (vta=2 fixed) so the cube isolates
  // (strat × vto × H) from the calibration axes cubes #5/#10/#13
  // measure.
  //
  // Defense layers in scope:
  //   - stratification_enabled ∈ {off, on}: cube #11's axis. With
  //     priming and strat=on, the cluster signal closes Dave at
  //     request_assignment; the coalition's effective leverage drops
  //     to Carol's lone reject.
  //   - votes_to_reject ∈ {2, 3}: cube #12's vto axis. At vto=2 the
  //     coalition can capture by arithmetic (K=vto, both rejects
  //     converge); at vto=3 the coalition cannot reach the threshold
  //     by arithmetic (K<vto), regardless of whether Dave is gated.
  //   - honest pool size H ∈ {1, 2}: cube #11's closure-quality axis
  //     (vta=2 fixed). At H=1 the honest pool reaches 1 accept (below
  //     vta=2) and the proposal stalls; at H=2 it reaches vta and
  //     converges accepted.
  //
  // The composition reads:
  //   (strat=off, vto=2): K=vto, coalition captures by arithmetic
  //     before honest pool votes. ASR=100% across both H — H buys
  //     nothing at coalition-first ordering with K=vto. The regression
  //     handle on default-threshold capture, identical to cube #12's
  //     vto=2 row.
  //   (strat=off, vto=3): K<vto, capture closed *by threshold alone*.
  //     Dave votes (no cluster signal closure) but the coalition's
  //     two rejects don't reach vto=3. Honest pool drives convergence
  //     at H=2 (full closure) or stalls at H=1 (1 accept < vta=2).
  //     This is cube #12's vto=3 row at a smaller H axis.
  //   (strat=on, vto=2): K=vto, but Dave is cluster-gated. Carol's
  //     lone reject is below vto=2, so capture is closed *by
  //     stratification alone* — the load-bearing path the cube
  //     measures: vto is at the K-affording threshold where cube #12
  //     reads ASR=100%, but the cluster signal closes the same attack
  //     anyway. Honest pool drives convergence at H=2; stalls at
  //     H=1.
  //   (strat=on, vto=3): both defenses fire. Capture is *over-
  //     determined* — closed by stratification (Dave gated) AND by
  //     threshold (K<vto). Closure quality matches the (strat=on,
  //     vto=2) row: H=2 closes accepted, H=1 stalls. The over-
  //     determined cell reads "the second defense buys no additional
  //     capture-resistance once the first has fired" — the two
  //     defenses are not multiplicative on capture, they are
  //     redundantly sufficient.
  //
  // Eight cells over (strat ∈ {off, on}) × (vto ∈ {2, 3}) × (H ∈
  // {1, 2}) drive `it.each`. The aggregate groups by (strat, vto)
  // and reads (ASR + stall_rate) per pair across the H axis: (off,
  // 2) at (ASR=100%, stall=0%) — coalition captures regardless of
  // H; (off, 3) at (ASR=0%, stall=50%) — closure-by-threshold,
  // closure quality depends on H; (on, 2) at (ASR=0%, stall=50%) —
  // closure-by-stratification, closure quality depends on H; (on, 3)
  // at (ASR=0%, stall=50%) — closure-by-both, no different from
  // either alone on either metric.
  //
  // The complementary aggregates by single axis read:
  //   - by strat: off at (ASR=50%, stall=25%) — vto=2 captures both
  //     H, vto=3 stalls at H=1; on at (ASR=0%, stall=50%) — capture
  //     closed at every cell, both H=1 cells stall.
  //   - by vto: 2 at (ASR=50%, stall=25%) — strat=off captures both
  //     H, strat=on stalls at H=1; 3 at (ASR=0%, stall=50%) —
  //     capture closed at every cell, both H=1 cells stall.
  //   - by H: 1 at (ASR=25%, stall=75%) — only (off, 2) captures at
  //     H=1, three cells stall (everywhere capture is closed); 2 at
  //     (ASR=25%, stall=0%) — only (off, 2) captures, every closure
  //     cell reaches vta.
  //
  // The headline is the *redundant-sufficiency* reading: the two
  // closure mechanisms close capture by *different* paths (cluster
  // signal closes Dave at request_assignment via the cross-stratum
  // gate; vto raises the arithmetic floor below K) but at the K=2
  // coalition each is independently sufficient. The (strat=on, vto=
  // 2) pair specifically reads "closure-by-stratification-not-by-
  // threshold" — the cell where vto is at the K-affording value
  // (cube #12 reads 100% ASR at vto=2 without stratification) but
  // capture is still closed because stratification fires first. The
  // (strat=on, vto=3) overdetermined pair reads no extra closure
  // beyond either alone — *redundant*, not *multiplicative*.
  //
  // The two-metric template (ASR, stall_rate) generalizes here as a
  // *closure-quality independence reading*: stall_rate is invariant
  // across the (strat, vto) pairs that close capture — at H=1 the
  // honest pool is below vta regardless of which defense fired, and
  // at H=2 the honest pool reaches vta regardless. The closure-
  // quality axis (H) is independent of which capture-defense fires;
  // both stratification and vto-tightening pay the same closure-
  // quality cost (1 stall at H=1) when capture is closed. PRD
  // §Reviewer assignment commits "slower to close but not capturable
  // by the pool-fits-the-coalition dynamic"; cube #14 reads this as
  // a property that survives the (strat × vto) composition rather
  // than being tied to a specific closure mechanism.
  //
  // The dave_voted invariant on each cell (true at strat=off, false
  // at strat=on; vto-independent) is the regression handle on the
  // cluster-signal closure path itself, surfacing a wiring regression
  // that disabled or weakened the cluster signal before downstream
  // ASR drift, the same shape cube #11 carries.
  async function runStratificationThresholdScenario(params: {
    stratification_enabled: boolean;
    votes_to_reject: number;
    honest_pool_size: number;
  }): Promise<{
    attack_succeeded: boolean;
    stalled: boolean;
    contested_status: string;
    dave_voted: boolean;
  }> {
    if (params.honest_pool_size < 1 || params.honest_pool_size > 2) {
      throw new Error(
        `runStratificationThresholdScenario: H=${params.honest_pool_size} out of range [1,2]`,
      );
    }
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('st14'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: params.votes_to_reject,
        // Calibration channels off — the cube isolates (strat × vto)
        // from the calibration axes cubes #5/#10/#13 measure.
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: params.stratification_enabled,
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

    // Reviewers. K=2 coalition (Carol+Dave) plus H honest reviewers
    // (Erin always, Frank at H=2).
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    const honestIdentities: Array<{ id: typeof erin.id; name: string }> = [
      { id: erin.id, name: 'erin' },
    ];
    if (params.honest_pool_size >= 2) {
      const frank = server.bootstrap.mintIdentity({ display_name: 'frank' });
      honestIdentities.push({ id: frank.id, name: 'frank' });
    }
    for (const id of [carol.id, dave.id, ...honestIdentities.map((h) => h.id)]) {
      await server.tools.setCapacity(
        { identity_id: id },
        { cause_id: cause.id, rate: 5, kinds: ['review'] },
      );
    }

    // PRIMING: three bias-aligned excerpts. Carol and Dave both vote
    // accept on each via direct cast_review_vote — the same priming
    // pattern cube #11 uses. The first auto-converges on Carol+Dave's
    // unanimous accept; the second and third stay staged after the
    // cluster forms and are curator-accepted to clear the frontier.
    // The priming is a no-op for the cluster signal at strat=off
    // (signal not computed) and load-bearing at strat=on (Carol+Dave
    // co-stratum after 3 shared accepts ≥ stratum_min_shared_proposals
    // = 2, agreement = 1.0 ≥ stratum_agreement_threshold).
    for (let i = 0; i < 3; i++) {
      const primer = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      const after = server.store.proposals.get(primer.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(primer.proposal_id);
      }
    }

    // CONTESTED: bias-misaligned excerpt under paper 2.
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
    const contestedId = contested.proposal_id;

    // ADVERSARY PHASE. Carol requests assignment first, gets routed,
    // votes reject. Dave requests next: gated at strat=on, routed and
    // votes reject at strat=off.
    const carolAssignment = await server.tools.requestAssignment(
      { identity_id: carol.id },
      { cause_id: cause.id },
    );
    if (carolAssignment.task.kind !== 'review') {
      throw new Error('expected carol routed to review task');
    }
    if (carolAssignment.task.proposal_id !== contestedId) {
      throw new Error(
        `expected carol routed to contested ${contestedId}, got ${carolAssignment.task.proposal_id}`,
      );
    }
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      {
        proposal_id: contestedId,
        decision: 'reject',
        rationale: 'underpowered, methodological concerns',
        assignment_id: carolAssignment.assignment_id,
      },
    );

    let daveVoted = false;
    const postCarol = server.store.proposals.get(contestedId);
    if (postCarol?.status === 'staged') {
      try {
        const daveAssignment = await server.tools.requestAssignment(
          { identity_id: dave.id },
          { cause_id: cause.id },
        );
        if (
          daveAssignment.task.kind === 'review' &&
          daveAssignment.task.proposal_id === contestedId
        ) {
          await server.tools.castReviewVote(
            { identity_id: dave.id },
            {
              proposal_id: contestedId,
              decision: 'reject',
              rationale: 'underpowered, methodological concerns',
              assignment_id: daveAssignment.assignment_id,
            },
          );
          daveVoted = true;
        }
      } catch (err) {
        if (err instanceof ServerError && err.code === 'not_found') {
          // Dave gated by the cross-stratum draw rule. Expected at
          // strat=on.
        } else {
          throw err;
        }
      }
    }

    // HONEST PHASE. Honest reviewers vote accept sequentially. Loop
    // short-circuits if contested already converged.
    for (const honest of honestIdentities) {
      const post = server.store.proposals.get(contestedId);
      if (post?.status !== 'staged') break;
      try {
        const honestAssignment = await server.tools.requestAssignment(
          { identity_id: honest.id },
          { cause_id: cause.id },
        );
        if (
          honestAssignment.task.kind !== 'review' ||
          honestAssignment.task.proposal_id !== contestedId
        ) {
          continue;
        }
        await server.tools.castReviewVote(
          { identity_id: honest.id },
          {
            proposal_id: contestedId,
            decision: 'accept',
            rationale: 'consistent with prevailing evidence',
            assignment_id: honestAssignment.assignment_id,
          },
        );
      } catch (err) {
        if (err instanceof ServerError && err.code === 'not_found') {
          continue;
        }
        throw err;
      }
    }

    const final = server.store.proposals.get(contestedId);
    if (!final) throw new Error('contested proposal not found');
    return {
      attack_succeeded: final.status === 'rejected',
      stalled: final.status === 'staged',
      contested_status: final.status,
      dave_voted: daveVoted,
    };
  }

  interface StratThresholdSweepCell {
    name: string;
    stratification_enabled: boolean;
    votes_to_reject: number;
    honest_pool_size: number;
    expected_attack_succeeded: boolean;
    expected_stalled: boolean;
    expected_dave_voted: boolean;
  }
  const stratThresholdSweepCells: StratThresholdSweepCell[] = [
    // (strat=off, vto=2): K=vto, coalition-first capture. ASR=100%
    // across both H — the regression handle on default-threshold
    // capture (cube #12's vto=2 row, replayed under priming).
    {
      name: 'strat=off, vto=2, H=1 (K=vto, coalition captures by arithmetic; H irrelevant)',
      stratification_enabled: false,
      votes_to_reject: 2,
      honest_pool_size: 1,
      expected_attack_succeeded: true,
      expected_stalled: false,
      expected_dave_voted: true,
    },
    {
      name: 'strat=off, vto=2, H=2 (K=vto, coalition captures; H=2 honest pool comes too late)',
      stratification_enabled: false,
      votes_to_reject: 2,
      honest_pool_size: 2,
      expected_attack_succeeded: true,
      expected_stalled: false,
      expected_dave_voted: true,
    },
    // (strat=off, vto=3): K<vto, capture closed by threshold alone.
    // Dave votes (cluster signal off), but coalition can't reach
    // vto=3. Closure quality on H: H=1 stalls (1 accept < vta=2);
    // H=2 closes accepted.
    {
      name: 'strat=off, vto=3, H=1 (closure-by-threshold; H<vta stalls)',
      stratification_enabled: false,
      votes_to_reject: 3,
      honest_pool_size: 1,
      expected_attack_succeeded: false,
      expected_stalled: true,
      expected_dave_voted: true,
    },
    {
      name: 'strat=off, vto=3, H=2 (closure-by-threshold; H=vta full closure)',
      stratification_enabled: false,
      votes_to_reject: 3,
      honest_pool_size: 2,
      expected_attack_succeeded: false,
      expected_stalled: false,
      expected_dave_voted: true,
    },
    // (strat=on, vto=2): K=vto, but Dave is cluster-gated. Carol's
    // lone reject below vto. Capture closed *by stratification alone*
    // — the load-bearing closure-by-stratification-not-by-threshold
    // path. Closure quality on H: H=1 stalls (1 reject + 1 accept,
    // neither threshold hit); H=2 closes accepted.
    {
      name: 'strat=on, vto=2, H=1 (closure-by-stratification at K=vto; H<vta stalls)',
      stratification_enabled: true,
      votes_to_reject: 2,
      honest_pool_size: 1,
      expected_attack_succeeded: false,
      expected_stalled: true,
      expected_dave_voted: false,
    },
    {
      name: 'strat=on, vto=2, H=2 (closure-by-stratification at K=vto; H=vta full closure — load-bearing)',
      stratification_enabled: true,
      votes_to_reject: 2,
      honest_pool_size: 2,
      expected_attack_succeeded: false,
      expected_stalled: false,
      expected_dave_voted: false,
    },
    // (strat=on, vto=3): both defenses fire. Capture overdetermined
    // — closed by stratification AND by threshold. Closure quality
    // matches the (strat=on, vto=2) row: same H-dependent stalls.
    {
      name: 'strat=on, vto=3, H=1 (overdetermined closure; H<vta stalls)',
      stratification_enabled: true,
      votes_to_reject: 3,
      honest_pool_size: 1,
      expected_attack_succeeded: false,
      expected_stalled: true,
      expected_dave_voted: false,
    },
    {
      name: 'strat=on, vto=3, H=2 (overdetermined closure; H=vta full closure)',
      stratification_enabled: true,
      votes_to_reject: 3,
      honest_pool_size: 2,
      expected_attack_succeeded: false,
      expected_stalled: false,
      expected_dave_voted: false,
    },
  ];
  it.each(stratThresholdSweepCells)('stratification × threshold sweep: $name', async ({
    stratification_enabled,
    votes_to_reject,
    honest_pool_size,
    expected_attack_succeeded,
    expected_stalled,
    expected_dave_voted,
  }) => {
    const result = await runStratificationThresholdScenario({
      stratification_enabled,
      votes_to_reject,
      honest_pool_size,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.stalled).toBe(expected_stalled);
    expect(result.dave_voted).toBe(expected_dave_voted);
  });

  it('stratification × threshold sweep cube: ASR + stall-rate aggregate by (strat, vto), strat, vto, and H', () => {
    // Aggregate per the two-metric template cube #5 introduced and
    // cubes #11/#12 carried forward: ASR (capture rate) + stall_rate
    // (staged-instead-of-converged rate). The cube's three axes
    // (strat, vto, H) read how each contributes to the (capture,
    // closure-quality) tradeoff, and the (strat × vto) joint
    // aggregate reads the orthogonality of the two capture-closure
    // mechanisms.
    interface StratThresholdAsrCell<K> {
      key: K;
      total: number;
      attacks_succeeded: number;
      stalled: number;
    }
    function group<K>(
      keyOf: (cell: StratThresholdSweepCell) => K,
    ): Map<string, StratThresholdAsrCell<K>> {
      const m = new Map<string, StratThresholdAsrCell<K>>();
      for (const cell of stratThresholdSweepCells) {
        const k = keyOf(cell);
        const ks = JSON.stringify(k);
        const g = m.get(ks) ?? { key: k, total: 0, attacks_succeeded: 0, stalled: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        if (cell.expected_stalled) g.stalled += 1;
        m.set(ks, g);
      }
      return m;
    }
    const groupedByStratVto = group((c) => [c.stratification_enabled, c.votes_to_reject]);
    const groupedByStrat = group((c) => c.stratification_enabled);
    const groupedByVto = group((c) => c.votes_to_reject);
    const groupedByH = group((c) => c.honest_pool_size);
    const asrOf = <K>(m: Map<string, StratThresholdAsrCell<K>>, k: K): number => {
      const g = m.get(JSON.stringify(k));
      if (!g) throw new Error(`missing key=${JSON.stringify(k)}`);
      return g.attacks_succeeded / g.total;
    };
    const stallOf = <K>(m: Map<string, StratThresholdAsrCell<K>>, k: K): number => {
      const g = m.get(JSON.stringify(k));
      if (!g) throw new Error(`missing key=${JSON.stringify(k)}`);
      return g.stalled / g.total;
    };

    // (strat × vto) joint aggregate — the headline orthogonality
    // reading. Each pair averages over H ∈ {1, 2}.
    //   (off, 2): K=vto, coalition captures both H. ASR=100%, stall=
    //     0%. The default-threshold capture baseline.
    expect(asrOf(groupedByStratVto, [false, 2])).toBe(1);
    expect(stallOf(groupedByStratVto, [false, 2])).toBe(0);
    //   (off, 3): closure-by-threshold; H=1 stalls. ASR=0%, stall=
    //     50%.
    expect(asrOf(groupedByStratVto, [false, 3])).toBe(0);
    expect(stallOf(groupedByStratVto, [false, 3])).toBe(0.5);
    //   (on, 2): closure-by-stratification at K=vto — the load-
    //     bearing closure-by-stratification-not-by-threshold cell.
    //     Cube #12 reads ASR=100% at (strat=off, vto=2); cube #11
    //     reads ASR=0% at (strat=on, vto=2 default); cube #14 here
    //     reads the latter directly under the same (strat × vto)
    //     coordinates. Stall_rate=50% (H=1 stalls).
    expect(asrOf(groupedByStratVto, [true, 2])).toBe(0);
    expect(stallOf(groupedByStratVto, [true, 2])).toBe(0.5);
    //   (on, 3): overdetermined closure — both defenses fire, no
    //     extra capture-resistance beyond either alone. ASR=0%,
    //     stall=50%, identical (on metric) to (on, 2) and (off, 3).
    //     The redundant-sufficiency reading.
    expect(asrOf(groupedByStratVto, [true, 3])).toBe(0);
    expect(stallOf(groupedByStratVto, [true, 3])).toBe(0.5);

    // strat axis: off captures at vto=2 (2/4 cells), stalls at
    // (vto=3, H=1) (1/4); on closes capture at every cell (4/4),
    // stalls at H=1 across both vto (2/4).
    expect(asrOf(groupedByStrat, false)).toBe(0.5);
    expect(stallOf(groupedByStrat, false)).toBe(0.25);
    expect(asrOf(groupedByStrat, true)).toBe(0);
    expect(stallOf(groupedByStrat, true)).toBe(0.5);

    // vto axis: 2 captures at strat=off (2/4 cells), stalls at
    // (strat=on, H=1) (1/4); 3 closes capture at every cell (4/4),
    // stalls at H=1 across both strat (2/4). Numerically identical
    // to the strat axis — the two defenses pay symmetric capture and
    // closure-quality readings under the (strat × vto × H) symmetry.
    expect(asrOf(groupedByVto, 2)).toBe(0.5);
    expect(stallOf(groupedByVto, 2)).toBe(0.25);
    expect(asrOf(groupedByVto, 3)).toBe(0);
    expect(stallOf(groupedByVto, 3)).toBe(0.5);

    // H axis: the closure-quality independence reading. At H=1 only
    // (off, 2) captures (1/4); the three closure cells stall (3/4
    // stall_rate). At H=2 only (off, 2) captures (1/4); every
    // closure cell reaches vta and stall_rate=0%. The H axis
    // cleanly separates capture from closure-quality regardless of
    // which defense fired — the property cube #11 named (graceful
    // degradation on the closure-quality axis) survives the (strat
    // × vto) composition.
    expect(asrOf(groupedByH, 1)).toBe(0.25);
    expect(stallOf(groupedByH, 1)).toBe(0.75);
    expect(asrOf(groupedByH, 2)).toBe(0.25);
    expect(stallOf(groupedByH, 2)).toBe(0);

    // Coverage invariants: every (strat, vto) pair has 2 H cells,
    // every single-axis aggregate has 4 cells. Same shape cubes
    // #6-#13 carry; a future cell expansion that breaks the symmetry
    // trips the assertion and forces the aggregate to be re-keyed.
    for (const cell of groupedByStratVto.values()) {
      expect(cell.total).toBe(2);
    }
    for (const m of [groupedByStrat, groupedByVto, groupedByH]) {
      for (const cell of m.values()) {
        expect(cell.total).toBe(4);
      }
    }
  });

  // Fifteenth parameter sweep cube: the (recent half-life × quiet
  // window) ratio-invariance cube on the patient-adversary archetype,
  // opening the reputation-decay axis the prior cubes left unswept.
  // PRD §What's deliberately not specified names "reputation decay
  // rates" as a knob deferred to the testbed; PRD §Reputation commits
  // the two-component bookkeeping (a slow-decay `demonstrated` and a
  // fast-decay `recent`, each with its own half-life), and the
  // patient-adversary closure cube #2 ships the assignment-time gate
  // (`assignment_min_recent`) that consumes the recent component
  // post-quiet-window. The load-bearing question this cube answers is
  // *what determines whether the gate fires* — the half-life value T,
  // the quiet-window length W, or their ratio W/T (decay measured in
  // half-lives). Cube #2 holds (T=60, W=360) fixed and reads the
  // gate-firing axis through the threshold; cube #15 holds the
  // threshold fixed at the cube-#2-tuned value (`assignment_min_recent`
  // = 0.5) and sweeps (T, W) directly.
  //
  // Attack pattern: the patient-adversary archetype, identical to the
  // canonical scenario the cube #2 runner pins — Carol primes through
  // 4 honest accepts on bias-zone-out content + 4 calibration passes
  // on the anchor corpus (calAwareBiasedDecider), drifts on a first
  // contested target (which converges accepted via Erin+Frank's
  // accepts), then attempts a second drift after a quiet window of W
  // seconds. Carol's recent immediately post-priming is R₀ ≈ 8 (the
  // bootstrap rotation contributes +1, calibration passes +4, and
  // priming-convergence reviewer credits +4 minus a -1 penalty for
  // voting against the converged first contested outcome — the exact
  // R₀ value is invariant across the cube's cells because tick=0 means
  // the clock doesn't advance during priming, so no decay is applied
  // before the quiet window opens). The gate fires when the decayed
  // recent R(W) = R₀ × 2^(-W/T) falls below the threshold of 0.5,
  // which depends on W/T only — not on T or W independently.
  //
  // Defense layers in scope:
  //   - recent_half_life_seconds T ∈ {60, 600}: decay rate axis. The
  //     patient-adversary scenario at line 5117 hardcodes T=60; cube
  //     #15 lifts it to a parameter via the runner extension on
  //     runPatientAdversaryGateScenario, with T=60 preserved as the
  //     default for cubes #2 and #5.
  //   - quiet_window_seconds W ∈ {T×1, T×2, T×6}: drift-cadence axis.
  //     The cube derives W from T at three ratios so the W/T axis is
  //     directly read across all six cells; W is NOT held constant
  //     because the closure depends on the ratio, and holding W
  //     constant would conflate the two T values' positions in the
  //     decay curve.
  //   - assignment_min_recent fixed at 0.5: cube #2's calibrated
  //     value, the same threshold the patient-adversary closure cube
  //     reads through. Holding it fixed is what isolates the (T, W)
  //     axis from the threshold axis cube #2 already measured.
  //
  // The composition reads:
  //   r=1 (W = T): R(W) = R₀/2 ≈ 4. Above threshold 0.5 → gate doesn't
  //     fire → Carol gets her second drift assignment → ASR=100%. Same
  //     outcome at T=60 (W=60) and T=600 (W=600): the ratio is what
  //     determines R, and 1 half-life is too short to drain R₀ below
  //     the threshold at any T.
  //   r=2 (W = 2T): R(W) = R₀/4 ≈ 2. Still above 0.5 → gate doesn't
  //     fire → ASR=100%. Same at both T values.
  //   r=6 (W = 6T): R(W) = R₀/64 ≈ 0.125. Below 0.5 → gate fires →
  //     Carol's second drift attempt is refused at request_assignment
  //     with `not_found` → ASR=0%. Same at both T values, the
  //     6-half-life closure cube #2 reads at T=60.
  //
  // Six cells over (T ∈ {60, 600}) × (r ∈ {1, 2, 6}) drive `it.each`,
  // with W computed as T × r per cell. The aggregate by ratio reads
  // (ASR=100%, 100%, 0%) at (r=1, 2, 6) — a binary closure on the
  // ratio axis that aggregates across both T values within each ratio
  // group. The aggregate by T reads (ASR=67%, 67%) — *identical
  // values across the T axis*, which is the load-bearing observation:
  // T alone is not the closure determinant. The aggregate by W reads
  // mixed values that don't align cleanly because W carries different
  // amounts of decay at different T values.
  //
  // The headline is the *ratio-invariance reading*: the closure
  // depends on W/T (decay measured in half-lives), not on T or W
  // independently. This is structurally inevitable from PRD
  // §Reputation's exponential-decay commitment — R(W) = R₀ × 2^(-W/T)
  // is invariant under (T, W) scaling that preserves the ratio — but
  // the cube reads it as a CI-checked invariant rather than relying
  // on the structural argument alone, since it pins the property that
  // any future change to the decay law (e.g. a non-exponential decay,
  // or a per-event-count reset that breaks the half-life abstraction)
  // would surface here as a ratio-aggregate that no longer reads
  // identically across T groups.
  //
  // The cube is the third design pass on a non-identity axis after
  // cube #11 (pool-size, graceful-degradation reading) and cube #12
  // (vote-aggregation thresholds, K+1-honest-reviewer dynamic). The
  // composition with cube #14's (stratification × threshold) cube is
  // the natural follow-up: a coalition that times its quiet window
  // against the half-life can re-acquire assignment after the gate
  // re-opens, which re-introduces the multi-round dynamic the
  // standalone patient-adversary scenarios pin at fixed cadence.
  // That cube is testbed-territory follow-up; cube #15 stays on the
  // single-axis ratio-invariance reading.
  interface DecayCadenceSweepCell {
    name: string;
    recent_half_life_seconds: number;
    quiet_window_seconds: number;
    ratio: number;
    expected_attack_succeeded: boolean;
  }
  const decayCadenceSweepCells: DecayCadenceSweepCell[] = [
    // r=1: W equals one half-life. R(W) = R₀/2 ≈ 4 > 0.5 → gate
    // doesn't fire. Same outcome at both T values.
    {
      name: 'T=60s, W=60s (1 half-life: R₀/2 above threshold; gate inert)',
      recent_half_life_seconds: 60,
      quiet_window_seconds: 60,
      ratio: 1,
      expected_attack_succeeded: true,
    },
    {
      name: 'T=600s, W=600s (1 half-life: R₀/2 above threshold; gate inert)',
      recent_half_life_seconds: 600,
      quiet_window_seconds: 600,
      ratio: 1,
      expected_attack_succeeded: true,
    },
    // r=2: W equals two half-lives. R(W) = R₀/4 ≈ 2 > 0.5 → gate
    // doesn't fire. Same outcome at both T values.
    {
      name: 'T=60s, W=120s (2 half-lives: R₀/4 above threshold; gate inert)',
      recent_half_life_seconds: 60,
      quiet_window_seconds: 120,
      ratio: 2,
      expected_attack_succeeded: true,
    },
    {
      name: 'T=600s, W=1200s (2 half-lives: R₀/4 above threshold; gate inert)',
      recent_half_life_seconds: 600,
      quiet_window_seconds: 1200,
      ratio: 2,
      expected_attack_succeeded: true,
    },
    // r=6: W equals six half-lives. R(W) = R₀/64 ≈ 0.125 < 0.5 → gate
    // fires. Same outcome at both T values, the closure cube #2 reads
    // at T=60.
    {
      name: 'T=60s, W=360s (6 half-lives: R₀/64 below threshold; gate fires)',
      recent_half_life_seconds: 60,
      quiet_window_seconds: 360,
      ratio: 6,
      expected_attack_succeeded: false,
    },
    {
      name: 'T=600s, W=3600s (6 half-lives: R₀/64 below threshold; gate fires)',
      recent_half_life_seconds: 600,
      quiet_window_seconds: 3600,
      ratio: 6,
      expected_attack_succeeded: false,
    },
  ];
  it.each(decayCadenceSweepCells)('decay-cadence sweep: $name', async ({
    recent_half_life_seconds,
    quiet_window_seconds,
    expected_attack_succeeded,
  }) => {
    const result = await runPatientAdversaryGateScenario({
      assignment_min_recent: 0.5,
      assignment_min_demonstrated: 0,
      recent_half_life_seconds,
      quiet_window_seconds,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    // false_positive_lockout is alpha-invariant at alpha=1 (cube #5's
    // baseline) — the bootstrap rotation gives Erin/Frank
    // demonstrated=2.0, well above any threshold the cube uses
    // (assignment_min_demonstrated=0). Pinning lockout=false on every
    // cell catches a future regression where the runner's bootstrap
    // changes and the honest pool collapses into the demo gate at the
    // cube's cells.
    expect(result.false_positive_lockout).toBe(false);
  });

  it('decay-cadence sweep cube: ASR aggregates by ratio invariantly across T (PRD §Reputation, exponential-decay commitment)', () => {
    // Aggregate per the cube template: group cells by ratio (the W/T
    // axis the closure actually depends on) and by T (the axis the
    // ratio-invariance reading pins as *not* the closure determinant).
    // The aggregate by ratio reads the binary closure: r ∈ {1, 2}
    // both leak (R above threshold), r=6 closes (R below threshold).
    // The aggregate by T reads identically (67%) across both T
    // values — the headline ratio-invariance observation.
    interface DecayAsrCell {
      key: number;
      total: number;
      attacks_succeeded: number;
    }
    function group(keyOf: (cell: DecayCadenceSweepCell) => number): Map<number, DecayAsrCell> {
      const m = new Map<number, DecayAsrCell>();
      for (const cell of decayCadenceSweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { key: k, total: 0, attacks_succeeded: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        m.set(k, g);
      }
      return m;
    }
    const groupedByRatio = group((c) => c.ratio);
    const groupedByT = group((c) => c.recent_half_life_seconds);
    const asrOf = (m: Map<number, DecayAsrCell>, k: number): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.attacks_succeeded / g.total;
    };

    // By ratio: r=1 at 100% (R₀/2 ≈ 4 > 0.5 at any T); r=2 at 100%
    // (R₀/4 ≈ 2 > 0.5 at any T); r=6 at 0% (R₀/64 ≈ 0.125 < 0.5 at
    // any T). The closure crosses between r=2 and r=6 — between
    // log2(R₀/0.5) ≈ 4 and 5 half-lives in this runner's R₀.
    expect(asrOf(groupedByRatio, 1)).toBe(1);
    expect(asrOf(groupedByRatio, 2)).toBe(1);
    expect(asrOf(groupedByRatio, 6)).toBe(0);

    // By T: identical values across both T axes — the ratio-invariance
    // reading. Each T has 3 cells (one per ratio), 2 of which leak
    // (r=1, 2) and 1 of which closes (r=6), so ASR=2/3 ≈ 0.67. A
    // future change to the decay law that breaks ratio invariance
    // (e.g. a per-event reset or a non-exponential decay) would
    // surface here as different aggregates across T — the cube's CI-
    // checked invariant.
    expect(asrOf(groupedByT, 60)).toBeCloseTo(2 / 3);
    expect(asrOf(groupedByT, 600)).toBeCloseTo(2 / 3);
    expect(asrOf(groupedByT, 60)).toBe(asrOf(groupedByT, 600));

    // Coverage invariants: every ratio cell has 2 T values, every T
    // cell has 3 ratios. Same shape cubes #6-#14 carry; a future cell
    // expansion that breaks the symmetry trips the assertion and
    // forces the aggregate to be re-keyed.
    for (const cell of groupedByRatio.values()) {
      expect(cell.total).toBe(2);
    }
    for (const cell of groupedByT.values()) {
      expect(cell.total).toBe(3);
    }
  });

  // Seventeenth parameter sweep cube: the (demonstrated half-life ×
  // quiet window) ratio-invariance cube on the patient-adversary
  // archetype, the demonstrated-component sibling of cube #15. PRD
  // §Reputation commits the two-component bookkeeping ("every
  // reputation event moves a slow-decay demonstrated and a fast-decay
  // recent component together"); cube #15 read the recent-component
  // closure axis through the recent gate. Cube #17 reads the
  // demonstrated-component closure axis through the demo gate, with
  // the recent path inert by both knob and value (recent gate
  // disabled, recent half-life Infinity), isolating the demo-decay
  // axis from the recent-decay axis cube #15 measured.
  //
  // Defense layers in scope:
  //   - demonstrated_half_life_seconds T_demo ∈ {60, 600}: decay rate
  //     axis on the demonstrated component, the runner extension on
  //     `runPatientAdversaryGateScenario` plumbed through to the
  //     server's `demonstrated_half_life_seconds` config (default
  //     Infinity preserves cubes #2, #5, and #15's calibration).
  //   - quiet_window_seconds W = T_demo × r: drift-cadence axis,
  //     same shape as cube #15 — the cube derives W from T_demo at
  //     four ratios so the W/T_demo axis is directly read across all
  //     eight cells, with two T_demo values per ratio for the
  //     ratio-invariance aggregate.
  //   - assignment_min_demonstrated fixed at 1.5: cube #2's
  //     calibrated value, the same threshold the demo gate consumed
  //     against the sybil-amplified-coalition pattern. Holding it
  //     fixed isolates the (T_demo, W) axis from the threshold axis
  //     cube #2 already measured on the demo gate.
  //   - assignment_min_recent fixed at 0 + recent_half_life Infinity:
  //     recent path inert at *both* layers (gate disabled by knob,
  //     recent component doesn't decay). Carol's recent stays at R₀
  //     ≈ 8 throughout, well above any threshold; the only defense
  //     in this cube is the demo gate, and the only reason Carol's
  //     second drift attempt fails is if demo drained below 1.5.
  //
  // The composition reads:
  //   r=1 (W = T_demo): demo(W) = R₀/2 ≈ 4. Above threshold 1.5 →
  //     gate doesn't fire → ASR=100%. Same at T_demo ∈ {60, 600}.
  //   r=2 (W = 2 T_demo): demo(W) = R₀/4 ≈ 2. Still above 1.5 →
  //     gate doesn't fire → ASR=100%. Same at both T_demo values.
  //   r=3 (W = 3 T_demo): demo(W) = R₀/8 = 1. Below 1.5 → gate
  //     fires → Carol's second drift attempt refused at
  //     request_assignment with `not_found` → ASR=0%. *The closure
  //     cross-point* — between r=2 and r=3 in this cube, which
  //     sits at log2(R₀/threshold_demo) = log2(8/1.5) ≈ 2.4
  //     half-lives, the cross-point predicted by the exponential-
  //     decay law at the demo threshold.
  //   r=6 (W = 6 T_demo): demo(W) = R₀/64 ≈ 0.125. Below 1.5 →
  //     gate fires → ASR=0%. Same at both T_demo values; the
  //     cube #15 r=6 closure cell replayed on the demo axis.
  //
  // Eight cells over (T_demo ∈ {60, 600}) × (r ∈ {1, 2, 3, 6}) drive
  // `it.each`, with W computed as T_demo × r per cell. The aggregate
  // by ratio reads (100%, 100%, 0%, 0%) at (r=1, 2, 3, 6) — the
  // closure cross-point is bracketed by adjacent-ratio cells at r ∈
  // {2, 3}, sharper than cube #15's r ∈ {2, 6} bracket since the demo
  // threshold (1.5) sits closer to the per-half-life decay step than
  // the recent threshold (0.5). The aggregate by T_demo reads (50%,
  // 50%) — *identical values across both T_demo axes*, the ratio-
  // invariance reading on the demo axis paralleling cube #15's
  // observation on the recent axis.
  //
  // The headline reading is the *cross-point dependence on the gate
  // threshold*: cube #15 closes at log2(R₀/0.5) ≈ 4 half-lives
  // (between r=2 and r=6 in cube #15's coarser bracket); cube #17
  // closes at log2(R₀/1.5) ≈ 2.4 half-lives (between r=2 and r=3 in
  // cube #17's tighter bracket). Both cubes show ratio invariance —
  // the closure depends on W/T, not on T or W independently — but
  // the *value* of the W/T cross-point depends on the threshold the
  // gate is configured against. Together cubes #15 and #17 close
  // the reputation-decay design pass at three layers: the recent
  // axis (cube #15), the demonstrated axis (cube #17), and the
  // structural ratio-invariance both cubes pin as the CI-checked
  // invariant on PRD §Reputation's exponential-decay commitment.
  // Any future change to the decay law that breaks ratio invariance
  // (e.g. a per-event reset or a non-exponential decay) surfaces in
  // both cubes as different aggregates across T groups.
  interface DemoDecayCadenceSweepCell {
    name: string;
    demonstrated_half_life_seconds: number;
    quiet_window_seconds: number;
    ratio: number;
    expected_attack_succeeded: boolean;
  }
  const demoDecayCadenceSweepCells: DemoDecayCadenceSweepCell[] = [
    // r=1: W equals one demo half-life. demo(W) = R₀/2 ≈ 4 > 1.5 →
    // gate doesn't fire. Same outcome at both T_demo values.
    {
      name: 'T_demo=60s, W=60s (1 demo half-life: R₀/2 above demo threshold; gate inert)',
      demonstrated_half_life_seconds: 60,
      quiet_window_seconds: 60,
      ratio: 1,
      expected_attack_succeeded: true,
    },
    {
      name: 'T_demo=600s, W=600s (1 demo half-life: R₀/2 above demo threshold; gate inert)',
      demonstrated_half_life_seconds: 600,
      quiet_window_seconds: 600,
      ratio: 1,
      expected_attack_succeeded: true,
    },
    // r=2: W equals two demo half-lives. demo(W) = R₀/4 ≈ 2 > 1.5 →
    // gate doesn't fire. Same outcome at both T_demo values; the
    // last leak before the cross-point.
    {
      name: 'T_demo=60s, W=120s (2 demo half-lives: R₀/4 above demo threshold; gate inert)',
      demonstrated_half_life_seconds: 60,
      quiet_window_seconds: 120,
      ratio: 2,
      expected_attack_succeeded: true,
    },
    {
      name: 'T_demo=600s, W=1200s (2 demo half-lives: R₀/4 above demo threshold; gate inert)',
      demonstrated_half_life_seconds: 600,
      quiet_window_seconds: 1200,
      ratio: 2,
      expected_attack_succeeded: true,
    },
    // r=3: W equals three demo half-lives. demo(W) = R₀/8 = 1 < 1.5
    // → gate fires. *The closure cross-point* — between r=2 and
    // r=3, which brackets log2(R₀/1.5) ≈ 2.4 half-lives.
    {
      name: 'T_demo=60s, W=180s (3 demo half-lives: R₀/8 below demo threshold; gate fires)',
      demonstrated_half_life_seconds: 60,
      quiet_window_seconds: 180,
      ratio: 3,
      expected_attack_succeeded: false,
    },
    {
      name: 'T_demo=600s, W=1800s (3 demo half-lives: R₀/8 below demo threshold; gate fires)',
      demonstrated_half_life_seconds: 600,
      quiet_window_seconds: 1800,
      ratio: 3,
      expected_attack_succeeded: false,
    },
    // r=6: W equals six demo half-lives. demo(W) = R₀/64 ≈ 0.125 <
    // 1.5 → gate fires. Same outcome at both T_demo values, the
    // cube #15 r=6 closure cell replayed on the demo axis.
    {
      name: 'T_demo=60s, W=360s (6 demo half-lives: R₀/64 below demo threshold; gate fires)',
      demonstrated_half_life_seconds: 60,
      quiet_window_seconds: 360,
      ratio: 6,
      expected_attack_succeeded: false,
    },
    {
      name: 'T_demo=600s, W=3600s (6 demo half-lives: R₀/64 below demo threshold; gate fires)',
      demonstrated_half_life_seconds: 600,
      quiet_window_seconds: 3600,
      ratio: 6,
      expected_attack_succeeded: false,
    },
  ];
  it.each(demoDecayCadenceSweepCells)('demo decay-cadence sweep: $name', async ({
    demonstrated_half_life_seconds,
    quiet_window_seconds,
    expected_attack_succeeded,
  }) => {
    const result = await runPatientAdversaryGateScenario({
      // Recent path inert at both layers (gate disabled, decay
      // disabled) — only the demo gate is active in this cube.
      assignment_min_recent: 0,
      assignment_min_demonstrated: 1.5,
      recent_half_life_seconds: Number.POSITIVE_INFINITY,
      quiet_window_seconds,
      demonstrated_half_life_seconds,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    // false_positive_lockout reads false on every cell — the
    // bootstrap rotation gives Erin/Frank demonstrated=2.0 (well
    // above the 1.5 demo threshold; the bootstrap completes before
    // the quiet window opens, so honest-pool demo doesn't decay
    // below threshold by Carol's second drift attempt because the
    // gate fires on Carol-not-yet-on-second-drift, not on the
    // honest pool's standing). Pinning lockout=false catches a
    // future bootstrap-shape change that would silently collapse
    // the honest pool into the demo gate.
    expect(result.false_positive_lockout).toBe(false);
  });

  it('demo decay-cadence sweep cube: ASR aggregates by ratio invariantly across T_demo, with cross-point bracketed at r ∈ {2, 3}', () => {
    interface DemoDecayAsrCell {
      key: number;
      total: number;
      attacks_succeeded: number;
    }
    function group(
      keyOf: (cell: DemoDecayCadenceSweepCell) => number,
    ): Map<number, DemoDecayAsrCell> {
      const m = new Map<number, DemoDecayAsrCell>();
      for (const cell of demoDecayCadenceSweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { key: k, total: 0, attacks_succeeded: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        m.set(k, g);
      }
      return m;
    }
    const groupedByRatio = group((c) => c.ratio);
    const groupedByT = group((c) => c.demonstrated_half_life_seconds);
    const asrOf = (m: Map<number, DemoDecayAsrCell>, k: number): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.attacks_succeeded / g.total;
    };

    // By ratio: r=1 at 100% (R₀/2 ≈ 4 > 1.5 at any T_demo); r=2 at
    // 100% (R₀/4 ≈ 2 > 1.5 at any T_demo); r=3 at 0% (R₀/8 = 1 < 1.5
    // at any T_demo) — *the cross-point*; r=6 at 0% (R₀/64 ≈ 0.125 <
    // 1.5 at any T_demo). Closure crosses between r=2 and r=3, which
    // brackets log2(R₀/1.5) ≈ 2.4 half-lives — the cross-point
    // predicted by the exponential-decay law at the demo threshold.
    expect(asrOf(groupedByRatio, 1)).toBe(1);
    expect(asrOf(groupedByRatio, 2)).toBe(1);
    expect(asrOf(groupedByRatio, 3)).toBe(0);
    expect(asrOf(groupedByRatio, 6)).toBe(0);

    // By T_demo: identical values across both T_demo axes — the
    // ratio-invariance reading on the demo axis. Each T_demo has 4
    // cells (one per ratio), 2 of which leak (r ∈ {1, 2}) and 2 of
    // which close (r ∈ {3, 6}), so ASR=2/4 = 0.5. A future change to
    // the demo-decay law that breaks ratio invariance would surface
    // here as different aggregates across T_demo — the cube's CI-
    // checked invariant.
    expect(asrOf(groupedByT, 60)).toBe(0.5);
    expect(asrOf(groupedByT, 600)).toBe(0.5);
    expect(asrOf(groupedByT, 60)).toBe(asrOf(groupedByT, 600));

    // Coverage invariants: every ratio cell has 2 T_demo values,
    // every T_demo cell has 4 ratios. Same shape cubes #6-#15 carry;
    // a future cell expansion that breaks the symmetry trips the
    // assertion and forces the aggregate to be re-keyed.
    for (const cell of groupedByRatio.values()) {
      expect(cell.total).toBe(2);
    }
    for (const cell of groupedByT.values()) {
      expect(cell.total).toBe(4);
    }
  });

  // (recent-decay × cluster-signal) sweep — cube #18, the natural
  // follow-up the prior milestones tail named after closing the
  // reputation-decay design pass at the solo patient archetype with
  // cubes #15 and #17. Cubes #15/#17 hold the cluster signal
  // structurally inert (solo patient adversary, no shared vote
  // history to cluster on) and read the exponential-decay law as
  // ratio invariance on the (T × W) axes; cube #18 holds the decay
  // parameters at cube #15's calibrated configuration (recent_half_
  // life=60s, quiet=6 half-lives) and reads the recent-decay gate's
  // role on a *coalition* multi-round attack pattern where Carol+
  // Dave time their quiet window against the half-life and re-prime
  // through contributor-initiated accept votes between drift rounds
  // — the "re-acquire assignment after the gate re-opens" dynamic
  // the prior next-milestones tail named by structural framing.
  //
  // The runner threads two drift rounds separated by a quiet window
  // and a re-prime cycle:
  //
  //   1. Coalition priming: Carol+Dave cast contributor-initiated
  //      accept votes on three bias-aligned excerpts (each converges
  //      at vto=2 on the unanimous coalition accept under
  //      review_credit_contention_alpha=1.0 default → +1 demonstrated
  //      / +1 recent per convergence). After three convergences,
  //      Carol+Dave each end with recent ≈ 3, demonstrated ≈ 3, well
  //      above any 0.5 recent threshold the cube sweeps. The 3
  //      shared accept votes form the cluster signal at
  //      stratum_min_shared_proposals=2 + agreement_threshold=1.0.
  //   2. Round 1 drift: contested #1 staged. Carol request_assignment
  //      routes her first (no co-stratum reviewer yet routed for
  //      contested), she casts reject. Dave request_assignment is
  //      either cross-stratum gated (cluster on; the cluster signal
  //      closure path cube #11 reads on the same primitive) or
  //      routes him to also cast reject (cluster off → contested
  //      converges 'rejected' at vto=2).
  //   3. Quiet window: clock advances past 6 recent half-lives.
  //      Carol+Dave's recent drains by ~64x to ≈ 0.047 — well below
  //      0.5 if the gate is active.
  //   4. Re-prime: Carol+Dave cast contributor-initiated accept on
  //      three new bias-aligned excerpts. The contributor-initiated
  //      `cast_review_vote` path bypasses the recent gate by null-
  //      policy (PRD §Reputation: "fresh-reviewer bypass so first-
  //      assignment bootstrap stays open" + the drained-but-honest
  //      contributor recovery path the standalone patient-adversary
  //      scenarios pin), so re-priming pays through the gate even
  //      at recent=0.5. Each excerpt converges at vto=2 on the
  //      coalition's two accepts → recent climbs back to ≈ 3 +
  //      0.047 ≈ 3.05, well above 0.5.
  //   5. Round 2 drift: contested #2 staged; same shape as round 1.
  //      Recent gate doesn't fire because re-priming lifted recent
  //      back; cluster signal still in vote store from priming + 3
  //      more shared accepts from re-priming, so cross-stratum gate
  //      fires against Dave on cluster-on cells.
  //
  // Cells: 4 over (assignment_min_recent ∈ {0, 0.5}) ×
  // (stratification_enabled ∈ {off, on}). The headlines:
  //
  //   - (recent=0, cluster=off): no defenses, both rounds capture
  //     → ASR=100%. The regression handle on the multi-round
  //     coalition attack pattern itself.
  //   - (recent=0, cluster=on): cluster signal alone closes Dave
  //     both rounds (cross-stratum gate from priming history),
  //     Carol's lone reject is below vto=2, contested stays staged
  //     on both rounds → ASR=0%.
  //   - (recent=0.5, cluster=off): re-priming lifts recent above
  //     threshold each round, recent gate ineffective, both rounds
  //     capture → ASR=100%. *The load-bearing cell*: the recent
  //     gate alone cannot close coalition amplification across
  //     timed rounds because re-priming pays through it.
  //   - (recent=0.5, cluster=on): cluster signal closes Dave both
  //     rounds regardless of recent gate → ASR=0%.
  //
  // Aggregate by cluster: off=100%, on=0%. *The cluster signal is
  // what does the closure work against coalition amplification* —
  // it operates on coalition structure (cross-stratum gate),
  // independent of adversary timing.
  //
  // Aggregate by recent: identical 50% across both threshold values
  // — *the recent-decay gate is ASR-invariant against this multi-
  // round timed coalition pattern*. The re-prime cost is real
  // (Carol+Dave each pay 3 honest accepts per cycle), but the gate
  // alone doesn't translate it into closure: contributor-initiated
  // voting bypasses by null-policy, so the adversary pays the
  // accumulation cost upstream of the gate. PRD §Reputation names
  // the recent gate's design role at the *solo* patient adversary
  // where re-priming is unamortized (cube #2's lockout cells
  // calibrated against the solo runner); cube #18 reads that role
  // as inert against the *coalition* variant where re-priming is
  // paid once and the cluster-signal closure does the actual work.
  //
  // The cube is the (decay × cluster-signal) sibling of cube #11
  // (pool-size × cluster-signal) and cube #14 ((stratification ×
  // threshold) composition): all three cubes read the cluster
  // signal alongside a non-cluster axis on the coalition attack
  // pattern, with cube #18's non-cluster axis being the recent-
  // decay gate the cube #2 lockout cells calibrated on the *solo*
  // patient archetype. Together cubes #11, #14, and #18 pin the
  // cluster signal as the load-bearing coalition-amplification
  // closure across three orthogonal axes (pool-size, threshold,
  // decay-rate) — the (ASR-by-cluster) reading is invariantly
  // 100%/0% across all three cubes against the K=2 coalition
  // pattern.
  async function runDecayClusterMultiRoundScenario(params: {
    assignment_min_recent: number;
    stratification_enabled: boolean;
  }): Promise<{
    attack_succeeded: boolean;
    attack_succeeded_round_1: boolean;
    attack_succeeded_round_2: boolean;
    dave_voted_round_1: boolean;
    dave_voted_round_2: boolean;
  }> {
    const RECENT_HALF_LIFE_SECONDS = 60;
    const QUIET_WINDOW_SECONDS = RECENT_HALF_LIFE_SECONDS * 6;
    const sources = new Map<string, string>([
      ['1', 'arm A: treatment X works in stage III patients across the cohort'],
      ['2', 'arm B: treatment X has no effect in stage IV patients'],
    ]);
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('dcl'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        // Calibration channels off — cube #18 isolates the
        // (decay × cluster-signal) composition on the convergence
        // path. Calibration is a separate axis pinned by cubes #10
        // / #13 / #16; mixing it in here would confound the read.
        calibration_inject_every_n: 0,
        calibration_aware_convergence: false,
        stratification_enabled: params.stratification_enabled,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        // Stratification-degraded tightening disabled — the cube
        // measures the cross-stratum *routing* gate (Dave refused
        // when Carol already routed to the same proposal), not the
        // convergence-threshold tightening (which would prevent the
        // priming + re-priming convergences from firing in cluster=
        // on cells once the cluster forms after the second shared
        // accept, leaving Carol+Dave's coalition rep at the +1 from
        // iteration 0 only and the recent-decay axis unmeasurable).
        // The convergence-threshold tightening is what cube #11
        // measures (closure-quality on the small-pool axis); cube
        // #18 isolates the routing gate to read the (decay × cluster
        // -signal) interaction without confounding by the
        // convergence-threshold knob.
        stratification_degraded_extra: 0,
        // Cube #15's calibrated configuration: T=60s recent half-
        // life, W=6 half-lives quiet window. Cube #15 already swept
        // the W/T ratio axis and pinned ratio invariance on the
        // solo patient archetype; cube #18 holds the configuration
        // at cube #15's calibrated value and sweeps the cluster-
        // signal axis alongside the recent gate threshold on the
        // coalition variant.
        recent_half_life_seconds: RECENT_HALF_LIFE_SECONDS,
        // Demo gate stays off — cube #18's axis is the recent-decay
        // gate; the demo gate is read on the patient archetype by
        // cubes #2 and #17. With demo off, fresh Carol+Dave bypass
        // by construction (no rep entries yet at first request_
        // assignment, but priming runs through contributor-initiated
        // votes that don't traverse the assignment gate at all).
        assignment_min_recent: params.assignment_min_recent,
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

    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    for (const id of [carol.id, dave.id]) {
      await server.tools.setCapacity(
        { identity_id: id },
        { cause_id: cause.id, rate: 5, kinds: ['review'] },
      );
    }

    // Phase 1 — coalition priming. Three bias-aligned excerpts under
    // anchor 1; Carol+Dave both contributor-initiated-accept on each.
    // Each converges at vto=2 on the unanimous coalition accept; the
    // third primer would stratification-degraded-tighten past two
    // accepts once the cluster forms, so the runner curator-accepts
    // any priming proposal still staged after the second vote so the
    // frontier doesn't carry leftover staged primers into the round 1
    // assignment loop.
    for (let i = 0; i < 3; i++) {
      const primer = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III priming ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: primer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      const after = server.store.proposals.get(primer.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(primer.proposal_id);
      }
    }

    // Phase 2 — round 1 drift. Stage contested #1 (bias-misaligned
    // excerpt under anchor 2). Carol request_assignment routes her
    // first (no co-stratum reviewer yet routed for contested), she
    // casts reject. Dave request_assignment is either cross-stratum
    // gated (cluster on) or routes him to cast reject (cluster off
    // → contested converges 'rejected' at vto=2 directly off the
    // coalition's two rejects; there's no honest pool in this runner
    // because the cube's ASR reading is "did the coalition land
    // both rejects" and Carol+Dave at vto=2 don't need a third
    // reviewer to converge if Dave is routable).
    const contested1 = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchor2Node.id,
      content: 'treatment X has no effect for stage IV round 1',
      quoted_span: {
        text: 'treatment X has no effect in stage IV patients',
        offset: 0,
      },
    });
    const contested1Id = contested1.proposal_id;

    const carolAssignment1 = await server.tools.requestAssignment(
      { identity_id: carol.id },
      { cause_id: cause.id },
    );
    if (carolAssignment1.task.kind !== 'review') {
      throw new Error('round 1: expected carol routed to a review task');
    }
    if (carolAssignment1.task.proposal_id !== contested1Id) {
      throw new Error(
        `round 1: expected carol routed to contested ${contested1Id}, got ${carolAssignment1.task.proposal_id}`,
      );
    }
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      {
        proposal_id: contested1Id,
        decision: 'reject',
        rationale: 'underpowered, methodological concerns',
        assignment_id: carolAssignment1.assignment_id,
      },
    );

    let daveVoted1 = false;
    try {
      const daveAssignment1 = await server.tools.requestAssignment(
        { identity_id: dave.id },
        { cause_id: cause.id },
      );
      if (
        daveAssignment1.task.kind === 'review' &&
        daveAssignment1.task.proposal_id === contested1Id
      ) {
        await server.tools.castReviewVote(
          { identity_id: dave.id },
          {
            proposal_id: contested1Id,
            decision: 'reject',
            rationale: 'underpowered, methodological concerns',
            assignment_id: daveAssignment1.assignment_id,
          },
        );
        daveVoted1 = true;
      }
    } catch (err) {
      if (err instanceof ServerError && err.code === 'not_found') {
        // Dave gated by the cross-stratum draw rule (cluster on).
        // At round 1 his recent is fresh from priming (≈ 3), so the
        // recent gate cannot fire here regardless of threshold —
        // this catch-branch is structurally cluster-only.
      } else {
        throw err;
      }
    }
    const round1Status = server.store.proposals.get(contested1Id)?.status;

    // Phase 3 — quiet window. Clock advances past 6 recent half-
    // lives; recent drains by ~64x for Carol and Dave alike. This
    // is the "times its quiet window against the half-life" beat
    // the milestone names — at recent=0.5 the gate would fire on
    // the next request_assignment if Carol/Dave didn't re-prime
    // through it.
    clock.advance(QUIET_WINDOW_SECONDS * 1000);

    // Phase 4 — re-prime. Three new bias-aligned excerpts under
    // anchor 1; Carol+Dave again contributor-initiated-accept on
    // each. Contributor-initiated `cast_review_vote` bypasses the
    // recent gate by null-policy (PRD §Reputation, recovery path),
    // so re-priming pays through the gate even at recent=0.5. Each
    // excerpt converges at vto=2 on the coalition's two accepts →
    // recent climbs back to ≈ 3 + 0.047 ≈ 3.05, well above any 0.5
    // threshold the cube sweeps. The cluster signal extends (3
    // priming + 3 re-priming = 6 shared accepts), reinforcing the
    // cross-stratum gate rather than weakening it.
    for (let i = 0; i < 3; i++) {
      const reprimer = await server.tools.proposeExcerpt(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchor1Node.id,
        content: `treatment X works for stage III re-prime ${i}`,
        quoted_span: { text: 'treatment X works in stage III patients', offset: 0 },
      });
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        {
          proposal_id: reprimer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      await server.tools.castReviewVote(
        { identity_id: dave.id },
        {
          proposal_id: reprimer.proposal_id,
          decision: 'accept',
          rationale: 'consistent with prevailing evidence',
        },
      );
      const after = server.store.proposals.get(reprimer.proposal_id);
      if (after?.status === 'staged') {
        server.curator.acceptProposal(reprimer.proposal_id);
      }
    }

    // Phase 5 — round 2 drift. Stage contested #2; same shape as
    // round 1. Recent gate doesn't fire because re-priming lifted
    // Carol+Dave back above any 0.5 threshold; cluster signal
    // still in vote store, so cross-stratum gate fires against
    // Dave on cluster-on cells.
    const contested2 = await server.tools.proposeExcerpt(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      parent_anchor_id: anchor2Node.id,
      content: 'treatment X has no effect for stage IV round 2',
      quoted_span: {
        text: 'treatment X has no effect in stage IV patients',
        offset: 0,
      },
    });
    const contested2Id = contested2.proposal_id;

    const carolAssignment2 = await server.tools.requestAssignment(
      { identity_id: carol.id },
      { cause_id: cause.id },
    );
    if (carolAssignment2.task.kind !== 'review') {
      throw new Error('round 2: expected carol routed to a review task');
    }
    if (carolAssignment2.task.proposal_id !== contested2Id) {
      throw new Error(
        `round 2: expected carol routed to contested ${contested2Id}, got ${carolAssignment2.task.proposal_id}`,
      );
    }
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      {
        proposal_id: contested2Id,
        decision: 'reject',
        rationale: 'underpowered, methodological concerns',
        assignment_id: carolAssignment2.assignment_id,
      },
    );

    let daveVoted2 = false;
    try {
      const daveAssignment2 = await server.tools.requestAssignment(
        { identity_id: dave.id },
        { cause_id: cause.id },
      );
      if (
        daveAssignment2.task.kind === 'review' &&
        daveAssignment2.task.proposal_id === contested2Id
      ) {
        await server.tools.castReviewVote(
          { identity_id: dave.id },
          {
            proposal_id: contested2Id,
            decision: 'reject',
            rationale: 'underpowered, methodological concerns',
            assignment_id: daveAssignment2.assignment_id,
          },
        );
        daveVoted2 = true;
      }
    } catch (err) {
      if (err instanceof ServerError && err.code === 'not_found') {
        // Dave gated by cross-stratum (cluster on); recent gate
        // can't fire on round 2 because re-priming lifted his
        // recent above any 0.5 threshold the cube sweeps.
      } else {
        throw err;
      }
    }
    const round2Status = server.store.proposals.get(contested2Id)?.status;

    const attackR1 = round1Status === 'rejected';
    const attackR2 = round2Status === 'rejected';
    return {
      attack_succeeded: attackR1 || attackR2,
      attack_succeeded_round_1: attackR1,
      attack_succeeded_round_2: attackR2,
      dave_voted_round_1: daveVoted1,
      dave_voted_round_2: daveVoted2,
    };
  }

  interface DecayClusterSweepCell {
    name: string;
    assignment_min_recent: number;
    stratification_enabled: boolean;
    expected_attack_succeeded: boolean;
    expected_attack_succeeded_round_1: boolean;
    expected_attack_succeeded_round_2: boolean;
    expected_dave_voted_round_1: boolean;
    expected_dave_voted_round_2: boolean;
  }
  const decayClusterSweepCells: DecayClusterSweepCell[] = [
    {
      name: 'recent=0, cluster=off (no defenses; both rounds capture)',
      assignment_min_recent: 0,
      stratification_enabled: false,
      expected_attack_succeeded: true,
      expected_attack_succeeded_round_1: true,
      expected_attack_succeeded_round_2: true,
      expected_dave_voted_round_1: true,
      expected_dave_voted_round_2: true,
    },
    {
      name: 'recent=0, cluster=on (cluster signal closes Dave both rounds)',
      assignment_min_recent: 0,
      stratification_enabled: true,
      expected_attack_succeeded: false,
      expected_attack_succeeded_round_1: false,
      expected_attack_succeeded_round_2: false,
      expected_dave_voted_round_1: false,
      expected_dave_voted_round_2: false,
    },
    {
      name: 'recent=0.5, cluster=off (re-prime pays through recent gate; both rounds capture)',
      assignment_min_recent: 0.5,
      stratification_enabled: false,
      expected_attack_succeeded: true,
      expected_attack_succeeded_round_1: true,
      expected_attack_succeeded_round_2: true,
      expected_dave_voted_round_1: true,
      expected_dave_voted_round_2: true,
    },
    {
      name: 'recent=0.5, cluster=on (cluster closure dominates; recent gate adds no marginal closure)',
      assignment_min_recent: 0.5,
      stratification_enabled: true,
      expected_attack_succeeded: false,
      expected_attack_succeeded_round_1: false,
      expected_attack_succeeded_round_2: false,
      expected_dave_voted_round_1: false,
      expected_dave_voted_round_2: false,
    },
  ];
  it.each(decayClusterSweepCells)('(decay × cluster-signal) sweep: $name', async ({
    assignment_min_recent,
    stratification_enabled,
    expected_attack_succeeded,
    expected_attack_succeeded_round_1,
    expected_attack_succeeded_round_2,
    expected_dave_voted_round_1,
    expected_dave_voted_round_2,
  }) => {
    const result = await runDecayClusterMultiRoundScenario({
      assignment_min_recent,
      stratification_enabled,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.attack_succeeded_round_1).toBe(expected_attack_succeeded_round_1);
    expect(result.attack_succeeded_round_2).toBe(expected_attack_succeeded_round_2);
    expect(result.dave_voted_round_1).toBe(expected_dave_voted_round_1);
    expect(result.dave_voted_round_2).toBe(expected_dave_voted_round_2);
  });

  it('(decay × cluster-signal) sweep cube: ASR aggregates by cluster show closure, by recent show invariance (PRD §Reputation, recent gate is solo-design; cluster signal carries coalition closure)', () => {
    interface DecayClusterAsrCell {
      key: string;
      total: number;
      attacks_succeeded: number;
    }
    function group(
      keyOf: (cell: DecayClusterSweepCell) => string,
    ): Map<string, DecayClusterAsrCell> {
      const m = new Map<string, DecayClusterAsrCell>();
      for (const cell of decayClusterSweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { key: k, total: 0, attacks_succeeded: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        m.set(k, g);
      }
      return m;
    }
    const groupedByCluster = group((c) => (c.stratification_enabled ? 'on' : 'off'));
    const groupedByRecent = group((c) => String(c.assignment_min_recent));
    const asrOf = (m: Map<string, DecayClusterAsrCell>, k: string): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.attacks_succeeded / g.total;
    };

    // By cluster: off=100% (both rounds capture in both recent
    // cells — re-prime pays through any recent threshold the cube
    // sweeps), on=0% (cluster signal closes Dave both rounds in
    // both recent cells). The headline closure axis: against
    // multi-round timed coalition amplification, the cluster signal
    // is what does the load-bearing closure work — it operates on
    // coalition structure (cross-stratum gate), independent of
    // adversary timing.
    expect(asrOf(groupedByCluster, 'off')).toBe(1);
    expect(asrOf(groupedByCluster, 'on')).toBe(0);

    // By recent: identical 50% across both threshold values — *the
    // recent-decay gate is ASR-invariant against this multi-round
    // timed coalition pattern*. The re-prime cost is real (Carol
    // and Dave each pay 3 honest accepts per cycle), but the gate
    // alone doesn't translate it into closure: contributor-
    // initiated voting bypasses the recent gate by null-policy
    // (PRD §Reputation, drained-but-honest contributor recovery
    // path), so the adversary pays the accumulation cost upstream
    // of the gate. PRD §Reputation names the recent gate's design
    // role at the *solo* patient adversary where re-priming is
    // unamortized (cube #2's lockout cells calibrated against the
    // solo runner); cube #18 reads that role as inert against the
    // *coalition* variant where re-priming is paid once and the
    // cluster-signal closure does the actual work.
    expect(asrOf(groupedByRecent, '0')).toBe(0.5);
    expect(asrOf(groupedByRecent, '0.5')).toBe(0.5);
    expect(asrOf(groupedByRecent, '0')).toBe(asrOf(groupedByRecent, '0.5'));

    // Coverage invariants: 4 cells, 2 per (cluster) value, 2 per
    // (recent) value. Same shape cubes #6-#17 carry; a future cell
    // expansion that breaks the symmetry trips the assertion and
    // forces the aggregate to be re-keyed.
    for (const cell of groupedByCluster.values()) {
      expect(cell.total).toBe(2);
    }
    for (const cell of groupedByRecent.values()) {
      expect(cell.total).toBe(2);
    }
  });

  // (cross-cause-sybil × min_signal) sweep — cube #19, the adversary
  // -measurement cube on the cross-cause identity-clustering surface
  // ROADMAP §Status's prior next-milestones tail named ("slice 4 of
  // identity-cost is wired as a curator projection but not yet cube-
  // checked against multi-cause sybil farms"). Cubes #6-#9 read the
  // four-layer sybil-resistance architecture's *enforcement* layers
  // (binding cost, issuance cap, per-identity rate-limit) at the
  // write-path gate; cube #19 reads the *visibility* layer (cross-
  // cause identity-clustering, `server.curator.identityClusters`) on
  // the regression-handle attack pattern PRD §Identity bullet 4
  // names: a sybil pair working multiple causes whose cross-cause
  // behavioral fingerprint lights up only when read across the whole
  // graph, with a single-cause honest pair as noise control to read
  // the precision axis alongside recall.
  //
  // The cube is structurally distinct from the prior 18 in that the
  // closure is *visibility for curator action*, not enforcement at
  // the write-path. PRD §Identity bullet 4 commits the projection as
  // a curator surface (specific signals operationally private at the
  // production instance) — the curator's enforcement choice on the
  // surfaced pair is downstream of the projection itself, so the
  // cube reads "did the projection surface the sybil pair" as the
  // ASR proxy and "did it filter the honest pair" as the precision
  // proxy. The mapping: ASR ≡ sybil pair NOT in projection result
  // (operator's perspective: the sybil farm evaded the curator's
  // visibility surface); false_positive_rate ≡ honest pair IN
  // projection result (curator's perspective: the surface lit up
  // against legitimate single-cause coordination).
  //
  // The runner sets up K_sybil causes; sybil pair (alice+bob) co-
  // votes on one excerpt in each cause (cross_cause_count = K_sybil,
  // shared_proposal_count = K_sybil); honest pair (carol+dave) co-
  // votes on one excerpt in cause 0 only (cross_cause_count = 1,
  // shared_proposal_count = 1). The projection is computed at
  // `min_signal=M` and the runner reads pair presence directly off
  // the result list. Cluster-formation under the cube is purely
  // arithmetic — pairs surface iff cross_cause_count ≥ M — so the
  // cube reads M's effect on the precision-recall pivot directly:
  //
  //   - (K=2, M=1): sybil in (count=2 ≥ 1), honest in (count=1 ≥
  //     1) → attack=false, fp=true. Both pairs surface; M=1 is the
  //     "show everything" threshold the v0 default avoids.
  //   - (K=2, M=2): sybil in (2 ≥ 2), honest out (1 < 2) → attack=
  //     false, fp=false. *The precision-recall pivot, the v0
  //     default*: sybil pair surfaces, honest noise filtered.
  //   - (K=2, M=3): sybil out (2 < 3), honest out → attack=true,
  //     fp=false. Tighter threshold lets the K=2 farm evade.
  //   - (K=3, M=1): sybil in, honest in → attack=false, fp=true.
  //   - (K=3, M=2): sybil in (3 ≥ 2), honest out → attack=false,
  //     fp=false.
  //   - (K=3, M=3): sybil in (3 ≥ 3), honest out → attack=false,
  //     fp=false. Wider farms surface at any M ≤ K.
  //
  // Aggregate by min_signal:
  //   - M=1: ASR=0% (everything surfaces), fp_rate=100% (honest noise
  //     surfaces).
  //   - M=2: ASR=0% (sybils all surface), fp_rate=0% (honest filtered)
  //     — *the precision-recall pivot, the v0 default per the
  //     identityClusters() implementation, and the smallest threshold
  //     that filters single-cause coordination noise*.
  //   - M=3: ASR=50% (K=2 evades, K=3 surfaces), fp_rate=0%.
  //
  // Aggregate by K_sybil:
  //   - K=2: ASR=33% (only M=3 evades), fp_rate=33% (only M=1 fp).
  //   - K=3: ASR=0% (no M evades), fp_rate=33% (only M=1 fp).
  //
  // The K=2 vs K=3 ASR difference reads the *operator's spread-thin
  // strategy*: at the v0 default M=2 the projection catches K=2 and
  // K=3 farms uniformly; raising M trades recall (K=2 evades at
  // M=3) for tighter precision the M=2 default already buys for
  // free. The curator's threshold choice is operationally private
  // per PRD §Identity bullet 4 ("methodology is public, tuning is
  // not") — cube #19 reads the public methodology's precision-
  // recall structure across thresholds without committing the v0
  // default to a particular tuning regime.
  //
  // Cube #19 is the visibility-layer sibling of cube #9 (the
  // enforcement-layer cube on the four-layer sybil-resistance
  // architecture): cube #9 reads the cluster-signal × budget-axis
  // composition where the closure is structural at the assignment
  // gate (cross-stratum routing); cube #19 reads the cross-cause
  // identity-clustering projection where the closure is
  // visibility for curator action. The two cubes cover
  // complementary modalities of the same architecture: cube #9 the
  // write-path gate, cube #19 the curator-side surface, both
  // reading regression-handle attack patterns PRD §Identity names
  // by structural framing.
  async function runCrossCauseSybilDetectionScenario(params: {
    sybil_cause_count: number;
    min_signal: number;
  }): Promise<{
    sybil_pair_surfaced: boolean;
    honest_pair_surfaced: boolean;
    attack_succeeded: boolean;
    honest_false_positive: boolean;
    sybil_cross_cause_count: number;
    honest_cross_cause_count: number;
  }> {
    if (params.sybil_cause_count < 2) {
      throw new Error(
        `runCrossCauseSybilDetectionScenario: sybil_cause_count=${params.sybil_cause_count} below 2 — single-cause coordination is not the cross-cause projection's domain by design (PRD §Identity bullet 4); other cubes (e.g. cube #11 stratification on coalition) measure single-cause closure paths`,
      );
    }
    const sources = new Map<string, string>();
    for (let c = 0; c < params.sybil_cause_count; c++) {
      // PMIDs validate as `^\d+$` per the contracts schema; use a
      // deterministic numeric encoding (cause-c → "100+c") rather
      // than letter-prefixed keys so proposeAnchor's input parse
      // doesn't reject the external_ref.
      sources.set(String(100 + c), `cause ${c} sybil paper`);
    }
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('cci'),
      verifier: new FakeVerifier(new Set(), new Map(), sources),
      // No special review config — the projection is a curator-side
      // surface, agnostic to assignment-time and convergence-time
      // knobs. Defaults keep the runner's scope honest: cube #19
      // measures the projection itself, not its interaction with
      // assignment gates or convergence thresholds.
    });
    const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
    const seederCaller = { identity_id: seeder.id };

    interface SybilCause {
      id: CauseId;
      subTopicId: SubTopicId;
      anchorId: NodeId;
    }
    type CauseId = ReturnType<typeof server.bootstrap.createCause>['id'];
    type SubTopicId = ReturnType<typeof server.bootstrap.seedSubTopic>['id'];
    const causes: SybilCause[] = [];
    for (let c = 0; c < params.sybil_cause_count; c++) {
      const cause = server.bootstrap.createCause({
        name: `cause-${c}`,
        description: `cause ${c}`,
      });
      const subTopic = server.bootstrap.seedSubTopic({
        cause_id: cause.id,
        name: `st-${c}`,
        description: 'x',
        scope_query: 'x',
      });
      const anchor = await server.tools.proposeAnchor(seederCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `cause-${c} sybil anchor`,
        external_ref: { kind: 'pmid', value: String(100 + c) },
      });
      server.curator.acceptProposal(anchor.proposal_id);
      const anchorNode = [...server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `cause-${c} sybil anchor`,
      );
      if (!anchorNode) throw new Error(`cause ${c} anchor not materialized`);
      causes.push({ id: cause.id, subTopicId: subTopic.id, anchorId: anchorNode.id });
    }

    // Sybil pair: alice+bob co-vote on one excerpt in each of the
    // K_sybil causes → cross_cause_count = K_sybil,
    // shared_proposal_count = K_sybil. The contributor-initiated
    // path doesn't require capacity (no assignment loop), so the
    // sybil pair operates fresh-from-mint without rep-gate setup.
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    for (const c of causes) {
      const excerpt = await server.tools.proposeExcerpt(seederCaller, {
        cause_id: c.id,
        home_sub_topic_id: c.subTopicId,
        parent_anchor_id: c.anchorId,
        content: 'sybil-shared excerpt',
        quoted_span: { text: 'sybil paper', offset: 0 },
      });
      for (const id of [alice.id, bob.id]) {
        await server.tools.castReviewVote(
          { identity_id: id },
          { proposal_id: excerpt.proposal_id, decision: 'accept', rationale: 'r' },
        );
      }
    }

    // Honest noise pair: carol+dave co-vote on one excerpt in cause
    // 0 only → cross_cause_count = 1, shared_proposal_count = 1.
    // The cube's precision axis: at min_signal=1 they surface as a
    // false positive; at min_signal ≥ 2 they're filtered by the
    // projection threshold.
    const cause0 = causes[0];
    if (!cause0) throw new Error('cause 0 missing');
    const honestExcerpt = await server.tools.proposeExcerpt(seederCaller, {
      cause_id: cause0.id,
      home_sub_topic_id: cause0.subTopicId,
      parent_anchor_id: cause0.anchorId,
      content: 'honest single-cause excerpt',
      quoted_span: { text: 'sybil paper', offset: 0 },
    });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    for (const id of [carol.id, dave.id]) {
      await server.tools.castReviewVote(
        { identity_id: id },
        { proposal_id: honestExcerpt.proposal_id, decision: 'accept', rationale: 'r' },
      );
    }

    const clusters = server.curator.identityClusters({ min_signal: params.min_signal });
    const sybilIds = [alice.id, bob.id].sort();
    const honestIds = [carol.id, dave.id].sort();
    const sybilEntry = clusters.find(
      (c) => [c.identity_a, c.identity_b].sort().join('|') === sybilIds.join('|'),
    );
    const honestEntry = clusters.find(
      (c) => [c.identity_a, c.identity_b].sort().join('|') === honestIds.join('|'),
    );
    return {
      sybil_pair_surfaced: sybilEntry !== undefined,
      honest_pair_surfaced: honestEntry !== undefined,
      attack_succeeded: sybilEntry === undefined,
      honest_false_positive: honestEntry !== undefined,
      sybil_cross_cause_count: sybilEntry?.cross_cause_count ?? 0,
      honest_cross_cause_count: honestEntry?.cross_cause_count ?? 0,
    };
  }

  interface CrossCauseSweepCell {
    name: string;
    sybil_cause_count: number;
    min_signal: number;
    expected_attack_succeeded: boolean;
    expected_honest_false_positive: boolean;
  }
  const crossCauseSweepCells: CrossCauseSweepCell[] = [
    {
      name: 'K_sybil=2, min_signal=1 (everything surfaces; honest noise lights up as false positive)',
      sybil_cause_count: 2,
      min_signal: 1,
      expected_attack_succeeded: false,
      expected_honest_false_positive: true,
    },
    {
      name: 'K_sybil=2, min_signal=2 (precision-recall pivot, v0 default — sybils surface, honest filtered)',
      sybil_cause_count: 2,
      min_signal: 2,
      expected_attack_succeeded: false,
      expected_honest_false_positive: false,
    },
    {
      name: 'K_sybil=2, min_signal=3 (tighter threshold lets K=2 farm evade; honest still filtered)',
      sybil_cause_count: 2,
      min_signal: 3,
      expected_attack_succeeded: true,
      expected_honest_false_positive: false,
    },
    {
      name: 'K_sybil=3, min_signal=1 (everything surfaces; honest noise false positive)',
      sybil_cause_count: 3,
      min_signal: 1,
      expected_attack_succeeded: false,
      expected_honest_false_positive: true,
    },
    {
      name: 'K_sybil=3, min_signal=2 (default; wider farm surfaces, honest filtered)',
      sybil_cause_count: 3,
      min_signal: 2,
      expected_attack_succeeded: false,
      expected_honest_false_positive: false,
    },
    {
      name: 'K_sybil=3, min_signal=3 (M = K_sybil boundary; pair just makes it through)',
      sybil_cause_count: 3,
      min_signal: 3,
      expected_attack_succeeded: false,
      expected_honest_false_positive: false,
    },
  ];
  it.each(crossCauseSweepCells)('(cross-cause-sybil × min_signal) sweep: $name', async ({
    sybil_cause_count,
    min_signal,
    expected_attack_succeeded,
    expected_honest_false_positive,
  }) => {
    const result = await runCrossCauseSybilDetectionScenario({
      sybil_cause_count,
      min_signal,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.honest_false_positive).toBe(expected_honest_false_positive);
    // Regression handle on the projection's metric arithmetic:
    // sybil cross_cause_count must equal sybil_cause_count when
    // surfaced (a future change to the per-pair counting that
    // misses the cause-distinct semantics would surface here
    // before downstream ASR drift). When the pair is below
    // threshold the runner reports 0 by construction (filtered
    // pairs aren't in the result list); the assertion only fires
    // on cells where the pair surfaces.
    if (!expected_attack_succeeded) {
      expect(result.sybil_cross_cause_count).toBe(sybil_cause_count);
    }
    if (expected_honest_false_positive) {
      expect(result.honest_cross_cause_count).toBe(1);
    }
  });

  it('(cross-cause-sybil × min_signal) sweep cube: ASR + false-positive-rate aggregate by min_signal isolates the precision-recall pivot at the v0 default M=2 (PRD §Identity bullet 4, cross-cause clustering as visibility surface)', () => {
    interface CrossCauseAsrCell {
      key: number;
      total: number;
      attacks_succeeded: number;
      false_positives: number;
    }
    function group(keyOf: (cell: CrossCauseSweepCell) => number): Map<number, CrossCauseAsrCell> {
      const m = new Map<number, CrossCauseAsrCell>();
      for (const cell of crossCauseSweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { key: k, total: 0, attacks_succeeded: 0, false_positives: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        if (cell.expected_honest_false_positive) g.false_positives += 1;
        m.set(k, g);
      }
      return m;
    }
    const groupedByMin = group((c) => c.min_signal);
    const groupedByK = group((c) => c.sybil_cause_count);
    const asrOf = (m: Map<number, CrossCauseAsrCell>, k: number): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.attacks_succeeded / g.total;
    };
    const fprOf = (m: Map<number, CrossCauseAsrCell>, k: number): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.false_positives / g.total;
    };

    // By min_signal: the precision-recall pivot reading. M=1 is
    // "show everything" — both metrics at their permissive extreme:
    // ASR=0% (no farm evades) but fp_rate=100% (honest noise lights
    // up). M=2 (the v0 default in identityClusters()) is *the
    // smallest threshold that filters single-cause noise*: ASR
    // stays 0% (all multi-cause farms surface) but fp_rate flips to
    // 0%. M=3 trades recall for nothing — fp_rate already 0% at
    // M=2, but ASR rises to 50% as the K=2 farm evades. The
    // pivot at M=2 is the headline: it's the smallest threshold
    // that achieves perfect precision against single-cause noise
    // without sacrificing any recall against the K ∈ {2, 3} farms
    // the cube measures.
    expect(asrOf(groupedByMin, 1)).toBe(0);
    expect(fprOf(groupedByMin, 1)).toBe(1);
    expect(asrOf(groupedByMin, 2)).toBe(0);
    expect(fprOf(groupedByMin, 2)).toBe(0);
    expect(asrOf(groupedByMin, 3)).toBe(0.5);
    expect(fprOf(groupedByMin, 3)).toBe(0);

    // By K_sybil: the operator's spread-thin reading. K=2 farms
    // evade at M=3 (1/3 cells leak); K=3 farms surface at every M
    // the cube measures (0/3 cells leak). The fp_rate reads
    // identical 33% across both K values because the noise pair is
    // configured at K=1 regardless and only M=1 surfaces it.
    expect(asrOf(groupedByK, 2)).toBeCloseTo(1 / 3);
    expect(asrOf(groupedByK, 3)).toBe(0);
    expect(fprOf(groupedByK, 2)).toBeCloseTo(1 / 3);
    expect(fprOf(groupedByK, 3)).toBeCloseTo(1 / 3);

    // Coverage invariants: 6 cells, 2 per (min_signal) value, 3
    // per (K_sybil) value. Same shape cubes #6-#18 carry; a future
    // cell expansion that breaks the symmetry trips the assertion
    // and forces the aggregate to be re-keyed.
    for (const cell of groupedByMin.values()) {
      expect(cell.total).toBe(2);
    }
    for (const cell of groupedByK.values()) {
      expect(cell.total).toBe(3);
    }
  });

  // (alpha × stratification × demo-threshold) sweep — cube #20, the
  // re-baseline of cube #5's difficulty-aware findings on cube #11's
  // stratification axis the prior next-milestones tail named. Cube #5
  // swept `review_credit_contention_alpha` ∈ {1.0, 0.5} on the
  // patient-adversary gate-threshold cube #2 and pinned the alpha-
  // shrinkage failure mode: at alpha=0.5 the bootstrap demonstrated
  // shrinks from 2.0 to 1.0 and a demo gate calibrated against the
  // alpha=1 bootstrap (1.5) false-positive-locks-out the honest pool,
  // with the re-tuned demo=0.75 recovering the closure with the same
  // 0.25 headroom; cube #5 pinned the recovery on the sybil pattern
  // as a single companion regression at the re-tuned thresholds.
  // Cube #20 generalizes that companion regression into a cube across
  // (alpha × stratification × demo-threshold) on the sybil-amplified-
  // coalition pattern (`runSybilAmplifiedGateScenario`), reading the
  // alpha-recalibration on cube #11's stratification axis — the
  // closure mechanism here is the cross-stratum gate (cluster signal
  // closes Dave) plus the demo gate's null-policy (closes the fresh
  // recruit Eve), not cube #2/#5's recent gate.
  //
  // Eight cells over (`review_credit_contention_alpha` ∈ {1.0, 0.5})
  // × (`stratification_enabled` ∈ {off, on}) × (`assignment_min_
  // demonstrated` ∈ {1.5, 0.75}), `assignment_min_recent`=0
  // throughout (isolating the demo axis the alpha-recalibration acts
  // on). Per-cell readings:
  //
  //   - (alpha=1, strat=off, demo ∈ {1.5, 0.75}): coalition captures
  //     by arithmetic — Carol+Dave's two rejects reach vto=2 before
  //     the honest pool can vote, and their priming demonstrated
  //     (3.0 at alpha=1) clears both demo thresholds. ASR=100%,
  //     lockout=false (Erin's bootstrap demonstrated=2.0 clears the
  //     demo gate, she votes accept first but the coalition's two
  //     rejects converge anyway).
  //   - (alpha=1, strat=on, demo ∈ {1.5, 0.75}): cross-stratum gate
  //     closes Dave, demo gate's null-policy closes Eve (zero rep <
  //     any positive threshold), Carol's lone reject is below vto=2,
  //     and the honest pool (bootstrap demonstrated=2.0 ≥ both
  //     thresholds) converges contested 'accepted' across singleton
  //     strata. ASR=0%, lockout=false.
  //   - (alpha=0.5, strat=off, demo=1.5): Erin's bootstrap
  //     demonstrated shrinks to 1.0 < 1.5 → she's locked out at
  //     request_assignment. Carol+Dave's priming demonstrated is 1.5
  //     (= the threshold, 1.5 < 1.5 is false → passes), so they
  //     route and reject → contested converges 'rejected' at vto=2.
  //     ASR=100%, lockout=true — *the demo gate at alpha=0.5 is
  //     worse than useless here: it fails to gate the coalition
  //     (whose priming demonstrated clears it) while locking out the
  //     honest pool as pure collateral damage*.
  //   - (alpha=0.5, strat=off, demo=0.75): Erin's bootstrap
  //     demonstrated=1.0 ≥ 0.75 → she passes and votes accept first;
  //     Carol+Dave still capture by arithmetic. ASR=100%,
  //     lockout=false — the re-tuned threshold preserves the honest
  //     pool but the coalition still captures (strat=off has no
  //     cluster signal to close Dave).
  //   - (alpha=0.5, strat=on, demo=1.5): cross-stratum gate closes
  //     Dave, demo gate's null-policy closes Eve, and the demo gate
  //     *also* fires on the honest pool (bootstrap demonstrated=1.0 <
  //     1.5) — so contested has Carol's lone reject, no honest
  //     accepts, and the degraded-pool tightening bumps vto past 2 →
  //     contested stalls 'staged'. ASR=0%, lockout=true — *the
  //     misleading-closure cell*: the closure observation (ASR=0%)
  //     reads as honest defense but is actually honest-pool collapse,
  //     the same shape cube #5 read on the recent-gate closure
  //     mechanism. This is the cell the re-tuned threshold recovers.
  //   - (alpha=0.5, strat=on, demo=0.75): Erin's bootstrap
  //     demonstrated=1.0 ≥ 0.75 → honest pool passes and converges
  //     contested 'accepted'; cross-stratum gate still closes Dave,
  //     demo gate's null-policy still closes Eve. ASR=0%,
  //     lockout=false — the re-tuned threshold recovers the
  //     stratification closure's honest-defense reading at alpha=0.5.
  //
  // Aggregate by stratification: off=(ASR=100%, lockout=25%) — the
  // coalition captures regardless of demo/alpha; the demo gate's
  // alpha=0.5 lockout (the demo=1.5 cell) is pure collateral damage.
  // on=(ASR=0%, lockout=25%) — the cross-stratum gate + demo null-
  // policy close capture at every cell; the demo gate's alpha=0.5
  // lockout (the demo=1.5 cell) is what makes that closure
  // observation misleading. *ASR is stratification-determined: the
  // cluster signal is the capture-closure, alpha-invariant; alpha
  // and demo only move the lockout metric* — the closure-quality
  // axis, exactly cube #5's two-metric template generalized to the
  // stratification mechanism.
  //
  // Aggregate by alpha: alpha=1=(ASR=50%, lockout=0%) — the alpha=1
  // bootstrap demonstrated (2.0) clears both demo thresholds, no
  // lockout anywhere. alpha=0.5=(ASR=50%, lockout=50%) — the
  // shrunken bootstrap demonstrated (1.0) trips the demo=1.5
  // threshold at both stratification settings, so the demo=1.5 cells
  // (one strat=off, one strat=on) both lock out.
  //
  // Aggregate by demo-threshold: demo=1.5=(ASR=50%, lockout=50%) —
  // the threshold calibrated against the alpha=1 bootstrap locks out
  // the honest pool at alpha=0.5 regardless of stratification.
  // demo=0.75=(ASR=50%, lockout=0%) — cube #5's re-tuned threshold
  // preserves the 0.25 headroom at alpha=0.5 and is trivially clear
  // at alpha=1, so zero lockout at both alphas. *The re-tuned
  // threshold's recovery is mechanism-agnostic*: cube #5 pinned it
  // on the recent-gate closure (patient archetype); cube #20 reads
  // the same recovery on the stratification closure (coalition
  // archetype), converting the mechanism-agnostic-recalibration
  // claim into a CI-checked invariant.
  //
  // Cube #20 is the alpha-axis sibling of cube #5 (the difficulty-
  // aware re-baseline of cube #2 on the patient archetype): cube #5
  // reads the alpha-recalibration on the recent-gate closure, cube
  // #20 on the stratification closure. Together they pin the
  // recalibration as a property of the demo gate's eligibility-tier
  // role (a threshold calibrated for alpha=1 false-positive-locks-out
  // at alpha < 1, and the re-tuned demo=0.75 recovers it), invariant
  // to which mechanism does the actual capture-closure — cube #14's
  // closure-quality-independence reading applied to the alpha axis.
  interface AlphaStratSweepCell {
    name: string;
    review_credit_contention_alpha: number;
    stratification_enabled: boolean;
    assignment_min_demonstrated: number;
    expected_attack_succeeded: boolean;
    expected_false_positive_lockout: boolean;
  }
  const alphaStratSweepCells: AlphaStratSweepCell[] = [
    {
      name: 'alpha=1, strat=off, demo=1.5 (coalition captures by arithmetic; honest pool clears the demo gate)',
      review_credit_contention_alpha: 1.0,
      stratification_enabled: false,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    {
      name: 'alpha=1, strat=off, demo=0.75 (coalition captures; re-tuned threshold trivially clear)',
      review_credit_contention_alpha: 1.0,
      stratification_enabled: false,
      assignment_min_demonstrated: 0.75,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    {
      name: 'alpha=1, strat=on, demo=1.5 (cross-stratum closes Dave; demo null-policy closes Eve; honest pool converges)',
      review_credit_contention_alpha: 1.0,
      stratification_enabled: true,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
    {
      name: 'alpha=1, strat=on, demo=0.75 (composition closes; honest defense at both metrics)',
      review_credit_contention_alpha: 1.0,
      stratification_enabled: true,
      assignment_min_demonstrated: 0.75,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
    {
      name: 'alpha=0.5, strat=off, demo=1.5 (coalition still captures; demo gate locks out honest pool as collateral damage)',
      review_credit_contention_alpha: 0.5,
      stratification_enabled: false,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: true,
    },
    {
      name: 'alpha=0.5, strat=off, demo=0.75 (coalition still captures; re-tuned threshold preserves honest pool)',
      review_credit_contention_alpha: 0.5,
      stratification_enabled: false,
      assignment_min_demonstrated: 0.75,
      expected_attack_succeeded: true,
      expected_false_positive_lockout: false,
    },
    {
      name: 'alpha=0.5, strat=on, demo=1.5 (misleading closure: cluster closes capture but honest-pool collapse is why ASR reads 0%)',
      review_credit_contention_alpha: 0.5,
      stratification_enabled: true,
      assignment_min_demonstrated: 1.5,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: true,
    },
    {
      name: 'alpha=0.5, strat=on, demo=0.75 (re-tuned threshold recovers honest defense at both metrics)',
      review_credit_contention_alpha: 0.5,
      stratification_enabled: true,
      assignment_min_demonstrated: 0.75,
      expected_attack_succeeded: false,
      expected_false_positive_lockout: false,
    },
  ];
  it.each(alphaStratSweepCells)('(alpha × stratification × demo) sweep: $name', async ({
    review_credit_contention_alpha,
    stratification_enabled,
    assignment_min_demonstrated,
    expected_attack_succeeded,
    expected_false_positive_lockout,
  }) => {
    const result = await runSybilAmplifiedGateScenario({
      assignment_min_recent: 0,
      assignment_min_demonstrated,
      review_credit_contention_alpha,
      stratification_enabled,
    });
    expect(result.attack_succeeded).toBe(expected_attack_succeeded);
    expect(result.false_positive_lockout).toBe(expected_false_positive_lockout);
    // The coalition's post-priming demonstrated (3 unanimous
    // priming accepts × alpha) is what clears the demo gate by the
    // strict-less-than predicate at strat=on — but the value
    // `carol_demonstrated` reports here is read *after* the
    // contested phase, where Carol's reject becomes inaccurate
    // (and alpha-contention-scaled) if contested converges, so
    // it's only 3 × alpha on cells where contested stalls. The
    // priming arithmetic itself is pinned by cube #5's standalone
    // `carol_demonstrated ≈ 1.5` regression (demo=1.5, alpha=0.5,
    // contested stalls staged); cube #20 doesn't re-pin it.
  });

  it('(alpha × stratification × demo) sweep cube: ASR is stratification-determined; lockout-rate carries the alpha-recalibration, recovered by cube #5 re-tuned demo=0.75 (PRD §Reputation, difficulty-normalized review credit)', () => {
    interface AlphaStratAggCell {
      key: string;
      total: number;
      attacks_succeeded: number;
      lockouts: number;
    }
    function group(keyOf: (cell: AlphaStratSweepCell) => string): Map<string, AlphaStratAggCell> {
      const m = new Map<string, AlphaStratAggCell>();
      for (const cell of alphaStratSweepCells) {
        const k = keyOf(cell);
        const g = m.get(k) ?? { key: k, total: 0, attacks_succeeded: 0, lockouts: 0 };
        g.total += 1;
        if (cell.expected_attack_succeeded) g.attacks_succeeded += 1;
        if (cell.expected_false_positive_lockout) g.lockouts += 1;
        m.set(k, g);
      }
      return m;
    }
    const groupedByStrat = group((c) => (c.stratification_enabled ? 'on' : 'off'));
    const groupedByAlpha = group((c) => String(c.review_credit_contention_alpha));
    const groupedByDemo = group((c) => String(c.assignment_min_demonstrated));
    const asrOf = (m: Map<string, AlphaStratAggCell>, k: string): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.attacks_succeeded / g.total;
    };
    const lockoutOf = (m: Map<string, AlphaStratAggCell>, k: string): number => {
      const g = m.get(k);
      if (!g) throw new Error(`missing key=${k}`);
      return g.lockouts / g.total;
    };

    // By stratification: ASR is mechanism-determined — strat=off the
    // coalition captures by arithmetic (Carol+Dave's two rejects
    // reach vto=2 before the honest pool can vote, and their priming
    // demonstrated clears both demo thresholds at both alphas);
    // strat=on the cross-stratum gate closes Dave and the demo
    // null-policy closes Eve, collapsing the coalition's amplification
    // to Carol's lone reject. lockout-rate is identical 25% at both
    // settings — the single demo=1.5-alpha=0.5 cell — but its
    // *meaning* differs: at strat=off it's collateral damage (the
    // attack wins anyway), at strat=on it's the misleading-closure
    // failure mode (the attack appears closed because honest review
    // collapsed). The two-metric template cube #5 introduced reads
    // both — "a defense that closes the attack by collapsing the
    // honest pool is not a defense" — and cube #20 generalizes it
    // from the recent-gate to the stratification closure mechanism.
    expect(asrOf(groupedByStrat, 'off')).toBe(1);
    expect(asrOf(groupedByStrat, 'on')).toBe(0);
    expect(lockoutOf(groupedByStrat, 'off')).toBe(0.25);
    expect(lockoutOf(groupedByStrat, 'on')).toBe(0.25);

    // By alpha: ASR identical 50% (the two strat=off cells capture
    // at each alpha; the two strat=on cells close) — alpha doesn't
    // move ASR. lockout-rate flips from 0% at alpha=1 (the bootstrap
    // demonstrated of 2.0 clears both demo thresholds) to 50% at
    // alpha=0.5 (the shrunken bootstrap demonstrated of 1.0 trips the
    // demo=1.5 threshold at both stratification settings). *This is
    // the alpha-recalibration headline*: the demo gate calibrated
    // against the alpha=1 bootstrap false-positive-locks-out at
    // alpha < 1, the same shape cube #5 read on the patient
    // archetype.
    expect(asrOf(groupedByAlpha, '1')).toBe(0.5);
    expect(asrOf(groupedByAlpha, '0.5')).toBe(0.5);
    expect(lockoutOf(groupedByAlpha, '1')).toBe(0);
    expect(lockoutOf(groupedByAlpha, '0.5')).toBe(0.5);

    // By demo-threshold: ASR identical 50% (the strat axis carries
    // ASR, not the demo threshold). lockout-rate: demo=1.5 at 50%
    // (the threshold calibrated against the alpha=1 bootstrap locks
    // out at alpha=0.5 regardless of stratification), demo=0.75 at
    // 0% (cube #5's re-tuned threshold preserves the 0.25 headroom
    // at alpha=0.5 and is trivially clear at alpha=1). *The re-tuned
    // threshold's recovery is mechanism-agnostic* — cube #5 pinned
    // it on the recent-gate closure, cube #20 reads it on the
    // stratification closure.
    expect(asrOf(groupedByDemo, '1.5')).toBe(0.5);
    expect(asrOf(groupedByDemo, '0.75')).toBe(0.5);
    expect(lockoutOf(groupedByDemo, '1.5')).toBe(0.5);
    expect(lockoutOf(groupedByDemo, '0.75')).toBe(0);

    // Coverage invariants: 8 cells, 4 per (stratification) value, 4
    // per (alpha) value, 4 per (demo) value. Same shape cubes
    // #6-#19 carry; a future cell expansion that breaks the symmetry
    // trips the assertion and forces the aggregate to be re-keyed.
    for (const cell of groupedByStrat.values()) {
      expect(cell.total).toBe(4);
    }
    for (const cell of groupedByAlpha.values()) {
      expect(cell.total).toBe(4);
    }
    for (const cell of groupedByDemo.values()) {
      expect(cell.total).toBe(4);
    }
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
