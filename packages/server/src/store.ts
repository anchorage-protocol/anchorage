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
  Reputation,
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
  // Per-(identity, cause, sub_topic) reputation. PRD §Reputation: rep
  // is anchored at the cause level and refined by sub-topic landing
  // pattern. The composite key keeps lookups O(1); the values are
  // updated on convergence in resolveByConvergence.
  readonly reputations = new Map<`${IdentityId}|${CauseId}|${SubTopicId}`, Reputation>();
  // Per-(identity, cause, sub_topic) calibration record: passes minus
  // fails on calibration items. Updated on calibration `cast_review_vote`
  // and read by the convergence layer when calibration-aware vote
  // weighting is enabled. Tracked separately from the rep ledger
  // because rep also moves on convergence-vote accuracy — which a
  // strategic coalition can farm by voting with the outcome it itself
  // drives. Calibration record only moves on votes scored against
  // ground truth, so it is not farmable that way.
  readonly calibrationRecords = new Map<
    `${IdentityId}|${CauseId}|${SubTopicId}`,
    { passes: number; fails: number }
  >();
  // Server-observed verification metadata (content hashes, eventually
  // span offsets and provenance). Keyed by proposal_id because that is
  // when verification ran; copied onto the materialized node at
  // acceptance time.
  readonly verifiedRefs = new Map<ProposalId, VerifiedRef>();
  // Per-identity rate-limit counter (PRD §Identity bullet 3). Single
  // record per identity, advanced on epoch boundary: when a write
  // tool is invoked, the server resolves the current epoch from
  // wall-clock time and the configured `rate_limit_epoch_seconds`,
  // and either reuses the existing counter (same epoch) or resets to
  // 0 (new epoch) before checking against the cap. The single-record
  // shape is sufficient because the cap enforces a maximum-per-epoch
  // and the counter is consumed atomically; historical per-epoch
  // counts are not needed for enforcement (the curator's cross-cause
  // identity-clustering projection — slice 4 — is where historical
  // signals surface for surveillance, not enforcement).
  readonly rateLimits = new Map<IdentityId, { epoch: number; count: number }>();
}
