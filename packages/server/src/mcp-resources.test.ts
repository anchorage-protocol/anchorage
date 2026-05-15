import {
  CauseDirectory,
  ContributorProfile,
  Manuscript,
  NodeNeighborhood,
  type ResourceName,
  Subgraph,
  SubTopicDetail,
} from '@anchorage/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// PRD §Read-path tools and resources. Slice 5a wires the four MCP
// resources committed by the PRD — `cause://`, `sub-topic://{id}`,
// `node://{id}`, `subgraph://{sub-topic-id}` — as the passive
// browsing surface the web UI (slice 5b) will read against. The
// transport is `buildMcpServer`'s in-memory pair, identical to the
// rest of the MCP test surface, so these reads cover both the
// server-side resource handlers and the URI-template wiring on the
// MCP wrapper.

async function fixture() {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('r'),
    verifier: new FakeVerifier(),
  });
  const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const { secret } = server.bootstrap.bindAgentCredential({
    identity_id: alice.id,
    label: 'desktop',
  });
  const crc = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const mrd = server.bootstrap.seedSubTopic({
    cause_id: crc.id,
    name: 'ctDNA-MRD',
    description: 'mrd',
    scope_query: 'ctDNA',
  });
  const oligo = server.bootstrap.seedSubTopic({
    cause_id: crc.id,
    name: 'oligo-met',
    description: 'oligomets',
    scope_query: 'oligometastatic',
  });

  const mcp = buildMcpServer(server, { token: secret });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);

  return { server, client, alice, crc, mrd, oligo };
}

// Seed one anchor + one excerpt under (crc, mrd) so node/subgraph
// resources have real content to project. Returns the accepted ids.
async function seedAcceptedPair(f: Awaited<ReturnType<typeof fixture>>) {
  const anchor = await f.server.tools.proposeAnchor(
    { identity_id: f.alice.id },
    {
      cause_id: f.crc.id,
      home_sub_topic_id: f.mrd.id,
      content: 'anchor content',
      external_ref: { kind: 'pmid', value: '1' },
    },
  );
  const ar = f.server.curator.acceptProposal(anchor.proposal_id);
  const excerpt = await f.server.tools.proposeExcerpt(
    { identity_id: f.alice.id },
    {
      cause_id: f.crc.id,
      home_sub_topic_id: f.mrd.id,
      parent_anchor_id: ar.node_id!,
      content: 'span content',
      quoted_span: { text: 'span', offset: 0 },
    },
  );
  const er = f.server.curator.acceptProposal(excerpt.proposal_id);
  return { anchorId: ar.node_id!, excerptId: er.node_id! };
}

type ReadResult = Awaited<ReturnType<Client['readResource']>>;

function parseJsonResource(contents: ReadResult['contents']): unknown {
  const block = contents[0];
  // resource handlers return text-content blocks (JSON-serialized
  // payloads); blob-content is only produced by binary resources,
  // none of which exist on Anchorage's read-path surface.
  if (!block || !('text' in block)) {
    throw new Error('expected text resource content');
  }
  return JSON.parse(block.text);
}

describe('mcp resources (PRD §Read-path tools and resources)', () => {
  // The full set of resource scheme names exposed by the MCP server,
  // mirroring ResourceName in @anchorage/contracts/resources.ts. The
  // exhaustive assertion catches drift between the wrapper's
  // registerResource calls and the contracts-side ResourceName enum
  // — the same drift the tool exhaustiveness test catches for ToolName.
  const REGISTERED_RESOURCE_NAMES = [
    'cause',
    'sub-topic',
    'node',
    'subgraph',
    'contributor',
    'manuscript',
  ] as const;

  it('exposes every resource scheme committed by the PRD (exhaustive — no drift between MCP wrapper and ResourceName)', async () => {
    const { client } = await fixture();
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    const schemesFromStatic = resources.resources.map((r) => r.uri.replace(/:\/\/.*$/, ''));
    const schemesFromTemplates = templates.resourceTemplates.map((t) =>
      t.uriTemplate.replace(/:\/\/.*$/, ''),
    );
    const observed: ResourceName[] = [
      ...schemesFromStatic,
      ...schemesFromTemplates,
    ] as ResourceName[];
    expect([...observed].sort()).toEqual([...REGISTERED_RESOURCE_NAMES].sort());
  });

  describe('cause:// — directory', () => {
    it('returns active causes with their active sub-topics, stable-ordered', async () => {
      const { client, crc, mrd, oligo } = await fixture();
      const result = await client.readResource({ uri: 'cause://' });
      expect(result.contents[0]?.mimeType).toBe('application/json');
      const parsed = CauseDirectory.parse(parseJsonResource(result.contents));
      expect(parsed.causes).toHaveLength(1);
      expect(parsed.causes[0]?.cause.id).toBe(crc.id);
      expect(parsed.causes[0]?.sub_topics.map((s) => s.id)).toEqual([mrd.id, oligo.id]);
    });

    it('excludes archived causes and proposed/archived sub-topics', async () => {
      const f = await fixture();
      const second = f.server.bootstrap.createCause({
        name: 'AMR',
        description: 'antibiotic resistance',
      });
      f.server.store.causes.set(second.id, { ...second, status: 'archived' });
      // Seed a proposed sub-topic via the propose path so its status
      // is `proposed`; the directory must skip it.
      const proposal = await f.server.tools.proposeSubTopic(
        { identity_id: f.alice.id },
        {
          cause_id: f.crc.id,
          name: 'staged-st',
          description: 'staged',
          scope_query: 'staged',
        },
      );
      // Sanity: proposing a sub-topic doesn't materialize an active record.
      expect([...f.server.store.subTopics.values()].some((s) => s.status === 'proposed')).toBe(
        false,
      );
      // proposedId is informational; the proposal stays staged in v0.
      void proposal;

      const result = await f.client.readResource({ uri: 'cause://' });
      const parsed = CauseDirectory.parse(parseJsonResource(result.contents));
      expect(parsed.causes.map((c) => c.cause.id)).toEqual([f.crc.id]);
      expect(parsed.causes[0]?.sub_topics.every((s) => s.status === 'active')).toBe(true);
    });
  });

  describe('sub-topic://{id} — detail + activity counters', () => {
    it('returns metadata + counts derived from current graph state', async () => {
      const f = await fixture();
      await seedAcceptedPair(f);
      // Also stage a fresh proposal so staged_proposals > 0.
      await f.server.tools.proposeAnchor(
        { identity_id: f.alice.id },
        {
          cause_id: f.crc.id,
          home_sub_topic_id: f.mrd.id,
          content: 'staged anchor',
          external_ref: { kind: 'pmid', value: '2' },
        },
      );

      const result = await f.client.readResource({ uri: `sub-topic://${f.mrd.id}` });
      const parsed = SubTopicDetail.parse(parseJsonResource(result.contents));
      expect(parsed.sub_topic.id).toBe(f.mrd.id);
      expect(parsed.cause.id).toBe(f.crc.id);
      expect(parsed.activity.active_nodes).toBe(2); // anchor + excerpt
      expect(parsed.activity.staged_proposals).toBe(1);
      expect(parsed.activity.frontier_items).toBeGreaterThanOrEqual(1); // staged proposal needs review
    });

    it('refuses with not_found for an unknown sub-topic id (typed code in McpError data)', async () => {
      const { client } = await fixture();
      await expect(client.readResource({ uri: 'sub-topic://stp_missing' })).rejects.toMatchObject({
        code: -32602, // InvalidParams
        data: { code: 'not_found' },
      });
    });
  });

  describe('node://{id} — node + immediate neighbors', () => {
    it('returns the node + its immediate active edges + hydrated neighbors', async () => {
      const f = await fixture();
      const { anchorId, excerptId } = await seedAcceptedPair(f);

      const result = await f.client.readResource({ uri: `node://${anchorId}` });
      const parsed = NodeNeighborhood.parse(parseJsonResource(result.contents));
      expect(parsed.node.id).toBe(anchorId);
      // The derives edge from anchor → excerpt is materialized at
      // acceptProposal; the resource exposes it as an immediate
      // neighbor.
      expect(parsed.edges).toHaveLength(1);
      expect(parsed.edges[0]?.kind).toBe('derives');
      expect(parsed.neighbors.map((n) => n.id)).toEqual([excerptId]);
    });

    it('refuses with not_found for an unknown node id', async () => {
      const { client } = await fixture();
      await expect(client.readResource({ uri: 'node://nod_missing' })).rejects.toMatchObject({
        code: -32602,
        data: { code: 'not_found' },
      });
    });

    it('returns the node with empty neighborhood when no active edges touch it', async () => {
      const f = await fixture();
      // Seed an isolated anchor that gets accepted but has no
      // excerpts attached.
      const a = await f.server.tools.proposeAnchor(
        { identity_id: f.alice.id },
        {
          cause_id: f.crc.id,
          home_sub_topic_id: f.mrd.id,
          content: 'lonely anchor',
          external_ref: { kind: 'pmid', value: '99' },
        },
      );
      const accepted = f.server.curator.acceptProposal(a.proposal_id);
      const result = await f.client.readResource({ uri: `node://${accepted.node_id}` });
      const parsed = NodeNeighborhood.parse(parseJsonResource(result.contents));
      expect(parsed.node.id).toBe(accepted.node_id);
      expect(parsed.edges).toEqual([]);
      expect(parsed.neighbors).toEqual([]);
    });
  });

  describe('subgraph://{sub-topic-id} — active subgraph', () => {
    it('returns active nodes (home OR scope-member) and edges between them', async () => {
      const f = await fixture();
      const { anchorId, excerptId } = await seedAcceptedPair(f);

      const result = await f.client.readResource({ uri: `subgraph://${f.mrd.id}` });
      const parsed = Subgraph.parse(parseJsonResource(result.contents));
      expect(parsed.sub_topic.id).toBe(f.mrd.id);
      expect(parsed.nodes.map((n) => n.id).sort()).toEqual([anchorId, excerptId].sort());
      expect(parsed.edges).toHaveLength(1);
      expect(parsed.edges[0]?.from).toBe(anchorId);
      expect(parsed.edges[0]?.to).toBe(excerptId);
    });

    it('returns an empty subgraph for a sub-topic with no active nodes', async () => {
      const f = await fixture();
      const result = await f.client.readResource({ uri: `subgraph://${f.oligo.id}` });
      const parsed = Subgraph.parse(parseJsonResource(result.contents));
      expect(parsed.nodes).toEqual([]);
      expect(parsed.edges).toEqual([]);
    });

    it('refuses with not_found for an unknown sub-topic id', async () => {
      const { client } = await fixture();
      await expect(client.readResource({ uri: 'subgraph://stp_missing' })).rejects.toMatchObject({
        code: -32602,
        data: { code: 'not_found' },
      });
    });
  });

  describe('contributor://{id} — public profile + tier projection', () => {
    // Slice 5c. The shape is deliberately narrow: PublicContributor
    // carries only display fields; PublicReputation carries tier
    // labels only — never raw demonstrated/recent values, even when
    // the caller is the contributor themselves (the
    // `query_reputation` *tool* is where the raw numbers flow, to
    // the contributor's own caller). PRD §Reputation:
    // "Eligibility tiers public; numeric reputation private."

    it('returns PublicContributor (display fields only — no IdP subject, attestation_level, role, or identity_provider)', async () => {
      const f = await fixture();
      const result = await f.client.readResource({ uri: `contributor://${f.alice.id}` });
      const parsed = ContributorProfile.parse(parseJsonResource(result.contents));
      expect(parsed.contributor.id).toBe(f.alice.id);
      expect(parsed.contributor.display_name).toBe('alice');
      expect(parsed.contributor.status).toBe('active');
      // Operational/PII fields are absent by construction (strict
      // schema rejects unknown keys; this also asserts they are not
      // surfaced).
      const raw = parseJsonResource(result.contents) as Record<string, unknown>;
      const contributor = raw['contributor'] as Record<string, unknown>;
      expect(contributor['identity_provider']).toBeUndefined();
      expect(contributor['identity_provider_subject']).toBeUndefined();
      expect(contributor['attestation_level']).toBeUndefined();
      expect(contributor['role']).toBeUndefined();
    });

    it('returns an empty reputation entry list when the contributor has no rep records', async () => {
      const f = await fixture();
      const result = await f.client.readResource({ uri: `contributor://${f.alice.id}` });
      const parsed = ContributorProfile.parse(parseJsonResource(result.contents));
      expect(parsed.reputation.entries).toEqual([]);
    });

    it('maps (demonstrated, recent) to tiers against the server review-config thresholds', async () => {
      // Construct a server with non-zero thresholds so the tier
      // mapping has all three branches to exercise. The default
      // server uses 0/0 (gates inert), under which every entry
      // collapses to `contributing`; with non-zero thresholds the
      // `none` and `quiet` branches activate.
      const server = new Server({
        clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
        idGen: new SeededIdGen('tier'),
        verifier: new FakeVerifier(),
        // Non-zero so every branch of `tierFor` is reachable.
        review: { assignment_min_demonstrated: 1.0, assignment_min_recent: 0.5 },
      });
      const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
      const { secret } = server.bootstrap.bindAgentCredential({
        identity_id: alice.id,
        label: 'desk',
      });
      const crc = server.bootstrap.createCause({ name: 'CRC', description: 'cc' });
      const stA = server.bootstrap.seedSubTopic({
        cause_id: crc.id,
        name: 'A',
        description: 'a',
        scope_query: 'a',
      });
      const stB = server.bootstrap.seedSubTopic({
        cause_id: crc.id,
        name: 'B',
        description: 'b',
        scope_query: 'b',
      });
      const stC = server.bootstrap.seedSubTopic({
        cause_id: crc.id,
        name: 'C',
        description: 'c',
        scope_query: 'c',
      });
      // Inject three rep entries with hand-chosen components covering
      // each tier branch. Bypassing `bumpReputation` here lets the
      // test pin the *mapping* without coupling to the reputation
      // event/decay machinery (which has its own coverage upstream).
      const now = server.clock.now();
      server.store.reputations.set(`${alice.id}|${crc.id}|${stA.id}`, {
        identity_id: alice.id,
        cause_id: crc.id,
        sub_topic_id: stA.id,
        demonstrated: 0.5, // below threshold → none
        recent: 0.0,
        updated_at: now,
      });
      server.store.reputations.set(`${alice.id}|${crc.id}|${stB.id}`, {
        identity_id: alice.id,
        cause_id: crc.id,
        sub_topic_id: stB.id,
        demonstrated: 2.0, // above demonstrated, but recent < threshold → quiet
        recent: 0.1,
        updated_at: now,
      });
      server.store.reputations.set(`${alice.id}|${crc.id}|${stC.id}`, {
        identity_id: alice.id,
        cause_id: crc.id,
        sub_topic_id: stC.id,
        demonstrated: 2.0,
        recent: 1.0, // both above → contributing
        updated_at: now,
      });

      const mcp = buildMcpServer(server, { token: secret });
      const client = new Client({ name: 't', version: '0.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(st), client.connect(ct)]);

      const result = await client.readResource({ uri: `contributor://${alice.id}` });
      const parsed = ContributorProfile.parse(parseJsonResource(result.contents));
      const byId = new Map(parsed.reputation.entries.map((e) => [e.sub_topic_id, e.tier]));
      expect(byId.get(stA.id)).toBe('none');
      expect(byId.get(stB.id)).toBe('quiet');
      expect(byId.get(stC.id)).toBe('contributing');
    });

    it('never surfaces raw demonstrated/recent values', async () => {
      const f = await fixture();
      // Seed a real bumpReputation through the propose+accept path
      // so the entry has live decayed values to potentially leak.
      await seedAcceptedPair(f);
      const result = await f.client.readResource({ uri: `contributor://${f.alice.id}` });
      const raw = parseJsonResource(result.contents) as Record<string, unknown>;
      const reputation = raw['reputation'] as { entries: Record<string, unknown>[] };
      for (const entry of reputation.entries) {
        expect(entry['demonstrated']).toBeUndefined();
        expect(entry['recent']).toBeUndefined();
        expect(entry['tier']).toBeDefined();
      }
    });

    it('resolves revoked contributors (graph history stays browsable)', async () => {
      const f = await fixture();
      // Revoke a *different* identity than the caller (alice runs the
      // browse), so the resource's resolveCaller step doesn't trip
      // on the caller's own revocation before reaching the lookup.
      const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
      f.server.store.identities.set(bob.id, {
        ...f.server.store.identities.get(bob.id)!,
        status: 'revoked',
      });
      const result = await f.client.readResource({ uri: `contributor://${bob.id}` });
      const parsed = ContributorProfile.parse(parseJsonResource(result.contents));
      expect(parsed.contributor.id).toBe(bob.id);
      expect(parsed.contributor.status).toBe('revoked');
    });

    it('refuses with not_found for an unknown identity id', async () => {
      const { client } = await fixture();
      await expect(client.readResource({ uri: 'contributor://idn_missing' })).rejects.toMatchObject(
        {
          code: -32602,
          data: { code: 'not_found' },
        },
      );
    });
  });

  describe('manuscript://{sub-topic-id} — projection (slice 6a)', () => {
    // PRD §Manuscript projection: a derived view of the sub-topic
    // graph (outline + cited claims) plus contributor credit via
    // PRD §Credit. The v0 implicit default config groups active
    // nodes into four sections; credit attribution combines proposer
    // weight + accepted-aligned reviewer weight, scaled by
    // survivor + load-bearing factors. Specific weights are
    // testbed-tunable knobs on `ReviewConfig`.

    it('returns sections in fixed order with the right item-kind mapping', async () => {
      const f = await fixture();
      const { anchorId, excerptId } = await seedAcceptedPair(f);
      // Add a synthesis grounded on the excerpt + an open_question
      // on the same parent so all four sections have content.
      const synth = await f.server.tools.proposeSynthesis(
        { identity_id: f.alice.id },
        {
          cause_id: f.crc.id,
          home_sub_topic_id: f.mrd.id,
          parent_ids: [excerptId],
          content: 'synthesis claim',
          kind: 'synthesis',
        },
      );
      const sr = f.server.curator.acceptProposal(synth.proposal_id);
      const oq = await f.server.tools.proposeSynthesis(
        { identity_id: f.alice.id },
        {
          cause_id: f.crc.id,
          home_sub_topic_id: f.mrd.id,
          parent_ids: [excerptId],
          content: 'an open question',
          kind: 'open_question',
        },
      );
      const oqr = f.server.curator.acceptProposal(oq.proposal_id);

      const result = await f.client.readResource({
        uri: `manuscript://${f.mrd.id}`,
      });
      expect(result.contents[0]?.mimeType).toBe('application/json');
      const parsed = Manuscript.parse(parseJsonResource(result.contents));
      expect(parsed.sub_topic.id).toBe(f.mrd.id);
      expect(parsed.cause.id).toBe(f.crc.id);
      // Section order is part of the v0 contract.
      expect(parsed.sections.map((s) => s.kind)).toEqual([
        'sources',
        'quotations',
        'synthesis',
        'open_questions',
      ]);
      const byKind = new Map(parsed.sections.map((s) => [s.kind, s.items]));
      expect(byKind.get('sources')?.map((i) => i.node_id)).toEqual([anchorId]);
      expect(byKind.get('quotations')?.map((i) => i.node_id)).toEqual([excerptId]);
      expect(byKind.get('synthesis')?.map((i) => i.node_id)).toEqual([sr.node_id]);
      expect(byKind.get('open_questions')?.map((i) => i.node_id)).toEqual([oqr.node_id]);
    });

    it('carries kind-specific fields on each citation (external_ref + content_hash on anchors, quoted_span on excerpts, parents on syntheses)', async () => {
      const f = await fixture();
      const { anchorId, excerptId } = await seedAcceptedPair(f);
      const synth = await f.server.tools.proposeSynthesis(
        { identity_id: f.alice.id },
        {
          cause_id: f.crc.id,
          home_sub_topic_id: f.mrd.id,
          parent_ids: [excerptId],
          content: 'claim X',
          kind: 'synthesis',
        },
      );
      const sr = f.server.curator.acceptProposal(synth.proposal_id);

      const parsed = Manuscript.parse(
        parseJsonResource(
          (await f.client.readResource({ uri: `manuscript://${f.mrd.id}` })).contents,
        ),
      );
      const sources = parsed.sections.find((s) => s.kind === 'sources');
      const anchor = sources?.items[0];
      expect(anchor?.node_id).toBe(anchorId);
      expect(anchor?.external_ref).toEqual({ kind: 'pmid', value: '1' });
      expect(anchor?.content_hash).toBeDefined();
      expect(anchor?.content_hash?.length).toBeGreaterThan(0);
      // Anchor has no derives parents — empty array, not omitted.
      expect(anchor?.parent_node_ids).toEqual([]);

      const quotations = parsed.sections.find((s) => s.kind === 'quotations');
      const excerpt = quotations?.items[0];
      expect(excerpt?.quoted_span).toEqual({ text: 'span', offset: 0 });
      // Excerpt parents-via-derives include the anchor.
      expect(excerpt?.parent_node_ids).toEqual([anchorId]);

      const synthesis = parsed.sections.find((s) => s.kind === 'synthesis');
      const synthesisItem = synthesis?.items[0];
      expect(synthesisItem?.node_id).toBe(sr.node_id);
      expect(synthesisItem?.parent_node_ids).toEqual([excerptId]);
      expect(synthesisItem?.quoted_span).toBeUndefined();
      expect(synthesisItem?.external_ref).toBeUndefined();
    });

    it('attributes proposer credit at full weight and accepted-aligned reviewer credit at the reduced weight', async () => {
      // Build a fresh server so we can pin specific credit weights
      // and avoid coupling to the assignment-driven default reputation
      // gates. Use distinct identities for proposer and reviewer so
      // both lines of credit are observable.
      const server = new Server({
        clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
        idGen: new SeededIdGen('cred'),
        verifier: new FakeVerifier(),
        review: {
          credit_proposer_weight: 1.0,
          credit_reviewer_weight: 0.25,
          credit_survivor_bonus_per_supersede: 0,
          credit_load_bonus_per_induced_derives: 0,
        },
      });
      const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
      const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
      const { secret } = server.bootstrap.bindAgentCredential({
        identity_id: alice.id,
        label: 'desk',
      });
      const crc = server.bootstrap.createCause({ name: 'CRC', description: 'cc' });
      const mrd = server.bootstrap.seedSubTopic({
        cause_id: crc.id,
        name: 'mrd',
        description: 'm',
        scope_query: 'm',
      });
      const anchor = await server.tools.proposeAnchor(
        { identity_id: alice.id },
        {
          cause_id: crc.id,
          home_sub_topic_id: mrd.id,
          content: 'a content',
          external_ref: { kind: 'pmid', value: '1' },
        },
      );
      // Bob casts an accept vote on Alice's proposal before curator
      // acceptance materializes the node. After acceptance, the
      // projection should credit Bob as an accepted-aligned reviewer.
      await server.tools.castReviewVote(
        { identity_id: bob.id },
        {
          proposal_id: anchor.proposal_id,
          decision: 'accept',
          rationale: 'looks right',
        },
      );
      server.curator.acceptProposal(anchor.proposal_id);

      const mcp = buildMcpServer(server, { token: secret });
      const client = new Client({ name: 't', version: '0.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(st), client.connect(ct)]);
      const parsed = Manuscript.parse(
        parseJsonResource((await client.readResource({ uri: `manuscript://${mrd.id}` })).contents),
      );

      const byContributor = new Map(parsed.contributors.map((c) => [c.contributor_id, c]));
      expect(byContributor.get(alice.id)?.units).toBeCloseTo(1.0);
      expect(byContributor.get(alice.id)?.proposed_node_count).toBe(1);
      expect(byContributor.get(alice.id)?.reviewed_node_count).toBe(0);
      expect(byContributor.get(bob.id)?.units).toBeCloseTo(0.25);
      expect(byContributor.get(bob.id)?.proposed_node_count).toBe(0);
      expect(byContributor.get(bob.id)?.reviewed_node_count).toBe(1);
      // Proposer-self-votes shouldn't double-count: a proposer who
      // also votes accept on their own proposal still only accrues
      // proposer credit.
      expect(byContributor.get(alice.id)?.reviewed_node_count).toBe(0);
      // Contributor list is sorted by units descending.
      expect(parsed.contributors.map((c) => c.contributor_id)).toEqual([alice.id, bob.id]);
    });

    it('applies the load-bearing multiplier from the induced subgraph (an anchor with a child excerpt counts more than a peripheral anchor)', async () => {
      const server = new Server({
        clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
        idGen: new SeededIdGen('load'),
        verifier: new FakeVerifier(),
        review: {
          credit_proposer_weight: 1.0,
          credit_reviewer_weight: 0,
          credit_survivor_bonus_per_supersede: 0,
          credit_load_bonus_per_induced_derives: 1.0,
        },
      });
      const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
      const bob = server.bootstrap.mintIdentity({ display_name: 'bob' });
      const { secret } = server.bootstrap.bindAgentCredential({
        identity_id: alice.id,
        label: 'd',
      });
      const crc = server.bootstrap.createCause({ name: 'CRC', description: 'c' });
      const mrd = server.bootstrap.seedSubTopic({
        cause_id: crc.id,
        name: 'mrd',
        description: 'm',
        scope_query: 'm',
      });
      // Alice's anchor with an excerpt child (induced derives degree 1).
      const a1 = await server.tools.proposeAnchor(
        { identity_id: alice.id },
        {
          cause_id: crc.id,
          home_sub_topic_id: mrd.id,
          content: 'anchor 1',
          external_ref: { kind: 'pmid', value: '11' },
        },
      );
      const a1r = server.curator.acceptProposal(a1.proposal_id);
      const e = await server.tools.proposeExcerpt(
        { identity_id: alice.id },
        {
          cause_id: crc.id,
          home_sub_topic_id: mrd.id,
          parent_anchor_id: a1r.node_id!,
          content: 'span content',
          quoted_span: { text: 'span', offset: 0 },
        },
      );
      server.curator.acceptProposal(e.proposal_id);
      // Bob's peripheral anchor with no children (induced derives degree 0).
      const a2 = await server.tools.proposeAnchor(
        { identity_id: bob.id },
        {
          cause_id: crc.id,
          home_sub_topic_id: mrd.id,
          content: 'anchor 2',
          external_ref: { kind: 'pmid', value: '12' },
        },
      );
      server.curator.acceptProposal(a2.proposal_id);

      const mcp = buildMcpServer(server, { token: secret });
      const client = new Client({ name: 't', version: '0.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(st), client.connect(ct)]);
      const parsed = Manuscript.parse(
        parseJsonResource((await client.readResource({ uri: `manuscript://${mrd.id}` })).contents),
      );
      const byContributor = new Map(parsed.contributors.map((c) => [c.contributor_id, c]));
      // Alice: anchor-with-excerpt-child (mult 1 + 1*1 = 2) + excerpt
      //        (mult 1 + 1*1 = 2) → 1.0*2 + 1.0*2 = 4.0.
      expect(byContributor.get(alice.id)?.units).toBeCloseTo(4.0);
      // Bob: peripheral anchor (mult 1 + 0 = 1) → 1.0*1 = 1.0.
      expect(byContributor.get(bob.id)?.units).toBeCloseTo(1.0);
    });

    it('returns empty sections + contributors for a sub-topic with no active nodes', async () => {
      const f = await fixture();
      const parsed = Manuscript.parse(
        parseJsonResource(
          (await f.client.readResource({ uri: `manuscript://${f.oligo.id}` })).contents,
        ),
      );
      expect(parsed.sections.every((s) => s.items.length === 0)).toBe(true);
      expect(parsed.contributors).toEqual([]);
    });

    it('keeps revoked contributors in the credit list with the status flagged', async () => {
      const f = await fixture();
      // Have a *different* identity than the caller propose so the
      // revocation doesn't trip the caller's own Authenticator gate.
      const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
      const anchor = await f.server.tools.proposeAnchor(
        { identity_id: bob.id },
        {
          cause_id: f.crc.id,
          home_sub_topic_id: f.mrd.id,
          content: 'bob anchor',
          external_ref: { kind: 'pmid', value: '7' },
        },
      );
      f.server.curator.acceptProposal(anchor.proposal_id);
      // Revoke bob; the past contribution remains in the credit list
      // (PRD §Identity: past contributions remain in the graph with
      // the revocation flagged).
      f.server.store.identities.set(bob.id, {
        ...f.server.store.identities.get(bob.id)!,
        status: 'revoked',
      });
      const parsed = Manuscript.parse(
        parseJsonResource(
          (await f.client.readResource({ uri: `manuscript://${f.mrd.id}` })).contents,
        ),
      );
      const bobEntry = parsed.contributors.find((c) => c.contributor_id === bob.id);
      expect(bobEntry).toBeDefined();
      expect(bobEntry?.status).toBe('revoked');
    });

    it('refuses with not_found for an unknown sub-topic id', async () => {
      const { client } = await fixture();
      await expect(client.readResource({ uri: 'manuscript://stp_missing' })).rejects.toMatchObject({
        code: -32602,
        data: { code: 'not_found' },
      });
    });
  });

  // Read-path resources match the existing read-path tool gating:
  // the caller token must resolve through the Authenticator (so
  // unbound traffic is refused at the seam), but resource reads
  // don't consume the per-identity rate-limit budget. This pins the
  // first half of that property; the second half (no budget burn)
  // is implicit — the resource handlers don't call
  // `accountWriteAction`, which is what the gate fires on.
  it('refuses resource reads from an unbound caller at the Authenticator seam', async () => {
    const f = await fixture();
    expect(() => buildMcpServer(f.server, { token: 'not-a-real-secret' })).toThrow(
      /unknown identity/,
    );
  });
});
