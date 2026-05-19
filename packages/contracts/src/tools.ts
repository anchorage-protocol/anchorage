import { z } from 'zod';
import { AssignmentTask, WorkKind } from './assignments.js';
import { FrontierItem, FrontierKind } from './frontier.js';
import { PrincipalStatus } from './identity.js';
import {
  AssignmentId,
  CauseId,
  IdentityId,
  NodeId,
  ProposalId,
  ReviewVoteId,
  SubTopicId,
} from './ids.js';
import { ExternalRef, QuotedSpan } from './nodes.js';
import { Proposal, ProposalPayload, ProposalStatus } from './proposals.js';
import { CauseDirectory } from './resources.js';
import { ReviewDecision } from './reviews.js';

// Tool I/O contracts: the input/output shapes for the MCP tools defined
// in PRD §MCP tool surface. These sit one layer outboard of the data
// contracts (Proposal, Assignment, Membership, …) so the transport
// shape is independent of the persisted shape.

const ok = z.object({ ok: z.literal(true) }).strict();
const proposalIdResult = z.object({ proposal_id: ProposalId }).strict();

// ──── Assignment ────
//
// There is no capacity declaration, no decline, and no accept step
// (PRD §Assignment). A contributor holds a single FIFO slot per
// (identity, cause): `request_assignment` returns it already held
// (`accepted`) — single-slot has no decision at offer time, so there
// is nothing to accept or decline — then fulfill it via the matching
// `propose_*` / `cast_review_vote`. The slot also resolves without
// contributor action when its precondition lapses, and is
// shadow-reassigned (never expired) past its TTL.

export const RequestAssignmentInput = z
  .object({
    cause_id: CauseId,
    // Strict per-kind filter, not a soft preference and not an
    // expertise signal (PRD §Assignment, `request_assignment`).
    kind: WorkKind.optional(),
  })
  .strict();
export type RequestAssignmentInput = z.infer<typeof RequestAssignmentInput>;
export const RequestAssignmentOutput = z
  .object({ assignment_id: AssignmentId, task: AssignmentTask })
  .strict();
export type RequestAssignmentOutput = z.infer<typeof RequestAssignmentOutput>;

// ──── Proposals (assignment-fulfilling or contributor-initiated) ────
//
// Each `propose_*` tool below takes an optional `assignment_id`. When
// present, the call fulfills an accepted propose-kind assignment (the
// task kind must match the proposal kind and the task's pinned context
// — sub-topic, parent anchor, parent set — must match what the proposal
// claims) and accrues full assigned-work reputation; the assignment
// transitions to `submitted` with this proposal as `fulfilled_by`.
// Without it, the proposal is contributor-initiated and weighted lower
// for reputation (see PRD §Reputation). This mirrors `cast_review_vote`,
// which carries the same optional `assignment_id` for review work — so
// there is one tool per node kind whether or not an assignment is being
// fulfilled, rather than a separate assignment-only entry point.

export const ProposeAnchorInput = z
  .object({
    cause_id: CauseId,
    home_sub_topic_id: SubTopicId,
    memberships: z.array(SubTopicId).optional(),
    content: z.string().min(1),
    external_ref: ExternalRef,
    assignment_id: AssignmentId.optional(),
  })
  .strict();
export type ProposeAnchorInput = z.infer<typeof ProposeAnchorInput>;
export const ProposeAnchorOutput = proposalIdResult;
export type ProposeAnchorOutput = z.infer<typeof ProposeAnchorOutput>;

export const ProposeExcerptInput = z
  .object({
    cause_id: CauseId,
    home_sub_topic_id: SubTopicId,
    memberships: z.array(SubTopicId).optional(),
    parent_anchor_id: NodeId,
    content: z.string().min(1),
    quoted_span: QuotedSpan,
    assignment_id: AssignmentId.optional(),
  })
  .strict();
export type ProposeExcerptInput = z.infer<typeof ProposeExcerptInput>;
export const ProposeExcerptOutput = proposalIdResult;
export type ProposeExcerptOutput = z.infer<typeof ProposeExcerptOutput>;

// PRD's `propose_synthesis` is one tool covering both synthesis and
// open_question via a `kind` field. The internal ProposalPayload splits
// these; the server bridges between them.
export const ProposeSynthesisInput = z
  .object({
    cause_id: CauseId,
    home_sub_topic_id: SubTopicId,
    memberships: z.array(SubTopicId).optional(),
    parent_ids: z.array(NodeId).min(1),
    content: z.string().min(1),
    kind: z.enum(['synthesis', 'open_question']),
    assignment_id: AssignmentId.optional(),
  })
  .strict();
export type ProposeSynthesisInput = z.infer<typeof ProposeSynthesisInput>;
export const ProposeSynthesisOutput = proposalIdResult;
export type ProposeSynthesisOutput = z.infer<typeof ProposeSynthesisOutput>;

export const ProposeSupersedesInput = z
  .object({
    from_node_id: NodeId,
    to_node_id: NodeId,
    rationale: z.string().min(1),
    assignment_id: AssignmentId.optional(),
  })
  .strict();
export type ProposeSupersedesInput = z.infer<typeof ProposeSupersedesInput>;
export const ProposeSupersedesOutput = proposalIdResult;
export type ProposeSupersedesOutput = z.infer<typeof ProposeSupersedesOutput>;

export const ProposeMembershipInput = z
  .object({ node_id: NodeId, sub_topic_id: SubTopicId, assignment_id: AssignmentId.optional() })
  .strict();
export type ProposeMembershipInput = z.infer<typeof ProposeMembershipInput>;
export const ProposeMembershipOutput = proposalIdResult;
export type ProposeMembershipOutput = z.infer<typeof ProposeMembershipOutput>;

export const ProposeChangeOfHomeInput = z
  .object({
    node_id: NodeId,
    new_home_sub_topic_id: SubTopicId,
    rationale: z.string().min(1),
  })
  .strict();
export type ProposeChangeOfHomeInput = z.infer<typeof ProposeChangeOfHomeInput>;
export const ProposeChangeOfHomeOutput = proposalIdResult;
export type ProposeChangeOfHomeOutput = z.infer<typeof ProposeChangeOfHomeOutput>;

export const ProposeSubTopicInput = z
  .object({
    cause_id: CauseId,
    name: z.string().min(1).max(200),
    description: z.string().min(1),
    scope_query: z.string().min(1),
  })
  .strict();
export type ProposeSubTopicInput = z.infer<typeof ProposeSubTopicInput>;
export const ProposeSubTopicOutput = proposalIdResult;
export type ProposeSubTopicOutput = z.infer<typeof ProposeSubTopicOutput>;

// ──── Review ────

export const CastReviewVoteInput = z
  .object({
    proposal_id: ProposalId,
    decision: ReviewDecision,
    rationale: z.string().min(1),
    assignment_id: AssignmentId.optional(),
  })
  .strict();
export type CastReviewVoteInput = z.infer<typeof CastReviewVoteInput>;
export const CastReviewVoteOutput = z.object({ vote_id: ReviewVoteId }).strict();
export type CastReviewVoteOutput = z.infer<typeof CastReviewVoteOutput>;

// ──── Read-path tools ────

// `query_causes` is the agent's bootstrap entry point: the tool-surface
// twin of the `cause://` resource, returning the identical
// `CauseDirectory` shape. It exists because the tool surface must be
// self-sufficient for the *first* contribution. `request_assignment`
// requires a `cause_id`, but the only other way to obtain one is the
// passive `cause://` resource — and an MCP client is
// not guaranteed to surface resources to the model driving it (many
// expose only tools, or gate resources behind explicit user attach).
// Without a tool, a freshly-connected agent that just authenticated has
// no in-band path from "I want to contribute" to a `cause_id`, which is
// exactly the moment we must not lose a new contributor. Resources stay
// the canonical passive browsing mirror (PRD §Read-path tools and
// resources); this is the active enumeration the bootstrap needs. No
// args: an instance's cause set is small and the directory is the whole
// answer (filtering is `query_frontier`'s job, one step later).
export const QueryCausesInput = z.object({}).strict();
export type QueryCausesInput = z.infer<typeof QueryCausesInput>;
export const QueryCausesOutput = CauseDirectory;
export type QueryCausesOutput = z.infer<typeof QueryCausesOutput>;

export const QueryFrontierInput = z
  .object({
    cause_id: CauseId.optional(),
    sub_topic_id: SubTopicId.optional(),
    frontier_kind: FrontierKind.optional(),
  })
  .strict();
export type QueryFrontierInput = z.infer<typeof QueryFrontierInput>;
export const QueryFrontierOutput = z.object({ items: z.array(FrontierItem) }).strict();
export type QueryFrontierOutput = z.infer<typeof QueryFrontierOutput>;

export const QueryProposalsInput = z
  .object({
    status: ProposalStatus.optional(),
    sub_topic_id: SubTopicId.optional(),
    assigned_to_me: z.boolean().optional(),
  })
  .strict();
export type QueryProposalsInput = z.infer<typeof QueryProposalsInput>;
export const QueryProposalsOutput = z.object({ proposals: z.array(Proposal) }).strict();
export type QueryProposalsOutput = z.infer<typeof QueryProposalsOutput>;

// A review-batch item exposes only the fields a reviewer needs to
// review: the proposal_id (to vote against) and the payload (to read).
// `status`, `created_at`, `proposer_id`, and `assignment_id` are
// deliberately omitted — they are the fields a patient adversary could
// use to tell calibration items from real frontier items (PRD
// §Calibration batches: "statistically indistinguishable from real
// frontier work in the dimensions a reviewer can act on").
export const ReviewBatchItem = z
  .object({ proposal_id: ProposalId, payload: ProposalPayload })
  .strict();
export type ReviewBatchItem = z.infer<typeof ReviewBatchItem>;

export const FetchCalibrationBatchInput = z.object({ sub_topic_id: SubTopicId }).strict();
export type FetchCalibrationBatchInput = z.infer<typeof FetchCalibrationBatchInput>;
export const FetchCalibrationBatchOutput = z.object({ items: z.array(ReviewBatchItem) }).strict();
export type FetchCalibrationBatchOutput = z.infer<typeof FetchCalibrationBatchOutput>;

// Reputation read. Returns the *caller's own* per-sub-topic scores
// in a cause. PRD §Reputation: "Eligibility tiers public; numeric
// reputation private" — the contributor sees their own raw numbers
// (otherwise they can't reason about where they sit relative to
// tier gates), but other contributors see only tiers (which the
// public read-path will surface through a separate resource once
// tiers are defined).
//
// Each entry returns both reputation components per PRD §Reputation:
// `demonstrated` (slow-decay competence, gates pool admission via
// `assignment_min_demonstrated`) and `recent` (fast-decay activity,
// gates assignment via `assignment_min_recent`). Values are decayed
// forward to the server's current time before return — clients see
// the live numbers, not the snapshots at last bump.
export const QueryReputationInput = z.object({ cause_id: CauseId }).strict();
export type QueryReputationInput = z.infer<typeof QueryReputationInput>;
export const ReputationEntry = z
  .object({
    sub_topic_id: SubTopicId,
    demonstrated: z.number(),
    recent: z.number(),
  })
  .strict();
export type ReputationEntry = z.infer<typeof ReputationEntry>;
export const QueryReputationOutput = z.object({ entries: z.array(ReputationEntry) }).strict();
export type QueryReputationOutput = z.infer<typeof QueryReputationOutput>;

// ──── Curator-only tools ────
//
// The curator-only MCP surface: the wire-level path for the in-process
// `server.curator.*` namespace. PRD §The contribution flow (Resolve
// step) and PRD §Reviewer assignment (step 4) commit curator escalation
// as part of the governance machinery; slice 4b seated the `'curator'`
// role on `Identity`; slice 7a wires the over-the-wire path.
//
// Authorization is enforced at the MCP dispatch layer (`mcp.ts`,
// `wrapCurator`): the resolved caller's identity is re-fetched from
// the store on every call and the role asserted to be `'curator'`,
// refusing with `permission_denied` otherwise. The seam (role check
// at the wire, not inside the in-process `server.curator.*` methods)
// keeps the testbed and admin-CLI paths — which legitimately invoke
// curator behavior without a wire-level caller — unchanged, and pins
// the role-gate as a transport-layer concern in the same posture as
// `unauthorized` resolution at the Authenticator seam.

export const CuratorAcceptProposalInput = z.object({ proposal_id: ProposalId }).strict();
export type CuratorAcceptProposalInput = z.infer<typeof CuratorAcceptProposalInput>;
// `acceptProposal` returns whichever id the proposal materialized: a
// node_id for graph-creating kinds, a sub_topic_id for sub_topic, or
// neither for in-place mutations (membership, supersedes,
// change_of_home). Both ids are optional; clients pattern-match.
export const CuratorAcceptProposalOutput = z
  .object({ node_id: NodeId.optional(), sub_topic_id: SubTopicId.optional() })
  .strict();
export type CuratorAcceptProposalOutput = z.infer<typeof CuratorAcceptProposalOutput>;

export const CuratorRejectProposalInput = z.object({ proposal_id: ProposalId }).strict();
export type CuratorRejectProposalInput = z.infer<typeof CuratorRejectProposalInput>;
export const CuratorRejectProposalOutput = ok;
export type CuratorRejectProposalOutput = z.infer<typeof CuratorRejectProposalOutput>;

export const CuratorDeferSubTopicInput = z.object({ proposal_id: ProposalId }).strict();
export type CuratorDeferSubTopicInput = z.infer<typeof CuratorDeferSubTopicInput>;
export const CuratorDeferSubTopicOutput = z.object({ sub_topic_id: SubTopicId }).strict();
export type CuratorDeferSubTopicOutput = z.infer<typeof CuratorDeferSubTopicOutput>;

// Idempotent: revoking an already-revoked identity is a no-op rather
// than an error — `changed: false` says "we found it but the
// transition was a no-op", same posture as the admin-CLI revoke
// path. PRD §Identity (Roles, revocation cascade): a revoked
// identity stays browsable as graph history but loses write access
// across the agent-as-delegate fan-out.
export const CuratorRevokeIdentityInput = z.object({ identity_id: IdentityId }).strict();
export type CuratorRevokeIdentityInput = z.infer<typeof CuratorRevokeIdentityInput>;
export const CuratorRevokeIdentityOutput = z
  .object({ identity_id: IdentityId, status: PrincipalStatus, changed: z.boolean() })
  .strict();
export type CuratorRevokeIdentityOutput = z.infer<typeof CuratorRevokeIdentityOutput>;

export const CuratorArchiveStaleProposalsInput = z
  .object({ window_seconds: z.number().positive(), cause_id: CauseId.optional() })
  .strict();
export type CuratorArchiveStaleProposalsInput = z.infer<typeof CuratorArchiveStaleProposalsInput>;
export const CuratorArchiveStaleProposalsOutput = z
  .object({ proposal_ids: z.array(ProposalId) })
  .strict();
export type CuratorArchiveStaleProposalsOutput = z.infer<typeof CuratorArchiveStaleProposalsOutput>;

// `identityClusters` projection (PRD §Identity bullet 4, cross-cause
// identity clustering): identity pairs whose behavioral fingerprint
// across causes suggests coordination. Two metrics ride along
// (`cross_cause_count`, `shared_proposal_count`) so the curator can
// read what's driving the signal; the curator decides what counts as
// a coalition vs. coincidence.
export const IdentityClusterPair = z
  .object({
    identity_a: IdentityId,
    identity_b: IdentityId,
    cross_cause_count: z.number().int().nonnegative(),
    shared_proposal_count: z.number().int().nonnegative(),
  })
  .strict();
export type IdentityClusterPair = z.infer<typeof IdentityClusterPair>;
export const CuratorIdentityClustersInput = z
  .object({
    window_seconds: z.number().positive().optional(),
    min_signal: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CuratorIdentityClustersInput = z.infer<typeof CuratorIdentityClustersInput>;
export const CuratorIdentityClustersOutput = z
  .object({ pairs: z.array(IdentityClusterPair) })
  .strict();
export type CuratorIdentityClustersOutput = z.infer<typeof CuratorIdentityClustersOutput>;

// `reverifyAnchors` batch primitive (PRD §Verification engine,
// Re-verification): pick `active` anchors whose `last_verified_at` is
// older than `max_age_ms`, oldest first, up to `batch_size`, re-fetch
// each through the configured verifier, and either bump
// `last_verified_at` (hash match) or flip to `unresolvable` (hash
// mismatch, or verifier refusal — retraction, host gone, network
// failure all collapse here; the verifier seam conflates them). The
// production scheduler ticks against this primitive; operators can
// also drive it on demand.
export const ReverifyAnchorOutcome = z.enum(['unchanged', 'unresolvable']);
export type ReverifyAnchorOutcome = z.infer<typeof ReverifyAnchorOutcome>;
export const ReverifiedAnchor = z
  .object({ anchor_id: NodeId, outcome: ReverifyAnchorOutcome })
  .strict();
export type ReverifiedAnchor = z.infer<typeof ReverifiedAnchor>;
export const CuratorReverifyAnchorsInput = z
  .object({
    batch_size: z.number().int().positive(),
    max_age_ms: z.number().int().nonnegative(),
    cause_id: CauseId.optional(),
  })
  .strict();
export type CuratorReverifyAnchorsInput = z.infer<typeof CuratorReverifyAnchorsInput>;
export const CuratorReverifyAnchorsOutput = z
  .object({
    checked: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    unresolvable: z.number().int().nonnegative(),
    anchors: z.array(ReverifiedAnchor),
  })
  .strict();
export type CuratorReverifyAnchorsOutput = z.infer<typeof CuratorReverifyAnchorsOutput>;

// ──── Tool name registry ────
//
// The full set of tool names exposed by the MCP server. Useful for the
// server's tool-dispatch table and for the testbed's harness, both of
// which need to know what tool a name resolves to without crawling the
// schema list.
//
// Names cluster by surface: assignment, propose_*, cast_review_vote,
// the read-path `query_*` and `fetch_*`, and the curator-only
// `curator_*` block (slice 7a). The `curator_` prefix names the role
// gate at the wire — a contributor calling any name in that block
// refuses with `permission_denied`, same posture as `unauthorized` at
// the Authenticator seam.
export const ToolName = z.enum([
  'request_assignment',
  'propose_anchor',
  'propose_excerpt',
  'propose_synthesis',
  'propose_supersedes',
  'propose_membership',
  'propose_change_of_home',
  'propose_sub_topic',
  'cast_review_vote',
  'query_causes',
  'query_frontier',
  'query_proposals',
  'fetch_calibration_batch',
  'query_reputation',
  'curator_accept_proposal',
  'curator_reject_proposal',
  'curator_defer_sub_topic',
  'curator_revoke_identity',
  'curator_archive_stale_proposals',
  'curator_identity_clusters',
  'curator_reverify_anchors',
]);
export type ToolName = z.infer<typeof ToolName>;
