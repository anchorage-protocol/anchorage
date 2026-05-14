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

// MapLike is the access pattern the server (and the testbed-side
// reporting/projection code) actually uses against the store: get one
// record by key, upsert one record by key, iterate all records, count
// records, iterate [key, value] pairs. The full `Map` surface is
// intentionally not required — the SQLite-backed adapter (slice 2)
// implements only what the codebase reaches for, which keeps the
// per-table wrapper small. Iteration order is insertion order on both
// backends: JavaScript `Map` guarantees it natively; `SqliteStore`
// orders by `rowid` to match. JavaScript's `Map` satisfies this shape
// directly (its `set` returns `this`, assignable to `void`), so
// `MemoryStore`'s fields remain plain Maps.
export interface MapLike<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  readonly size: number;
}

// Store is the trust boundary's data surface. The Server reaches state
// only through this interface, so swapping backends (in-memory for the
// testbed's cassette-deterministic CI, SQLite for the single-instance
// production runtime, eventually Postgres if multi-instance becomes
// necessary before Phase 4) is a localized change with no `if (sim)`
// branching — see [CLAUDE.md §Load-bearing design commitments] on the
// sim≡prod invariant.
export interface Store {
  readonly identities: MapLike<IdentityId, Identity>;
  readonly agentCredentials: MapLike<AgentCredentialId, AgentCredential>;
  readonly causes: MapLike<CauseId, Cause>;
  readonly subTopics: MapLike<SubTopicId, SubTopic>;
  readonly proposals: MapLike<ProposalId, Proposal>;
  readonly nodes: MapLike<NodeId, Node>;
  readonly edges: MapLike<EdgeId, Edge>;
  readonly reviewVotes: MapLike<ReviewVoteId, ReviewVote>;
  readonly assignments: MapLike<AssignmentId, Assignment>;
  // Capacity is one declaration per (identity, cause) — PRD §Capacity
  // and assignment: capacity is cause-scoped, not sub-topic-scoped.
  // The composite key keeps lookups O(1) without scanning all records,
  // and set_capacity is naturally an upsert under that key.
  readonly capacities: MapLike<`${IdentityId}|${CauseId}`, Capacity>;
  // Per-(identity, cause, sub_topic) reputation. PRD §Reputation: rep
  // is anchored at the cause level and refined by sub-topic landing
  // pattern. The composite key keeps lookups O(1); the values are
  // updated on convergence in resolveByConvergence.
  readonly reputations: MapLike<`${IdentityId}|${CauseId}|${SubTopicId}`, Reputation>;
  // Per-(identity, cause, sub_topic) calibration record: passes minus
  // fails on calibration items. Updated on calibration `cast_review_vote`
  // and read by the convergence layer when calibration-aware vote
  // weighting is enabled. Tracked separately from the rep ledger
  // because rep also moves on convergence-vote accuracy — which a
  // strategic coalition can farm by voting with the outcome it itself
  // drives. Calibration record only moves on votes scored against
  // ground truth, so it is not farmable that way.
  readonly calibrationRecords: MapLike<
    `${IdentityId}|${CauseId}|${SubTopicId}`,
    { passes: number; fails: number }
  >;
  // Server-observed verification metadata (content hashes, eventually
  // span offsets and provenance). Keyed by proposal_id because that is
  // when verification ran; copied onto the materialized node at
  // acceptance time.
  readonly verifiedRefs: MapLike<ProposalId, VerifiedRef>;
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
  readonly rateLimits: MapLike<IdentityId, { epoch: number; count: number }>;
}

// In-memory Store. Used by the testbed (cassettes need deterministic id
// ordering and zero-disk I/O) and by tests; production uses
// `SqliteStore` for durability. Both satisfy the same `Store` interface
// so the Server reaches state identically regardless of backend — the
// sim≡prod invariant in code.
export class MemoryStore implements Store {
  readonly identities = new Map<IdentityId, Identity>();
  readonly agentCredentials = new Map<AgentCredentialId, AgentCredential>();
  readonly causes = new Map<CauseId, Cause>();
  readonly subTopics = new Map<SubTopicId, SubTopic>();
  readonly proposals = new Map<ProposalId, Proposal>();
  readonly nodes = new Map<NodeId, Node>();
  readonly edges = new Map<EdgeId, Edge>();
  readonly reviewVotes = new Map<ReviewVoteId, ReviewVote>();
  readonly assignments = new Map<AssignmentId, Assignment>();
  readonly capacities = new Map<`${IdentityId}|${CauseId}`, Capacity>();
  readonly reputations = new Map<`${IdentityId}|${CauseId}|${SubTopicId}`, Reputation>();
  readonly calibrationRecords = new Map<
    `${IdentityId}|${CauseId}|${SubTopicId}`,
    { passes: number; fails: number }
  >();
  readonly verifiedRefs = new Map<ProposalId, VerifiedRef>();
  readonly rateLimits = new Map<IdentityId, { epoch: number; count: number }>();
}
