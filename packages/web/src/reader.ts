import type {
  CauseDirectory,
  QueryFrontierOutput,
  Subgraph,
  SubTopicDetail,
  SubTopicId,
} from '@anchorage/contracts';
import type { Caller, Server } from '@anchorage/server';

// AnchorageReader: the read-only projection of the server surface the
// web pages need. Pages depend on this interface, not on `Server`
// directly — that keeps the page-render layer independent of the
// transport posture beneath it.
//
// Slice 5b ships one concrete implementation (`InProcessReader`) and
// commits the web service to running in-process with the MCP server:
// both surfaces share a single `Server` instance and the web handler
// holds a privileged `Caller` to satisfy resource-level
// Authenticator gating (PRD §Read-path tools and resources, slice 5a:
// resource reads require a resolved caller, but do not consume the
// per-identity rate-limit budget). The web service's identity is
// minted by the operator via `anchorage-admin mint-reader` (slice 5b
// integration commit) and is a contributor-role identity bound to no
// human — a service caller, not a delegate of any contributor.
//
// The anonymous-browse story collapses to: anonymous web users get
// HTML pages from the in-process web service; they never present a
// bearer themselves. The web reader's privileged identity is the
// single resolved caller for *all* anonymous traffic. This is a
// deliberate departure from the ROADMAP's earlier "per-session
// anonymous identity" guess — minting an identity per browse session
// would multiply identity count for no gain (read-path doesn't
// consume rate-limit budget) and would press needlessly against the
// IdP's binding-cost gate. Auth-required contributor views (later
// slice) will still mint per-human identities through the OAuth flow.
//
// Future postures: a second `HttpMcpReader` implementation could call
// a remote MCP-over-HTTP server via `StreamableHTTPClientTransport`,
// for deployments that separate the web tier from the MCP tier.
// Slice 5b doesn't ship that — `mcp.anchorage.science` and
// `anchorage.science` are served from the same process by design.
export interface AnchorageReader {
  // `cause://` resource. Home-page payload.
  getCauseDirectory(): Promise<CauseDirectory>;
  // `sub-topic://{id}` resource. Metadata + cause + activity counters.
  getSubTopicDetail(id: SubTopicId): Promise<SubTopicDetail>;
  // `subgraph://{sub-topic-id}` resource. Active nodes + edges scoped
  // to the sub-topic.
  getSubgraph(id: SubTopicId): Promise<Subgraph>;
  // `query_frontier` read-path tool, scoped to a sub-topic for the
  // sub-topic page's work-to-be-done section.
  queryFrontier(subTopicId: SubTopicId): Promise<QueryFrontierOutput>;
}

export interface InProcessReaderOpts {
  server: Server;
  // The web service's resolved caller. The caller's identity must be
  // active in the store; the web handler boot path validates this
  // up-front so a stale env config fails loudly rather than per-
  // request. Read-path methods on `Server` re-resolve through the
  // store on every call (PRD §Identity, Authenticator seam), so
  // revocation observed after boot is honored immediately.
  caller: Caller;
}

// Wraps a Server instance directly. No transport boundary, no JSON
// serialization — the web handler shares a process and a heap with
// the MCP server it reads from. Sim≡prod stays clean because the
// underlying `server.resources.*` methods are the same ones the MCP
// wrapper registers for over-the-wire clients; this is just a
// privileged shortcut for the co-located web tier.
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
