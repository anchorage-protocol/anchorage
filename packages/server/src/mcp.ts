import {
  AcceptAssignmentInput,
  AcceptAssignmentOutput,
  CastReviewVoteInput,
  CastReviewVoteOutput,
  DeclineAssignmentInput,
  DeclineAssignmentOutput,
  FetchCalibrationBatchInput,
  FetchCalibrationBatchOutput,
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
  SubmitAssignedProposalInput,
  SubmitAssignedProposalOutput,
} from '@anchorage/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Caller } from './auth.js';
import { ServerError } from './errors.js';
import type { Server } from './server.js';

// One MCP server instance corresponds to one client connection
// (the SDK's stdio + in-memory transports are one-to-one with the
// process / harness instance), so the caller binding is per-instance.
// For multi-tenant deployments (HTTP transport) the binding would
// move into per-request context, but the same handler shape applies.
//
// Errors:
//   - ServerError → returned as a tool error result (PRD's typed error
//     codes survive into the wire response, so testbed adversaries
//     pattern-match on `code` exactly as they do against the
//     in-process server).
//   - Anything else → thrown (transport-level fault); MCP turns it
//     into a generic protocol error and the connection stays open.
export interface McpBuildOptions {
  caller: Caller;
  serverInfo?: { name?: string; version?: string };
}

export function buildMcpServer(server: Server, options: McpBuildOptions): McpServer {
  const { caller } = options;
  const mcp = new McpServer({
    name: options.serverInfo?.name ?? 'anchorage',
    version: options.serverInfo?.version ?? PROTOCOL_VERSION,
  });

  // Wrap a Server.tools.* method into an MCP tool callback. Wraps
  // ServerError into a tool error result; lets other throws bubble
  // up as protocol errors. Both successful results and errors return
  // structuredContent for clients that prefer the typed shape, plus
  // a JSON-stringified text fallback.
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
            structuredContent: payload,
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

  mcp.registerTool(
    'submit_assigned_proposal',
    {
      description: 'Fulfill an accepted propose-kind assignment.',
      inputSchema: SubmitAssignedProposalInput.shape,
      outputSchema: SubmitAssignedProposalOutput.shape,
    },
    wrap(server.tools.submitAssignedProposal),
  );

  // ── Contributor-initiated proposals ─────────────────────────────
  mcp.registerTool(
    'propose_anchor',
    {
      description: 'Stage an anchor proposal (PMID/DOI/URL must resolve).',
      inputSchema: ProposeAnchorInput.shape,
      outputSchema: ProposeAnchorOutput.shape,
    },
    wrap(server.tools.proposeAnchor),
  );

  mcp.registerTool(
    'propose_excerpt',
    {
      description: 'Stage an excerpt proposal under an active anchor parent.',
      inputSchema: ProposeExcerptInput.shape,
      outputSchema: ProposeExcerptOutput.shape,
    },
    wrap(server.tools.proposeExcerpt),
  );

  mcp.registerTool(
    'propose_synthesis',
    {
      description: 'Stage a synthesis or open_question over multiple parents.',
      inputSchema: ProposeSynthesisInput.shape,
      outputSchema: ProposeSynthesisOutput.shape,
    },
    wrap(server.tools.proposeSynthesis),
  );

  mcp.registerTool(
    'propose_supersedes',
    {
      description: 'Stage a supersedes edge between two active nodes.',
      inputSchema: ProposeSupersedesInput.shape,
      outputSchema: ProposeSupersedesOutput.shape,
    },
    wrap(server.tools.proposeSupersedes),
  );

  mcp.registerTool(
    'propose_membership',
    {
      description: 'Stage a scope-membership claim for an existing node.',
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

  return mcp;
}
