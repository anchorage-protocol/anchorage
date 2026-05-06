import { describe, expect, it } from 'vitest';
import type { Caller } from './auth.js';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
import { SeededIdGen } from './id-gen.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

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
    // edge type (PRD §Edges line 76).
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
