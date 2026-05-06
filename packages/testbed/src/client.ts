import {
  AcceptAssignmentOutput,
  type AssignmentId,
  CastReviewVoteOutput,
  type CauseId,
  DeclineAssignmentOutput,
  FetchCalibrationBatchOutput,
  type NodeId,
  ProposeAnchorOutput,
  ProposeChangeOfHomeOutput,
  ProposeExcerptOutput,
  ProposeMembershipOutput,
  ProposeSubTopicOutput,
  ProposeSupersedesOutput,
  ProposeSynthesisOutput,
  QueryFrontierOutput,
  QueryProposalsOutput,
  RequestAssignmentOutput,
  type ReviewDecision,
  type ServerErrorCode,
  SetCapacityOutput,
  type SubTopicId,
  SubmitAssignedProposalOutput,
  type ToolName,
  type WorkKind,
} from '@anchorage/contracts';
import type { ExternalRef, ProposalPayload, QuotedSpan } from '@anchorage/contracts';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ZodTypeAny, z } from 'zod';

// Typed error surfaced by AnchorageClient when the server returned a
// ServerError tool error result. The PRD-defined `code` field is the
// stable handle archetypes pattern-match on (e.g. an honest archetype
// stops after `not_found` from request_assignment because the
// frontier is empty; an adversary archetype probes for `unauthorized`
// to map permission boundaries).
export class AnchorageClientError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    readonly tool: ToolName,
    message: string,
  ) {
    super(`[${tool}] ${code}: ${message}`);
    this.name = 'AnchorageClientError';
  }
}

// Type guards for parsing the server's tool error payload back into
// a typed code without smuggling `any` through.
function isServerErrorCode(s: unknown): s is ServerErrorCode {
  return (
    s === 'not_found' || s === 'invalid_state' || s === 'invalid_input' || s === 'unauthorized'
  );
}

// AnchorageClient — a typed wrapper around an MCP client connected to
// an Anchorage server. Each method corresponds to one entry in the
// PRD's MCP tool surface; inputs and outputs are the contracts'
// types. The wrapper exists so archetypes don't have to manually
// shape tool calls and parse structuredContent — they can read like
// the in-process Server.tools.* methods, just over the wire.
//
// This client is the *only* surface the testbed has to the server.
// By construction it cannot reach into server internals (the testbed
// package's tsconfig and package.json both enforce this), so any
// behavior the harness depends on must be observable through tools.
export class AnchorageClient {
  constructor(private readonly client: Client) {}

  async setCapacity(input: {
    cause_id: CauseId;
    rate: number;
    kinds: WorkKind[];
  }): Promise<SetCapacityOutput> {
    return this.call('set_capacity', input, SetCapacityOutput);
  }

  async requestAssignment(input: {
    cause_id: CauseId;
    kind?: WorkKind;
  }): Promise<RequestAssignmentOutput> {
    return this.call('request_assignment', input, RequestAssignmentOutput);
  }

  async acceptAssignment(input: { assignment_id: AssignmentId }): Promise<AcceptAssignmentOutput> {
    return this.call('accept_assignment', input, AcceptAssignmentOutput);
  }

  async declineAssignment(input: {
    assignment_id: AssignmentId;
    reason: string;
  }): Promise<DeclineAssignmentOutput> {
    return this.call('decline_assignment', input, DeclineAssignmentOutput);
  }

  async submitAssignedProposal(input: {
    assignment_id: AssignmentId;
    payload: ProposalPayload;
  }): Promise<SubmitAssignedProposalOutput> {
    return this.call('submit_assigned_proposal', input, SubmitAssignedProposalOutput);
  }

  async proposeAnchor(input: {
    cause_id: CauseId;
    home_sub_topic_id: SubTopicId;
    memberships?: SubTopicId[];
    content: string;
    external_ref: ExternalRef;
  }): Promise<ProposeAnchorOutput> {
    return this.call('propose_anchor', input, ProposeAnchorOutput);
  }

  async proposeExcerpt(input: {
    cause_id: CauseId;
    home_sub_topic_id: SubTopicId;
    memberships?: SubTopicId[];
    parent_anchor_id: NodeId;
    content: string;
    quoted_span: QuotedSpan;
  }): Promise<ProposeExcerptOutput> {
    return this.call('propose_excerpt', input, ProposeExcerptOutput);
  }

  async proposeSynthesis(input: {
    cause_id: CauseId;
    home_sub_topic_id: SubTopicId;
    memberships?: SubTopicId[];
    parent_ids: NodeId[];
    content: string;
    kind: 'synthesis' | 'open_question';
  }): Promise<ProposeSynthesisOutput> {
    return this.call('propose_synthesis', input, ProposeSynthesisOutput);
  }

  async proposeSupersedes(input: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    rationale: string;
  }): Promise<ProposeSupersedesOutput> {
    return this.call('propose_supersedes', input, ProposeSupersedesOutput);
  }

  async proposeMembership(input: {
    node_id: NodeId;
    sub_topic_id: SubTopicId;
  }): Promise<ProposeMembershipOutput> {
    return this.call('propose_membership', input, ProposeMembershipOutput);
  }

  async proposeChangeOfHome(input: {
    node_id: NodeId;
    new_home_sub_topic_id: SubTopicId;
    rationale: string;
  }): Promise<ProposeChangeOfHomeOutput> {
    return this.call('propose_change_of_home', input, ProposeChangeOfHomeOutput);
  }

  async proposeSubTopic(input: {
    cause_id: CauseId;
    name: string;
    description: string;
    scope_query: string;
  }): Promise<ProposeSubTopicOutput> {
    return this.call('propose_sub_topic', input, ProposeSubTopicOutput);
  }

  async castReviewVote(input: {
    proposal_id: string;
    decision: ReviewDecision;
    rationale: string;
    assignment_id?: AssignmentId;
  }): Promise<CastReviewVoteOutput> {
    return this.call('cast_review_vote', input, CastReviewVoteOutput);
  }

  async queryFrontier(input: {
    cause_id?: CauseId;
    sub_topic_id?: SubTopicId;
    frontier_kind?: 'orphan_anchor' | 'needs_synthesis' | 'needs_review' | 'unresolvable_anchor';
  }): Promise<QueryFrontierOutput> {
    return this.call('query_frontier', input, QueryFrontierOutput);
  }

  async queryProposals(input: {
    status?: 'staged' | 'accepted' | 'rejected' | 'unresolved-archived';
    sub_topic_id?: SubTopicId;
    assigned_to_me?: boolean;
  }): Promise<QueryProposalsOutput> {
    return this.call('query_proposals', input, QueryProposalsOutput);
  }

  async fetchCalibrationBatch(input: {
    sub_topic_id: SubTopicId;
  }): Promise<FetchCalibrationBatchOutput> {
    return this.call('fetch_calibration_batch', input, FetchCalibrationBatchOutput);
  }

  // The single point at which we shape an MCP callTool round-trip
  // into a typed result. Two failure modes:
  //   - The tool returned `isError: true` with our typed code/message
  //     payload → throw AnchorageClientError carrying the typed code.
  //   - The tool returned a result that doesn't parse against the
  //     output schema → throw a generic Error (this is a contract
  //     drift, not a runtime decision the archetype makes).
  private async call<S extends ZodTypeAny>(
    tool: ToolName,
    args: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    const result = await this.client.callTool({ name: tool, arguments: args });
    if (result.isError) {
      const sc = (result.structuredContent ?? {}) as { code?: unknown; message?: unknown };
      const code = isServerErrorCode(sc.code) ? sc.code : 'invalid_state';
      const message = typeof sc.message === 'string' ? sc.message : 'unspecified server error';
      throw new AnchorageClientError(code, tool, message);
    }
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new Error(`[${tool}] response did not parse against output schema: ${parsed.error}`);
    }
    return parsed.data;
  }
}
