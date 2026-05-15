import { z } from 'zod';
import { Cause, SubTopic } from './cause.js';
import { Edge } from './edges.js';
import { PrincipalStatus } from './identity.js';
import { CauseId, IdentityId, NodeId, SubTopicId } from './ids.js';
import { ExternalRef, Node, NodeKind, QuotedSpan } from './nodes.js';
import { Timestamp } from './timestamps.js';

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

// ── contributor://{id} — public contributor profile + tier projection
// ─────────────────────────────────────────────────────────────────
// The anonymous-browse-safe projection of a contributor: a
// deliberately narrow `PublicContributor` (id, display_name,
// created_at, status — *not* `identity_provider`,
// `identity_provider_subject`, `attestation_level`, or `role`, all of
// which leak operationally-private signal or PII) and a per-(cause,
// sub-topic) tier label.
//
// PRD §Reputation: "Eligibility tiers public; numeric reputation
// private." Slice 5c commits the v0 tier mapping — *three* tiers
// derived from the contributor's (`demonstrated`, `recent`) reputation
// values *for the specific (cause, sub-topic)* against the server's
// review-config thresholds (`assignment_min_demonstrated`,
// `assignment_min_recent`):
//
//   - `none`           — no entry for this (cause, sub-topic), OR
//                        `demonstrated < assignment_min_demonstrated`.
//                        Public-facing: "not yet in the reviewer
//                        pool here." Matches the demonstrated gate's
//                        opposite null-policy (PRD §Reputation,
//                        Two-component reputation): unproven
//                        identities are *by construction* not in
//                        the pool.
//   - `quiet`          — `demonstrated >= threshold` but
//                        `recent < assignment_min_recent`. The
//                        proven-but-currently-dormant tier — the
//                        episodic-expert case PRD §Reputation
//                        commits ("the part-time clinician is
//                        exactly the contributor we want") in a
//                        between-windows state. Visible to readers
//                        as past contribution that hasn't lapsed
//                        out of the demonstrated ledger.
//   - `contributing`   — both gates pass. The active-pool tier:
//                        the contributor would not be filtered at
//                        `request_assignment` on the reputation
//                        gates for this (cause, sub-topic).
//
// When both gates are inert at the server (`assignment_min_*` set
// to 0 — the default), every entry with non-negative components
// renders as `contributing` and the projection collapses to "has
// any rep here, yes or no." The tier richness scales with the
// operator's chosen thresholds, by construction — no separate
// tier-threshold knob layered on top.
//
// The numeric components are *not* in the wire shape. The
// contributor's own `query_reputation` tool returns numbers (the
// contributor needs them to reason about where they sit relative
// to gates); the public projection here is the read-other-
// contributor surface and is intentionally tier-only.
export const PublicReputationTier = z.enum(['none', 'quiet', 'contributing']);
export type PublicReputationTier = z.infer<typeof PublicReputationTier>;

export const PublicReputationEntry = z
  .object({
    cause_id: CauseId,
    sub_topic_id: SubTopicId,
    tier: PublicReputationTier,
  })
  .strict();
export type PublicReputationEntry = z.infer<typeof PublicReputationEntry>;

export const PublicReputation = z
  .object({
    entries: z.array(PublicReputationEntry),
  })
  .strict();
export type PublicReputation = z.infer<typeof PublicReputation>;

export const PublicContributor = z
  .object({
    id: IdentityId,
    display_name: z.string().min(1).max(100),
    created_at: Timestamp,
    status: PrincipalStatus,
  })
  .strict();
export type PublicContributor = z.infer<typeof PublicContributor>;

export const ContributorProfile = z
  .object({
    contributor: PublicContributor,
    reputation: PublicReputation,
  })
  .strict();
export type ContributorProfile = z.infer<typeof ContributorProfile>;

// ── manuscript://{sub-topic-id} — outline + cited claims + credited contributors
// ─────────────────────────────────────────────────────────────────
// PRD §Manuscript projection: "a derived view of a sub-topic's graph
// plus editorial choices (section order, narrative voice, scope of
// inclusion). Projections are not a separate truth ledger — they are
// a function of (graph state, projection config)." Slice 6a commits
// the v0 *implicit default* projection config — no separate
// `ProjectionConfig` graph record yet (versioned configs as
// governance artifacts is a later slice; PRD §Manuscript projection
// commits the shape without yet committing the persisted record).
// The v0 default:
//
//   - Scope of inclusion: every active node whose home is the
//     sub-topic OR whose scope_memberships include it — the same
//     node set `subgraph://` returns. The convex-hull substrate is
//     what gets projected; staged/rejected work stays in the
//     proposal queue.
//   - Section order: a fixed sequence — `sources` (anchors,
//     ordered by created_at), `quotations` (excerpts, by created_at
//     then id), `synthesis` (synthesis nodes, by induced-subgraph
//     parent count descending then created_at), `open_questions`
//     (by created_at). The order is content-shape-driven:
//     a manuscript reads source → quotation → synthesis → question,
//     and the v0 walk is faithful to the graph rather than
//     re-narrating it.
//   - Narrative voice: none — v0 surfaces each included node's own
//     `content` verbatim. Narrative composition is a Phase 3
//     surface; v0 is a faithful projection.
//
// Credit attribution (PRD §Credit) shape: for each included node,
// the proposer accrues the proposer weight; reviewers whose
// `cast_review_vote` aligned with the converged outcome (accept,
// since rejected nodes are excluded by scope) accrue the reviewer
// weight (smaller than the proposer weight, per PRD §Credit:
// "weighted lower than proposers"). Each contribution is scaled by
// a survivor factor (nodes that survived supersedes events count
// more) and a load-bearing factor (nodes participating in more
// derives edges in the induced subgraph count more). Specific
// numeric weights are testbed-tunable knobs on `ReviewConfig`
// (PRD §Credit: "Specific weights are deferred to the testbed").
// Revoked-status contributors remain in the credit list with the
// status flagged — PRD §Identity commits "past contributions
// remain in the graph with the revocation flagged."

export const ManuscriptSectionKind = z.enum([
  'sources',
  'quotations',
  'synthesis',
  'open_questions',
]);
export type ManuscriptSectionKind = z.infer<typeof ManuscriptSectionKind>;

// Per-node projection entry. The shape carries the kind-specific
// fields the manuscript renderer needs without forcing it to
// re-fetch each node — `external_ref` for anchors so a citation
// line resolves without a second read, `quoted_span` for excerpts
// so the quotation renders with its offset, `parent_node_ids`
// (restricted to the *included* set) for syntheses and open
// questions so the chain-of-claim is visible inside the projection.
export const ManuscriptCitation = z
  .object({
    node_id: NodeId,
    kind: NodeKind,
    content: z.string(),
    // anchors only
    external_ref: ExternalRef.optional(),
    // anchors only — sha256 of fetched source content
    content_hash: z.string().optional(),
    // excerpts only
    quoted_span: QuotedSpan.optional(),
    // syntheses + open_questions only — derives parents, restricted
    // to the included node set so a click-through resolves inside
    // the manuscript view; out-of-scope parents are dropped.
    parent_node_ids: z.array(NodeId),
    // proposer's identity id; the public profile resolves through
    // `contributor://{id}`.
    proposer_id: IdentityId,
  })
  .strict();
export type ManuscriptCitation = z.infer<typeof ManuscriptCitation>;

export const ManuscriptSection = z
  .object({
    kind: ManuscriptSectionKind,
    title: z.string(),
    items: z.array(ManuscriptCitation),
  })
  .strict();
export type ManuscriptSection = z.infer<typeof ManuscriptSection>;

// One credited contributor on the manuscript. `display_name` and
// `status` come from the same `PublicContributor` projection the
// contributor profile uses — the credit list is the public-safe
// view of authorship. `units` is the projected credit value
// computed by the v0 credit function; `proposed_node_count` and
// `reviewed_node_count` break the figure down so a reader can see
// where the credit came from without the projection having to
// expose individual weights.
export const CreditAttribution = z
  .object({
    contributor_id: IdentityId,
    display_name: z.string(),
    status: PrincipalStatus,
    units: z.number().nonnegative(),
    proposed_node_count: z.number().int().nonnegative(),
    reviewed_node_count: z.number().int().nonnegative(),
  })
  .strict();
export type CreditAttribution = z.infer<typeof CreditAttribution>;

export const Manuscript = z
  .object({
    sub_topic: SubTopic,
    cause: Cause,
    sections: z.array(ManuscriptSection),
    contributors: z.array(CreditAttribution),
  })
  .strict();
export type Manuscript = z.infer<typeof Manuscript>;

// ── Resource-name registry ───────────────────────────────────────
// The full set of resource scheme names exposed by the MCP server.
// Parallel to `ToolName`: the harness and any introspecting client
// can enumerate the read-path surface without crawling the SDK's
// registration table. Schemes match the URI prefix (`cause://`,
// `sub-topic://{id}`, `node://{id}`, `subgraph://{sub-topic-id}`,
// `contributor://{id}`, `manuscript://{sub-topic-id}`).
export const ResourceName = z.enum([
  'cause',
  'sub-topic',
  'node',
  'subgraph',
  'contributor',
  'manuscript',
]);
export type ResourceName = z.infer<typeof ResourceName>;
