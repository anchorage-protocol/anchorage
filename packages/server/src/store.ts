import type {
  AgentCredential,
  AgentCredentialId,
  Cause,
  CauseId,
  Identity,
  IdentityId,
  Node,
  NodeId,
  Proposal,
  ProposalId,
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
  // Server-observed verification metadata (content hashes, eventually
  // span offsets and provenance). Keyed by proposal_id because that is
  // when verification ran; copied onto the materialized node at
  // acceptance time.
  readonly verifiedRefs = new Map<ProposalId, VerifiedRef>();
}
