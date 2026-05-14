import { z } from 'zod';
import { Cause, SubTopic } from './cause.js';
import { Edge } from './edges.js';
import { Node } from './nodes.js';

// MCP-resource read-path shapes (PRD §Read-path tools and resources).
// Resources are the *passive* browsing surface: addressable by URI,
// returning the structured payload a web UI or MCP-capable client
// renders directly. Schemas live in `contracts` so the server and
// every client (web read-UI, testbed harness, future federated peer)
// agree on the wire shape by construction — no per-client drift.
//
// Identity gating matches the existing read-path tools: the caller's
// token must resolve through the Authenticator (so unbound traffic is
// refused at the seam), but read-path reads do not consume the
// per-identity rate-limit budget. The web UI's anonymous-browse story
// (if any) is a slice-5b decision about session minting, not a
// resource-shape decision: from the server's perspective, every
// reader is a resolved caller. Sim≡prod is preserved by construction
// — the testbed and the production runtime serve the same resources
// over the same MCP transport.

// ── cause:// — list of active causes with their active sub-topics
// ─────────────────────────────────────────────────────────────────
// The home-page payload: enough to render the cause list and click
// into a cause without a second resource read. Causes in `archived`
// status are excluded by construction (the home view is a recruitment
// surface); a cause-history view would re-read with a different
// resource if/when it lands. Sub-topics under each cause are limited
// to `active`; `proposed` sub-topics live in the proposal queue
// (visible via `query_proposals`), and `archived` sub-topics are
// not contribution targets.
export const CauseWithSubTopics = z
  .object({
    cause: Cause,
    sub_topics: z.array(SubTopic),
  })
  .strict();
export type CauseWithSubTopics = z.infer<typeof CauseWithSubTopics>;

export const CauseDirectory = z
  .object({
    causes: z.array(CauseWithSubTopics),
  })
  .strict();
export type CauseDirectory = z.infer<typeof CauseDirectory>;

// ── sub-topic://{id} — sub-topic detail + activity counters
// ─────────────────────────────────────────────────────────────────
// "Sub-topic metadata, status, scope query, recent activity" per the
// PRD. The metadata + status + scope_query are the SubTopic record
// itself; the cause is hydrated so a sub-topic page can show its
// umbrella cause without a second read; the activity counters are
// the recent-activity projection — counts of active nodes
// (the convex-hull substrate), staged proposals (work under review),
// and frontier items (work to be done).
export const SubTopicActivityCounters = z
  .object({
    active_nodes: z.number().int().nonnegative(),
    staged_proposals: z.number().int().nonnegative(),
    frontier_items: z.number().int().nonnegative(),
  })
  .strict();
export type SubTopicActivityCounters = z.infer<typeof SubTopicActivityCounters>;

export const SubTopicDetail = z
  .object({
    sub_topic: SubTopic,
    cause: Cause,
    activity: SubTopicActivityCounters,
  })
  .strict();
export type SubTopicDetail = z.infer<typeof SubTopicDetail>;

// ── node://{id} — node + immediate neighbors
// ─────────────────────────────────────────────────────────────────
// The node itself plus its active edge neighborhood: every active
// edge where this node is either endpoint, and the other endpoint
// of each such edge hydrated. Stable iteration order (created_at,
// then id) keeps cassette-replay equality intact for testbed runs
// that observe the same graph through this resource.
export const NodeNeighborhood = z
  .object({
    node: Node,
    edges: z.array(Edge),
    neighbors: z.array(Node),
  })
  .strict();
export type NodeNeighborhood = z.infer<typeof NodeNeighborhood>;

// ── subgraph://{sub-topic-id} — active nodes + edges scoped to a sub-topic
// ─────────────────────────────────────────────────────────────────
// "Full or filtered subgraph in a structured form" per the PRD. v0
// returns the *active* slice: nodes whose `home_sub_topic_id` is
// the given sub-topic OR whose `scope_memberships` includes it
// (the scope-membership projection is what makes a node visible
// outside its home), restricted to `status === 'active'`. Edges
// are included when both endpoints are in the returned node set
// AND the edge itself is `active`. Staged work and rejected work
// remain visible through `query_proposals`; the resource is the
// convex-hull view.
export const Subgraph = z
  .object({
    sub_topic: SubTopic,
    nodes: z.array(Node),
    edges: z.array(Edge),
  })
  .strict();
export type Subgraph = z.infer<typeof Subgraph>;

// ── Resource-name registry ───────────────────────────────────────
// The full set of resource scheme names exposed by the MCP server.
// Parallel to `ToolName`: the harness and any introspecting client
// can enumerate the read-path surface without crawling the SDK's
// registration table. Schemes match the URI prefix (`cause://`,
// `sub-topic://{id}`, `node://{id}`, `subgraph://{sub-topic-id}`).
export const ResourceName = z.enum(['cause', 'sub-topic', 'node', 'subgraph']);
export type ResourceName = z.infer<typeof ResourceName>;
