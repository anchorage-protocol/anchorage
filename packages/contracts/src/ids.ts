import { z } from 'zod';

const idShape = z.string().min(1).max(128);

export const IdentityId = idShape.brand<'IdentityId'>();
export type IdentityId = z.infer<typeof IdentityId>;

export const AgentCredentialId = idShape.brand<'AgentCredentialId'>();
export type AgentCredentialId = z.infer<typeof AgentCredentialId>;

export const CauseId = idShape.brand<'CauseId'>();
export type CauseId = z.infer<typeof CauseId>;

export const SubTopicId = idShape.brand<'SubTopicId'>();
export type SubTopicId = z.infer<typeof SubTopicId>;

export const NodeId = idShape.brand<'NodeId'>();
export type NodeId = z.infer<typeof NodeId>;

export const EdgeId = idShape.brand<'EdgeId'>();
export type EdgeId = z.infer<typeof EdgeId>;

export const ProposalId = idShape.brand<'ProposalId'>();
export type ProposalId = z.infer<typeof ProposalId>;

export const MembershipId = idShape.brand<'MembershipId'>();
export type MembershipId = z.infer<typeof MembershipId>;

export const AssignmentId = idShape.brand<'AssignmentId'>();
export type AssignmentId = z.infer<typeof AssignmentId>;
