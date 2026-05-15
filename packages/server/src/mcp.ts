import {
  AcceptAssignmentInput,
  AcceptAssignmentOutput,
  CastReviewVoteInput,
  CastReviewVoteOutput,
  DeclineAssignmentInput,
  DeclineAssignmentOutput,
  FetchCalibrationBatchInput,
  FetchCalibrationBatchOutput,
  IdentityId,
  NodeId,
  PROTOCOL_VERSION,
  ProposeAnchorInput,
  ProposeAnchorOutput,
  ProposeChangeOfHomeInput,
  ProposeChangeOfHomeOutput,
  ProposeExcerptInput,
  ProposeExcerptOutput,
  ProposeMembershipInput,
  ProposeMembershipOutput,
  ProposeSubTopicInput,
  ProposeSubTopicOutput,
  ProposeSupersedesInput,
  ProposeSupersedesOutput,
  ProposeSynthesisInput,
  ProposeSynthesisOutput,
  QueryFrontierInput,
  QueryFrontierOutput,
  QueryProposalsInput,
  QueryProposalsOutput,
  QueryReputationInput,
  QueryReputationOutput,
  RequestAssignmentInput,
  RequestAssignmentOutput,
  SetCapacityInput,
  SetCapacityOutput,
  SubTopicId,
} from '@anchorage/contracts';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Caller } from './auth.js';
import { ServerError } from './errors.js';
import type { Server } from './server.js';

// One MCP server instance corresponds to one client connection
// (the SDK's stdio + in-memory transports are one-to-one with the
// process / harness instance), so the caller binding is per-instance.
// For multi-tenant deployments (HTTP transport) the binding moves into
// per-request context, but the same handler shape applies.
//
// Caller binding goes through `server.authenticator` (PRD §Identity,
// Authenticator seam): the build receives an opaque transport-layer
// token and resolves it once here, throwing `ServerError('unauthorized')`
// at the seam if the token is malformed/unknown/revoked. Downstream
// tool handlers see only the resolved `Caller`; per-tool freshness is
// re-checked by `resolveCaller` inside the Server.
//
// Errors:
//   - ServerError → returned as a tool error result (PRD's typed error
//     codes survive into the wire response, so testbed adversaries
//     pattern-match on `code` exactly as they do against the
//     in-process server).
//   - Anything else → thrown (transport-level fault); MCP turns it
//     into a generic protocol error and the connection stays open.
export interface McpBuildOptions {
  // Opaque bearer token; the Server's Authenticator interprets it.
  // The testbed's `HarnessAuthenticator` accepts an identity id (or
  // `identityId/agentCredentialId` for delegated agents); the
  // production runtime's `GithubOAuthAuthenticator` (slice 3c)
  // accepts OAuth-issued session ids.
  token: string;
  serverInfo?: { name?: string; version?: string };
}

export function buildMcpServer(server: Server, options: McpBuildOptions): McpServer {
  const caller: Caller = server.authenticator.authenticate(options.token);
  const mcp = new McpServer({
    name: options.serverInfo?.name ?? 'anchorage',
    version: options.serverInfo?.version ?? PROTOCOL_VERSION,
  });

  // Wrap a Server.tools.* method into an MCP tool callback. Wraps
  // ServerError into a tool error result; lets other throws bubble
  // up as protocol errors.
  //
  // Success results carry `structuredContent` (the typed shape) plus a
  // JSON-stringified text fallback. Error results carry the typed
  // `{ code, message }` payload only as JSON text in `content` — *not*
  // as `structuredContent`. This is deliberate: a client that has
  // called `tools/list` caches each tool's `outputSchema` and validates
  // any `structuredContent` it gets back against it (MCP spec
  // behavior), and the error payload does not conform to the tool's
  // success-output schema. Putting it in `content` keeps the typed code
  // on the wire (the AnchorageClient parses it back out; see
  // `client.ts`) without tripping output-schema validation. Clients
  // that never list tools (the scripted archetypes) are unaffected
  // either way.
  function wrap<I, O>(
    handler: (caller: Caller, input: I) => Promise<O>,
  ): (input: I) => Promise<CallToolResult> {
    return async (input: I): Promise<CallToolResult> => {
      try {
        const result = await handler(caller, input);
        return {
          structuredContent: result as Record<string, unknown>,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof ServerError) {
          const payload = { code: err.code, message: err.message };
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(payload) }],
          };
        }
        throw err;
      }
    };
  }

  // Each registration uses the contracts' zod schema's `.shape` as
  // the MCP inputSchema (rawShape). For schemas wrapped in `.strict()`,
  // ZodObject still exposes `.shape`, and the zod-compat layer in the
  // SDK accepts it. The shape is passed inline per registration so
  // the SDK's generic inference recovers the per-tool input type
  // rather than widening to a generic raw shape.

  // ── Capacity & assignment ───────────────────────────────────────
  mcp.registerTool(
    'set_capacity',
    {
      description: 'Declare cause-level capacity (rate cap + accepted work kinds).',
      inputSchema: SetCapacityInput.shape,
      outputSchema: SetCapacityOutput.shape,
    },
    wrap(server.tools.setCapacity),
  );

  mcp.registerTool(
    'request_assignment',
    {
      description: 'Pull an assignment from the frontier within declared capacity.',
      inputSchema: RequestAssignmentInput.shape,
      outputSchema: RequestAssignmentOutput.shape,
    },
    wrap(server.tools.requestAssignment),
  );

  mcp.registerTool(
    'accept_assignment',
    {
      description: 'Move an offered assignment to accepted.',
      inputSchema: AcceptAssignmentInput.shape,
      outputSchema: AcceptAssignmentOutput.shape,
    },
    wrap(server.tools.acceptAssignment),
  );

  mcp.registerTool(
    'decline_assignment',
    {
      description: 'Decline an offered assignment with a reason.',
      inputSchema: DeclineAssignmentInput.shape,
      outputSchema: DeclineAssignmentOutput.shape,
    },
    wrap(server.tools.declineAssignment),
  );

  // ── Proposals (assignment-fulfilling or contributor-initiated) ──
  // Each propose_* tool takes an optional `assignment_id`: present, it
  // fulfills the named accepted propose-kind assignment (full
  // assigned-work reputation, assignment → `submitted`); absent, the
  // proposal is contributor-initiated and weighted lower. Same shape as
  // `cast_review_vote` for review work — one tool per node kind.
  mcp.registerTool(
    'propose_anchor',
    {
      description:
        'Stage an anchor proposal (PMID/DOI/URL must resolve). Pass assignment_id to fulfill an accepted anchor-kind assignment.',
      inputSchema: ProposeAnchorInput.shape,
      outputSchema: ProposeAnchorOutput.shape,
    },
    wrap(server.tools.proposeAnchor),
  );

  mcp.registerTool(
    'propose_excerpt',
    {
      description:
        'Stage an excerpt proposal under an active anchor parent. Pass assignment_id to fulfill an accepted excerpt-kind assignment for that anchor.',
      inputSchema: ProposeExcerptInput.shape,
      outputSchema: ProposeExcerptOutput.shape,
    },
    wrap(server.tools.proposeExcerpt),
  );

  mcp.registerTool(
    'propose_synthesis',
    {
      description:
        'Stage a synthesis or open_question over multiple parents. Pass assignment_id to fulfill an accepted synthesis/open_question-kind assignment.',
      inputSchema: ProposeSynthesisInput.shape,
      outputSchema: ProposeSynthesisOutput.shape,
    },
    wrap(server.tools.proposeSynthesis),
  );

  mcp.registerTool(
    'propose_supersedes',
    {
      description:
        'Stage a supersedes edge between two active nodes. Pass assignment_id to fulfill an accepted supersedes-kind assignment.',
      inputSchema: ProposeSupersedesInput.shape,
      outputSchema: ProposeSupersedesOutput.shape,
    },
    wrap(server.tools.proposeSupersedes),
  );

  mcp.registerTool(
    'propose_membership',
    {
      description:
        'Stage a scope-membership claim for an existing node. Pass assignment_id to fulfill an accepted membership-kind assignment.',
      inputSchema: ProposeMembershipInput.shape,
      outputSchema: ProposeMembershipOutput.shape,
    },
    wrap(server.tools.proposeMembership),
  );

  mcp.registerTool(
    'propose_change_of_home',
    {
      description: 'Stage a change-of-home for a node within the same cause.',
      inputSchema: ProposeChangeOfHomeInput.shape,
      outputSchema: ProposeChangeOfHomeOutput.shape,
    },
    wrap(server.tools.proposeChangeOfHome),
  );

  mcp.registerTool(
    'propose_sub_topic',
    {
      description: 'Stage a sub-topic proposal under an active cause.',
      inputSchema: ProposeSubTopicInput.shape,
      outputSchema: ProposeSubTopicOutput.shape,
    },
    wrap(server.tools.proposeSubTopic),
  );

  // ── Review ──────────────────────────────────────────────────────
  mcp.registerTool(
    'cast_review_vote',
    {
      description: 'Vote on a staged proposal with required rationale.',
      inputSchema: CastReviewVoteInput.shape,
      outputSchema: CastReviewVoteOutput.shape,
    },
    wrap(server.tools.castReviewVote),
  );

  // ── Read-path ───────────────────────────────────────────────────
  mcp.registerTool(
    'query_frontier',
    {
      description: 'List frontier items, optionally filtered by cause / sub-topic / kind.',
      inputSchema: QueryFrontierInput.shape,
      outputSchema: QueryFrontierOutput.shape,
    },
    wrap(server.tools.queryFrontier),
  );

  mcp.registerTool(
    'query_proposals',
    {
      description: 'List proposals, optionally filtered by status / sub-topic / assignment.',
      inputSchema: QueryProposalsInput.shape,
      outputSchema: QueryProposalsOutput.shape,
    },
    wrap(server.tools.queryProposals),
  );

  mcp.registerTool(
    'fetch_calibration_batch',
    {
      description: 'Fetch calibration items for a sub-topic (review-batch shape).',
      inputSchema: FetchCalibrationBatchInput.shape,
      outputSchema: FetchCalibrationBatchOutput.shape,
    },
    wrap(server.tools.fetchCalibrationBatch),
  );

  mcp.registerTool(
    'query_reputation',
    {
      description: "Read the caller's per-sub-topic reputation scores in a cause.",
      inputSchema: QueryReputationInput.shape,
      outputSchema: QueryReputationOutput.shape,
    },
    wrap(server.tools.queryReputation),
  );

  // ── Read-path resources ─────────────────────────────────────────
  // PRD §Read-path tools and resources commits four MCP resources as
  // the passive browsing surface — `cause://`, `sub-topic://{id}`,
  // `node://{id}`, `subgraph://{sub-topic-id}`. The handlers live on
  // `server.resources.*`; this is the wire-side registration.
  //
  // Each resource returns a single `text/json` content block (the
  // structured payload JSON-stringified) with the resolved URI in the
  // `uri` field. Errors surface as McpError: ServerError('not_found')
  // becomes InvalidParams (the URI variable did not resolve), and the
  // typed PRD error code rides along in the McpError `data` field so
  // clients can pattern-match exactly as they do on tool error
  // payloads. Anything other than ServerError bubbles up as a
  // protocol-level InternalError — the same posture wrap() takes for
  // unexpected throws in the tool path.

  function resourceError(err: unknown): never {
    if (err instanceof ServerError) {
      const jsonRpcCode =
        err.code === 'not_found' || err.code === 'invalid_input'
          ? ErrorCode.InvalidParams
          : ErrorCode.InternalError;
      throw new McpError(jsonRpcCode, err.message, { code: err.code });
    }
    throw err;
  }

  function jsonResource(uri: string, payload: unknown): ReadResourceResult {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(payload),
        },
      ],
    };
  }

  // cause:// — static URI, list of active causes + their active sub-topics.
  mcp.registerResource(
    'cause-directory',
    'cause://',
    {
      description: 'List of active causes with their active sub-topics.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      try {
        const result = await server.resources.getCauseDirectory(caller);
        return jsonResource(uri.toString(), result);
      } catch (err) {
        resourceError(err);
      }
    },
  );

  // sub-topic://{id} — sub-topic detail + activity counters.
  mcp.registerResource(
    'sub-topic-detail',
    new ResourceTemplate('sub-topic://{id}', { list: undefined }),
    {
      description: 'Sub-topic metadata, status, scope query, and recent activity counters.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      try {
        const id = SubTopicId.parse(String(variables['id']));
        const result = await server.resources.getSubTopicDetail(caller, id);
        return jsonResource(uri.toString(), result);
      } catch (err) {
        resourceError(err);
      }
    },
  );

  // node://{id} — node + immediate active neighbors.
  mcp.registerResource(
    'node-neighborhood',
    new ResourceTemplate('node://{id}', { list: undefined }),
    {
      description: 'A node plus its immediate active edge neighborhood.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      try {
        const id = NodeId.parse(String(variables['id']));
        const result = await server.resources.getNodeNeighborhood(caller, id);
        return jsonResource(uri.toString(), result);
      } catch (err) {
        resourceError(err);
      }
    },
  );

  // subgraph://{sub-topic-id} — active nodes + edges scoped to a sub-topic.
  mcp.registerResource(
    'subgraph',
    new ResourceTemplate('subgraph://{sub_topic_id}', { list: undefined }),
    {
      description: 'Active nodes and edges scoped to (or referencing) a sub-topic.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      try {
        const id = SubTopicId.parse(String(variables['sub_topic_id']));
        const result = await server.resources.getSubgraph(caller, id);
        return jsonResource(uri.toString(), result);
      } catch (err) {
        resourceError(err);
      }
    },
  );

  // manuscript://{sub-topic-id} — outline + cited claims + credited
  // contributors. PRD §Manuscript projection (slice 6a). The
  // projection is a deterministic function of the active subgraph
  // plus the per-(cause, sub-topic) credit weights on
  // `ReviewConfig` — no separate projection-config graph record yet
  // (the versioned-config-as-governance-artifact path that PRD
  // §Manuscript projection commits is a later slice).
  mcp.registerResource(
    'manuscript',
    new ResourceTemplate('manuscript://{sub_topic_id}', { list: undefined }),
    {
      description:
        'Manuscript projection of a sub-topic: outline (sources, quotations, synthesis, open questions) + credited contributors.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      try {
        const id = SubTopicId.parse(String(variables['sub_topic_id']));
        const result = await server.resources.getManuscript(caller, id);
        return jsonResource(uri.toString(), result);
      } catch (err) {
        resourceError(err);
      }
    },
  );

  // contributor://{id} — public contributor profile + tier projection.
  // The anonymous-browse-safe read-other-contributor surface (slice
  // 5c). PRD §Reputation: "Eligibility tiers public; numeric
  // reputation private" — the response carries `PublicContributor`
  // (id, display_name, created_at, status) and a per-(cause,
  // sub-topic) tier label, never the raw demonstrated/recent
  // numbers (those flow through `query_reputation` to the
  // contributor's *own* caller).
  mcp.registerResource(
    'contributor',
    new ResourceTemplate('contributor://{id}', { list: undefined }),
    {
      description:
        'Public contributor profile: display fields + per-(cause, sub-topic) eligibility-tier projection (no raw reputation numbers).',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      try {
        const id = IdentityId.parse(String(variables['id']));
        const result = await server.resources.getContributorProfile(caller, id);
        return jsonResource(uri.toString(), result);
      } catch (err) {
        resourceError(err);
      }
    },
  );

  return mcp;
}
