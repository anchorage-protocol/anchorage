import { z } from 'zod';
import { AssignmentId, CauseId, IdentityId, NodeId, ProposalId, SubTopicId } from './ids.js';
import { Timestamp } from './timestamps.js';

// The kinds of work a contributor can declare capacity for and the
// system can pull from the frontier. Excludes `change_of_home` (curator
// action per PRD §Change of home) and `sub_topic` (curator-gated per
// PRD §Sub-topic creation) — those are not assignment-driven in v0.
export const WorkKind = z.enum([
  'anchor',
  'excerpt',
  'synthesis',
  'open_question',
  'supersedes',
  'membership',
  'review',
]);
export type WorkKind = z.infer<typeof WorkKind>;

// Capacity is declared at the cause level — sub-topic granularity would
// reopen the rep-laundering vector by letting contributors cherry-pick
// easy sub-topics (PRD §Capacity and assignment).
export const Capacity = z
  .object({
    identity_id: IdentityId,
    cause_id: CauseId,
    // a cap, not a schedule: maximum assignments granted per window.
    rate: z.number().int().positive(),
    kinds: z.array(WorkKind).min(1),
    updated_at: Timestamp,
  })
  .strict();
export type Capacity = z.infer<typeof Capacity>;

// Tasks are concrete (PRD §Capacity and assignment, `request_assignment`
// bullet: "a specific node-shape to propose, or a specific proposal to
// review, in a specific sub-topic"). Each variant carries the context
// needed to produce the work without the contributor consulting the
// tool layer.
const proposeTaskBase = {
  cause_id: CauseId,
  sub_topic_id: SubTopicId,
};

export const AssignmentTask = z.discriminatedUnion('kind', [
  z.object({ ...proposeTaskBase, kind: z.literal('anchor') }).strict(),
  z.object({ ...proposeTaskBase, kind: z.literal('excerpt'), parent_anchor_id: NodeId }).strict(),
  z
    .object({
      ...proposeTaskBase,
      kind: z.literal('synthesis'),
      parent_ids: z.array(NodeId).min(1),
    })
    .strict(),
  z
    .object({
      ...proposeTaskBase,
      kind: z.literal('open_question'),
      parent_ids: z.array(NodeId).min(1),
    })
    .strict(),
  z.object({ ...proposeTaskBase, kind: z.literal('supersedes'), from_node_id: NodeId }).strict(),
  z.object({ ...proposeTaskBase, kind: z.literal('membership'), node_id: NodeId }).strict(),
  z.object({ kind: z.literal('review'), proposal_id: ProposalId }).strict(),
]);
export type AssignmentTask = z.infer<typeof AssignmentTask>;

// Lifecycle: offered (system pushed via request_assignment) →
// accepted → submitted; or offered → declined; or offered → expired.
// Decline is non-punitive on its own (PRD §Capacity and assignment);
// pattern-decline is an abuse signal handled by both a curator-side
// projection (`declinePatterns`) and an assignment-time gate
// (`assignment_max_decline_rate`) — same per-(cause, reviewer)
// cumulative rate consumed at two surfaces.
export const AssignmentStatus = z.enum(['offered', 'accepted', 'submitted', 'declined', 'expired']);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

export const Assignment = z
  .object({
    id: AssignmentId,
    contributor_id: IdentityId,
    task: AssignmentTask,
    status: AssignmentStatus,
    // optional pointer to the proposal that fulfilled the task (for
    // propose-kind tasks) or that the review vote attached to (for
    // review-kind tasks). Set on transition to `submitted`.
    fulfilled_by: ProposalId.optional(),
    // reason given on decline (PRD §Capacity and assignment).
    // Set on transition to `declined`. Persisted because pattern-
    // declines surface to the curator-side `declinePatterns`
    // projection where the reason is what the curator inspects
    // when patterns surface — the assignment-time
    // `assignment_max_decline_rate` gate reads only the cumulative
    // rate, so the reason stays curator-facing by construction.
    decline_reason: z.string().min(1).optional(),
    created_at: Timestamp,
    updated_at: Timestamp,
    expires_at: Timestamp.optional(),
  })
  .strict();
export type Assignment = z.infer<typeof Assignment>;
