import { z } from 'zod';
import { EdgeId, IdentityId, NodeId } from './ids.js';
import { Timestamp } from './timestamps.js';

export const EdgeKind = z.enum(['derives', 'supersedes']);
export type EdgeKind = z.infer<typeof EdgeKind>;

// Edges have a narrower lifecycle than nodes: they are either staged for
// review, active in the canonical graph, or rejected. They are never
// superseded (a `supersedes` edge replaces a node, not another edge) and
// never `unresolvable` (which is anchor-only).
export const EdgeStatus = z.enum(['staged', 'active', 'rejected']);
export type EdgeStatus = z.infer<typeof EdgeStatus>;

const edgeBase = {
  id: EdgeId,
  // direction matches storage: parent (support) → child for `derives`,
  // old → replacement for `supersedes`.
  from: NodeId,
  to: NodeId,
  status: EdgeStatus,
  created_by: IdentityId,
  created_at: Timestamp,
};

// `derives` edges are created atomically with their child node and share
// its lifecycle: a `derives` edge is `active` iff the child it terminates
// at is `active`. The verification engine enforces that constraint and
// also enforces the parent-active-at-acceptance rule (PRD §Edges).
export const DerivesEdge = z
  .object({
    ...edgeBase,
    kind: z.literal('derives'),
  })
  .strict();
export type DerivesEdge = z.infer<typeof DerivesEdge>;

// `supersedes` edges are themselves proposable; rationale is required at
// proposal time (PRD §Edges, `propose_supersedes`).
export const SupersedesEdge = z
  .object({
    ...edgeBase,
    kind: z.literal('supersedes'),
    rationale: z.string().min(1),
  })
  .strict();
export type SupersedesEdge = z.infer<typeof SupersedesEdge>;

export const Edge = z.discriminatedUnion('kind', [DerivesEdge, SupersedesEdge]);
export type Edge = z.infer<typeof Edge>;
