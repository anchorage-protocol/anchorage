import { z } from 'zod';
import { AssignmentId, CauseId, IdentityId, NodeId, ProposalId, SubTopicId } from './ids.js';
import { Timestamp } from './timestamps.js';

// The kinds of work the system can pull from the frontier, and the
// optional `kind` filter on `request_assignment`. Excludes
// `change_of_home` (curator action per PRD §Change of home) and
// `sub_topic` (curator-gated per PRD §Sub-topic creation) — those are
// not assignment-driven in v0. There is no capacity declaration: a
// contributor holds a single FIFO slot per (identity, cause) and the
// only knob is this strict per-kind filter (PRD §Assignment).
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

// Tasks are concrete (PRD §Assignment, `request_assignment` bullet: "a
// specific node-shape to propose, or a specific proposal to review, in
// a specific sub-topic"). Each variant carries the context needed to
// produce the work without the contributor consulting the tool layer.
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

// Lifecycle (PRD §Assignment): accepted (held the moment
// request_assignment returns it) → submitted (fulfilled); or
// accepted → lapsed. There is no `offered`, no `declined`, and no
// `expired`. Single-slot has no decision at offer time — the only
// outcomes are fulfill the held slot or let it go — so there is no
// separate accept step and no `offered` waiting state: a pulled
// assignment is `accepted` (held) from creation.
//
//   - `lapsed` is terminal and means the slot resolved without a
//     fulfillment and without credit or penalty — the precondition no
//     longer holds (parent went `unresolvable`, sub-topic or cause
//     closed) or the slot was already resolved by the holder or a TTL
//     shadow. The slot frees; the contributor takes no reputation hit,
//     symmetric with not having delivered it.
//   - The lapse-is-a-finding path (an anchor whose `external_ref` will
//     not resolve) is NOT `lapsed`: it materializes a real fulfillment
//     carrying the honest negative result and goes `submitted` through
//     the same `unresolvable` machinery a re-verification flip uses.
//   - TTL is shadow-reassignment, never holder-expiry: a slot idle past
//     `ttl_at` is *additionally* offered to a backup as a separate
//     assignment carrying `shadow_of`; the slot resolves on the first
//     fulfillment by anyone and the original holder is released
//     regardless of author. A duplicate fulfillment of an
//     already-resolved slot is dropped (the loser transitions
//     `lapsed`).
export const AssignmentStatus = z.enum(['accepted', 'submitted', 'lapsed']);
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
    // present iff this assignment is a TTL shadow re-offer of another
    // contributor's still-unresolved task (PRD §Assignment, "TTL is
    // shadow-reassignment"). Points at the original assignment whose
    // slot this shadow can resolve; resolving either resolves the slot
    // and releases the original holder regardless of author.
    shadow_of: AssignmentId.optional(),
    created_at: Timestamp,
    updated_at: Timestamp,
    // the TTL after which an unresolved slot is *additionally*
    // shadow-offered to a backup — not a holder-expiry. Absent means no
    // shadow has been scheduled yet.
    ttl_at: Timestamp.optional(),
  })
  .strict();
export type Assignment = z.infer<typeof Assignment>;
