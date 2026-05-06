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
  other_sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
}

function fixture(opts: { unresolvable?: ReadonlySet<string> } = {}): Fixture {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('t'),
    verifier: new FakeVerifier(opts.unresolvable),
  });
  const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const cred = server.bootstrap.bindAgentCredential({ identity_id: identity.id, label: 'desktop' });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const st = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'mrd',
    scope_query: 'ctDNA',
  });
  const other = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'screening-adherence',
    description: 'screening',
    scope_query: 'screening',
  });
  return {
    server,
    caller: { identity_id: identity.id, agent_credential_id: cred.id },
    cause_id: cause.id,
    sub_topic_id: st.id,
    other_sub_topic_id: other.id,
  };
}

describe('tools.setCapacity', () => {
  it('records a capacity declaration under (identity, cause)', async () => {
    const f = fixture();
    await f.server.tools.setCapacity(f.caller, {
      cause_id: f.cause_id,
      rate: 5,
      kinds: ['anchor', 'review'],
    });
    const cap = f.server.store.capacities.get(`${f.caller.identity_id}|${f.cause_id}`);
    expect(cap?.rate).toBe(5);
    expect(cap?.kinds).toEqual(['anchor', 'review']);
    expect(cap?.identity_id).toBe(f.caller.identity_id);
  });

  it('replaces a prior declaration on re-call (upsert)', async () => {
    const f = fixture();
    await f.server.tools.setCapacity(f.caller, {
      cause_id: f.cause_id,
      rate: 5,
      kinds: ['anchor'],
    });
    await f.server.tools.setCapacity(f.caller, {
      cause_id: f.cause_id,
      rate: 2,
      kinds: ['review'],
    });
    const cap = f.server.store.capacities.get(`${f.caller.identity_id}|${f.cause_id}`);
    expect(cap?.rate).toBe(2);
    expect(cap?.kinds).toEqual(['review']);
    expect(f.server.store.capacities.size).toBe(1);
  });

  it('de-duplicates kinds at the boundary', async () => {
    const f = fixture();
    await f.server.tools.setCapacity(f.caller, {
      cause_id: f.cause_id,
      rate: 1,
      kinds: ['review', 'review', 'anchor'],
    });
    const cap = f.server.store.capacities.get(`${f.caller.identity_id}|${f.cause_id}`);
    expect(cap?.kinds).toEqual(['review', 'anchor']);
  });

  it('rejects when the cause is archived', async () => {
    const f = fixture();
    const cause = f.server.store.causes.get(f.cause_id);
    if (!cause) throw new Error('cause missing');
    f.server.store.causes.set(f.cause_id, { ...cause, status: 'archived' });
    await expect(
      f.server.tools.setCapacity(f.caller, {
        cause_id: f.cause_id,
        rate: 1,
        kinds: ['anchor'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('rejects an unauthorized caller', async () => {
    const f = fixture();
    await expect(
      f.server.tools.setCapacity(
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        { identity_id: 'idn_bogus' as any },
        { cause_id: f.cause_id, rate: 1, kinds: ['anchor'] },
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('tools.proposeAnchor', () => {
  it('stages an anchor proposal when verification passes', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'Tie et al., ctDNA-guided adjuvant chemotherapy in stage II colon cancer',
      external_ref: { kind: 'pmid', value: '35657323' },
    });
    const p = f.server.store.proposals.get(proposal_id);
    expect(p?.status).toBe('staged');
    expect(p?.payload.kind).toBe('anchor');
    expect(p?.proposer_id).toBe(f.caller.identity_id);
  });

  it('records optional memberships on the payload', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      memberships: [f.other_sub_topic_id],
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'anchor') throw new Error('unexpected payload');
    expect(p.payload.memberships).toEqual([f.other_sub_topic_id]);
  });

  it('rejects when the external_ref does not resolve', async () => {
    const f = fixture({ unresolvable: new Set(['9999999999']) });
    await expect(
      f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'x',
        external_ref: { kind: 'pmid', value: '9999999999' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.server.store.proposals.size).toBe(0);
  });

  it('rejects when the home sub-topic belongs to a different cause', async () => {
    const f = fixture();
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'amr' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'x',
      description: 'x',
      scope_query: 'x',
    });
    await expect(
      f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: otherSt.id,
        content: 'x',
        external_ref: { kind: 'pmid', value: '1' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects an unknown identity', async () => {
    const f = fixture();
    await expect(
      f.server.tools.proposeAnchor(
        // biome-ignore lint/suspicious/noExplicitAny: fabricating an unauthorized caller
        { identity_id: 'idn_bogus' as any },
        {
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          content: 'x',
          external_ref: { kind: 'pmid', value: '1' },
        },
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects an agent credential that does not belong to the identity', async () => {
    const f = fixture();
    const other = f.server.bootstrap.mintIdentity({ display_name: 'mallory' });
    const otherCred = f.server.bootstrap.bindAgentCredential({
      identity_id: other.id,
      label: 'mallory-bot',
    });
    await expect(
      f.server.tools.proposeAnchor(
        { identity_id: f.caller.identity_id, agent_credential_id: otherCred.id },
        {
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          content: 'x',
          external_ref: { kind: 'pmid', value: '1' },
        },
      ),
    ).rejects.toBeInstanceOf(ServerError);
  });
});

describe('tools.proposeExcerpt', () => {
  async function withAcceptedAnchor(f: ReturnType<typeof fixture>) {
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent paper',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const { node_id } = f.server.curator.acceptProposal(proposal_id);
    if (!node_id) throw new Error('expected anchor node');
    return node_id;
  }

  it('stages an excerpt proposal under an active anchor', async () => {
    const f = fixture();
    const anchor_id = await withAcceptedAnchor(f);
    const { proposal_id } = await f.server.tools.proposeExcerpt(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: anchor_id,
      content: 'In stage II resected CRC, ctDNA-positivity at week 4...',
      quoted_span: { text: 'ctDNA-positivity at week 4', offset: 42 },
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'excerpt') throw new Error('unexpected payload');
    expect(p.payload.parent_anchor_id).toBe(anchor_id);
    expect(p.payload.quoted_span).toEqual({ text: 'ctDNA-positivity at week 4', offset: 42 });
    expect(p.status).toBe('staged');
  });

  it('rejects an excerpt against an unknown parent', async () => {
    const f = fixture();
    await expect(
      f.server.tools.proposeExcerpt(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        parent_anchor_id: 'nod_missing' as any,
        content: 'x',
        quoted_span: { text: 'x', offset: 0 },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects an excerpt whose home sub-topic is in a different cause', async () => {
    const f = fixture();
    const anchor_id = await withAcceptedAnchor(f);
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'x' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'x',
      description: 'x',
      scope_query: 'x',
    });
    await expect(
      f.server.tools.proposeExcerpt(f.caller, {
        cause_id: otherCause.id,
        home_sub_topic_id: otherSt.id,
        parent_anchor_id: anchor_id,
        content: 'x',
        quoted_span: { text: 'x', offset: 0 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects an excerpt whose parent is staged (not yet a node)', async () => {
    const f = fixture();
    const { proposal_id: anchor_proposal } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent paper',
      external_ref: { kind: 'pmid', value: '1' },
    });
    // No accept call: anchor exists only as a staged proposal.
    expect(anchor_proposal).toBeDefined();
    // Excerpt asserts a parent that has not been materialized as a
    // node yet. The parent_anchor_id must be a NodeId; without
    // materialization there's no NodeId to point at, so the test
    // confirms the "must reference a real, active anchor node" rule
    // by passing a node id that doesn't exist.
    await expect(
      f.server.tools.proposeExcerpt(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        parent_anchor_id: 'nod_t_0001' as any,
        content: 'x',
        quoted_span: { text: 'x', offset: 0 },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('tools.proposeSynthesis', () => {
  async function withTwoAnchors(f: ReturnType<typeof fixture>) {
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
    if (!aId || !bId) throw new Error('expected both anchors');
    return [aId, bId] as const;
  }

  it('stages a synthesis proposal with multiple parents', async () => {
    const f = fixture();
    const [a, b] = await withTwoAnchors(f);
    const { proposal_id } = await f.server.tools.proposeSynthesis(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_ids: [a, b],
      content: 'a and b together suggest...',
      kind: 'synthesis',
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'synthesis') throw new Error('expected synthesis payload');
    expect(p.payload.parent_ids).toEqual([a, b]);
  });

  it('routes kind:open_question into an open_question payload', async () => {
    const f = fixture();
    const [a, b] = await withTwoAnchors(f);
    const { proposal_id } = await f.server.tools.proposeSynthesis(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_ids: [a, b],
      content: 'why does a contradict b?',
      kind: 'open_question',
    });
    const p = f.server.store.proposals.get(proposal_id);
    expect(p?.payload.kind).toBe('open_question');
  });

  it('rejects duplicate parent_ids', async () => {
    const f = fixture();
    const [a] = await withTwoAnchors(f);
    await expect(
      f.server.tools.proposeSynthesis(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        parent_ids: [a, a],
        content: 'x',
        kind: 'synthesis',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects when any parent is missing from the cause', async () => {
    const f = fixture();
    const [a] = await withTwoAnchors(f);
    await expect(
      f.server.tools.proposeSynthesis(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        parent_ids: [a, 'nod_missing' as any],
        content: 'x',
        kind: 'synthesis',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('tools.proposeSupersedes', () => {
  async function withTwoAnchors(f: ReturnType<typeof fixture>) {
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
    if (!aId || !bId) throw new Error('expected both anchors');
    return [aId, bId] as const;
  }

  it('stages a supersedes proposal between two active nodes', async () => {
    const f = fixture();
    const [a, b] = await withTwoAnchors(f);
    const { proposal_id } = await f.server.tools.proposeSupersedes(f.caller, {
      from_node_id: a,
      to_node_id: b,
      rationale: 'b is the corrected version of a',
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'supersedes') throw new Error('expected supersedes payload');
    expect(p.payload.from_node_id).toBe(a);
    expect(p.payload.to_node_id).toBe(b);
    expect(p.payload.rationale).toBe('b is the corrected version of a');
    expect(p.status).toBe('staged');
  });

  it('rejects from === to', async () => {
    const f = fixture();
    const [a] = await withTwoAnchors(f);
    await expect(
      f.server.tools.proposeSupersedes(f.caller, {
        from_node_id: a,
        to_node_id: a,
        rationale: 'self',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects an unknown from node', async () => {
    const f = fixture();
    const [, b] = await withTwoAnchors(f);
    await expect(
      f.server.tools.proposeSupersedes(f.caller, {
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        from_node_id: 'nod_missing' as any,
        to_node_id: b,
        rationale: 'x',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects when the from node is already superseded', async () => {
    const f = fixture();
    const [a, b] = await withTwoAnchors(f);
    const node = f.server.store.nodes.get(a);
    if (!node) throw new Error('expected node');
    f.server.store.nodes.set(a, { ...node, status: 'superseded' });
    await expect(
      f.server.tools.proposeSupersedes(f.caller, {
        from_node_id: a,
        to_node_id: b,
        rationale: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('rejects when endpoints belong to different causes', async () => {
    const f = fixture();
    const [a] = await withTwoAnchors(f);
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'x' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'x',
      description: 'x',
      scope_query: 'x',
    });
    const otherProp = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: otherCause.id,
      home_sub_topic_id: otherSt.id,
      content: 'other',
      external_ref: { kind: 'pmid', value: '99' },
    });
    const otherId = f.server.curator.acceptProposal(otherProp.proposal_id).node_id;
    if (!otherId) throw new Error('expected other anchor');
    await expect(
      f.server.tools.proposeSupersedes(f.caller, {
        from_node_id: a,
        to_node_id: otherId,
        rationale: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects a proposal that would close a supersedes cycle', async () => {
    const f = fixture();
    const [a, b] = await withTwoAnchors(f);
    // a → b is fine.
    const { proposal_id } = await f.server.tools.proposeSupersedes(f.caller, {
      from_node_id: a,
      to_node_id: b,
      rationale: 'first',
    });
    f.server.curator.acceptProposal(proposal_id);

    // Now b is the only active end of the chain. A proposal b → a
    // would re-introduce a (already superseded) and form a cycle once
    // a is reactivated; even before that the cycle test (b → a → b
    // via the existing edge) trips. Use a fresh active node to make
    // the cycle path concrete: c → a, then a → c attempted.
    const cProp = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'c',
      external_ref: { kind: 'pmid', value: '3' },
    });
    const cId = f.server.curator.acceptProposal(cProp.proposal_id).node_id;
    if (!cId) throw new Error('expected c');

    // c → b creates a chain c → b alongside the existing a → b.
    const { proposal_id: cb } = await f.server.tools.proposeSupersedes(f.caller, {
      from_node_id: cId,
      to_node_id: b,
      rationale: 'second',
    });
    f.server.curator.acceptProposal(cb);

    // b is still active. b → c would mean b ⇒ c ⇒ b, a cycle.
    // But b is active and c is now superseded, so the from/to-active
    // checks would fire first. Reactivate c by hand to expose the
    // cycle check.
    const cNode = f.server.store.nodes.get(cId);
    if (!cNode) throw new Error('c missing');
    f.server.store.nodes.set(cId, { ...cNode, status: 'active' });
    await expect(
      f.server.tools.proposeSupersedes(f.caller, {
        from_node_id: b,
        to_node_id: cId,
        rationale: 'cycle',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('tools.proposeMembership', () => {
  async function withAnchor(f: ReturnType<typeof fixture>) {
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'msi-high crc definition',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const id = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!id) throw new Error('expected anchor');
    return id;
  }

  it('stages a membership proposal for an active node and target sub-topic', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    const { proposal_id } = await f.server.tools.proposeMembership(f.caller, {
      node_id,
      sub_topic_id: f.other_sub_topic_id,
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'membership') throw new Error('expected membership payload');
    expect(p.payload.node_id).toBe(node_id);
    expect(p.payload.sub_topic_id).toBe(f.other_sub_topic_id);
    expect(p.status).toBe('staged');
  });

  it('rejects a target sub-topic in a different cause', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'x' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'x',
      description: 'x',
      scope_query: 'x',
    });
    await expect(
      f.server.tools.proposeMembership(f.caller, {
        node_id,
        sub_topic_id: otherSt.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it("rejects re-claiming the node's own home sub-topic", async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    await expect(
      f.server.tools.proposeMembership(f.caller, {
        node_id,
        sub_topic_id: f.sub_topic_id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects a duplicate membership claim', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    const { proposal_id } = await f.server.tools.proposeMembership(f.caller, {
      node_id,
      sub_topic_id: f.other_sub_topic_id,
    });
    f.server.curator.acceptProposal(proposal_id);
    await expect(
      f.server.tools.proposeMembership(f.caller, {
        node_id,
        sub_topic_id: f.other_sub_topic_id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects when the node is not active', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    const node = f.server.store.nodes.get(node_id);
    if (!node) throw new Error('node missing');
    f.server.store.nodes.set(node_id, { ...node, status: 'superseded' });
    await expect(
      f.server.tools.proposeMembership(f.caller, {
        node_id,
        sub_topic_id: f.other_sub_topic_id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('tools.proposeChangeOfHome', () => {
  async function withAnchor(f: ReturnType<typeof fixture>) {
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const id = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!id) throw new Error('expected anchor');
    return id;
  }

  it('stages a change_of_home proposal for a different sub-topic in the same cause', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    const { proposal_id } = await f.server.tools.proposeChangeOfHome(f.caller, {
      node_id,
      new_home_sub_topic_id: f.other_sub_topic_id,
      rationale: 'this node is really about screening adherence',
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'change_of_home') throw new Error('expected change_of_home payload');
    expect(p.payload.node_id).toBe(node_id);
    expect(p.payload.new_home_sub_topic_id).toBe(f.other_sub_topic_id);
    expect(p.payload.rationale).toMatch(/screening/);
    expect(p.status).toBe('staged');
  });

  it('rejects when the new home equals the current home', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    await expect(
      f.server.tools.proposeChangeOfHome(f.caller, {
        node_id,
        new_home_sub_topic_id: f.sub_topic_id,
        rationale: 'no-op',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects when the new home is in a different cause', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'x' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'x',
      description: 'x',
      scope_query: 'x',
    });
    await expect(
      f.server.tools.proposeChangeOfHome(f.caller, {
        node_id,
        new_home_sub_topic_id: otherSt.id,
        rationale: 'cross-cause',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects when the node is not active', async () => {
    const f = fixture();
    const node_id = await withAnchor(f);
    const node = f.server.store.nodes.get(node_id);
    if (!node) throw new Error('node missing');
    f.server.store.nodes.set(node_id, { ...node, status: 'superseded' });
    await expect(
      f.server.tools.proposeChangeOfHome(f.caller, {
        node_id,
        new_home_sub_topic_id: f.other_sub_topic_id,
        rationale: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('tools.proposeSubTopic', () => {
  it('stages a sub_topic proposal under an active cause', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeSubTopic(f.caller, {
      cause_id: f.cause_id,
      name: 'lynch-surveillance',
      description: 'Surveillance regimens for Lynch syndrome carriers',
      scope_query: 'lynch syndrome surveillance',
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'sub_topic') throw new Error('expected sub_topic payload');
    expect(p.payload.name).toBe('lynch-surveillance');
    expect(p.status).toBe('staged');
    // The SubTopic itself is NOT created at propose time — it lives
    // only as a payload until a curator decision (PRD line 218).
    expect(
      [...f.server.store.subTopics.values()].find((s) => s.name === 'lynch-surveillance'),
    ).toBeUndefined();
  });

  it('rejects when the cause does not exist', async () => {
    const f = fixture();
    await expect(
      f.server.tools.proposeSubTopic(f.caller, {
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        cause_id: 'cau_missing' as any,
        name: 'x',
        description: 'x',
        scope_query: 'x',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects when the cause is archived', async () => {
    const f = fixture();
    const cause = f.server.store.causes.get(f.cause_id);
    if (!cause) throw new Error('cause missing');
    f.server.store.causes.set(f.cause_id, { ...cause, status: 'archived' });
    await expect(
      f.server.tools.proposeSubTopic(f.caller, {
        cause_id: f.cause_id,
        name: 'x',
        description: 'x',
        scope_query: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('tools.queryFrontier', () => {
  it('surfaces an active anchor with no excerpt as an orphan_anchor item', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'lone',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);

    const { items } = await f.server.tools.queryFrontier(f.caller, {});
    const orphans = items.filter((i) => i.kind === 'orphan_anchor');
    expect(orphans).toHaveLength(1);
  });

  it('drops an anchor from the frontier once an excerpt derives from it', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    const e = await f.server.tools.proposeExcerpt(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: aId,
      content: 'ex',
      quoted_span: { text: 'ex', offset: 0 },
    });
    f.server.curator.acceptProposal(e.proposal_id);

    const { items } = await f.server.tools.queryFrontier(f.caller, {});
    expect(items.find((i) => i.kind === 'orphan_anchor')).toBeUndefined();
  });

  it('surfaces a staged proposal as a needs_review item routed to its home', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const { items } = await f.server.tools.queryFrontier(f.caller, {});
    const review = items.find((i) => i.kind === 'needs_review');
    if (review?.kind !== 'needs_review') throw new Error('expected needs_review');
    expect(review.proposal_id).toBe(proposal_id);
    expect(review.sub_topic_id).toBe(f.sub_topic_id);
  });

  it('routes a membership proposal to the target sub-topic', async () => {
    const f = fixture();
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
      sub_topic_id: f.other_sub_topic_id,
    });
    const { items } = await f.server.tools.queryFrontier(f.caller, {
      sub_topic_id: f.other_sub_topic_id,
      frontier_kind: 'needs_review',
    });
    const review = items.find((i) => i.kind === 'needs_review');
    if (review?.kind !== 'needs_review') throw new Error('expected needs_review');
    expect(review.proposal_id).toBe(proposal_id);
    expect(review.sub_topic_id).toBe(f.other_sub_topic_id);
  });

  it('excludes curator-only kinds (sub_topic, change_of_home) from the frontier', async () => {
    const f = fixture();
    await f.server.tools.proposeSubTopic(f.caller, {
      cause_id: f.cause_id,
      name: 'lynch',
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
    await f.server.tools.proposeChangeOfHome(f.caller, {
      node_id: aId,
      new_home_sub_topic_id: f.other_sub_topic_id,
      rationale: 'x',
    });
    const { items } = await f.server.tools.queryFrontier(f.caller, {
      frontier_kind: 'needs_review',
    });
    // Two staged proposals exist (sub_topic + change_of_home) but
    // neither belongs in the reviewer-pool frontier.
    expect(items).toHaveLength(0);
  });

  it('surfaces unresolvable anchors with a higher priority than orphans', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'live',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const liveId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!liveId) throw new Error('expected anchor');
    const b = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'broken',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const brokenId = f.server.curator.acceptProposal(b.proposal_id).node_id;
    if (!brokenId) throw new Error('expected anchor');
    // Simulate verification failure on broken's source.
    const broken = f.server.store.nodes.get(brokenId);
    if (!broken) throw new Error('broken missing');
    f.server.store.nodes.set(brokenId, { ...broken, status: 'unresolvable' });

    const { items } = await f.server.tools.queryFrontier(f.caller, {});
    const indexes = {
      unresolvable: items.findIndex((i) => i.kind === 'unresolvable_anchor'),
      orphan: items.findIndex((i) => i.kind === 'orphan_anchor'),
    };
    expect(indexes.unresolvable).toBeGreaterThanOrEqual(0);
    expect(indexes.orphan).toBeGreaterThan(indexes.unresolvable);
  });

  it('rejects an unauthenticated caller', async () => {
    const f = fixture();
    await expect(
      f.server.tools.queryFrontier(
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        { identity_id: 'idn_bogus' as any },
        {},
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('tools.requestAssignment', () => {
  it('rejects when no capacity is declared for the cause', async () => {
    const f = fixture();
    await expect(
      f.server.tools.requestAssignment(f.caller, { cause_id: f.cause_id }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('offers an excerpt task for an orphan anchor under a different proposer', async () => {
    const f = fixture();
    // Alice (the base caller) seeds an orphan anchor.
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'orphan',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    // Bob declares capacity for excerpts and pulls.
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 3,
      kinds: ['excerpt'],
    });
    const { assignment_id, task } = await f.server.tools.requestAssignment(bobCaller, {
      cause_id: f.cause_id,
    });
    if (task.kind !== 'excerpt') throw new Error('expected excerpt task');
    expect(task.parent_anchor_id).toBe(aId);
    expect(task.sub_topic_id).toBe(f.sub_topic_id);

    const stored = f.server.store.assignments.get(assignment_id);
    expect(stored?.contributor_id).toBe(bob.id);
    expect(stored?.status).toBe('offered');
  });

  it("doesn't offer a review of one's own proposal", async () => {
    const f = fixture();
    await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'self',
      external_ref: { kind: 'pmid', value: '1' },
    });
    await f.server.tools.setCapacity(f.caller, {
      cause_id: f.cause_id,
      rate: 3,
      kinds: ['review'],
    });
    await expect(
      f.server.tools.requestAssignment(f.caller, { cause_id: f.cause_id }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('offers a review task to a non-proposer with review capacity', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 3,
      kinds: ['review'],
    });
    const { task } = await f.server.tools.requestAssignment(bobCaller, {
      cause_id: f.cause_id,
    });
    if (task.kind !== 'review') throw new Error('expected review task');
    expect(task.proposal_id).toBe(proposal_id);
  });

  it('respects the rate cap', async () => {
    const f = fixture();
    // Two orphan anchors so two distinct excerpt tasks exist.
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
    f.server.curator.acceptProposal(a.proposal_id);
    f.server.curator.acceptProposal(b.proposal_id);

    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 1,
      kinds: ['excerpt'],
    });
    await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    await expect(
      f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it("doesn't double-offer the same target to the same contributor", async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'a',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);

    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 5,
      kinds: ['excerpt'],
    });
    const first = await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    expect(first.task.kind).toBe('excerpt');
    await expect(
      f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a kind preference outside declared capacity', async () => {
    const f = fixture();
    await f.server.tools.setCapacity(f.caller, {
      cause_id: f.cause_id,
      rate: 1,
      kinds: ['review'],
    });
    await expect(
      f.server.tools.requestAssignment(f.caller, {
        cause_id: f.cause_id,
        kind: 'excerpt',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('tools.acceptAssignment / declineAssignment', () => {
  async function withOfferedExcerptAssignment() {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'orphan',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 3,
      kinds: ['excerpt'],
    });
    const { assignment_id } = await f.server.tools.requestAssignment(bobCaller, {
      cause_id: f.cause_id,
    });
    return { f, bobCaller, bob, assignment_id };
  }

  it('moves an offered assignment to accepted', async () => {
    const { f, bobCaller, assignment_id } = await withOfferedExcerptAssignment();
    await f.server.tools.acceptAssignment(bobCaller, { assignment_id });
    expect(f.server.store.assignments.get(assignment_id)?.status).toBe('accepted');
  });

  it('rejects accepting an assignment that does not belong to the caller', async () => {
    const { f, assignment_id } = await withOfferedExcerptAssignment();
    const mallory = f.server.bootstrap.mintIdentity({ display_name: 'mallory' });
    await expect(
      f.server.tools.acceptAssignment({ identity_id: mallory.id }, { assignment_id }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects accepting twice', async () => {
    const { f, bobCaller, assignment_id } = await withOfferedExcerptAssignment();
    await f.server.tools.acceptAssignment(bobCaller, { assignment_id });
    await expect(
      f.server.tools.acceptAssignment(bobCaller, { assignment_id }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('moves an offered assignment to declined and persists the reason', async () => {
    const { f, bobCaller, assignment_id } = await withOfferedExcerptAssignment();
    await f.server.tools.declineAssignment(bobCaller, {
      assignment_id,
      reason: 'outside my wheelhouse',
    });
    const stored = f.server.store.assignments.get(assignment_id);
    expect(stored?.status).toBe('declined');
    expect(stored?.decline_reason).toBe('outside my wheelhouse');
  });

  it('rejects declining an unknown assignment', async () => {
    const { f, bobCaller } = await withOfferedExcerptAssignment();
    await expect(
      f.server.tools.declineAssignment(bobCaller, {
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        assignment_id: 'asn_missing' as any,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('frees the rate budget when an assignment is declined', async () => {
    const { f, bobCaller, assignment_id } = await withOfferedExcerptAssignment();
    // Add a second orphan so a second assignment is available.
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'second',
      external_ref: { kind: 'pmid', value: '2' },
    });
    f.server.curator.acceptProposal(a.proposal_id);
    // Bob's rate is 3 in the helper; confirm decline doesn't block
    // a second pull. (The helper uses 3 deliberately; the rate-cap
    // test in requestAssignment uses 1 to exercise the cap path.)
    await f.server.tools.declineAssignment(bobCaller, { assignment_id, reason: 'no time' });
    const next = await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    expect(next.assignment_id).not.toBe(assignment_id);
  });
});

describe('tools.submitAssignedProposal', () => {
  // End-to-end happy path of the assignment loop.
  async function withAcceptedExcerptAssignment() {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 3,
      kinds: ['excerpt'],
    });
    const offered = await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    await f.server.tools.acceptAssignment(bobCaller, { assignment_id: offered.assignment_id });
    return { f, bobCaller, anchor_id: aId, assignment_id: offered.assignment_id };
  }

  it('stages a proposal, attributes the assignment, and marks it submitted', async () => {
    const { f, bobCaller, anchor_id, assignment_id } = await withAcceptedExcerptAssignment();
    const { proposal_id } = await f.server.tools.submitAssignedProposal(bobCaller, {
      assignment_id,
      payload: {
        kind: 'excerpt',
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        parent_anchor_id: anchor_id,
        content: 'span content',
        quoted_span: { text: 'span', offset: 0 },
      },
    });

    const proposal = f.server.store.proposals.get(proposal_id);
    expect(proposal?.payload.kind).toBe('excerpt');
    expect(proposal?.assignment_id).toBe(assignment_id);

    const updatedAssignment = f.server.store.assignments.get(assignment_id);
    expect(updatedAssignment?.status).toBe('submitted');
    expect(updatedAssignment?.fulfilled_by).toBe(proposal_id);
  });

  it('rejects when the assignment is not yet accepted', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'p',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 1,
      kinds: ['excerpt'],
    });
    const offered = await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    // No accept call.
    await expect(
      f.server.tools.submitAssignedProposal(bobCaller, {
        assignment_id: offered.assignment_id,
        payload: {
          kind: 'excerpt',
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          parent_anchor_id: aId,
          content: 'x',
          quoted_span: { text: 'x', offset: 0 },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('rejects when payload kind does not match task kind', async () => {
    const { f, bobCaller, assignment_id } = await withAcceptedExcerptAssignment();
    await expect(
      f.server.tools.submitAssignedProposal(bobCaller, {
        assignment_id,
        payload: {
          kind: 'anchor',
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          content: 'rep-laundering attempt',
          external_ref: { kind: 'pmid', value: '99' },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects when payload pins a different parent anchor than the task', async () => {
    const { f, bobCaller, assignment_id } = await withAcceptedExcerptAssignment();
    // Stage a second anchor and use its id in the payload.
    const a2 = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'other',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const a2Id = f.server.curator.acceptProposal(a2.proposal_id).node_id;
    if (!a2Id) throw new Error('expected second anchor');
    await expect(
      f.server.tools.submitAssignedProposal(bobCaller, {
        assignment_id,
        payload: {
          kind: 'excerpt',
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          parent_anchor_id: a2Id,
          content: 'x',
          quoted_span: { text: 'x', offset: 0 },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects fulfilling a review assignment via this tool (use cast_review_vote)', async () => {
    const f = fixture();
    await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 1,
      kinds: ['review'],
    });
    const offered = await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    await f.server.tools.acceptAssignment(bobCaller, { assignment_id: offered.assignment_id });
    if (offered.task.kind !== 'review') throw new Error('expected review task');
    // submit_assigned_proposal rejects review-kind tasks before the
    // payload is even unwrapped — pass a well-formed propose-kind
    // payload so we exercise the early review-kind guard, not the
    // payload-kind mismatch.
    await expect(
      f.server.tools.submitAssignedProposal(bobCaller, {
        assignment_id: offered.assignment_id,
        payload: {
          kind: 'anchor',
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          content: 'x',
          external_ref: { kind: 'pmid', value: '2' },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('tools.fetchCalibrationBatch', () => {
  it('returns accepted proposals routed to the sub-topic, projected to ReviewBatchItem shape', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'a',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);

    const { items } = await f.server.tools.fetchCalibrationBatch(f.caller, {
      sub_topic_id: f.sub_topic_id,
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    if (!item) throw new Error('expected one item');
    expect(item.proposal_id).toBe(a.proposal_id);
    // ReviewBatchItem deliberately exposes only proposal_id + payload
    // — no status, created_at, proposer_id, or assignment_id (PRD
    // §Calibration batches; tools.ts ReviewBatchItem comment).
    expect(Object.keys(item).sort()).toEqual(['payload', 'proposal_id']);
  });

  it('omits staged proposals (only validated history is calibration material)', async () => {
    const f = fixture();
    await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'staged',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const { items } = await f.server.tools.fetchCalibrationBatch(f.caller, {
      sub_topic_id: f.sub_topic_id,
    });
    expect(items).toHaveLength(0);
  });

  it('only surfaces proposals routed to the requested sub-topic', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);

    const { items } = await f.server.tools.fetchCalibrationBatch(f.caller, {
      sub_topic_id: f.other_sub_topic_id,
    });
    expect(items).toHaveLength(0);
  });

  it('caps the batch at the calibration size with a recency bias', async () => {
    const f = fixture();
    // Five accepted anchors; the helper FakeClock advances by 1000ms
    // each tick, so created_at is ordered.
    for (let i = 1; i <= 5; i++) {
      const a = await f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: `c${i}`,
        external_ref: { kind: 'pmid', value: String(i) },
      });
      f.server.curator.acceptProposal(a.proposal_id);
    }
    const { items } = await f.server.tools.fetchCalibrationBatch(f.caller, {
      sub_topic_id: f.sub_topic_id,
    });
    // The cap is implementation-defined (3 in v0). Whatever it is,
    // the batch must be shorter than the candidate pool.
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(5);
  });

  it('rejects an unknown sub-topic', async () => {
    const f = fixture();
    await expect(
      f.server.tools.fetchCalibrationBatch(f.caller, {
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        sub_topic_id: 'stp_missing' as any,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('tools.queryProposals', () => {
  it('returns all proposals when no filters are given, ordered by created_at', async () => {
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
    const { proposals } = await f.server.tools.queryProposals(f.caller, {});
    expect(proposals.map((p) => p.id)).toEqual([a.proposal_id, b.proposal_id]);
  });

  it('filters by status', async () => {
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
    f.server.curator.acceptProposal(a.proposal_id);
    const { proposals: staged } = await f.server.tools.queryProposals(f.caller, {
      status: 'staged',
    });
    expect(staged.map((p) => p.id)).toEqual([b.proposal_id]);
    const { proposals: accepted } = await f.server.tools.queryProposals(f.caller, {
      status: 'accepted',
    });
    expect(accepted.map((p) => p.id)).toEqual([a.proposal_id]);
  });

  it('filters by sub-topic — including membership proposals targeting it', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    // A membership proposal targeting `other_sub_topic_id`. Its
    // payload home is the source node's home (sub_topic_id), but
    // review pressure routes to the target, so a sub-topic query
    // for the target should surface it.
    const { proposal_id: membershipPid } = await f.server.tools.proposeMembership(f.caller, {
      node_id: aId,
      sub_topic_id: f.other_sub_topic_id,
    });
    // Plus an unrelated anchor in the source sub-topic.
    const b = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'b',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const { proposals: targetStaged } = await f.server.tools.queryProposals(f.caller, {
      sub_topic_id: f.other_sub_topic_id,
      status: 'staged',
    });
    expect(targetStaged.map((p) => p.id)).toEqual([membershipPid]);
    const { proposals: sourceStaged } = await f.server.tools.queryProposals(f.caller, {
      sub_topic_id: f.sub_topic_id,
      status: 'staged',
    });
    expect(sourceStaged.map((p) => p.id)).toEqual([b.proposal_id]);
  });
});

describe('tools.castReviewVote', () => {
  // Two-identity fixture: alice proposes, bob reviews. The base
  // fixture only mints alice; bob is a second identity for the
  // self-review and reviewer-isolation tests.
  async function withReviewerAndStaged(f: ReturnType<typeof fixture>) {
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    return { bobCaller, proposal_id };
  }

  it('records a vote with rationale on a staged proposal', async () => {
    const f = fixture();
    const { bobCaller, proposal_id } = await withReviewerAndStaged(f);
    const { vote_id } = await f.server.tools.castReviewVote(bobCaller, {
      proposal_id,
      decision: 'accept',
      rationale: 'verifies cleanly and the claim is well-anchored',
    });
    const vote = f.server.store.reviewVotes.get(vote_id);
    expect(vote?.proposal_id).toBe(proposal_id);
    expect(vote?.reviewer_id).toBe(bobCaller.identity_id);
    expect(vote?.decision).toBe('accept');
    expect(vote?.assignment_id).toBeUndefined();
  });

  it('rejects self-review (proposer voting on their own proposal)', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    await expect(
      f.server.tools.castReviewVote(f.caller, {
        proposal_id,
        decision: 'accept',
        rationale: 'self',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects voting on a non-staged proposal', async () => {
    const f = fixture();
    const { bobCaller, proposal_id } = await withReviewerAndStaged(f);
    f.server.curator.acceptProposal(proposal_id);
    await expect(
      f.server.tools.castReviewVote(bobCaller, {
        proposal_id,
        decision: 'accept',
        rationale: 'too late',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('rejects double-voting by the same reviewer', async () => {
    const f = fixture();
    const { bobCaller, proposal_id } = await withReviewerAndStaged(f);
    await f.server.tools.castReviewVote(bobCaller, {
      proposal_id,
      decision: 'accept',
      rationale: 'first',
    });
    await expect(
      f.server.tools.castReviewVote(bobCaller, {
        proposal_id,
        decision: 'reject',
        rationale: 'changed mind',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('admits parallel votes from different reviewers', async () => {
    const f = fixture();
    const { bobCaller, proposal_id } = await withReviewerAndStaged(f);
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const carolCaller: Caller = { identity_id: carol.id };
    await f.server.tools.castReviewVote(bobCaller, {
      proposal_id,
      decision: 'accept',
      rationale: 'bob accepts',
    });
    await f.server.tools.castReviewVote(carolCaller, {
      proposal_id,
      decision: 'reject',
      rationale: 'carol rejects',
    });
    const votes = [...f.server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === proposal_id,
    );
    expect(votes).toHaveLength(2);
    expect(new Set(votes.map((v) => v.decision))).toEqual(new Set(['accept', 'reject']));
  });

  it('auto-accepts a staged proposal once accept votes hit threshold', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'accept', rationale: 'b' },
    );
    // Still staged after one accept (default threshold is 2).
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id, decision: 'accept', rationale: 'c' },
    );
    // Two accepts triggers convergence: proposal accepted and the
    // anchor node is materialized just like the curator path.
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('accepted');
    const anchors = [...f.server.store.nodes.values()].filter((n) => n.kind === 'anchor');
    expect(anchors).toHaveLength(1);
  });

  it('auto-rejects a staged proposal once reject votes hit threshold', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'reject', rationale: 'no' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id, decision: 'reject', rationale: 'no' },
    );
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('rejected');
    // No node materializes on reject.
    expect(f.server.store.nodes.size).toBe(0);
  });

  it('does not count revise votes toward either threshold', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'revise', rationale: 'needs work' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id, decision: 'revise', rationale: 'needs work' },
    );
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
  });

  it('honors a custom convergence threshold from server config', async () => {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('t'),
      verifier: new FakeVerifier(),
      review: { votes_to_accept: 1 },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
    const st = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'st',
      description: 'x',
      scope_query: 'x',
    });
    const { proposal_id } = await server.tools.proposeAnchor(
      { identity_id: alice.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: st.id,
        content: 'x',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    await server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'accept', rationale: 'sufficient at 1' },
    );
    expect(server.store.proposals.get(proposal_id)?.status).toBe('accepted');
  });

  it('does not auto-resolve curator-only proposal kinds', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeSubTopic(f.caller, {
      cause_id: f.cause_id,
      name: 'lynch',
      description: 'x',
      scope_query: 'x',
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'accept', rationale: 'x' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id, decision: 'accept', rationale: 'x' },
    );
    // Curator-only — votes don't move it (PRD lines 131, 218).
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
  });

  it('credits the proposer when their proposal converges to accepted', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'accept', rationale: 'b' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id, decision: 'accept', rationale: 'c' },
    );
    // Contributor-initiated (no assignment_id) → reduced weight (0.5
    // by default). Default proposer_accepted_gain is 1, so alice gets
    // 0.5 in her home sub-topic.
    const { entries } = await f.server.tools.queryReputation(f.caller, {
      cause_id: f.cause_id,
    });
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, score: 0.5 }]);
  });

  it('debits the proposer when their proposal converges to rejected', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'reject', rationale: 'b' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id, decision: 'reject', rationale: 'c' },
    );
    const { entries } = await f.server.tools.queryReputation(f.caller, {
      cause_id: f.cause_id,
    });
    // -1 * 0.5 = -0.5 (contributor-initiated factor).
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, score: -0.5 }]);
  });

  it('credits accurate reviewers and debits inaccurate ones on convergence', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
    // Two accepts (bob, carol) → converges to accepted. Dave's reject
    // is "inaccurate" against the converged outcome, but he can only
    // vote before convergence — so we have him vote first.
    await f.server.tools.castReviewVote(
      { identity_id: dave.id },
      { proposal_id, decision: 'reject', rationale: 'd' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'accept', rationale: 'b' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id, decision: 'accept', rationale: 'c' },
    );
    // Bob and Carol each get +1 (accurate); Dave gets -1 (inaccurate).
    const { entries: bobE } = await f.server.tools.queryReputation(
      { identity_id: bob.id },
      { cause_id: f.cause_id },
    );
    expect(bobE).toEqual([{ sub_topic_id: f.sub_topic_id, score: 1 }]);
    const { entries: carolE } = await f.server.tools.queryReputation(
      { identity_id: carol.id },
      { cause_id: f.cause_id },
    );
    expect(carolE).toEqual([{ sub_topic_id: f.sub_topic_id, score: 1 }]);
    const { entries: daveE } = await f.server.tools.queryReputation(
      { identity_id: dave.id },
      { cause_id: f.cause_id },
    );
    expect(daveE).toEqual([{ sub_topic_id: f.sub_topic_id, score: -1 }]);
  });

  it('uses full proposer weight when the proposal was assignment-driven', async () => {
    // End-to-end through the assignment loop: the proposal carries
    // assignment_id, so contributor_initiated_factor doesn't apply.
    const f = fixture();
    // Set up an orphan anchor that will produce an excerpt assignment.
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);

    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.setCapacity(bobCaller, {
      cause_id: f.cause_id,
      rate: 3,
      kinds: ['excerpt'],
    });
    const offered = await f.server.tools.requestAssignment(bobCaller, {
      cause_id: f.cause_id,
    });
    if (offered.task.kind !== 'excerpt') throw new Error('expected excerpt');
    await f.server.tools.acceptAssignment(bobCaller, {
      assignment_id: offered.assignment_id,
    });
    const submitted = await f.server.tools.submitAssignedProposal(bobCaller, {
      assignment_id: offered.assignment_id,
      payload: {
        kind: 'excerpt',
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        parent_anchor_id: offered.task.parent_anchor_id,
        content: 'span',
        quoted_span: { text: 'span', offset: 0 },
      },
    });
    // Two reviewers converge it.
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
    await f.server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id: submitted.proposal_id, decision: 'accept', rationale: 'c' },
    );
    await f.server.tools.castReviewVote(
      { identity_id: dave.id },
      { proposal_id: submitted.proposal_id, decision: 'accept', rationale: 'd' },
    );
    // Bob's proposal was assignment-driven → full weight (1.0), not
    // 0.5.
    const { entries } = await f.server.tools.queryReputation(bobCaller, {
      cause_id: f.cause_id,
    });
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, score: 1 }]);
  });

  it('does not move reputation on revise votes', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    await f.server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id, decision: 'revise', rationale: 'needs work' },
    );
    // Proposal still staged (revise doesn't count). No rep movement.
    expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
    const { entries } = await f.server.tools.queryReputation(f.caller, {
      cause_id: f.cause_id,
    });
    expect(entries).toEqual([]);
  });

  it('rejects an assignment_id pointing to no assignment', async () => {
    const f = fixture();
    const { bobCaller, proposal_id } = await withReviewerAndStaged(f);
    await expect(
      f.server.tools.castReviewVote(bobCaller, {
        proposal_id,
        decision: 'accept',
        rationale: 'x',
        // biome-ignore lint/suspicious/noExplicitAny: fabricated bad id
        assignment_id: 'asn_missing' as any,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
