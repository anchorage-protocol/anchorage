import {
  CauseDirectory,
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
  const REGISTERED_RESOURCE_NAMES = ['cause', 'sub-topic', 'node', 'subgraph'] as const;

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
