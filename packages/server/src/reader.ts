import type {
  CauseDirectory,
  CauseId,
  ContributorProfile,
  IdentityId,
  Manuscript,
  NodeId,
  NodeNeighborhood,
  Proposal,
  QueryFrontierOutput,
  Subgraph,
  SubTopicDetail,
  SubTopicId,
} from '@anchorage/contracts';
import type { AnchorageCuratorReader, AnchorageReader } from '@anchorage/web';
import type { Caller } from './auth.js';
import type { Server } from './server.js';

// In-process implementation of the `AnchorageReader` interface from
// `@anchorage/web`. Lives here, not in the web package, because
// `Server` and `Caller` are server-runtime symbols and we keep the
// workspace dependency graph one-way: web depends only on contracts
// at runtime; the server composes the web handler with this reader.
//
// Slice 5b posture: the web handler runs in the same Node process as
// the MCP server, so the reader is a direct method-dispatch
// shortcut to `server.resources.*` and `server.tools.queryFrontier`.
// No JSON serialization across a transport boundary. The reader
// holds the web tier's privileged `Caller`; `server.resources.*`
// re-resolves it through the store on every call, so revocation
// (via `anchorage-admin revoke-identity`) is honored mid-flight
// without a restart.

export interface InProcessReaderOpts {
  server: Server;
  // The web service's resolved caller. The caller's identity must be
  // active in the store; the boot path in `run-prod.ts` validates
  // this up-front so a stale env config fails loudly rather than
  // per-request. Read-path methods on `Server` re-resolve through
  // the store on every call (PRD §Identity, Authenticator seam), so
  // revocation observed after boot is honored immediately.
  caller: Caller;
}

export class InProcessReader implements AnchorageReader {
  private readonly server: Server;
  private readonly caller: Caller;

  constructor(opts: InProcessReaderOpts) {
    this.server = opts.server;
    this.caller = opts.caller;
  }

  async getCauseDirectory(): Promise<CauseDirectory> {
    return this.server.resources.getCauseDirectory(this.caller);
  }

  async getSubTopicDetail(id: SubTopicId): Promise<SubTopicDetail> {
    return this.server.resources.getSubTopicDetail(this.caller, id);
  }

  async getSubgraph(id: SubTopicId): Promise<Subgraph> {
    return this.server.resources.getSubgraph(this.caller, id);
  }

  async getNodeNeighborhood(id: NodeId): Promise<NodeNeighborhood> {
    return this.server.resources.getNodeNeighborhood(this.caller, id);
  }

  async getContributorProfile(id: IdentityId): Promise<ContributorProfile> {
    return this.server.resources.getContributorProfile(this.caller, id);
  }

  async queryFrontier(subTopicId: SubTopicId): Promise<QueryFrontierOutput> {
    return this.server.tools.queryFrontier(this.caller, { sub_topic_id: subTopicId });
  }

  async getManuscript(id: SubTopicId): Promise<Manuscript> {
    return this.server.resources.getManuscript(this.caller, id);
  }
}

// Slice 7b — curator-side reader. Same shape as `InProcessReader` but
// holds a curator-role caller and exposes the curator-only read
// projections from `server.resources.*`. The split-reader posture
// (public reader → public routes; curator reader → /curator/*
// routes) matches the deliberate split-interface seam in
// `AnchorageReader` / `AnchorageCuratorReader` over in `@anchorage/web`:
// the curator console is mounted by configuration (no curator
// reader → no /curator/* routes at all) and refuses by type, not by
// per-request branching. The underlying server methods also re-
// assert the role on every call so a mid-flight revocation lands on
// the next page load without a restart.
export class InProcessCuratorReader implements AnchorageCuratorReader {
  private readonly server: Server;
  private readonly caller: Caller;

  constructor(opts: InProcessReaderOpts) {
    this.server = opts.server;
    this.caller = opts.caller;
  }

  async getCuratorQueue(options?: { cause_id?: CauseId }): Promise<{ proposals: Proposal[] }> {
    return this.server.resources.getCuratorQueue(this.caller, options);
  }

  async getCuratorDeclinePatterns(
    causeId: CauseId,
    options?: { min_offers?: number; min_rate?: number },
  ): Promise<{
    entries: Array<{
      identity_id: IdentityId;
      offers: number;
      declines: number;
      decline_rate: number;
    }>;
  }> {
    return this.server.resources.getCuratorDeclinePatterns(this.caller, causeId, options);
  }

  async getCuratorIdentityClusters(options?: {
    window_seconds?: number;
    min_signal?: number;
  }): Promise<{
    pairs: Array<{
      identity_a: IdentityId;
      identity_b: IdentityId;
      cross_cause_count: number;
      shared_proposal_count: number;
    }>;
  }> {
    return this.server.resources.getCuratorIdentityClusters(this.caller, options);
  }
}
