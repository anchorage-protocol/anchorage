import type {
  CauseDirectory,
  QueryFrontierOutput,
  Subgraph,
  SubTopicDetail,
  SubTopicId,
} from '@anchorage/contracts';
import type { AnchorageReader } from '@anchorage/web';
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

  async queryFrontier(subTopicId: SubTopicId): Promise<QueryFrontierOutput> {
    return this.server.tools.queryFrontier(this.caller, { sub_topic_id: subTopicId });
  }
}
