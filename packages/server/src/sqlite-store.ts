import { DatabaseSync } from 'node:sqlite';
import type {
  AgentCredential,
  AgentCredentialId,
  Assignment,
  AssignmentId,
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
import type { MapLike, Store } from './store.js';
import type { VerifiedRef } from './verifier.js';

// SqliteStore is the production-runtime backend for the Server's data
// surface — slice 4 wires it into the hosted MCP endpoint; slice 2
// (this file) lands the implementation alongside the in-memory testbed
// store. Each collection is a single `(key TEXT PRIMARY KEY, value
// TEXT)` table holding JSON-encoded records. The shape is deliberately
// trivial: the Server only reaches state through `Store`'s small
// MapLike surface (`get`, `set`, `values`, `entries`, `size`), so the
// per-table adapter implements exactly that — no schema-aware SQL, no
// indexed projections. The data model lives in `@anchorage/contracts`
// and is exercised against MemoryStore in the same way; SqliteStore
// adds durability and zero behavioral difference. Iteration order is
// pinned to insertion order via `ORDER BY rowid`, matching
// JavaScript `Map`'s native order so testbed-deterministic ordering
// holds across backends — see [CLAUDE.md §Load-bearing design
// commitments] (sim≡prod invariant).
//
// Why JSON-in-text rather than structured columns: the Server's only
// access pattern against the store is by primary key plus full-scan
// iteration; richer columnar projections (frontier queries, identity
// clustering, etc.) are server-side derivations from iterated state,
// not store-side queries. Indexed columns would be premature here —
// the right shape if/when the read paths grow query-heavy is to add
// projections as separate materialized tables alongside, not to
// migrate the primary records. Tracked as Phase 2 follow-up if and
// only if measured query cost demands it.
//
// Why `node:sqlite` rather than `better-sqlite3`: Node ≥24 is already
// required (`package.json` engines) and `node:sqlite` is stable and
// synchronous on that version. No new native dependency, no install
// step, fewer moving parts.
//
// Concurrency posture: single-instance for the v1 single-cause public
// instance per [ROADMAP §Phase 2] (slice 2). The Server is the trust
// boundary and serializes mutation through its tool surface; the
// SQLite connection is therefore exercised single-threaded from a
// single process. WAL is enabled so a future read-only projection
// process can attach without blocking writes, but multi-writer is out
// of scope until the Postgres path (Phase 4-or-later).

interface KvRow {
  value: string;
}
interface KvEntryRow {
  key: string;
  value: string;
}
interface CountRow {
  n: number | bigint;
}

class JsonTable<K extends string, V> implements MapLike<K, V> {
  readonly #getStmt: ReturnType<DatabaseSync['prepare']>;
  readonly #setStmt: ReturnType<DatabaseSync['prepare']>;
  readonly #valuesStmt: ReturnType<DatabaseSync['prepare']>;
  readonly #entriesStmt: ReturnType<DatabaseSync['prepare']>;
  readonly #countStmt: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync, table: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.#getStmt = db.prepare(`SELECT value FROM "${table}" WHERE key = ?`);
    this.#setStmt = db.prepare(
      `INSERT INTO "${table}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.#valuesStmt = db.prepare(`SELECT value FROM "${table}" ORDER BY rowid`);
    this.#entriesStmt = db.prepare(`SELECT key, value FROM "${table}" ORDER BY rowid`);
    this.#countStmt = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`);
  }

  get(key: K): V | undefined {
    const row = this.#getStmt.get(key) as unknown as KvRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as V);
  }

  set(key: K, value: V): void {
    this.#setStmt.run(key, JSON.stringify(value));
  }

  *values(): IterableIterator<V> {
    for (const row of this.#valuesStmt.all() as unknown as KvRow[]) {
      yield JSON.parse(row.value) as V;
    }
  }

  *entries(): IterableIterator<[K, V]> {
    for (const row of this.#entriesStmt.all() as unknown as KvEntryRow[]) {
      yield [row.key as K, JSON.parse(row.value) as V];
    }
  }

  get size(): number {
    const row = this.#countStmt.get() as unknown as CountRow;
    return typeof row.n === 'bigint' ? Number(row.n) : row.n;
  }
}

export interface SqliteStoreOptions {
  // Path to the SQLite file, or `:memory:` for an ephemeral database
  // (useful for tests and for the parity scenario that exercises both
  // backends through the same Server entrypoints).
  path: string;
}

export class SqliteStore implements Store {
  readonly db: DatabaseSync;
  readonly identities: MapLike<IdentityId, Identity>;
  readonly agentCredentials: MapLike<AgentCredentialId, AgentCredential>;
  readonly agentCredentialSecrets: MapLike<string, AgentCredentialId>;
  readonly causes: MapLike<CauseId, Cause>;
  readonly subTopics: MapLike<SubTopicId, SubTopic>;
  readonly proposals: MapLike<ProposalId, Proposal>;
  readonly nodes: MapLike<NodeId, Node>;
  readonly edges: MapLike<EdgeId, Edge>;
  readonly reviewVotes: MapLike<ReviewVoteId, ReviewVote>;
  readonly assignments: MapLike<AssignmentId, Assignment>;
  readonly reputations: MapLike<`${IdentityId}|${CauseId}|${SubTopicId}`, Reputation>;
  readonly calibrationRecords: MapLike<
    `${IdentityId}|${CauseId}|${SubTopicId}`,
    { passes: number; fails: number }
  >;
  readonly verifiedRefs: MapLike<ProposalId, VerifiedRef>;
  readonly identityProviderSubjects: MapLike<string, IdentityId>;
  readonly idpIssuanceCounters: MapLike<string, { epoch: number; count: number }>;
  readonly rateLimits: MapLike<IdentityId, { epoch: number; count: number }>;

  constructor(opts: SqliteStoreOptions) {
    this.db = new DatabaseSync(opts.path);
    // WAL for concurrent readers, NORMAL synchronous for the
    // performance/durability balance appropriate to single-writer
    // posture (full fsync on every transaction is overkill when the
    // server's commit boundary is per-tool-call; WAL + NORMAL still
    // survives process crash, only OS-level crash can lose the last
    // few transactions).
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
    this.identities = new JsonTable(this.db, 'identities');
    this.agentCredentials = new JsonTable(this.db, 'agent_credentials');
    this.agentCredentialSecrets = new JsonTable(this.db, 'agent_credential_secrets');
    this.causes = new JsonTable(this.db, 'causes');
    this.subTopics = new JsonTable(this.db, 'sub_topics');
    this.proposals = new JsonTable(this.db, 'proposals');
    this.nodes = new JsonTable(this.db, 'nodes');
    this.edges = new JsonTable(this.db, 'edges');
    this.reviewVotes = new JsonTable(this.db, 'review_votes');
    this.assignments = new JsonTable(this.db, 'assignments');
    this.reputations = new JsonTable(this.db, 'reputations');
    this.calibrationRecords = new JsonTable(this.db, 'calibration_records');
    this.verifiedRefs = new JsonTable(this.db, 'verified_refs');
    this.identityProviderSubjects = new JsonTable(this.db, 'identity_provider_subjects');
    this.idpIssuanceCounters = new JsonTable(this.db, 'idp_issuance_counters');
    this.rateLimits = new JsonTable(this.db, 'rate_limits');
  }

  close(): void {
    this.db.close();
  }
}
