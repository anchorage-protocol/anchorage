import { z } from 'zod';
import { CauseId, NodeId, ProposalId, SubTopicId } from './ids.js';

// Frontier items are *candidates* for the assignment loop to draw from;
// they are not themselves assignments. The kinds map to the gap types
// PRD §Capacity and assignment names: orphan anchors needing excerpts,
// syntheses needing parents, contested claims needing review, plus
// unresolvable anchors that surface for re-anchoring (PRD §Verification
// engine).
export const FrontierKind = z.enum([
  'orphan_anchor',
  'needs_synthesis',
  'needs_review',
  'unresolvable_anchor',
]);
export type FrontierKind = z.infer<typeof FrontierKind>;

const frontierBase = {
  // priority is an opaque ordering hint, not a contract about scale —
  // the system tunes it. Higher means more urgent.
  priority: z.number(),
  cause_id: CauseId,
};

// Anchor exists; needs at least one excerpt to be productive.
export const OrphanAnchorItem = z
  .object({
    ...frontierBase,
    kind: z.literal('orphan_anchor'),
    sub_topic_id: SubTopicId,
    anchor_id: NodeId,
  })
  .strict();
export type OrphanAnchorItem = z.infer<typeof OrphanAnchorItem>;

// A cluster of related excerpts/syntheses where a synthesis (or
// open_question) would close a visible gap.
export const NeedsSynthesisItem = z
  .object({
    ...frontierBase,
    kind: z.literal('needs_synthesis'),
    sub_topic_id: SubTopicId,
    parent_ids: z.array(NodeId).min(1),
  })
  .strict();
export type NeedsSynthesisItem = z.infer<typeof NeedsSynthesisItem>;

// A staged proposal awaiting review. Carries the proposal_id only; the
// reviewer fetches the proposal as a resource (or via the calibration
// batch, where it is delivered with status omitted).
export const NeedsReviewItem = z
  .object({
    ...frontierBase,
    kind: z.literal('needs_review'),
    sub_topic_id: SubTopicId,
    proposal_id: ProposalId,
  })
  .strict();
export type NeedsReviewItem = z.infer<typeof NeedsReviewItem>;

// An anchor whose source has drifted/been retracted. PRD §Verification
// engine: surfaces as a frontier item rather than silently rotting.
export const UnresolvableAnchorItem = z
  .object({
    ...frontierBase,
    kind: z.literal('unresolvable_anchor'),
    sub_topic_id: SubTopicId,
    anchor_id: NodeId,
  })
  .strict();
export type UnresolvableAnchorItem = z.infer<typeof UnresolvableAnchorItem>;

export const FrontierItem = z.discriminatedUnion('kind', [
  OrphanAnchorItem,
  NeedsSynthesisItem,
  NeedsReviewItem,
  UnresolvableAnchorItem,
]);
export type FrontierItem = z.infer<typeof FrontierItem>;
