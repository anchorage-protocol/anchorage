import type { ExternalRef, NodeId, QuotedSpan, Timestamp } from '@anchorage/contracts';
import { describe, expect, it } from 'vitest';
import type { Caller } from './auth.js';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
import { SeededIdGen } from './id-gen.js';
import { Server } from './server.js';
import { FakeVerifier, TransientFetchError, type VerifiedRef, type Verifier } from './verifier.js';

interface Fixture {
  server: Server;
  caller: Caller;
  cause_id: ReturnType<Server['bootstrap']['createCause']>['id'];
  sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
}

function fixture(): Fixture {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('t'),
    verifier: new FakeVerifier(),
  });
  const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
  const st = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'x',
    scope_query: 'x',
  });
  return {
    server,
    caller: { identity_id: identity.id },
    cause_id: cause.id,
    sub_topic_id: st.id,
  };
}

describe('curator.acceptProposal', () => {
  it('materializes an AnchorNode from an accepted anchor proposal', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'Tie et al., ctDNA-guided adjuvant chemotherapy in stage II colon cancer',
      external_ref: { kind: 'pmid', value: '35657323' },
    });

    const { node_id } = f.server.curator.acceptProposal(proposal_id);
    if (!node_id) throw new Error('expected materialized node_id');

    const proposal = f.server.store.proposals.get(proposal_id);
    expect(proposal?.status).toBe('accepted');

    const node = f.server.store.nodes.get(node_id);
    if (node?.kind !== 'anchor') throw new Error('expected anchor node');
    expect(node.status).toBe('active');
    expect(node.created_by).toBe(f.caller.identity_id);
    expect(node.home_sub_topic_id).toBe(f.sub_topic_id);
    expect(node.external_ref).toEqual({ kind: 'pmid', value: '35657323' });
    expect(node.content_hash).toBe('fake:pmid:35657323');
  });

  it('rejects accepting a non-staged proposal', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(proposal_id);
    expect(() => f.server.curator.acceptProposal(proposal_id)).toThrow(ServerError);
  });

  it('materializes an ExcerptNode plus a derives edge from its parent anchor', async () => {
    const f = fixture();
    const { proposal_id: anchor_proposal } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const { node_id: anchor_id } = f.server.curator.acceptProposal(anchor_proposal);
    if (!anchor_id) throw new Error('expected anchor');

    const { proposal_id: excerpt_proposal } = await f.server.tools.proposeExcerpt(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: anchor_id,
      content: 'span content',
      quoted_span: { text: 'span', offset: 0 },
    });
    const { node_id: excerpt_id } = f.server.curator.acceptProposal(excerpt_proposal);
    if (!excerpt_id) throw new Error('expected excerpt');

    const excerpt = f.server.store.nodes.get(excerpt_id);
    if (excerpt?.kind !== 'excerpt') throw new Error('expected excerpt node');
    expect(excerpt.quoted_span).toEqual({ text: 'span', offset: 0 });

    const edges = [...f.server.store.edges.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      kind: 'derives',
      from: anchor_id,
      to: excerpt_id,
      status: 'active',
    });
  });

  it('rejects accepting an excerpt whose parent has been superseded', async () => {
    const f = fixture();
    const { proposal_id: anchor_proposal } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const { node_id: anchor_id } = f.server.curator.acceptProposal(anchor_proposal);
    if (!anchor_id) throw new Error('expected anchor');

    const { proposal_id: excerpt_proposal } = await f.server.tools.proposeExcerpt(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: anchor_id,
      content: 'x',
      quoted_span: { text: 'x', offset: 0 },
    });

    // Simulate the parent being superseded between propose and accept.
    const parent = f.server.store.nodes.get(anchor_id);
    if (parent?.kind !== 'anchor') throw new Error('parent not anchor');
    f.server.store.nodes.set(parent.id, { ...parent, status: 'superseded' });

    expect(() => f.server.curator.acceptProposal(excerpt_proposal)).toThrow(ServerError);
  });

  it('materializes a SynthesisNode with one derives edge per parent', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'a',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const b = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'b',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    const bId = f.server.curator.acceptProposal(b.proposal_id).node_id;
    if (!aId || !bId) throw new Error('expected anchors');

    const { proposal_id } = await f.server.tools.proposeSynthesis(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_ids: [aId, bId],
      content: 'synthesis content',
      kind: 'synthesis',
    });
    const { node_id: synth_id } = f.server.curator.acceptProposal(proposal_id);
    if (!synth_id) throw new Error('expected synthesis');

    const synth = f.server.store.nodes.get(synth_id);
    expect(synth?.kind).toBe('synthesis');

    const incoming = [...f.server.store.edges.values()].filter((e) => e.to === synth_id);
    expect(incoming).toHaveLength(2);
    expect(new Set(incoming.map((e) => e.from))).toEqual(new Set([aId, bId]));
    expect(incoming.every((e) => e.kind === 'derives' && e.status === 'active')).toBe(true);
  });

  it('materializes a supersedes edge and flips the from-node to superseded', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'old',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const b = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'new',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    const bId = f.server.curator.acceptProposal(b.proposal_id).node_id;
    if (!aId || !bId) throw new Error('expected anchors');

    const { proposal_id } = await f.server.tools.proposeSupersedes(f.caller, {
      from_node_id: aId,
      to_node_id: bId,
      rationale: 'b corrects a',
    });
    const result = f.server.curator.acceptProposal(proposal_id);
    // supersedes does not create a node.
    expect(result.node_id).toBeUndefined();

    const fromNode = f.server.store.nodes.get(aId);
    expect(fromNode?.status).toBe('superseded');
    const toNode = f.server.store.nodes.get(bId);
    expect(toNode?.status).toBe('active');

    const supersedesEdges = [...f.server.store.edges.values()].filter(
      (e) => e.kind === 'supersedes',
    );
    expect(supersedesEdges).toHaveLength(1);
    expect(supersedesEdges[0]).toMatchObject({
      kind: 'supersedes',
      from: aId,
      to: bId,
      status: 'active',
      rationale: 'b corrects a',
    });
  });

  it('rejects accepting a supersedes whose from node was superseded between propose and accept', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'old',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const b = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'new',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    const bId = f.server.curator.acceptProposal(b.proposal_id).node_id;
    if (!aId || !bId) throw new Error('expected anchors');

    const { proposal_id } = await f.server.tools.proposeSupersedes(f.caller, {
      from_node_id: aId,
      to_node_id: bId,
      rationale: 'x',
    });

    // Simulate a different supersedes path having flipped a inactive
    // between propose and accept.
    const aNode = f.server.store.nodes.get(aId);
    if (!aNode) throw new Error('a missing');
    f.server.store.nodes.set(aId, { ...aNode, status: 'superseded' });

    expect(() => f.server.curator.acceptProposal(proposal_id)).toThrow(ServerError);
  });

  it('materializes a membership by appending to scope_memberships', async () => {
    const f = fixture();
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: f.cause_id,
      name: 'lynch-surveillance',
      description: 'x',
      scope_query: 'x',
    });
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'msi-high crc definition',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    const { proposal_id } = await f.server.tools.proposeMembership(f.caller, {
      node_id: aId,
      sub_topic_id: otherSt.id,
    });
    const result = f.server.curator.acceptProposal(proposal_id);
    expect(result.node_id).toBeUndefined();

    const updated = f.server.store.nodes.get(aId);
    expect(updated?.scope_memberships).toEqual([otherSt.id]);
    expect(updated?.home_sub_topic_id).toBe(f.sub_topic_id);
    expect(updated?.status).toBe('active');
    // No edges are created — memberships are a node property, not an
    // edge type (PRD §Edges).
    expect(f.server.store.edges.size).toBe(0);
  });

  it('rejects accepting a membership whose node has been superseded between propose and accept', async () => {
    const f = fixture();
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: f.cause_id,
      name: 'lynch-surveillance',
      description: 'x',
      scope_query: 'x',
    });
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    const { proposal_id } = await f.server.tools.proposeMembership(f.caller, {
      node_id: aId,
      sub_topic_id: otherSt.id,
    });
    const node = f.server.store.nodes.get(aId);
    if (!node) throw new Error('node missing');
    f.server.store.nodes.set(aId, { ...node, status: 'superseded' });
    expect(() => f.server.curator.acceptProposal(proposal_id)).toThrow(ServerError);
  });

  it('materializes change_of_home by rewriting home and preserving unrelated memberships', async () => {
    const f = fixture();
    const second = f.server.bootstrap.seedSubTopic({
      cause_id: f.cause_id,
      name: 'screening-adherence',
      description: 'x',
      scope_query: 'x',
    });
    const third = f.server.bootstrap.seedSubTopic({
      cause_id: f.cause_id,
      name: 'lynch-surveillance',
      description: 'x',
      scope_query: 'x',
    });
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      memberships: [third.id],
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    const { proposal_id } = await f.server.tools.proposeChangeOfHome(f.caller, {
      node_id: aId,
      new_home_sub_topic_id: second.id,
      rationale: 'misfiled',
    });
    const result = f.server.curator.acceptProposal(proposal_id);
    expect(result.node_id).toBeUndefined();

    const updated = f.server.store.nodes.get(aId);
    expect(updated?.home_sub_topic_id).toBe(second.id);
    // PRD §Change of home: memberships unaffected when the new home
    // wasn't already in the list.
    expect(updated?.scope_memberships).toEqual([third.id]);
  });

  it('strips the new home from scope_memberships when promoting an existing member', async () => {
    const f = fixture();
    const second = f.server.bootstrap.seedSubTopic({
      cause_id: f.cause_id,
      name: 'screening-adherence',
      description: 'x',
      scope_query: 'x',
    });
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      memberships: [second.id],
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    const { proposal_id } = await f.server.tools.proposeChangeOfHome(f.caller, {
      node_id: aId,
      new_home_sub_topic_id: second.id,
      rationale: 'promoting an existing member',
    });
    f.server.curator.acceptProposal(proposal_id);

    const updated = f.server.store.nodes.get(aId);
    expect(updated?.home_sub_topic_id).toBe(second.id);
    // The previously-membership-now-home entry is stripped (PRD §Change
    // of home: home is implicitly in scope, leaving it in
    // scope_memberships would be a redundant duplicate).
    expect(updated?.scope_memberships).toEqual([]);
  });

  it('materializes a sub_topic proposal as an active SubTopic on accept', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeSubTopic(f.caller, {
      cause_id: f.cause_id,
      name: 'lynch-surveillance',
      description: 'Lynch surveillance',
      scope_query: 'lynch',
    });
    const result = f.server.curator.acceptProposal(proposal_id);
    expect(result.node_id).toBeUndefined();
    if (!result.sub_topic_id) throw new Error('expected sub_topic_id');

    const created = f.server.store.subTopics.get(result.sub_topic_id);
    expect(created?.name).toBe('lynch-surveillance');
    expect(created?.status).toBe('active');
    expect(created?.cause_id).toBe(f.cause_id);
  });

  it('materializes a sub_topic proposal as a proposed SubTopic on defer', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeSubTopic(f.caller, {
      cause_id: f.cause_id,
      name: 'crc-microbiome',
      description: 'gut microbiome and CRC',
      scope_query: 'microbiome',
    });
    const { sub_topic_id } = f.server.curator.deferSubTopic(proposal_id);

    const created = f.server.store.subTopics.get(sub_topic_id);
    expect(created?.status).toBe('proposed');
    // The proposal is resolved (status accepted) — proposed is a
    // SubTopic state, not a Proposal state.
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('accepted');
  });

  it('rejects deferring a non-sub_topic proposal', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    expect(() => f.server.curator.deferSubTopic(proposal_id)).toThrow(ServerError);
  });

  it('rejects deferring a non-staged proposal', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeSubTopic(f.caller, {
      cause_id: f.cause_id,
      name: 'x',
      description: 'x',
      scope_query: 'x',
    });
    f.server.curator.acceptProposal(proposal_id);
    expect(() => f.server.curator.deferSubTopic(proposal_id)).toThrow(ServerError);
  });

  it('rejects an unknown proposal id', () => {
    const f = fixture();
    try {
      // biome-ignore lint/suspicious/noExplicitAny: fabricating an unknown id
      f.server.curator.acceptProposal('prp_nope' as any);
      expect.fail('expected ServerError');
    } catch (err) {
      expect((err as ServerError).code).toBe('not_found');
    }
  });
});

describe('curator.rejectProposal', () => {
  it('closes a staged proposal as rejected without materializing a node', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const nodesBefore = f.server.store.nodes.size;
    f.server.curator.rejectProposal(proposal_id);
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('rejected');
    expect(f.server.store.nodes.size).toBe(nodesBefore);
  });

  it('rejects rejecting a non-staged proposal', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(proposal_id);
    expect(() => f.server.curator.rejectProposal(proposal_id)).toThrow(ServerError);
  });

  it('rejects an unknown proposal id', () => {
    const f = fixture();
    try {
      // biome-ignore lint/suspicious/noExplicitAny: fabricating an unknown id
      f.server.curator.rejectProposal('prp_nope' as any);
      expect.fail('expected ServerError');
    } catch (err) {
      expect((err as ServerError).code).toBe('not_found');
    }
  });
});

// Slice 7b — curator-side read projections on `server.resources.*`.
// These wrap the same in-process `server.curator.*` namespace the
// MCP curator tools wrap, with one added concern: a role check.
// The wire-level `wrapCurator` (slice 7a) gates the MCP tool path;
// `requireCurator` gates the web-tier read path. Both refuse with
// the typed `permission_denied` code so the web handler can map
// it to 403 the same way the HTTP transport does for the MCP
// path.
describe('curator-side resource read projections (slice 7b)', () => {
  function curatorFixture(): {
    server: Server;
    contributorCaller: Caller;
    curatorCaller: Caller;
    cause_id: ReturnType<Server['bootstrap']['createCause']>['id'];
    sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
  } {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('t7b'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const carol = server.bootstrap.mintIdentity({
      display_name: 'carol',
      role: 'curator',
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const st = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'x',
      scope_query: 'x',
    });
    return {
      server,
      contributorCaller: { identity_id: alice.id },
      curatorCaller: { identity_id: carol.id },
      cause_id: cause.id,
      sub_topic_id: st.id,
    };
  }

  it('getCuratorQueue refuses a non-curator caller with permission_denied', async () => {
    const f = curatorFixture();
    await expect(f.server.resources.getCuratorQueue(f.contributorCaller)).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  it('getCuratorQueue returns every staged proposal, oldest first', async () => {
    const f = curatorFixture();
    // Two anchor proposals staged across the clock; the queue
    // returns them in creation order.
    const first = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'first',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const second = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'second',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const queue = await f.server.resources.getCuratorQueue(f.curatorCaller);
    expect(queue.proposals.map((p) => p.id)).toEqual([first.proposal_id, second.proposal_id]);
    // Accepting one removes it from the queue.
    f.server.curator.acceptProposal(first.proposal_id);
    const after = await f.server.resources.getCuratorQueue(f.curatorCaller);
    expect(after.proposals.map((p) => p.id)).toEqual([second.proposal_id]);
  });

  it('getCuratorQueue filters by cause_id when provided', async () => {
    const f = curatorFixture();
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'x' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'amr-st',
      description: 'x',
      scope_query: 'x',
    });
    await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'in-cause',
      external_ref: { kind: 'pmid', value: '1' },
    });
    await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: otherCause.id,
      home_sub_topic_id: otherSt.id,
      content: 'other-cause',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const inCause = await f.server.resources.getCuratorQueue(f.curatorCaller, {
      cause_id: f.cause_id,
    });
    expect(inCause.proposals).toHaveLength(1);
    expect(inCause.proposals[0]?.payload.kind).toBe('anchor');
    const inOther = await f.server.resources.getCuratorQueue(f.curatorCaller, {
      cause_id: otherCause.id,
    });
    expect(inOther.proposals).toHaveLength(1);
  });

  it('getCuratorIdentityClusters refuses non-curators', async () => {
    const f = curatorFixture();
    await expect(
      f.server.resources.getCuratorIdentityClusters(f.contributorCaller),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('getCuratorIdentityClusters delegates to the curator namespace', async () => {
    // Same data as the in-process namespace would return — the
    // resource path is a role-gated wrapper, not a re-implementation.
    const f = curatorFixture();
    const clusters = await f.server.resources.getCuratorIdentityClusters(f.curatorCaller);
    expect(clusters.pairs).toEqual(f.server.curator.identityClusters());
  });

  it('refuses a curator whose identity was revoked (unauthorized at the seam)', async () => {
    const f = curatorFixture();
    const carol = f.server.store.identities.get(f.curatorCaller.identity_id);
    if (!carol) throw new Error('curator vanished');
    f.server.store.identities.set(carol.id, { ...carol, status: 'revoked' });
    await expect(f.server.resources.getCuratorQueue(f.curatorCaller)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

// MutableVerifier: a fake verifier whose hash per ref can change
// between calls, so a test can stage drift by mutating the map after
// initial materialization. `unresolvable` flips a ref to "verifier
// throws" mid-test, exercising the host-gone / retraction branch.
class MutableVerifier implements Verifier {
  readonly hashes = new Map<string, string>();
  readonly unresolvable = new Set<string>();
  readonly transient = new Set<string>();
  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    if (this.transient.has(ref.value)) {
      throw new TransientFetchError(
        503,
        `source fetch temporarily unavailable: ${ref.value} (HTTP 503); retry later`,
      );
    }
    if (this.unresolvable.has(ref.value)) {
      throw new ServerError('invalid_input', `external_ref does not resolve: ${ref.value}`);
    }
    const content_hash = this.hashes.get(ref.value) ?? `mut:${ref.kind}:${ref.value}`;
    return { content_hash };
  }
  async verifySpan(_ref: ExternalRef, _span: QuotedSpan): Promise<void> {
    // no-op
  }
}

describe('curator.reverifyAnchor (slice 7c)', () => {
  // The drift fixture wires a curator role plus a mutable verifier
  // whose hash for each ref the tests can change mid-fixture; the
  // tests then drive an anchor through propose → accept → reverify
  // along the path the production scheduler will tick.
  function driftFixture(): {
    server: Server;
    clock: FakeClock;
    verifier: MutableVerifier;
    contributorCaller: Caller;
    curatorCaller: Caller;
    cause_id: ReturnType<Server['bootstrap']['createCause']>['id'];
    sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
  } {
    const verifier = new MutableVerifier();
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('t7c'),
      verifier,
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const carol = server.bootstrap.mintIdentity({
      display_name: 'carol',
      role: 'curator',
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const st = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'x',
      scope_query: 'x',
    });
    return {
      server,
      clock,
      verifier,
      contributorCaller: { identity_id: alice.id },
      curatorCaller: { identity_id: carol.id },
      cause_id: cause.id,
      sub_topic_id: st.id,
    };
  }

  async function landAnchor(
    f: ReturnType<typeof driftFixture>,
    pmid: string,
  ): Promise<{ anchor_id: NodeId; initial_hash: string; initial_verified_at: Timestamp }> {
    const { proposal_id } = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: `anchor for ${pmid}`,
      external_ref: { kind: 'pmid', value: pmid },
    });
    const { node_id } = f.server.curator.acceptProposal(proposal_id);
    if (!node_id) throw new Error('expected materialized anchor node_id');
    const node = f.server.store.nodes.get(node_id);
    if (node?.kind !== 'anchor') throw new Error('expected anchor node');
    return {
      anchor_id: node_id,
      initial_hash: node.content_hash,
      initial_verified_at: node.last_verified_at,
    };
  }

  it('sets last_verified_at on initial verify (acceptance time)', async () => {
    const f = driftFixture();
    const { anchor_id, initial_verified_at } = await landAnchor(f, '1001');
    const node = f.server.store.nodes.get(anchor_id);
    if (node?.kind !== 'anchor') throw new Error('expected anchor');
    expect(node.last_verified_at).toBe(initial_verified_at);
    expect(node.last_verified_at).toBe(node.created_at);
  });

  it('bumps last_verified_at when the hash still matches; leaves updated_at alone', async () => {
    const f = driftFixture();
    const { anchor_id, initial_hash, initial_verified_at } = await landAnchor(f, '1002');
    const before = f.server.store.nodes.get(anchor_id);
    if (before?.kind !== 'anchor') throw new Error('expected anchor');
    const initialUpdatedAt = before.updated_at;
    // Verifier still returns the same hash on re-fetch.
    const result = await f.server.curator.reverifyAnchor(anchor_id);
    expect(result.outcome).toBe('unchanged');
    expect(result.content_hash).toBe(initial_hash);
    expect(result.last_verified_at > initial_verified_at).toBe(true);
    const after = f.server.store.nodes.get(anchor_id);
    if (after?.kind !== 'anchor') throw new Error('expected anchor');
    expect(after.status).toBe('active');
    expect(after.last_verified_at).toBe(result.last_verified_at);
    // updated_at must not move on a verification heartbeat — staleness
    // logic that keys off updated_at (assignment expiry, proposal
    // archival) reads "user-meaningful change," not background poll.
    expect(after.updated_at).toBe(initialUpdatedAt);
  });

  it('flips active → unresolvable on drift, preserving last_verified_at', async () => {
    const f = driftFixture();
    const { anchor_id, initial_hash, initial_verified_at } = await landAnchor(f, '1003');
    // Stage drift: same ref now resolves to a different hash.
    f.verifier.hashes.set('1003', `mut:pmid:1003:drifted`);
    const result = await f.server.curator.reverifyAnchor(anchor_id);
    expect(result.outcome).toBe('unresolvable');
    expect(result.content_hash).toBe(initial_hash);
    // last_verified_at is the *stored* timestamp on the now-flipped
    // anchor — the moment the source was last known good — not a
    // fresh now().
    expect(result.last_verified_at).toBe(initial_verified_at);
    const after = f.server.store.nodes.get(anchor_id);
    if (after?.kind !== 'anchor') throw new Error('expected anchor');
    expect(after.status).toBe('unresolvable');
    expect(after.last_verified_at).toBe(initial_verified_at);
    // updated_at moved: the flip is a meaningful state change the
    // curator surface keys on.
    expect(after.updated_at > initial_verified_at).toBe(true);
  });

  it('flips active → unresolvable when the verifier itself refuses (host gone / retraction)', async () => {
    const f = driftFixture();
    const { anchor_id } = await landAnchor(f, '1004');
    f.verifier.unresolvable.add('1004');
    const result = await f.server.curator.reverifyAnchor(anchor_id);
    expect(result.outcome).toBe('unresolvable');
    const after = f.server.store.nodes.get(anchor_id);
    if (after?.kind !== 'anchor') throw new Error('expected anchor');
    expect(after.status).toBe('unresolvable');
  });

  it('reports transient on upstream 429/5xx and persists nothing', async () => {
    // A TransientFetchError is evidence about the upstream, not the
    // source: the anchor must stay active with both timestamps
    // untouched, so the next scheduler tick retries for free.
    const f = driftFixture();
    const { anchor_id, initial_hash, initial_verified_at } = await landAnchor(f, '1012');
    const before = f.server.store.nodes.get(anchor_id);
    if (before?.kind !== 'anchor') throw new Error('expected anchor');
    f.verifier.transient.add('1012');
    const result = await f.server.curator.reverifyAnchor(anchor_id);
    expect(result.outcome).toBe('transient');
    expect(result.content_hash).toBe(initial_hash);
    expect(result.last_verified_at).toBe(initial_verified_at);
    const after = f.server.store.nodes.get(anchor_id);
    if (after?.kind !== 'anchor') throw new Error('expected anchor');
    expect(after.status).toBe('active');
    expect(after.last_verified_at).toBe(initial_verified_at);
    expect(after.updated_at).toBe(before.updated_at);
    // Upstream recovers: the same anchor re-verifies cleanly.
    f.verifier.transient.delete('1012');
    const retry = await f.server.curator.reverifyAnchor(anchor_id);
    expect(retry.outcome).toBe('unchanged');
  });

  it('refuses re-verification on non-active anchors', async () => {
    const f = driftFixture();
    const { anchor_id } = await landAnchor(f, '1005');
    // Flip to unresolvable once.
    f.verifier.unresolvable.add('1005');
    await f.server.curator.reverifyAnchor(anchor_id);
    // Second attempt now refuses — unresolvable is terminal; recovery
    // is via supersedes from a contributor proposal.
    await expect(f.server.curator.reverifyAnchor(anchor_id)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('recovers an unresolvable anchor via propose_supersedes from a fresh external_ref', async () => {
    // The documented recovery from the terminal re-verification state
    // (PRD §Verification engine): a fresh anchor supersedes the dead
    // one. The from-end status gate must admit `unresolvable` at both
    // propose time and acceptance, or the state is a permanent dead end.
    const f = driftFixture();
    const { anchor_id: dead_id } = await landAnchor(f, '1007');
    f.verifier.unresolvable.add('1007');
    await f.server.curator.reverifyAnchor(dead_id);
    const { anchor_id: fresh_id } = await landAnchor(f, '1008');

    const { proposal_id } = await f.server.tools.proposeSupersedes(f.contributorCaller, {
      from_node_id: dead_id,
      to_node_id: fresh_id,
      rationale: 'source no longer resolves; fresh ref carries the same claim',
    });
    f.server.curator.acceptProposal(proposal_id);

    const dead = f.server.store.nodes.get(dead_id);
    expect(dead?.status).toBe('superseded');
    const fresh = f.server.store.nodes.get(fresh_id);
    expect(fresh?.status).toBe('active');
    const edge = [...f.server.store.edges.values()].find(
      (e) => e.kind === 'supersedes' && e.from === dead_id && e.to === fresh_id,
    );
    expect(edge?.status).toBe('active');
  });

  it('still refuses propose_supersedes from a rejected or superseded node', async () => {
    // The unresolvable carve-out must not loosen the gate for the
    // other non-active statuses: superseding an already-superseded
    // node would fork the lineage chain.
    const f = driftFixture();
    const { anchor_id: dead_id } = await landAnchor(f, '1009');
    const { anchor_id: fresh_id } = await landAnchor(f, '1010');
    const { anchor_id: third_id } = await landAnchor(f, '1011');
    const { proposal_id } = await f.server.tools.proposeSupersedes(f.contributorCaller, {
      from_node_id: dead_id,
      to_node_id: fresh_id,
      rationale: 'replace',
    });
    f.server.curator.acceptProposal(proposal_id);
    // dead_id is now `superseded`; a second supersedes from it refuses.
    await expect(
      f.server.tools.proposeSupersedes(f.contributorCaller, {
        from_node_id: dead_id,
        to_node_id: third_id,
        rationale: 'fork attempt',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('does not resurrect an anchor superseded while the re-verification fetch was in flight', async () => {
    // No store write from a pre-await snapshot: reverifyAnchor reads
    // the node, awaits the fetch, then writes. A supersedes accepted
    // inside that window has already flipped the node out of `active`;
    // writing the stale spread back would silently resurrect it.
    let release: (() => void) | undefined;
    const inner = new MutableVerifier();
    const gated: Verifier = {
      async verifyExternalRef(ref) {
        if (release !== undefined) throw new Error('one gate at a time');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        release = undefined;
        return inner.verifyExternalRef(ref);
      },
      verifySpan: (ref, span) => inner.verifySpan(ref, span),
    };
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({ clock, idGen: new SeededIdGen('t7cr'), verifier: inner });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const aliceCaller: Caller = { identity_id: alice.id };
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const st = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'x',
      scope_query: 'x',
    });
    const land = async (pmid: string): Promise<NodeId> => {
      const { proposal_id } = await server.tools.proposeAnchor(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: st.id,
        content: pmid,
        external_ref: { kind: 'pmid', value: pmid },
      });
      const { node_id } = server.curator.acceptProposal(proposal_id);
      if (!node_id) throw new Error('expected anchor');
      return node_id;
    };
    const oldId = await land('3001');
    const newId = await land('3002');
    const { proposal_id: supersedes } = await server.tools.proposeSupersedes(aliceCaller, {
      from_node_id: oldId,
      to_node_id: newId,
      rationale: 'replacement',
    });
    // Swap in the gated verifier and start the re-verification; it
    // parks inside the fetch with a pre-await snapshot of the old node.
    (server as unknown as { verifier: Verifier }).verifier = gated;
    const inFlight = server.curator.reverifyAnchor(oldId);
    await Promise.resolve(); // let reverifyAnchor reach its await
    // The supersedes lands while the fetch is in flight.
    server.curator.acceptProposal(supersedes);
    expect(server.store.nodes.get(oldId)?.status).toBe('superseded');
    release?.();
    await expect(inFlight).rejects.toMatchObject({ code: 'invalid_state' });
    // The stale spread was not written back: the node stays superseded.
    expect(server.store.nodes.get(oldId)?.status).toBe('superseded');
  });

  it('refuses re-verification on a non-anchor node', async () => {
    const f = driftFixture();
    const { anchor_id } = await landAnchor(f, '1006');
    const { proposal_id: excerpt_proposal } = await f.server.tools.proposeExcerpt(
      f.contributorCaller,
      {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        parent_anchor_id: anchor_id,
        content: 'verbatim span',
        quoted_span: { text: 'verbatim', offset: 0 },
      },
    );
    const { node_id: excerpt_id } = f.server.curator.acceptProposal(excerpt_proposal);
    if (!excerpt_id) throw new Error('expected excerpt id');
    await expect(f.server.curator.reverifyAnchor(excerpt_id)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('refuses an unknown anchor id', async () => {
    const f = driftFixture();
    await expect(
      f.server.curator.reverifyAnchor('n_does_not_exist' as NodeId),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('curator.reverifyDueAnchors (slice 7c)', () => {
  function driftFixture() {
    const verifier = new MutableVerifier();
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('t7cb'),
      verifier,
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const st = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'x',
      scope_query: 'x',
    });
    return {
      server,
      clock,
      verifier,
      contributorCaller: { identity_id: alice.id } as Caller,
      cause_id: cause.id,
      sub_topic_id: st.id,
    };
  }

  it('picks oldest last_verified_at first, capped by batch_size', async () => {
    const f = driftFixture();
    // Land three anchors at distinct clock ticks; each tick advances
    // 1s so last_verified_at differs across them.
    const ids: NodeId[] = [];
    for (const pmid of ['2001', '2002', '2003']) {
      const { proposal_id } = await f.server.tools.proposeAnchor(f.contributorCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: pmid,
        external_ref: { kind: 'pmid', value: pmid },
      });
      const { node_id } = f.server.curator.acceptProposal(proposal_id);
      if (!node_id) throw new Error('expected anchor id');
      ids.push(node_id);
    }
    // Jump forward well past max_age_ms so all three are eligible.
    f.clock.advance(60_000);
    const out = await f.server.curator.reverifyDueAnchors({
      batch_size: 2,
      max_age_ms: 1_000,
    });
    expect(out.checked).toBe(2);
    expect(out.unchanged).toBe(2);
    expect(out.unresolvable).toBe(0);
    // The two oldest by last_verified_at — the first two materialized.
    expect(out.anchors.map((a) => a.anchor_id)).toEqual([ids[0], ids[1]]);
  });

  it('skips anchors whose last_verified_at is fresher than max_age_ms', async () => {
    const f = driftFixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'fresh',
      external_ref: { kind: 'pmid', value: '2100' },
    });
    f.server.curator.acceptProposal(proposal_id);
    // No clock advance: the anchor was just verified, every threshold > 0 leaves it ineligible.
    const out = await f.server.curator.reverifyDueAnchors({
      batch_size: 10,
      max_age_ms: 60_000,
    });
    expect(out.checked).toBe(0);
    expect(out.anchors).toEqual([]);
  });

  it('accumulates outcomes across the batch (mix of unchanged and drift)', async () => {
    const f = driftFixture();
    const anchorIds: Record<string, NodeId> = {};
    for (const pmid of ['2201', '2202', '2203']) {
      const { proposal_id } = await f.server.tools.proposeAnchor(f.contributorCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: pmid,
        external_ref: { kind: 'pmid', value: pmid },
      });
      const { node_id } = f.server.curator.acceptProposal(proposal_id);
      if (!node_id) throw new Error('expected anchor');
      anchorIds[pmid] = node_id;
    }
    // Stage drift on the middle one; advance past the freshness window.
    f.verifier.hashes.set('2202', 'mut:pmid:2202:drifted');
    f.clock.advance(60_000);
    const out = await f.server.curator.reverifyDueAnchors({
      batch_size: 10,
      max_age_ms: 1_000,
    });
    expect(out.checked).toBe(3);
    expect(out.unchanged).toBe(2);
    expect(out.unresolvable).toBe(1);
    const flipped = out.anchors.find((a) => a.outcome === 'unresolvable');
    expect(flipped?.anchor_id).toBe(anchorIds['2202']);
  });

  it('honors cause_id filter', async () => {
    const f = driftFixture();
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'x' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'amr-st',
      description: 'x',
      scope_query: 'x',
    });
    const inCause = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'in',
      external_ref: { kind: 'pmid', value: '2301' },
    });
    f.server.curator.acceptProposal(inCause.proposal_id);
    const outCause = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: otherCause.id,
      home_sub_topic_id: otherSt.id,
      content: 'out',
      external_ref: { kind: 'pmid', value: '2302' },
    });
    f.server.curator.acceptProposal(outCause.proposal_id);
    f.clock.advance(60_000);
    const out = await f.server.curator.reverifyDueAnchors({
      batch_size: 10,
      max_age_ms: 1_000,
      cause_id: otherCause.id,
    });
    expect(out.checked).toBe(1);
    expect(out.anchors[0]?.anchor_id).toBeDefined();
  });

  it('stops the batch early on the first transient outcome', async () => {
    // Upstream rate-limit/outage hits the whole batch: stop on the
    // first transient signal instead of hammering the host, and leave
    // the unprocessed remainder untouched so it sorts first next tick.
    const f = driftFixture();
    const ids: NodeId[] = [];
    for (const pmid of ['2401', '2402', '2403']) {
      const { proposal_id } = await f.server.tools.proposeAnchor(f.contributorCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: pmid,
        external_ref: { kind: 'pmid', value: pmid },
      });
      const { node_id } = f.server.curator.acceptProposal(proposal_id);
      if (!node_id) throw new Error('expected anchor');
      ids.push(node_id);
    }
    // The oldest anchor (first landed) hits the outage.
    f.verifier.transient.add('2401');
    f.clock.advance(60_000);
    const out = await f.server.curator.reverifyDueAnchors({
      batch_size: 10,
      max_age_ms: 1_000,
    });
    expect(out.checked).toBe(1);
    expect(out.transient).toBe(1);
    expect(out.unchanged).toBe(0);
    expect(out.unresolvable).toBe(0);
    expect(out.anchors).toEqual([{ anchor_id: ids[0], outcome: 'transient' }]);
    // Nothing flipped, nothing bumped: all three remain active and
    // eligible for the next tick.
    for (const id of ids) {
      expect(f.server.store.nodes.get(id)?.status).toBe('active');
    }
  });

  it('no-ops on a non-positive batch_size', async () => {
    const f = driftFixture();
    const out = await f.server.curator.reverifyDueAnchors({ batch_size: 0, max_age_ms: 0 });
    expect(out).toEqual({ checked: 0, unchanged: 0, unresolvable: 0, transient: 0, anchors: [] });
  });
});

describe('curator-side unresolvable-anchors projection (slice 7c)', () => {
  function curatorFixture() {
    const verifier = new MutableVerifier();
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 1000);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('t7cp'),
      verifier,
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const carol = server.bootstrap.mintIdentity({
      display_name: 'carol',
      role: 'curator',
    });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const st = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'x',
      scope_query: 'x',
    });
    return {
      server,
      clock,
      verifier,
      contributorCaller: { identity_id: alice.id } as Caller,
      curatorCaller: { identity_id: carol.id } as Caller,
      cause_id: cause.id,
      sub_topic_id: st.id,
    };
  }

  it('refuses a non-curator caller with permission_denied', async () => {
    const f = curatorFixture();
    await expect(
      f.server.resources.getCuratorUnresolvableAnchors(f.contributorCaller),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('lists every unresolvable anchor with ref + hash + verified_at + updated_at', async () => {
    const f = curatorFixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'a',
      external_ref: { kind: 'pmid', value: '3001' },
    });
    const { node_id } = f.server.curator.acceptProposal(proposal_id);
    if (!node_id) throw new Error('expected anchor');
    // Drift, then sweep.
    f.verifier.hashes.set('3001', 'mut:pmid:3001:drifted');
    await f.server.curator.reverifyAnchor(node_id);
    const out = await f.server.resources.getCuratorUnresolvableAnchors(f.curatorCaller);
    expect(out.anchors).toHaveLength(1);
    const row = out.anchors[0];
    if (!row) throw new Error('expected row');
    expect(row.anchor_id).toBe(node_id);
    expect(row.home_sub_topic_id).toBe(f.sub_topic_id);
    expect(row.cause_id).toBe(f.cause_id);
    expect(row.external_ref).toEqual({ kind: 'pmid', value: '3001' });
    expect(row.content_hash.length).toBeGreaterThan(0);
    expect(row.last_verified_at < row.updated_at).toBe(true);
  });

  it('returns most-recent-drift-first', async () => {
    const f = curatorFixture();
    const ids: NodeId[] = [];
    for (const pmid of ['3101', '3102']) {
      const { proposal_id } = await f.server.tools.proposeAnchor(f.contributorCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: pmid,
        external_ref: { kind: 'pmid', value: pmid },
      });
      const { node_id } = f.server.curator.acceptProposal(proposal_id);
      if (!node_id) throw new Error('expected anchor');
      ids.push(node_id);
    }
    // Drift the first one, advance the clock, then drift the second.
    const first = ids[0];
    const second = ids[1];
    if (!first || !second) throw new Error('expected two ids');
    f.verifier.hashes.set('3101', 'mut:pmid:3101:drifted');
    await f.server.curator.reverifyAnchor(first);
    f.clock.advance(10_000);
    f.verifier.hashes.set('3102', 'mut:pmid:3102:drifted');
    await f.server.curator.reverifyAnchor(second);
    const out = await f.server.resources.getCuratorUnresolvableAnchors(f.curatorCaller);
    expect(out.anchors.map((a) => a.anchor_id)).toEqual([second, first]);
  });

  it('filters by cause_id when provided', async () => {
    const f = curatorFixture();
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'x' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'amr-st',
      description: 'x',
      scope_query: 'x',
    });
    const inCause = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'in',
      external_ref: { kind: 'pmid', value: '3201' },
    });
    const { node_id: inId } = f.server.curator.acceptProposal(inCause.proposal_id);
    if (!inId) throw new Error('expected anchor');
    const outCauseAnchor = await f.server.tools.proposeAnchor(f.contributorCaller, {
      cause_id: otherCause.id,
      home_sub_topic_id: otherSt.id,
      content: 'out',
      external_ref: { kind: 'pmid', value: '3202' },
    });
    const { node_id: outId } = f.server.curator.acceptProposal(outCauseAnchor.proposal_id);
    if (!outId) throw new Error('expected anchor');
    f.verifier.hashes.set('3201', 'mut:pmid:3201:drifted');
    f.verifier.hashes.set('3202', 'mut:pmid:3202:drifted');
    await f.server.curator.reverifyAnchor(inId);
    await f.server.curator.reverifyAnchor(outId);
    const inResult = await f.server.resources.getCuratorUnresolvableAnchors(f.curatorCaller, {
      cause_id: f.cause_id,
    });
    expect(inResult.anchors.map((a) => a.anchor_id)).toEqual([inId]);
    const otherResult = await f.server.resources.getCuratorUnresolvableAnchors(f.curatorCaller, {
      cause_id: otherCause.id,
    });
    expect(otherResult.anchors.map((a) => a.anchor_id)).toEqual([outId]);
  });
});
