import { z } from 'zod';
import { AssignmentId, CauseId, IdentityId, NodeId, ProposalId, SubTopicId } from './ids.js';
import { ExternalRef, QuotedSpan } from './nodes.js';
import { Timestamp } from './timestamps.js';

// Persisted-proposal lifecycle. Proposals that fail synchronous
// verification at the tool boundary (PRD §Verification engine) never
// become records — they fail with an error and no proposal_id is
// returned. So `rejected` here means review-rejected, not
// verification-rejected. `unresolved-archived` is reachable via the
// divergence-closure mechanism (PRD §Reviewer assignment).
export const ProposalStatus = z.enum(['staged', 'accepted', 'rejected', 'unresolved-archived']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

// Optional list of additional sub-topic memberships requested at
// proposal time. Each becomes a separately-reviewable membership claim
// post-acceptance; the proposal-level acceptance does not blanket-grant
// them.
const requestedMemberships = z.array(SubTopicId).optional();

// Eight payload kinds, one per propose_* tool in the PRD's MCP tool
// surface. The PRD's `propose_synthesis` is split here into `synthesis`
// and `open_question` payloads to keep the discriminator clean; the MCP
// tool I/O layer reunites them at the tool boundary.
export const ProposeAnchorPayload = z
  .object({
    kind: z.literal('anchor'),
    cause_id: CauseId,
    home_sub_topic_id: SubTopicId,
    memberships: requestedMemberships,
    content: z.string().min(1),
    external_ref: ExternalRef,
  })
  .strict();
export type ProposeAnchorPayload = z.infer<typeof ProposeAnchorPayload>;

export const ProposeExcerptPayload = z
  .object({
    kind: z.literal('excerpt'),
    cause_id: CauseId,
    home_sub_topic_id: SubTopicId,
    memberships: requestedMemberships,
    parent_anchor_id: NodeId,
    content: z.string().min(1),
    quoted_span: QuotedSpan,
  })
  .strict();
export type ProposeExcerptPayload = z.infer<typeof ProposeExcerptPayload>;

const synthesisLikeBase = {
  cause_id: CauseId,
  home_sub_topic_id: SubTopicId,
  memberships: requestedMemberships,
  parent_ids: z.array(NodeId).min(1),
  content: z.string().min(1),
};

export const ProposeSynthesisPayload = z
  .object({ ...synthesisLikeBase, kind: z.literal('synthesis') })
  .strict();
export type ProposeSynthesisPayload = z.infer<typeof ProposeSynthesisPayload>;

export const ProposeOpenQuestionPayload = z
  .object({ ...synthesisLikeBase, kind: z.literal('open_question') })
  .strict();
export type ProposeOpenQuestionPayload = z.infer<typeof ProposeOpenQuestionPayload>;

export const ProposeSupersedesPayload = z
  .object({
    kind: z.literal('supersedes'),
    from_node_id: NodeId,
    to_node_id: NodeId,
    rationale: z.string().min(1),
  })
  .strict();
export type ProposeSupersedesPayload = z.infer<typeof ProposeSupersedesPayload>;

export const ProposeMembershipPayload = z
  .object({
    kind: z.literal('membership'),
    node_id: NodeId,
    sub_topic_id: SubTopicId,
  })
  .strict();
export type ProposeMembershipPayload = z.infer<typeof ProposeMembershipPayload>;

export const ProposeChangeOfHomePayload = z
  .object({
    kind: z.literal('change_of_home'),
    node_id: NodeId,
    new_home_sub_topic_id: SubTopicId,
    rationale: z.string().min(1),
  })
  .strict();
export type ProposeChangeOfHomePayload = z.infer<typeof ProposeChangeOfHomePayload>;

export const ProposeSubTopicPayload = z
  .object({
    kind: z.literal('sub_topic'),
    cause_id: CauseId,
    name: z.string().min(1).max(200),
    description: z.string().min(1),
    scope_query: z.string().min(1),
  })
  .strict();
export type ProposeSubTopicPayload = z.infer<typeof ProposeSubTopicPayload>;

export const ProposalPayload = z.discriminatedUnion('kind', [
  ProposeAnchorPayload,
  ProposeExcerptPayload,
  ProposeSynthesisPayload,
  ProposeOpenQuestionPayload,
  ProposeSupersedesPayload,
  ProposeMembershipPayload,
  ProposeChangeOfHomePayload,
  ProposeSubTopicPayload,
]);
export type ProposalPayload = z.infer<typeof ProposalPayload>;

export const Proposal = z
  .object({
    id: ProposalId,
    proposer_id: IdentityId,
    // present when the proposal was submitted via an assignment
    // (PRD §Assignment); contributor-initiated proposals
    // omit it and are weighted lower for reputation.
    assignment_id: AssignmentId.optional(),
    status: ProposalStatus,
    payload: ProposalPayload,
    created_at: Timestamp,
    updated_at: Timestamp,
    // PRD §Reviewer assignment: derived flag projected at the read-
    // path (query_proposals) when the eligible reviewer pool for this
    // proposal cannot furnish the configured number of distinct
    // strata. Not persisted — it is computed from current vote-history
    // clusters and the current eligible pool every time a proposal is
    // surfaced. Convergence reads the same derived signal to tighten
    // thresholds. Absent (undefined) when stratification is disabled
    // or the proposal has reached a terminal status; false when the
    // pool is diverse enough; true when the diversity floor is not
    // met.
    stratification_degraded: z.boolean().optional(),
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;
