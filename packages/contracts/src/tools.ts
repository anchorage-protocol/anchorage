import { z } from 'zod';
import { AssignmentTask, WorkKind } from './assignments.js';
import { FrontierItem, FrontierKind } from './frontier.js';
import { AssignmentId, CauseId, NodeId, ProposalId, ReviewVoteId, SubTopicId } from './ids.js';
import { ExternalRef, QuotedSpan } from './nodes.js';
import { Proposal, ProposalPayload, ProposalStatus } from './proposals.js';
import { ReviewDecision } from './reviews.js';

// Tool I/O contracts: the input/output shapes for the MCP tools defined
// in PRD §MCP tool surface. These sit one layer outboard of the data
// contracts (Proposal, Assignment, Membership, …) so the transport
// shape is independent of the persisted shape.

const ok = z.object({ ok: z.literal(true) }).strict();
const proposalIdResult = z.object({ proposal_id: ProposalId }).strict();

// ──── Capacity & assignment ────

export const SetCapacityInput = z
  .object({
    cause_id: CauseId,
    rate: z.number().int().positive(),
    kinds: z.array(WorkKind).min(1),
  })
  .strict();
export type SetCapacityInput = z.infer<typeof SetCapacityInput>;
export const SetCapacityOutput = ok;
export type SetCapacityOutput = z.infer<typeof SetCapacityOutput>;

export const RequestAssignmentInput = z
  .object({
    cause_id: CauseId,
    // Optional preference; the system is not bound by it.
    kind: WorkKind.optional(),
  })
  .strict();
export type RequestAssignmentInput = z.infer<typeof RequestAssignmentInput>;
export const RequestAssignmentOutput = z
  .object({ assignment_id: AssignmentId, task: AssignmentTask })
  .strict();
export type RequestAssignmentOutput = z.infer<typeof RequestAssignmentOutput>;

export const AcceptAssignmentInput = z.object({ assignment_id: AssignmentId }).strict();
export type AcceptAssignmentInput = z.infer<typeof AcceptAssignmentInput>;
export const AcceptAssignmentOutput = ok;
export type AcceptAssignmentOutput = z.infer<typeof AcceptAssignmentOutput>;

export const DeclineAssignmentInput = z
  .object({ assignment_id: AssignmentId, reason: z.string().min(1) })
  .strict();
export type DeclineAssignmentInput = z.infer<typeof DeclineAssignmentInput>;
export const DeclineAssignmentOutput = ok;
export type DeclineAssignmentOutput = z.infer<typeof DeclineAssignmentOutput>;

export const SubmitAssignedProposalInput = z
  .object({ assignment_id: AssignmentId, payload: ProposalPayload })
  .strict();
export type SubmitAssignedProposalInput = z.infer<typeof SubmitAssignedProposalInput>;
export const SubmitAssignedProposalOutput = proposalIdResult;
export type SubmitAssignedProposalOutput = z.infer<typeof SubmitAssignedProposalOutput>;

// ──── Contributor-initiated proposals ────

export const ProposeAnchorInput = z
  .object({
    cause_id: CauseId,
    home_sub_topic_id: SubTopicId,
    memberships: z.array(SubTopicId).optional(),
    content: z.string().min(1),
    external_ref: ExternalRef,
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
  })
  .strict();
export type ProposeSupersedesInput = z.infer<typeof ProposeSupersedesInput>;
export const ProposeSupersedesOutput = proposalIdResult;
export type ProposeSupersedesOutput = z.infer<typeof ProposeSupersedesOutput>;

export const ProposeMembershipInput = z
  .object({ node_id: NodeId, sub_topic_id: SubTopicId })
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
// `demonstrated` (slow-decay competence, intended to gate eligibility
// tiers) and `recent` (fast-decay activity, intended to gate
// assignment). Values are decayed forward to the server's current
// time before return — clients see the live numbers, not the
// snapshots at last bump.
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

// ──── Tool name registry ────
//
// The full set of tool names exposed by the MCP server. Useful for the
// server's tool-dispatch table and for the testbed's harness, both of
// which need to know what tool a name resolves to without crawling the
// schema list.
export const ToolName = z.enum([
  'set_capacity',
  'request_assignment',
  'accept_assignment',
  'decline_assignment',
  'submit_assigned_proposal',
  'propose_anchor',
  'propose_excerpt',
  'propose_synthesis',
  'propose_supersedes',
  'propose_membership',
  'propose_change_of_home',
  'propose_sub_topic',
  'cast_review_vote',
  'query_frontier',
  'query_proposals',
  'fetch_calibration_batch',
  'query_reputation',
]);
export type ToolName = z.infer<typeof ToolName>;
