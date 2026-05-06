import type {
  AgentCredential,
  AgentCredentialId,
  Cause,
  CauseId,
  Identity,
  IdentityId,
  SubTopic,
  SubTopicId,
} from '@anchorage/contracts';

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
}
