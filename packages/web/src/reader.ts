import type {
  CauseDirectory,
  ContributorProfile,
  IdentityId,
  NodeId,
  NodeNeighborhood,
  QueryFrontierOutput,
  Subgraph,
  SubTopicDetail,
  SubTopicId,
} from '@anchorage/contracts';

// AnchorageReader: the read-only projection of the server surface the
// web pages need. Pages depend on this interface, not on the server
// runtime directly — that keeps `@anchorage/web` independent of
// `@anchorage/server` (preserving a one-way dependency graph in the
// workspace: web → contracts only at runtime; server → web for the
// composition in `run-prod.ts`).
//
// Slice 5b commits the web service to running in-process with the MCP
// server. The concrete `InProcessReader` lives in `@anchorage/server`
// (`packages/server/src/reader.ts`) because it's the only piece that
// needs `Server` + `Caller` runtime symbols. The web handler accepts
// any `AnchorageReader`; production wires it to `InProcessReader`,
// tests can wire it to a fake or to the same `InProcessReader` they
// import from the server package directly.
//
// The anonymous-browse posture: anonymous web users get HTML pages
// from the in-process web service; they never present a bearer
// themselves. The web reader's privileged identity is the single
// resolved caller for *all* anonymous traffic. This is a deliberate
// departure from the ROADMAP's earlier "per-session anonymous
// identity" guess — minting an identity per browse session would
// multiply identity count for no gain (read-path doesn't consume
// rate-limit budget) and would press needlessly against the IdP's
// binding-cost gate. Auth-required contributor views (later slice)
// will still mint per-human identities through the OAuth flow.
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
  // `node://{id}` resource. Node + immediate active edges + hydrated
  // neighbors. Drives the node-detail page (slice 5c).
  getNodeNeighborhood(id: NodeId): Promise<NodeNeighborhood>;
  // `contributor://{id}` resource. Public contributor profile +
  // per-(cause, sub-topic) tier projection (PRD §Reputation). Drives
  // the contributor profile page (slice 5c).
  getContributorProfile(id: IdentityId): Promise<ContributorProfile>;
  // `query_frontier` read-path tool, scoped to a sub-topic for the
  // sub-topic page's work-to-be-done section.
  queryFrontier(subTopicId: SubTopicId): Promise<QueryFrontierOutput>;
}
