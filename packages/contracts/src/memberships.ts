import { z } from 'zod';
import { IdentityId, MembershipId, NodeId, SubTopicId } from './ids.js';
import { Timestamp } from './timestamps.js';

// A scope-membership record: the persisted, reviewable claim that a node
// is in scope for a sub-topic. The denormalized read-side view lives in
// Node.scope_memberships (active memberships only); this record is what
// gives a membership its own provenance, status, and revocation path.
//
// Memberships are reviewed by the *target* sub-topic's reviewer pool —
// the one the node is being claimed to be in scope for (PRD §Scope
// membership).
export const MembershipStatus = z.enum(['staged', 'active', 'revoked']);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

export const Membership = z
  .object({
    id: MembershipId,
    node_id: NodeId,
    sub_topic_id: SubTopicId,
    proposed_by: IdentityId,
    status: MembershipStatus,
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .strict();
export type Membership = z.infer<typeof Membership>;
