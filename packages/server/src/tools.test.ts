import type { RequestAssignmentAssigned, RequestAssignmentOutput } from '@anchorage/contracts';
import { describe, expect, it } from 'vitest';
import type { Caller } from './auth.js';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
import { SeededIdGen } from './id-gen.js';
import { type ReviewConfig, Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Narrowing helper: most tests in this file pre-seed work so that
// `request_assignment` is expected to mint a slot. The honest contract
// is now a discriminated union (assigned | idle); these tests narrow
// to the assigned variant at the call site. Several existing
// assertions (`.rejects.toMatchObject({ code: 'not_found' })`) exercise
// what used to be the exhaustion path and now flows through `idle` —
// semantically identical to a "no slot for you" refusal. To preserve
// those assertions without rewiring every test, this helper re-throws
// an idle response as the same `ServerError('not_found', ...)` the
// server used to throw directly. Tests that want to inspect the
// structured idle payload (sub_topics, guidance) narrow off `status`
// directly without going through this helper.
function asAssigned(o: RequestAssignmentOutput): RequestAssignmentAssigned {
  if (o.status !== 'assigned') {
    throw new ServerError(
      'not_found',
      `request_assignment returned status='${o.status}' reason='${o.reason}'`,
    );
  }
  return o;
}

interface Fixture {
  server: Server;
  caller: Caller;
  cause_id: ReturnType<Server['bootstrap']['createCause']>['id'];
  sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
  other_sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
}

function fixture(
  opts: { unresolvable?: ReadonlySet<string>; review?: Partial<ReviewConfig> } = {},
): Fixture {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('t'),
    verifier: new FakeVerifier(opts.unresolvable),
    ...(opts.review ? { review: opts.review } : {}),
  });
  const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const { credential: cred } = server.bootstrap.bindAgentCredential({
    identity_id: identity.id,
    label: 'desktop',
  });
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
    const { credential: otherCred } = f.server.bootstrap.bindAgentCredential({
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
    // only as a payload until a curator decision (PRD §Sub-topic creation).
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

  it('drops an anchor from the orphan frontier while an excerpt assignment for it is in flight', async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'parent',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const { assignment_id } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    // A held slot (request_assignment returns it `accepted` — there is
    // no separate accept step) takes the anchor off the frontier, so a
    // concurrent contributor can't pull it too.
    expect(assignment_id).toBeDefined();
    {
      const { items } = await f.server.tools.queryFrontier(f.caller, {});
      expect(items.find((i) => i.kind === 'orphan_anchor')).toBeUndefined();
    }
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
  it("returns status='idle' with active sub_topics + guidance when no frontier work exists", async () => {
    const f = fixture();
    const result = await f.server.tools.requestAssignment(f.caller, { cause_id: f.cause_id });
    expect(result.status).toBe('idle');
    if (result.status !== 'idle') throw new Error('narrowing');
    expect(result.cause_id).toBe(f.cause_id);
    expect(result.reason).toBe('no_eligible_frontier_item');
    // Both seeded sub-topics surfaced for spontaneous-proposal scope.
    expect(result.sub_topics.map((s) => s.id).sort()).toEqual(
      [f.sub_topic_id, f.other_sub_topic_id].sort(),
    );
    // Guidance points at the propose_* off-slot path (the cold-start
    // UX fix this change ships).
    expect(result.guidance).toMatch(/propose_anchor/);
  });

  it('idle guidance reflects pending reviews once the caller has reviewed every eligible staged proposal', async () => {
    const f = fixture();
    // Alice (base caller) stages an anchor. Bob reviews it, but a single
    // accept can't converge it (votes_to_accept=2), so it stays staged.
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    await f.server.tools.castReviewVote(bobCaller, {
      proposal_id,
      decision: 'accept',
      rationale: 'verifies cleanly and the claim is well-anchored',
    });
    // Bob has now voted on the only staged proposal he was eligible to
    // review, so a fresh pull is idle — but the queue is waiting on
    // *other* contributors' independent votes, not on Bob. The guidance
    // says exactly that, distinct from the empty-frontier branch which
    // leads with the propose_* path.
    const result = await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    expect(result.status).toBe('idle');
    if (result.status !== 'idle') throw new Error('narrowing');
    expect(result.reason).toBe('no_eligible_frontier_item');
    expect(result.guidance).toMatch(/already reviewed|votes are recorded/i);
    expect(result.guidance).toMatch(/other\b.*contributors|independent/i);
    // Same payload shape as the empty-frontier branch — no leaked vote
    // counts or convergence-proximity, only qualitative prose.
    expect(result.guidance).not.toMatch(/\b1 of 2\b|votes? remaining|\bneeds? \d/i);
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

    // Bob pulls — single slot, no capacity declaration.
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const { assignment_id, task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'excerpt') throw new Error('expected excerpt task');
    expect(task.parent_anchor_id).toBe(aId);
    expect(task.sub_topic_id).toBe(f.sub_topic_id);

    const stored = f.server.store.assignments.get(assignment_id);
    expect(stored?.contributor_id).toBe(bob.id);
    expect(stored?.status).toBe('accepted');
  });

  it("doesn't offer a review of one's own proposal (resolves to idle, not error)", async () => {
    const f = fixture();
    await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'self',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const result = await f.server.tools.requestAssignment(f.caller, { cause_id: f.cause_id });
    expect(result.status).toBe('idle');
  });

  it('offers a review task to a non-proposer', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const { task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'review') throw new Error('expected review task');
    expect(task.proposal_id).toBe(proposal_id);
  });

  it('enforces the single slot — a second pull while one is unresolved is refused', async () => {
    const f = fixture();
    // Two orphan anchors so a second excerpt task genuinely exists:
    // the refusal is the single-slot gate, not frontier exhaustion.
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
    await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    await expect(
      f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it("doesn't re-offer a target the contributor already delivered", async () => {
    const f = fixture();
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'a',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const aId = f.server.curator.acceptProposal(a.proposal_id).node_id;
    if (!aId) throw new Error('expected anchor');

    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const first = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    );
    expect(first.task.kind).toBe('excerpt');
    // Bob fulfills the slot, freeing it for a fresh pull.
    await f.server.tools.proposeExcerpt(bobCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: aId,
      content: 'span content',
      quoted_span: { text: 'span', offset: 0 },
      assignment_id: first.assignment_id,
    });
    // The only target now carries a staged excerpt — the frontier no
    // longer exposes it, so a fresh pull resolves to idle.
    const exhausted = await f.server.tools.requestAssignment(bobCaller, {
      cause_id: f.cause_id,
    });
    expect(exhausted.status).toBe('idle');
  });

  it('a strict kind filter with no matching frontier item resolves to idle', async () => {
    const f = fixture();
    // Only a staged anchor exists — that is review work, not excerpt
    // work. The `kind` argument is a strict filter, not a soft
    // preference: asking for a kind the frontier can't supply is a
    // plain miss, not a capacity violation.
    await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const result = await f.server.tools.requestAssignment(bobCaller, {
      cause_id: f.cause_id,
      kind: 'excerpt',
    });
    expect(result.status).toBe('idle');
  });
});

describe('single-slot resolution: precondition-lapse and TTL-shadow', () => {
  // No `decline_assignment` and no `accept_assignment`: a slot the
  // contributor cannot complete resolves through precondition-lapse
  // or TTL-shadow, never a contributor-steered refusal, and is held
  // (`accepted`) from `request_assignment` with no accept step
  // (PRD §Assignment).

  it('lapses an open slot whose sub-topic was archived, freeing it on the next request', async () => {
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
    const { assignment_id } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    // The sub-topic is archived out from under the held slot (the
    // cause stays active so request_assignment still reaches the
    // single-slot walk — the surviving lazy-lapse trigger now that
    // there is no accept step).
    const st = f.server.store.subTopics.get(f.sub_topic_id);
    if (!st) throw new Error('sub-topic missing');
    f.server.store.subTopics.set(f.sub_topic_id, { ...st, status: 'archived' });
    // The next request lazily lapses the dead slot (no credit, no
    // penalty, no contributor action) instead of refusing with
    // single-slot `invalid_state`: the contributor is freed, not
    // stuck. The original slot ends `lapsed`.
    const next = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    );
    expect(next.assignment_id).not.toBe(assignment_id);
    expect(f.server.store.assignments.get(assignment_id)?.status).toBe('lapsed');
  });

  it('lapses an excerpt slot whose parent anchor went unresolvable', async () => {
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
    const { assignment_id, task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'excerpt') throw new Error('expected excerpt task');
    // The parent anchor's source stops resolving.
    const parent = f.server.store.nodes.get(aId);
    if (!parent) throw new Error('parent missing');
    f.server.store.nodes.set(aId, { ...parent, status: 'unresolvable' });
    // The slot is freed lazily on the next single-slot walk, with no
    // contributor action — Bob's old slot lapses, and with the parent
    // anchor `unresolvable` the frontier has nothing else to offer, so
    // the fresh pull resolves to idle (no longer a `not_found` throw).
    const result = await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id });
    expect(result.status).toBe('idle');
    expect(f.server.store.assignments.get(assignment_id)?.status).toBe('lapsed');
  });

  it('past ttl_at the target re-enters the frontier as a shadow re-offer; first fulfillment resolves both', async () => {
    const f = fixture({ review: { assignment_ttl_seconds: 100 } });
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
    const slow = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    );

    // Time passes the slot's ttl_at. The covering slot stops covering
    // the orphan anchor, so the frontier re-exposes it.
    (f.server.clock as FakeClock).advance(200_000);
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const carolCaller: Caller = { identity_id: carol.id };
    const backup = asAssigned(
      await f.server.tools.requestAssignment(carolCaller, { cause_id: f.cause_id }),
    );
    if (backup.task.kind !== 'excerpt') throw new Error('expected excerpt task');
    const backupAsn = f.server.store.assignments.get(backup.assignment_id);
    expect(backupAsn?.shadow_of).toBe(slow.assignment_id);

    // Carol delivers first. The slot resolves; Bob's original slot is
    // released regardless of author (the resolution invariant).
    await f.server.tools.proposeExcerpt(carolCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: aId,
      content: 'span content',
      quoted_span: { text: 'span', offset: 0 },
      assignment_id: backup.assignment_id,
    });
    expect(f.server.store.assignments.get(backup.assignment_id)?.status).toBe('submitted');
    expect(f.server.store.assignments.get(slow.assignment_id)?.status).toBe('lapsed');
  });
});

describe('propose_* assignment fulfillment (the `assignment_id` argument)', () => {
  // An accepted excerpt-kind assignment for a freshly-staged anchor —
  // the loop state a `propose_excerpt` with `assignment_id` fulfills.
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
    const offered = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    );
    return { f, bobCaller, anchor_id: aId, assignment_id: offered.assignment_id };
  }

  it('attributes the assignment on the proposal and marks the assignment submitted', async () => {
    const { f, bobCaller, anchor_id, assignment_id } = await withAcceptedExcerptAssignment();
    const { proposal_id } = await f.server.tools.proposeExcerpt(bobCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: anchor_id,
      content: 'span content',
      quoted_span: { text: 'span', offset: 0 },
      assignment_id,
    });

    const proposal = f.server.store.proposals.get(proposal_id);
    expect(proposal?.payload.kind).toBe('excerpt');
    expect(proposal?.assignment_id).toBe(assignment_id);

    const updatedAssignment = f.server.store.assignments.get(assignment_id);
    expect(updatedAssignment?.status).toBe('submitted');
    expect(updatedAssignment?.fulfilled_by).toBe(proposal_id);
  });

  it('refuses a contributor-initiated proposal while a slot is held in the cause (single-slot off-slot guard)', async () => {
    const { f, bobCaller, anchor_id } = await withAcceptedExcerptAssignment();
    // Bob holds an unresolved excerpt slot. A contributor-initiated
    // propose (no assignment_id) is off-slot work and refused with
    // invalid_state — without this, single-slot would have an unbounded
    // side channel and an assigned contributor that omitted
    // assignment_id could strand its sole slot (PRD §Assignment,
    // "Contributor-initiated work is off-slot").
    await expect(
      f.server.tools.proposeExcerpt(bobCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        parent_anchor_id: anchor_id,
        content: 'span content',
        quoted_span: { text: 'span', offset: 0 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('leaves the proposal unattributed when contributor-initiated and no slot is held', async () => {
    const { f, anchor_id } = await withAcceptedExcerptAssignment();
    // A different contributor who never pulled a slot: the genuine
    // contributor-initiated path (e.g. bootstrap) still works and is
    // unattributed. The off-slot guard is cause-scoped to held slots,
    // so a contributor holding none is unaffected.
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const carolCaller: Caller = { identity_id: carol.id };
    const { proposal_id } = await f.server.tools.proposeExcerpt(carolCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: anchor_id,
      content: 'span content',
      quoted_span: { text: 'span', offset: 0 },
    });
    expect(f.server.store.proposals.get(proposal_id)?.assignment_id).toBeUndefined();
  });

  it('rejects when the proposal kind does not match the task kind', async () => {
    const { f, bobCaller, assignment_id } = await withAcceptedExcerptAssignment();
    // An excerpt-kind assignment can't be fulfilled by an anchor
    // proposal — closes the rep-laundering vector where a contributor
    // accepts a hard task and satisfies it with an easy one.
    await expect(
      f.server.tools.proposeAnchor(bobCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'rep-laundering attempt',
        external_ref: { kind: 'pmid', value: '99' },
        assignment_id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects when the proposal pins a different parent anchor than the task', async () => {
    const { f, bobCaller, assignment_id } = await withAcceptedExcerptAssignment();
    const a2 = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'other',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const a2Id = f.server.curator.acceptProposal(a2.proposal_id).node_id;
    if (!a2Id) throw new Error('expected second anchor');
    await expect(
      f.server.tools.proposeExcerpt(bobCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        parent_anchor_id: a2Id,
        content: 'x',
        quoted_span: { text: 'x', offset: 0 },
        assignment_id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects fulfilling a review assignment via a propose_* tool (use cast_review_vote)', async () => {
    const f = fixture();
    await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const offered = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, { cause_id: f.cause_id }),
    );
    if (offered.task.kind !== 'review') throw new Error('expected review task');
    await expect(
      f.server.tools.proposeAnchor(bobCaller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'x',
        external_ref: { kind: 'pmid', value: '2' },
        assignment_id: offered.assignment_id,
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
    // Curator-only — votes don't move it (PRD §Write-path tools, propose_change_of_home + §Sub-topic creation).
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
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: 0.5, recent: 0.5 }]);
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
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: -0.5, recent: -0.5 }]);
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
    expect(bobE).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: 1, recent: 1 }]);
    const { entries: carolE } = await f.server.tools.queryReputation(
      { identity_id: carol.id },
      { cause_id: f.cause_id },
    );
    expect(carolE).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: 1, recent: 1 }]);
    const { entries: daveE } = await f.server.tools.queryReputation(
      { identity_id: dave.id },
      { cause_id: f.cause_id },
    );
    expect(daveE).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: -1, recent: -1 }]);
  });

  it('scales reviewer rep deltas by per-proposal contention when review_credit_contention_alpha < 1', async () => {
    // PRD §Reputation commits difficulty-normalized review credit
    // with the same `2 * min(accepts, rejects) / total` contention
    // proxy the cluster signal uses. The alpha primitive is the
    // wedge: at alpha=1 (default) every accurate review credits the
    // same (preserved by the existing tests above); at alpha<1
    // unanimous-easy items earn `alpha * base_delta` and contentious
    // items earn the full delta. The patient-adversary signature
    // (priming through unanimous accepts on well-grounded excerpts to
    // harvest rep cheaply) is exactly the pattern uniform-credit
    // blesses, so the alpha knob is what lets the testbed re-baseline
    // the assignment-gate thresholds against the difficulty-aware
    // regime.
    //
    // This test pins the wiring on three cells that span the surface:
    //   - alpha=0, unanimous accepts (contention 0). creditWeight =
    //     0 + 1*0 = 0; reviewer rep delta short-circuits to no
    //     update — easy unanimous work earns no review credit.
    //     Proposer delta is unaffected (alpha is reviewer-only).
    //   - alpha=0, split accepts (one reject, two accepts → converges
    //     accepted; accepts=2, rejects=1, contention = 2*1/3). All
    //     three reviewers' deltas scale by ≈0.667.
    //   - alpha=0.5, unanimous accepts (contention 0). creditWeight =
    //     0.5 + 0.5*0 = 0.5; reviewers get half-credit on easy work,
    //     full credit on contentious.
    //
    // Same proposer/proposal shape as the "credits accurate reviewers"
    // test above; only `review_credit_contention_alpha` and the vote
    // mix vary.
    {
      const f = fixture({ review: { review_credit_contention_alpha: 0 } });
      const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'unanimous',
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
      // Reviewer delta = base * 0 = 0 → no rep entries materialize.
      // Proposer delta is independent of alpha and lands at 0.5
      // (contributor-initiated factor) per the existing accept rule.
      const { entries: bobE } = await f.server.tools.queryReputation(
        { identity_id: bob.id },
        { cause_id: f.cause_id },
      );
      expect(bobE).toEqual([]);
      const { entries: carolE } = await f.server.tools.queryReputation(
        { identity_id: carol.id },
        { cause_id: f.cause_id },
      );
      expect(carolE).toEqual([]);
      const { entries: aliceE } = await f.server.tools.queryReputation(f.caller, {
        cause_id: f.cause_id,
      });
      expect(aliceE).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: 0.5, recent: 0.5 }]);
    }

    {
      const f = fixture({ review: { review_credit_contention_alpha: 0 } });
      const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'split',
        external_ref: { kind: 'pmid', value: '1' },
      });
      const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
      const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
      const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
      // Dave rejects first so the split is on the record before
      // bob+carol's accepts converge it.
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
      // accepts=2, rejects=1, contention = 2*1/3 = 0.6667.
      // creditWeight = 0 + 1*0.6667 = 0.6667. bob+carol +0.6667 each;
      // dave -0.6667.
      const expected = (2 * 1) / 3;
      const { entries: bobE } = await f.server.tools.queryReputation(
        { identity_id: bob.id },
        { cause_id: f.cause_id },
      );
      expect(bobE).toEqual([
        { sub_topic_id: f.sub_topic_id, demonstrated: expected, recent: expected },
      ]);
      const { entries: daveE } = await f.server.tools.queryReputation(
        { identity_id: dave.id },
        { cause_id: f.cause_id },
      );
      expect(daveE).toEqual([
        { sub_topic_id: f.sub_topic_id, demonstrated: -expected, recent: -expected },
      ]);
    }

    {
      const f = fixture({ review: { review_credit_contention_alpha: 0.5 } });
      const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'half-credit',
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
      // contention=0; creditWeight = 0.5 + 0.5*0 = 0.5. Reviewers
      // get half-credit on easy work; with contention=1 they would
      // earn the full delta.
      const { entries: bobE } = await f.server.tools.queryReputation(
        { identity_id: bob.id },
        { cause_id: f.cause_id },
      );
      expect(bobE).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: 0.5, recent: 0.5 }]);
    }
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
    const offered = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (offered.task.kind !== 'excerpt') throw new Error('expected excerpt');
    const submitted = await f.server.tools.proposeExcerpt(bobCaller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      parent_anchor_id: offered.task.parent_anchor_id,
      content: 'span',
      quoted_span: { text: 'span', offset: 0 },
      assignment_id: offered.assignment_id,
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
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: 1, recent: 1 }]);
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

  // v3 closure-stack knob `contested_votes_to_accept` — auto-close-side
  // semantics pinned at the lowest level (`resolveByConvergence` in
  // server.ts). The integration-level v0/v3 delta is pinned by a
  // scripted-decider pair in `population-loop.test.ts` and the model-
  // backed regression baseline rides in the
  // `borderline-contested-v3` cube cell; these tests pin the four
  // canonical cases of the auto-close threshold rule so a regression
  // in the auto-close branch surfaces here before it can mask itself
  // in the higher-level harness.
  describe('contested_votes_to_accept auto-close semantics', () => {
    // Three reviewer identities — enough to drive a 2-accept-1-X
    // tally; the proposer (alice) is the base fixture's caller. The
    // function returns a staged anchor proposal ready for review.
    async function withThreeReviewers(reviewOverrides: Partial<ReviewConfig>) {
      const f = fixture({ review: reviewOverrides });
      const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
      const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
      const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
      const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'x',
        external_ref: { kind: 'pmid', value: '1' },
      });
      return {
        f,
        proposal_id,
        bob: { identity_id: bob.id } as Caller,
        carol: { identity_id: carol.id } as Caller,
        dave: { identity_id: dave.id } as Caller,
      };
    }

    it('v0 (knob inert, default 0): 2-accept-1-revise hits votes_to_accept and auto-closes accept', async () => {
      // Back-compat: with the v3 knob at its default 0, the auto-close
      // accept threshold is `votes_to_accept` regardless of any revise
      // votes — the v0 behavior every existing scenario relies on.
      const { f, proposal_id, bob, carol, dave } = await withThreeReviewers({
        votes_to_accept: 2,
        votes_to_reject: 2,
      });
      await f.server.tools.castReviewVote(bob, { proposal_id, decision: 'accept', rationale: 'a' });
      await f.server.tools.castReviewVote(carol, {
        proposal_id,
        decision: 'revise',
        rationale: 'a',
      });
      // Still staged after 1 accept + 1 revise.
      expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
      await f.server.tools.castReviewVote(dave, {
        proposal_id,
        decision: 'accept',
        rationale: 'a',
      });
      // 2nd accept hits votes_to_accept=2 → auto-closes accept.
      expect(f.server.store.proposals.get(proposal_id)?.status).toBe('accepted');
    });

    it('v3 on, dissent present: 2-accept-1-revise stays staged (contested floor blocks auto-close)', async () => {
      // With `contested_votes_to_accept=3` and any reject or revise
      // vote in the tally, the auto-close-accept threshold is raised
      // to 3. 2 accepts < 3 → the proposal is held for the curator
      // escalation pass rather than auto-closing accept.
      const { f, proposal_id, bob, carol, dave } = await withThreeReviewers({
        votes_to_accept: 2,
        votes_to_reject: 2,
        contested_votes_to_accept: 3,
      });
      await f.server.tools.castReviewVote(bob, { proposal_id, decision: 'accept', rationale: 'a' });
      await f.server.tools.castReviewVote(carol, {
        proposal_id,
        decision: 'revise',
        rationale: 'a',
      });
      await f.server.tools.castReviewVote(dave, {
        proposal_id,
        decision: 'accept',
        rationale: 'a',
      });
      expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
    });

    it('v3 on, dissent present (reject): 2-accept-1-reject stays staged (contested floor blocks auto-close)', async () => {
      // Sibling shape: any *reject* vote is dissent too, raising the
      // accept threshold to the contested floor. This is the exact
      // tally the borderline-contested-v3 cube cell recorded.
      const { f, proposal_id, bob, carol, dave } = await withThreeReviewers({
        votes_to_accept: 2,
        votes_to_reject: 3,
        contested_votes_to_accept: 3,
      });
      await f.server.tools.castReviewVote(bob, { proposal_id, decision: 'accept', rationale: 'a' });
      await f.server.tools.castReviewVote(carol, {
        proposal_id,
        decision: 'reject',
        rationale: 'a',
      });
      await f.server.tools.castReviewVote(dave, {
        proposal_id,
        decision: 'accept',
        rationale: 'a',
      });
      expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
    });

    it('v3 on, no dissent: 2 accepts auto-close at votes_to_accept (contested floor not applied)', async () => {
      // The contested floor only fires when the tally has a reject
      // or revise vote. A clean 2-accept tally still uses
      // `votes_to_accept` — the knob is not a global tightening, it
      // is a *contested-only* tightening. Auto-close fires at 2
      // accepts as it would under v0.
      const { f, proposal_id, bob, dave } = await withThreeReviewers({
        votes_to_accept: 2,
        votes_to_reject: 2,
        contested_votes_to_accept: 3,
      });
      await f.server.tools.castReviewVote(bob, { proposal_id, decision: 'accept', rationale: 'a' });
      await f.server.tools.castReviewVote(dave, {
        proposal_id,
        decision: 'accept',
        rationale: 'a',
      });
      expect(f.server.store.proposals.get(proposal_id)?.status).toBe('accepted');
    });

    it('v3 on, dissent + contested floor met: 3 accepts + 1 revise auto-closes accept', async () => {
      // The contested floor is met — the proposal has enough
      // affirmative weight to override the dissenting revise vote.
      // Validates that the knob is not a unanimity rule: a single
      // revise does not block a strong consensus.
      const { f, proposal_id, bob, carol, dave } = await withThreeReviewers({
        votes_to_accept: 2,
        votes_to_reject: 2,
        contested_votes_to_accept: 3,
      });
      const erin = f.server.bootstrap.mintIdentity({ display_name: 'erin' });
      const erinCaller: Caller = { identity_id: erin.id };
      await f.server.tools.castReviewVote(bob, { proposal_id, decision: 'accept', rationale: 'a' });
      await f.server.tools.castReviewVote(carol, {
        proposal_id,
        decision: 'revise',
        rationale: 'a',
      });
      await f.server.tools.castReviewVote(dave, {
        proposal_id,
        decision: 'accept',
        rationale: 'a',
      });
      // Still staged at 2-revise=1 < contested floor 3.
      expect(f.server.store.proposals.get(proposal_id)?.status).toBe('staged');
      await f.server.tools.castReviewVote(erinCaller, {
        proposal_id,
        decision: 'accept',
        rationale: 'a',
      });
      // 3 accepts ≥ contested floor 3 → auto-closes accept even with
      // the revise in the tally.
      expect(f.server.store.proposals.get(proposal_id)?.status).toBe('accepted');
    });
  });
});

describe('single-slot off-slot guard (testbed-caught review wedge)', () => {
  // PRD §Assignment, "Contributor-initiated work is off-slot": a
  // contributor-initiated cast_review_vote (no assignment_id) while a
  // slot is held in the proposal's cause is refused. The model-backed
  // testbed caught the unrecoverable form: an honest reviewer cast a
  // correct vote without echoing assignment_id, and — review tasks
  // neither lapse on target resolution nor take TTL-shadow — was wedged
  // out of all further work with no recovery.

  async function bobHoldsReviewSlot(f: Fixture) {
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    // Rep entry = the eligibleReviewerPool basis (no capacity, no
    // expertise: cause participation == has-accrued-rep).
    f.server.store.reputations.set(`${bob.id}|${f.cause_id}|${f.sub_topic_id}` as never, {
      identity_id: bob.id as never,
      cause_id: f.cause_id,
      sub_topic_id: f.sub_topic_id,
      demonstrated: 0,
      recent: 0,
      updated_at: f.server.clock.now(),
    });
    const asn = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
        kind: 'review',
      }),
    );
    if (asn.task.kind !== 'review') throw new Error('expected review task');
    expect(f.server.store.assignments.get(asn.assignment_id)?.status).toBe('accepted');
    return { bob, bobCaller, proposal_id, assignment_id: asn.assignment_id };
  }

  it('refuses a contributor-initiated vote (no assignment_id) while the review slot is held', async () => {
    const f = fixture();
    const { bobCaller, proposal_id } = await bobHoldsReviewSlot(f);
    await expect(
      f.server.tools.castReviewVote(bobCaller, {
        proposal_id,
        decision: 'reject',
        rationale: 'span overstates the source',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    // Refused before persistence: nothing recorded, so the corrected
    // re-call is not tripped by one-vote-per-(reviewer, proposal).
    expect(
      [...f.server.store.reviewVotes.values()].some((v) => v.proposal_id === proposal_id),
    ).toBe(false);
  });

  it('the same vote with assignment_id fulfills the slot and frees it', async () => {
    const f = fixture();
    const { bobCaller, proposal_id, assignment_id } = await bobHoldsReviewSlot(f);
    const { vote_id } = await f.server.tools.castReviewVote(bobCaller, {
      proposal_id,
      decision: 'reject',
      rationale: 'span overstates the source',
      assignment_id,
    });
    expect(f.server.store.reviewVotes.get(vote_id)?.assignment_id).toBe(assignment_id);
    const asn = f.server.store.assignments.get(assignment_id);
    expect(asn?.status).toBe('submitted');
    expect(asn?.fulfilled_by).toBe(proposal_id);
    // Slot freed: a re-request is no longer refused with the
    // single-slot invalid_state (it may be not_found if no more review
    // work exists, which is not the wedge).
    await f.server.tools
      .requestAssignment(bobCaller, { cause_id: f.cause_id })
      .catch((e: { code?: string }) => {
        expect(e.code).not.toBe('invalid_state');
      });
  });

  it('does not block a contributor-initiated vote in a different cause (cause-scoped)', async () => {
    const f = fixture();
    const { bobCaller } = await bobHoldsReviewSlot(f);
    // A second cause; alice stages there, bob holds no slot there.
    const cause2 = f.server.bootstrap.createCause({ name: 'AMR', description: 'antibiotics' });
    const st2 = f.server.bootstrap.seedSubTopic({
      cause_id: cause2.id,
      name: 'efflux',
      description: 'efflux pumps',
      scope_query: 'efflux',
    });
    const { proposal_id: p2 } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: cause2.id,
      home_sub_topic_id: st2.id,
      content: 'y',
      external_ref: { kind: 'pmid', value: '2' },
    });
    // Bob's held slot is in f.cause_id; a contributor-initiated vote in
    // cause2 is unaffected by it.
    const { vote_id } = await f.server.tools.castReviewVote(bobCaller, {
      proposal_id: p2,
      decision: 'accept',
      rationale: 'well-anchored',
    });
    expect(f.server.store.reviewVotes.get(vote_id)?.proposal_id).toBe(p2);
  });
});

describe('calibration loop', () => {
  // PRD §Calibration batches: reviewer batches mix real proposals with
  // calibration items drawn from validated history; calibration arrives
  // on the same assignment surface as real review work (PRD §Why assignment-driven contribution closes several attack surfaces).
  // These tests exercise the seam end-to-end at the tool layer:
  // request_assignment injects an accepted-from-history proposal as a
  // review task; cast_review_vote scores against ground truth and
  // adjusts the reviewer's reputation without re-resolving the
  // already-accepted proposal.

  // Sets up an accepted "validated history" proposal under alice and a
  // bob reviewer with review-kind capacity. Calibration injection is
  // configured to fire on bob's first review-task offer.
  async function withCalibrationCandidate(f: ReturnType<typeof fixture>) {
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'validated',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    return { bobCaller, accepted_proposal_id: a.proposal_id };
  }

  it('injects an accepted-from-history proposal as the first review-task offer', async () => {
    const f = fixture({ review: { calibration_inject_every_n: 1 } });
    const { bobCaller, accepted_proposal_id } = await withCalibrationCandidate(f);
    const { task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'review') throw new Error('expected review task');
    // Indistinguishable shape from a real review task: just a review
    // task pointing at a proposal_id. The reviewer can't tell from
    // the task alone that it's calibration.
    expect(task.proposal_id).toBe(accepted_proposal_id);
    expect(f.server.store.proposals.get(accepted_proposal_id)?.status).toBe('accepted');
  });

  it('accept on a calibration item bumps reputation by calibration_pass_gain', async () => {
    const f = fixture({
      review: { calibration_inject_every_n: 1, calibration_pass_gain: 2 },
    });
    const { bobCaller } = await withCalibrationCandidate(f);
    const { assignment_id, task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'review') throw new Error('expected review task');
    await f.server.tools.castReviewVote(bobCaller, {
      proposal_id: task.proposal_id,
      decision: 'accept',
      rationale: 'reads cleanly, span checks out',
      assignment_id,
    });
    const { entries } = await f.server.tools.queryReputation(bobCaller, {
      cause_id: f.cause_id,
    });
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: 2, recent: 2 }]);
  });

  it('reject on a calibration item subtracts calibration_fail_loss', async () => {
    const f = fixture({
      review: { calibration_inject_every_n: 1, calibration_fail_loss: 3 },
    });
    const { bobCaller } = await withCalibrationCandidate(f);
    const { assignment_id, task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'review') throw new Error('expected review task');
    await f.server.tools.castReviewVote(bobCaller, {
      proposal_id: task.proposal_id,
      decision: 'reject',
      rationale: 'underpowered',
      assignment_id,
    });
    const { entries } = await f.server.tools.queryReputation(bobCaller, {
      cause_id: f.cause_id,
    });
    expect(entries).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: -3, recent: -3 }]);
  });

  it('revise on a calibration item moves no reputation', async () => {
    const f = fixture({ review: { calibration_inject_every_n: 1 } });
    const { bobCaller } = await withCalibrationCandidate(f);
    const { assignment_id, task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'review') throw new Error('expected review task');
    await f.server.tools.castReviewVote(bobCaller, {
      proposal_id: task.proposal_id,
      decision: 'revise',
      rationale: 'wants more context',
      assignment_id,
    });
    const { entries } = await f.server.tools.queryReputation(bobCaller, {
      cause_id: f.cause_id,
    });
    expect(entries).toEqual([]);
  });

  it('a calibration vote does not re-resolve the already-accepted proposal', async () => {
    const f = fixture({ review: { calibration_inject_every_n: 1 } });
    const { bobCaller, accepted_proposal_id } = await withCalibrationCandidate(f);
    const { assignment_id, task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'review') throw new Error('expected review task');
    await f.server.tools.castReviewVote(bobCaller, {
      proposal_id: task.proposal_id,
      decision: 'reject',
      rationale: 'no',
      assignment_id,
    });
    // The proposal stays accepted: convergence does not run on
    // already-resolved proposals, so a reject vote on a calibration
    // item can't flip its status.
    expect(f.server.store.proposals.get(accepted_proposal_id)?.status).toBe('accepted');
    // The original proposer's reputation is untouched — calibration
    // scoring acts on the reviewer alone (curator-accepted anchors
    // don't currently bump proposer rep, so this is "still nothing,"
    // which is the right invariant either way: a calibration vote
    // must never flow rep to or from the proposer of the calibration
    // item).
    const { entries: aliceEntries } = await f.server.tools.queryReputation(f.caller, {
      cause_id: f.cause_id,
    });
    expect(aliceEntries).toEqual([]);
    // The reviewer alone takes the calibration hit (-1 default).
    const { entries: bobEntries } = await f.server.tools.queryReputation(bobCaller, {
      cause_id: f.cause_id,
    });
    expect(bobEntries).toEqual([{ sub_topic_id: f.sub_topic_id, demonstrated: -1, recent: -1 }]);
  });

  it('rejects voting on an accepted proposal without an assignment_id', async () => {
    const f = fixture();
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(proposal_id);
    // Contributor-initiated voting on already-accepted work has no
    // defined semantics and is not a calibration entry point — that
    // path requires the assignment seam.
    await expect(
      f.server.tools.castReviewVote(bobCaller, {
        proposal_id,
        decision: 'accept',
        rationale: 'late',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('skips calibration when no validated-history candidate exists, falling back to the frontier', async () => {
    const f = fixture({ review: { calibration_inject_every_n: 1 } });
    // Alice stages but never gets accepted: no calibration material.
    const staged = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'staged',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const bobCaller: Caller = { identity_id: bob.id };
    const { task } = asAssigned(
      await f.server.tools.requestAssignment(bobCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (task.kind !== 'review') throw new Error('expected review task');
    // Calibration draw returned null (no accepted proposals), so the
    // request fell through to the frontier and offered the staged
    // proposal as a normal review task.
    expect(task.proposal_id).toBe(staged.proposal_id);
  });

  it('a calibration draw skips the caller’s own validated proposals', async () => {
    const f = fixture({ review: { calibration_inject_every_n: 1 } });
    // Alice has an accepted proposal (validated history). She asks for
    // review-kind work only (strict `kind` filter). The calibration
    // draw must skip her own proposal (conflict of interest invariant),
    // and no other review work exists, so the request resolves to idle
    // — the excerpt work her own orphan anchor implies is excluded by
    // the kind filter, isolating the COI behavior under test.
    const a = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'mine',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(a.proposal_id);
    const result = await f.server.tools.requestAssignment(f.caller, {
      cause_id: f.cause_id,
      kind: 'review',
    });
    expect(result.status).toBe('idle');
  });
});

describe('two-component reputation decay', () => {
  // PRD §Reputation: demonstrated-competence (slow-decay) and
  // recent-activity (fast-decay) move together on every reputation
  // event; the half-lives applied at read time are what produces the
  // differential. The test pins three properties of the v0
  // bookkeeping:
  //   - default half-lives are Infinity (no decay; both fields equal
  //     the cumulative bump).
  //   - finite half-lives apply exponential decay on read, with each
  //     component decaying independently per its own half-life.
  //   - subsequent bumps land on the freshly-decayed value, so the
  //     stored snapshot stays a faithful at-bump-time anchor.
  // The eligibility and assignment gates that *consume* these
  // components — `assignment_min_recent` (fast-decay, gates
  // assignment) and `assignment_min_demonstrated` (slow-decay,
  // gates eligibility tiers) — are wired today (PRD §Reputation,
  // ROADMAP §Status) and have their own scenarios in testbed.test.
  // This test stays as the bookkeeping-correctness handle those
  // gates read against: change the decay math and this test fires
  // before the gate scenarios start observing inconsistent values.
  it('decays demonstrated and recent on read with their respective half-lives', async () => {
    // tickMs=0 — auto-advance per now() call would otherwise eat
    // into the half-life across the dozen-odd clock reads each tool
    // call performs. This test cares only about deliberate advances.
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('d'),
      verifier: new FakeVerifier(),
      review: {
        // Demonstrated stays effectively unchanged across the test's
        // simulated horizon; recent has a 60s half-life so a 60s
        // advance halves it cleanly.
        demonstrated_half_life_seconds: Infinity,
        recent_half_life_seconds: 60,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential: aliceCred } = server.bootstrap.bindAgentCredential({
      identity_id: alice.id,
      label: 'desktop',
    });
    const aliceCaller: Caller = { identity_id: alice.id, agent_credential_id: aliceCred.id };
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'mrd',
      description: 'mrd',
      scope_query: 'mrd',
    });

    // Land a +2 reputation bump via two converged accepts on alice's
    // contributor-initiated proposals (each contributes +1 *
    // contributor_initiated_factor = 0.5; we use direct rep movement
    // via reviewer accuracy for cleaner deltas — alice reviews two
    // accepted proposals that survive convergence). Skip the ceremony
    // and use a curator path that nudges rep directly: two assigned
    // reviews of bob's proposals that converge with alice's vote.
    //
    // Simplest: alice proposes one anchor with assignment-driven
    // weight via the bootstrap path, but that requires capacity etc.
    // Instead, exercise the public surface: alice is the proposer
    // (gain +0.5 contributor-initiated on accept) and we run two
    // accepts. After two converged accepts, alice has demonstrated =
    // recent = 1.0.
    for (let i = 1; i <= 2; i++) {
      const { proposal_id } = await server.tools.proposeAnchor(aliceCaller, {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `paper ${i}`,
        external_ref: { kind: 'pmid', value: String(i) },
      });
      const bob = server.bootstrap.mintIdentity({ display_name: `bob-${i}` });
      const carol = server.bootstrap.mintIdentity({ display_name: `carol-${i}` });
      await server.tools.castReviewVote(
        { identity_id: bob.id },
        { proposal_id, decision: 'accept', rationale: 'b' },
      );
      await server.tools.castReviewVote(
        { identity_id: carol.id },
        { proposal_id, decision: 'accept', rationale: 'c' },
      );
    }
    const initial = await server.tools.queryReputation(aliceCaller, { cause_id: cause.id });
    expect(initial.entries).toEqual([{ sub_topic_id: subTopic.id, demonstrated: 1, recent: 1 }]);

    // Jump 60s forward — one recent-half-life. demonstrated stays at
    // 1.0 (Infinity half-life); recent halves to 0.5.
    clock.advance(60_000);
    const afterOne = await server.tools.queryReputation(aliceCaller, { cause_id: cause.id });
    const afterOneEntry = afterOne.entries[0];
    expect(afterOneEntry?.demonstrated).toBe(1);
    expect(afterOneEntry?.recent).toBeCloseTo(0.5, 10);

    // Jump another 60s — recent halves again to 0.25; demonstrated
    // unchanged.
    clock.advance(60_000);
    const afterTwo = await server.tools.queryReputation(aliceCaller, { cause_id: cause.id });
    const afterTwoEntry = afterTwo.entries[0];
    expect(afterTwoEntry?.demonstrated).toBe(1);
    expect(afterTwoEntry?.recent).toBeCloseTo(0.25, 10);
  });

  it('lands subsequent bumps on the freshly-decayed snapshot', async () => {
    // Successive bumps must not compound stale values. After a decay
    // window, the next bump should add to the decayed value, not the
    // pre-decay one — otherwise two-component reputation degenerates
    // back to a cumulative-since-creation tally.
    // tickMs=0 — auto-advance per now() call would otherwise eat
    // into the half-life across the dozen-odd clock reads each tool
    // call performs. This test cares only about deliberate advances.
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('d2'),
      verifier: new FakeVerifier(),
      review: {
        demonstrated_half_life_seconds: Infinity,
        recent_half_life_seconds: 60,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential: aliceCred } = server.bootstrap.bindAgentCredential({
      identity_id: alice.id,
      label: 'desktop',
    });
    const aliceCaller: Caller = { identity_id: alice.id, agent_credential_id: aliceCred.id };
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'mrd',
      description: 'mrd',
      scope_query: 'mrd',
    });

    // First +0.5 bump (one contributor-initiated accept).
    const first = await server.tools.proposeAnchor(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'paper 1',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    await server.tools.castReviewVote(
      { identity_id: bob.id },
      { proposal_id: first.proposal_id, decision: 'accept', rationale: 'b' },
    );
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      { proposal_id: first.proposal_id, decision: 'accept', rationale: 'c' },
    );

    // Advance 60s — recent halves to 0.25 (pre-bump 0.5 → 0.25).
    clock.advance(60_000);

    // Second +0.5 bump.
    const second = await server.tools.proposeAnchor(aliceCaller, {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'paper 2',
      external_ref: { kind: 'pmid', value: '2' },
    });
    const dave = server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erin = server.bootstrap.mintIdentity({ display_name: 'erin' });
    await server.tools.castReviewVote(
      { identity_id: dave.id },
      { proposal_id: second.proposal_id, decision: 'accept', rationale: 'd' },
    );
    await server.tools.castReviewVote(
      { identity_id: erin.id },
      { proposal_id: second.proposal_id, decision: 'accept', rationale: 'e' },
    );

    // demonstrated = 0.5 + 0.5 = 1.0 (no decay).
    // recent = decay(0.5) + 0.5 = 0.25 + 0.5 = 0.75.
    const after = await server.tools.queryReputation(aliceCaller, { cause_id: cause.id });
    const entry = after.entries[0];
    expect(entry?.demonstrated).toBeCloseTo(1, 10);
    expect(entry?.recent).toBeCloseTo(0.75, 10);
  });
});

describe('recent-activity assignment gate', () => {
  // PRD §Reputation: the recent-activity component, fast-decay, gates
  // assignment. Three properties:
  //   - default threshold (0) leaves the gate inert.
  //   - a caller with no rep entries in the cause bypasses the gate
  //     even when the threshold is positive (fresh-reviewer
  //     bootstrap; without this, no one could ever earn their first
  //     assignment in a cause).
  //   - a caller with rep entries whose recent has decayed below the
  //     threshold is refused — and a path back exists via
  //     contributor-initiated voting, which never reaches
  //     request_assignment.
  it('with default threshold of 0, fresh callers and rep-bearing callers both pass', async () => {
    // Sanity check that the gate stays out of the way of every other
    // existing scenario when its knob isn't set.
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('g'),
      verifier: new FakeVerifier(),
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential: aliceCred } = server.bootstrap.bindAgentCredential({
      identity_id: alice.id,
      label: 'desktop',
    });
    const aliceCaller: Caller = { identity_id: alice.id, agent_credential_id: aliceCred.id };
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'mrd',
      description: 'mrd',
      scope_query: 'mrd',
    });
    // No frontier task available — request resolves to idle (the gate
    // didn't fire; the response shape pins that, since a gate refusal
    // would still throw).
    const result = await server.tools.requestAssignment(aliceCaller, { cause_id: cause.id });
    expect(result.status).toBe('idle');
  });

  it('bypasses callers with no rep entries in the cause (fresh-reviewer bootstrap)', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('g2'),
      verifier: new FakeVerifier(),
      review: {
        assignment_min_recent: 0.5,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential: aliceCred } = server.bootstrap.bindAgentCredential({
      identity_id: alice.id,
      label: 'desktop',
    });
    const aliceCaller: Caller = { identity_id: alice.id, agent_credential_id: aliceCred.id };
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'mrd',
      description: 'mrd',
      scope_query: 'mrd',
    });
    // Bob proposes an excerpt for alice to review. Bob doesn't need
    // capacity (proposing is contributor-initiated).
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const anchor = await server.tools.proposeAnchor(
      { identity_id: bob.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(anchor.proposal_id);
    await server.tools.proposeExcerpt(
      { identity_id: bob.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: [...server.store.nodes.values()].find(
          (n) => n.kind === 'anchor' && n.content === 'paper',
        )!.id,
        content: 'excerpt',
        quoted_span: { text: 'excerpt', offset: 0 },
      },
    );
    // Alice has no rep entries in this cause — gate bypasses, she
    // gets assigned the staged excerpt for review.
    const result = asAssigned(
      await server.tools.requestAssignment(aliceCaller, {
        cause_id: cause.id,
      }),
    );
    expect(result.task.kind).toBe('review');
  });

  it('refuses callers whose recent has decayed below the threshold', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z', 0);
    const server = new Server({
      clock,
      idGen: new SeededIdGen('g3'),
      verifier: new FakeVerifier(),
      review: {
        // Threshold above what a single +1 bump leaves after one
        // half-life: bump → recent=1; advance one half-life → 0.5;
        // threshold 0.6 catches it. Demonstrated stays at 1 (Infinity
        // half-life), so the gate is purely on recent.
        assignment_min_recent: 0.6,
        recent_half_life_seconds: 60,
        demonstrated_half_life_seconds: Infinity,
      },
    });
    const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential: aliceCred } = server.bootstrap.bindAgentCredential({
      identity_id: alice.id,
      label: 'desktop',
    });
    const aliceCaller: Caller = { identity_id: alice.id, agent_credential_id: aliceCred.id };
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'crc' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'mrd',
      description: 'mrd',
      scope_query: 'mrd',
    });

    // Alice gains rep by reviewing one of bob's proposals. Two other
    // identities cast the convergence-driving votes; alice's accept
    // is one of them, accruing +1 to her recent (and demonstrated).
    const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
    const carol = server.bootstrap.mintIdentity({ display_name: 'carol' });
    const anchor = await server.tools.proposeAnchor(
      { identity_id: bob.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'paper-1',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(anchor.proposal_id);
    const anchorNode = [...server.store.nodes.values()].find(
      (n) => n.kind === 'anchor' && n.content === 'paper-1',
    )!;
    const excerpt1 = await server.tools.proposeExcerpt(
      { identity_id: bob.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorNode.id,
        content: 'excerpt-1',
        quoted_span: { text: 'excerpt-1', offset: 0 },
      },
    );
    await server.tools.castReviewVote(aliceCaller, {
      proposal_id: excerpt1.proposal_id,
      decision: 'accept',
      rationale: 'a',
    });
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      {
        proposal_id: excerpt1.proposal_id,
        decision: 'accept',
        rationale: 'c',
      },
    );
    // Convergence reached: excerpt-1 accepted; alice gains +1 on both
    // components.
    const initial = await server.tools.queryReputation(aliceCaller, { cause_id: cause.id });
    expect(initial.entries[0]?.recent).toBe(1);

    // Stage a fresh proposal so the frontier is non-empty for the
    // gate check (otherwise the gate fires before the frontier loop
    // and we can't tell which path refused).
    await server.tools.proposeExcerpt(
      { identity_id: bob.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorNode.id,
        content: 'excerpt-2',
        quoted_span: { text: 'excerpt-2', offset: 0 },
      },
    );

    // Advance one half-life. Alice's recent drops to 0.5, below the
    // 0.6 threshold. Demonstrated stays at 1.
    clock.advance(60_000);

    await expect(
      server.tools.requestAssignment(aliceCaller, { cause_id: cause.id }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Alice can recover via contributor-initiated voting (no
    // assignment_id). That bumps her recent without going through
    // request_assignment, demonstrating the recovery path PRD names.
    // Alice's contributor-initiated vote counts as a reviewer-rep
    // event when convergence resolves.
    await server.tools.castReviewVote(aliceCaller, {
      proposal_id: [...server.store.proposals.values()].find(
        (p) => p.payload.kind === 'excerpt' && p.payload.content === 'excerpt-2',
      )!.id,
      decision: 'accept',
      rationale: 'a',
    });
    await server.tools.castReviewVote(
      { identity_id: carol.id },
      {
        proposal_id: [...server.store.proposals.values()].find(
          (p) => p.payload.kind === 'excerpt' && p.payload.content === 'excerpt-2',
        )!.id,
        decision: 'accept',
        rationale: 'c',
      },
    );
    // After a second +1 (landing on the decayed 0.5 recent),
    // alice's recent is 0.5 + 1 = 1.5 — above threshold. Stage a
    // third proposal and confirm the gate now passes.
    await server.tools.proposeExcerpt(
      { identity_id: bob.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        parent_anchor_id: anchorNode.id,
        content: 'excerpt-3',
        quoted_span: { text: 'excerpt-3', offset: 0 },
      },
    );
    const recovered = asAssigned(
      await server.tools.requestAssignment(aliceCaller, {
        cause_id: cause.id,
      }),
    );
    expect(recovered.task.kind).toBe('review');
  });
});

describe('stratified-by-history reviewer assignment', () => {
  // Build a sub-topic with `count` accepted anchors and `count`
  // staged excerpts hanging off them. Returns the staged excerpt ids
  // in creation order for use as priming targets and final targets.
  // Anchors and excerpts are alice's; the caller in `f` proposes them.
  async function seedExcerpts(f: Fixture, count: number): Promise<string[]> {
    const excerptIds: string[] = [];
    for (let i = 1; i <= count; i++) {
      const a = await f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: `paper ${i}`,
        external_ref: { kind: 'pmid', value: String(i) },
      });
      f.server.curator.acceptProposal(a.proposal_id);
      const anchorNode = [...f.server.store.nodes.values()].find(
        (n) => n.kind === 'anchor' && n.content === `paper ${i}`,
      );
      if (!anchorNode) throw new Error('anchor not materialized');
      const e = await f.server.tools.proposeExcerpt(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        parent_anchor_id: anchorNode.id,
        content: `excerpt ${i}`,
        quoted_span: { text: 'span', offset: 0 },
      });
      excerptIds.push(e.proposal_id);
    }
    return excerptIds;
  }

  // The eligible reviewer pool is identities with a reputation entry
  // in the cause (PRD §Reviewer assignment — no capacity, no expertise
  // routing). A fresh reviewer accrues rep only when a proposal they
  // voted on resolves, which is circular for these clustering setups,
  // so register each reviewer as a cause participant with a neutral
  // (0,0) entry. This is pool membership only; `computeReviewerStrata`
  // still derives clusters from the vote history, untouched.
  function seedReviewerRep(f: Fixture, ...ids: { id: string }[]): void {
    for (const { id } of ids) {
      f.server.store.reputations.set(`${id}|${f.cause_id}|${f.sub_topic_id}` as never, {
        identity_id: id as never,
        cause_id: f.cause_id,
        sub_topic_id: f.sub_topic_id,
        demonstrated: 0,
        recent: 0,
        updated_at: f.server.clock.now(),
      });
    }
  }

  it('clusters reviewers who co-vote on shared proposals into one stratum', async () => {
    // Two reviewers (carol, dave) co-vote accept on three primer
    // excerpts; clustering should put them in the same stratum. erin
    // (no shared history) is a singleton. With stratum_target_count=2
    // and an eligible pool of {carol, dave} only, the target proposal
    // must surface as stratification_degraded — there's only one
    // stratum reachable.
    const f = fixture({
      review: {
        votes_to_accept: 10,
        votes_to_reject: 10,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
      },
    });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolCaller: Caller = { identity_id: carol.id };
    const daveCaller: Caller = { identity_id: dave.id };
    seedReviewerRep(f, carol, dave);

    // Three priming excerpts plus the target. Carol and Dave vote
    // accept on the priming three (shared history); the target stays
    // unvoted.
    const [p0, p1, p2, targetId] = await seedExcerpts(f, 4);
    if (!p0 || !p1 || !p2 || !targetId) throw new Error('seed mismatch');
    for (const pid of [p0, p1, p2]) {
      await f.server.tools.castReviewVote(carolCaller, {
        proposal_id: pid as never,
        decision: 'accept',
        rationale: 'looks fine',
      });
      await f.server.tools.castReviewVote(daveCaller, {
        proposal_id: pid as never,
        decision: 'accept',
        rationale: 'agreed',
      });
    }

    const { proposals } = await f.server.tools.queryProposals(f.caller, {
      status: 'staged',
    });
    const target = proposals.find((p) => p.id === targetId);
    expect(target).toBeDefined();
    // Eligible pool is {carol, dave}, both clustered → one reachable
    // stratum, below stratum_target_count=2 → degraded.
    expect(target?.stratification_degraded).toBe(true);
  });

  it('treats reviewers with no shared history as singleton strata (not degraded)', async () => {
    // Same shape as above but the two reviewers never co-vote — they
    // each have only their own vote history. Each is its own
    // singleton stratum; the eligible pool covers two strata; not
    // degraded.
    const f = fixture({
      review: {
        votes_to_accept: 10,
        votes_to_reject: 10,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
      },
    });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolCaller: Caller = { identity_id: carol.id };
    const daveCaller: Caller = { identity_id: dave.id };
    seedReviewerRep(f, carol, dave);

    const [p0, p1, p2, targetId] = await seedExcerpts(f, 4);
    if (!p0 || !p1 || !p2 || !targetId) throw new Error('seed mismatch');
    // Carol votes on p0, p1; Dave votes on p1, p2. Only p1 is shared
    // — below the min_shared=2 floor, so no edge forms.
    await f.server.tools.castReviewVote(carolCaller, {
      proposal_id: p0 as never,
      decision: 'accept',
      rationale: 'a',
    });
    await f.server.tools.castReviewVote(carolCaller, {
      proposal_id: p1 as never,
      decision: 'accept',
      rationale: 'a',
    });
    await f.server.tools.castReviewVote(daveCaller, {
      proposal_id: p1 as never,
      decision: 'accept',
      rationale: 'a',
    });
    await f.server.tools.castReviewVote(daveCaller, {
      proposal_id: p2 as never,
      decision: 'accept',
      rationale: 'a',
    });

    const { proposals } = await f.server.tools.queryProposals(f.caller, {
      status: 'staged',
    });
    const target = proposals.find((p) => p.id === targetId);
    expect(target?.stratification_degraded).toBe(false);
  });

  it('leaves stratification_degraded undefined when stratification is disabled', async () => {
    const f = fixture(); // defaults: stratification_enabled = false
    const [targetId] = await seedExcerpts(f, 1);
    if (!targetId) throw new Error('seed mismatch');
    const { proposals } = await f.server.tools.queryProposals(f.caller, {
      status: 'staged',
    });
    const target = proposals.find((p) => p.id === targetId);
    expect(target).toBeDefined();
    expect(target?.stratification_degraded).toBeUndefined();
  });

  it('cross-stratum draw skips a co-stratum reviewer when one is already routed', async () => {
    // Carol and Dave are clustered (co-voted on 3 primer excerpts).
    // Carol picks up the target via request_assignment first. Dave's
    // request_assignment then has no eligible review task — the
    // target is the only candidate, and Carol-already-routed +
    // Dave-co-stratum-with-Carol means it's skipped for Dave.
    // Erin (singleton) can pick the target up.
    //
    // votes_to_X = 2 so the priming co-accepts (2 per proposal) drive
    // each priming proposal to status=accepted, removing them from the
    // frontier. Their votes still inform clustering — vote history
    // survives proposal resolution. The target (4th excerpt) is the
    // only staged proposal at the time of the request_assignment
    // calls below.
    const f = fixture({
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
      },
    });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
    const erin = f.server.bootstrap.mintIdentity({ display_name: 'erin' });
    const carolCaller: Caller = { identity_id: carol.id };
    const daveCaller: Caller = { identity_id: dave.id };
    const erinCaller: Caller = { identity_id: erin.id };
    seedReviewerRep(f, carol, dave, erin);

    const [p0, p1, p2, targetId] = await seedExcerpts(f, 4);
    if (!p0 || !p1 || !p2 || !targetId) throw new Error('seed mismatch');
    for (const pid of [p0, p1, p2]) {
      await f.server.tools.castReviewVote(carolCaller, {
        proposal_id: pid as never,
        decision: 'accept',
        rationale: 'a',
      });
      await f.server.tools.castReviewVote(daveCaller, {
        proposal_id: pid as never,
        decision: 'accept',
        rationale: 'a',
      });
    }

    // Carol pulls first: gets the target excerpt.
    const carolAssign = asAssigned(
      await f.server.tools.requestAssignment(carolCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (carolAssign.task.kind !== 'review') throw new Error('expected review task');
    expect(carolAssign.task.proposal_id).toBe(targetId);

    // Dave pulls next: cross-stratum skip blocks the target. The only
    // remaining frontier review item is the target (the priming three
    // already have votes from both carol and dave, so they are
    // filtered out by the already-voted gate). With the target
    // skipped, Dave's eligible frontier is empty — the request
    // resolves to idle (the cold-start UX fix that landed alongside
    // this honest contract turned the old `not_found` throw into a
    // structured "no work for you" payload).
    const daveResult = await f.server.tools.requestAssignment(daveCaller, {
      cause_id: f.cause_id,
    });
    expect(daveResult.status).toBe('idle');

    // Erin (singleton stratum, distinct from Carol's cluster) still
    // gets the target: cross-stratum check passes.
    const erinAssign = asAssigned(
      await f.server.tools.requestAssignment(erinCaller, {
        cause_id: f.cause_id,
      }),
    );
    if (erinAssign.task.kind !== 'review') throw new Error('expected review task');
    expect(erinAssign.task.proposal_id).toBe(targetId);
  });

  it('tightens convergence threshold on a stratification-degraded proposal', async () => {
    // Eligible pool = {carol, dave}, both clustered → 1 stratum
    // reachable; target stratum_count=2 → degraded. With votes_to_X=2
    // and stratification_degraded_extra=1, the effective threshold
    // is 3. Two coalition rejects on the target excerpt do not drive
    // it to rejected — the proposal stays staged.
    const f = fixture({
      review: {
        votes_to_accept: 2,
        votes_to_reject: 2,
        stratification_enabled: true,
        stratum_min_shared_proposals: 2,
        stratum_agreement_threshold: 1.0,
        stratum_target_count: 2,
        stratification_degraded_extra: 1,
      },
    });
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const dave = f.server.bootstrap.mintIdentity({ display_name: 'dave' });
    const carolCaller: Caller = { identity_id: carol.id };
    const daveCaller: Caller = { identity_id: dave.id };
    seedReviewerRep(f, carol, dave);

    // Priming: three co-rejects build the cluster signal. Each
    // priming proposal lands at status=rejected after the second
    // vote, but their votes still exist in the store and still inform
    // clustering. Three priming proposals (rather than two) keeps the
    // shared-vote count strictly above the min_shared floor.
    const [p0, p1, p2, targetId] = await seedExcerpts(f, 4);
    if (!p0 || !p1 || !p2 || !targetId) throw new Error('seed mismatch');
    for (const pid of [p0, p1, p2]) {
      await f.server.tools.castReviewVote(carolCaller, {
        proposal_id: pid as never,
        decision: 'reject',
        rationale: 'underpowered',
      });
      await f.server.tools.castReviewVote(daveCaller, {
        proposal_id: pid as never,
        decision: 'reject',
        rationale: 'underpowered',
      });
    }

    // Target excerpt: both coalition members reject. Without the
    // degraded-tightening, this would be 2 rejects >= votes_to_reject
    // = 2 and the proposal would converge to rejected. With the
    // degraded flag firing (eligible pool covers only the clustered
    // stratum), the threshold is 3 and the proposal stays staged.
    await f.server.tools.castReviewVote(carolCaller, {
      proposal_id: targetId as never,
      decision: 'reject',
      rationale: 'underpowered',
    });
    await f.server.tools.castReviewVote(daveCaller, {
      proposal_id: targetId as never,
      decision: 'reject',
      rationale: 'underpowered',
    });

    const target = f.server.store.proposals.get(targetId as never);
    expect(target?.status).toBe('staged');
  });
});
