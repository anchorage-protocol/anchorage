import type {
  AgentCredential,
  AgentCredentialId,
  Assignment,
  AssignmentId,
  Capacity,
  Cause,
  CauseId,
  Edge,
  EdgeId,
  Identity,
  IdentityId,
  Node,
  NodeId,
  Proposal,
  ProposalId,
  ReviewVote,
  ReviewVoteId,
  SubTopic,
  SubTopicId,
} from '@anchorage/contracts';
import type { VerifiedRef } from './verifier.js';

// In-memory store. Keeps the data model concrete while transport,
// persistence, and storage backend choices are still open. The Server
// only reaches state through this interface, so swapping backends later
// (e.g. SQLite for durability, Postgres for the hosted instance) is a
// localized change.
export class MemoryStore {
  readonly identities = new Map<IdentityId, Identity>();
  readonly agentCredentials = new Map<AgentCredentialId, AgentCredential>();
  readonly causes = new Map<CauseId, Cause>();
  readonly subTopics = new Map<SubTopicId, SubTopic>();
  readonly proposals = new Map<ProposalId, Proposal>();
  readonly nodes = new Map<NodeId, Node>();
  readonly edges = new Map<EdgeId, Edge>();
  readonly reviewVotes = new Map<ReviewVoteId, ReviewVote>();
  readonly assignments = new Map<AssignmentId, Assignment>();
  // Capacity is one declaration per (identity, cause) — PRD §Capacity
  // and assignment: capacity is cause-scoped, not sub-topic-scoped.
  // The composite key keeps lookups O(1) without scanning all records,
  // and set_capacity is naturally an upsert under that key.
  readonly capacities = new Map<`${IdentityId}|${CauseId}`, Capacity>();
  // Server-observed verification metadata (content hashes, eventually
  // span offsets and provenance). Keyed by proposal_id because that is
  // when verification ran; copied onto the materialized node at
  // acceptance time.
  readonly verifiedRefs = new Map<ProposalId, VerifiedRef>();
}
