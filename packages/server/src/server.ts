import {
  type AgentCredential,
  type AnchorNode,
  type Capacity,
  CastReviewVoteInput,
  type CastReviewVoteOutput,
  type Cause,
  type CauseId,
  type DerivesEdge,
  type Edge,
  type ExcerptNode,
  type FrontierItem,
  type Identity,
  type IdentityId,
  type Node,
  type NodeId,
  type OpenQuestionNode,
  type Proposal,
  type ProposalId,
  ProposeAnchorInput,
  type ProposeAnchorOutput,
  ProposeChangeOfHomeInput,
  type ProposeChangeOfHomeOutput,
  ProposeExcerptInput,
  type ProposeExcerptOutput,
  ProposeMembershipInput,
  type ProposeMembershipOutput,
  ProposeSubTopicInput,
  type ProposeSubTopicOutput,
  ProposeSupersedesInput,
  type ProposeSupersedesOutput,
  ProposeSynthesisInput,
  type ProposeSynthesisOutput,
  QueryFrontierInput,
  type QueryFrontierOutput,
  QueryProposalsInput,
  type QueryProposalsOutput,
  type ReviewVote,
  SetCapacityInput,
  type SetCapacityOutput,
  type SubTopic,
  type SubTopicId,
  type SupersedesEdge,
  type SynthesisNode,
} from '@anchorage/contracts';
import { z } from 'zod';
import { type Caller, resolveCaller } from './auth.js';
import { type Clock, SystemClock } from './clock.js';
import { ServerError } from './errors.js';
import { type IdGen, RandomIdGen } from './id-gen.js';
import { MemoryStore } from './store.js';
import { StructuralVerifier, type Verifier } from './verifier.js';

// Bootstrap input schemas. These are admin-surface inputs and are
// deliberately separate from the contributor-facing MCP tool I/O in
// `@anchorage/contracts/tools.ts` — see PRD §Service surfaces (admin
// surface vs MCP tool surface).
const MintIdentityInput = z.object({ display_name: z.string().min(1).max(100) }).strict();
type MintIdentityInput = z.infer<typeof MintIdentityInput>;

const BindAgentCredentialInput = z
  .object({
    identity_id: z.string().min(1),
    label: z.string().min(1).max(100),
  })
  .strict();
type BindAgentCredentialInput = z.infer<typeof BindAgentCredentialInput>;

const CreateCauseInput = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(1),
  })
  .strict();
type CreateCauseInput = z.infer<typeof CreateCauseInput>;

const SeedSubTopicInput = z
  .object({
    cause_id: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().min(1),
    scope_query: z.string().min(1),
  })
  .strict();
type SeedSubTopicInput = z.infer<typeof SeedSubTopicInput>;

export interface ServerDeps {
  clock?: Clock;
  idGen?: IdGen;
  store?: MemoryStore;
  verifier?: Verifier;
}

interface MaterializationResult {
  node: Node | null;
  edges: readonly Edge[];
  nodeUpdates: readonly Node[];
  subTopicCreates: readonly SubTopic[];
}

// Stable tiebreaker for frontier ordering when priorities tie. Each
// kind carries a different id-bearing field; we project onto a single
// string for deterministic sort.
function frontierTiebreakerKey(item: FrontierItem): string {
  switch (item.kind) {
    case 'orphan_anchor':
    case 'unresolvable_anchor':
      return `${item.kind}:${item.anchor_id}`;
    case 'needs_review':
      return `${item.kind}:${item.proposal_id}`;
    case 'needs_synthesis':
      return `${item.kind}:${item.parent_ids.join(',')}`;
  }
}

// Server is the trust boundary. All mutation goes through it. The
// `bootstrap` namespace holds curator/admin operations not exposed as
// MCP tools (cause creation, sub-topic seeding, identity issuance);
// the `tools` namespace holds the contributor-facing MCP tools, added
// incrementally and 1-to-1 with the I/O contracts in
// @anchorage/contracts/tools.
export class Server {
  readonly clock: Clock;
  readonly idGen: IdGen;
  readonly store: MemoryStore;
  readonly verifier: Verifier;

  constructor(deps: ServerDeps = {}) {
    this.clock = deps.clock ?? new SystemClock();
    this.idGen = deps.idGen ?? new RandomIdGen();
    this.store = deps.store ?? new MemoryStore();
    this.verifier = deps.verifier ?? new StructuralVerifier();
  }

  // Resolve a sub-topic that must exist, be active, and live under the
  // expected cause. Used by every tool that takes a sub-topic id, so
  // it lives on the Server rather than each tool re-implementing it.
  private requireActiveSubTopicInCause(
    subTopicId: SubTopicId,
    causeId: CauseId,
    label: string,
  ): SubTopic {
    const st = this.store.subTopics.get(subTopicId);
    if (!st) {
      throw new ServerError('not_found', `${label} sub-topic not found: ${subTopicId}`);
    }
    if (st.cause_id !== causeId) {
      throw new ServerError(
        'invalid_input',
        `${label} sub-topic ${subTopicId} does not belong to cause ${causeId}`,
      );
    }
    if (st.status !== 'active') {
      throw new ServerError('invalid_state', `${label} sub-topic is ${st.status}`);
    }
    return st;
  }

  private requireActiveCause(causeId: CauseId): Cause {
    const cause = this.store.causes.get(causeId);
    if (!cause) {
      throw new ServerError('not_found', `cause not found: ${causeId}`);
    }
    if (cause.status !== 'active') {
      throw new ServerError('invalid_state', `cause is ${cause.status}`);
    }
    return cause;
  }

  // Resolve an active node that lives in the given cause. The cause
  // check follows the node through its home sub-topic, since nodes
  // don't carry a cause_id directly — they're partitioned across sub-
  // topics, and sub-topics belong to a cause.
  private requireActiveNodeInCause(nodeId: NodeId, causeId: CauseId): Node {
    const node = this.store.nodes.get(nodeId);
    if (!node) {
      throw new ServerError('not_found', `node not found: ${nodeId}`);
    }
    if (node.status !== 'active') {
      throw new ServerError('invalid_state', `node ${nodeId} is ${node.status}`);
    }
    const home = this.store.subTopics.get(node.home_sub_topic_id);
    if (!home || home.cause_id !== causeId) {
      throw new ServerError('invalid_input', `node ${nodeId} does not belong to cause ${causeId}`);
    }
    return node;
  }

  private requireActiveAnchorInCause(nodeId: NodeId, causeId: CauseId): AnchorNode {
    const node = this.requireActiveNodeInCause(nodeId, causeId);
    if (node.kind !== 'anchor') {
      throw new ServerError('invalid_input', `node ${nodeId} is not an anchor`);
    }
    return node;
  }

  // The cause an existing node lives under, found via its home sub-topic.
  // Used by tools that take node ids without a redundant cause_id (PRD's
  // `propose_supersedes`, `propose_membership`, `propose_change_of_home`):
  // the cause is implicit in the node, and re-passing it would create a
  // surface for inconsistency.
  private causeOfNode(node: Node): CauseId {
    const home = this.store.subTopics.get(node.home_sub_topic_id);
    if (!home) {
      throw new ServerError(
        'invalid_state',
        `node ${node.id} home sub-topic ${node.home_sub_topic_id} not found`,
      );
    }
    return home.cause_id;
  }

  // Derive frontier items from current graph state. Frontier items
  // are *not* stored — they are projections over the existing nodes,
  // edges, and proposals. This keeps the frontier consistent with the
  // graph by construction: a state change that closes a gap (an
  // excerpt landing on an orphan anchor; a review vote arriving on a
  // staged proposal) makes the frontier item disappear on the next
  // call without bookkeeping. Used by `query_frontier` today and by
  // `request_assignment` when that lands.
  //
  // v0 covers three of the four FrontierKind variants:
  //
  //   - `orphan_anchor`         — active anchor with no active derives
  //                               child edge.
  //   - `unresolvable_anchor`   — anchor whose status is unresolvable
  //                               (PRD §Verification engine).
  //   - `needs_review`          — proposal in `staged` status whose
  //                               kind admits review-pool review.
  //                               Curator-only kinds (`sub_topic`,
  //                               `change_of_home`) are excluded.
  //
  // `needs_synthesis` is deferred — there is no testbed-validated
  // heuristic for "a synthesis would close a visible gap" yet, and
  // shipping a guess would just bias the simulator. v1 introduces it
  // alongside the closure-distance metric.
  //
  // Priorities are coarse v0 hints, not contracts about scale: review
  // queue clearing is highest, broken sources next, productive-but-
  // not-blocking orphans lowest. Real ordering is testbed-tuned and
  // lives in the assignment-selection layer, not here.
  private deriveFrontier(filters: {
    cause_id?: CauseId;
    sub_topic_id?: SubTopicId;
    frontier_kind?: FrontierItem['kind'];
  }): FrontierItem[] {
    const items: FrontierItem[] = [];

    // Build the set of node ids that are the `from` end of an active
    // derives edge — used to identify orphan anchors. Membership in
    // this set means at least one excerpt has landed.
    const hasDerivesChild = new Set<NodeId>();
    for (const e of this.store.edges.values()) {
      if (e.kind === 'derives' && e.status === 'active') {
        hasDerivesChild.add(e.from);
      }
    }

    for (const node of this.store.nodes.values()) {
      if (node.kind !== 'anchor') continue;
      const home = this.store.subTopics.get(node.home_sub_topic_id);
      if (!home) continue;
      if (node.status === 'active' && !hasDerivesChild.has(node.id)) {
        items.push({
          kind: 'orphan_anchor',
          cause_id: home.cause_id,
          sub_topic_id: node.home_sub_topic_id,
          anchor_id: node.id,
          priority: 5,
        });
      } else if (node.status === 'unresolvable') {
        items.push({
          kind: 'unresolvable_anchor',
          cause_id: home.cause_id,
          sub_topic_id: node.home_sub_topic_id,
          anchor_id: node.id,
          priority: 8,
        });
      }
    }

    for (const p of this.store.proposals.values()) {
      if (p.status !== 'staged') continue;
      const located = this.locateProposalForReview(p);
      if (!located) continue;
      items.push({
        kind: 'needs_review',
        cause_id: located.cause_id,
        sub_topic_id: located.sub_topic_id,
        proposal_id: p.id,
        priority: 10,
      });
    }

    const filtered = items.filter((it) => {
      if (filters.cause_id && it.cause_id !== filters.cause_id) return false;
      if (filters.sub_topic_id && it.sub_topic_id !== filters.sub_topic_id) return false;
      if (filters.frontier_kind && it.kind !== filters.frontier_kind) return false;
      return true;
    });

    // Stable order: priority descending, then ids alphabetical for
    // determinism. The testbed depends on stable ordering for replay
    // — randomness in selection lives at the assignment layer, not
    // the frontier query.
    filtered.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return frontierTiebreakerKey(a).localeCompare(frontierTiebreakerKey(b));
    });
    return filtered;
  }

  // Locate the (cause, sub-topic) for review-routing of a staged
  // proposal. Curator-only kinds (`sub_topic`, `change_of_home`)
  // return null — they are not surfaced to the reviewer pool.
  // Membership routes to the *target* sub-topic per PRD line 130.
  // Supersedes routes to the from-node's home (the home owns the node
  // being deactivated).
  private locateProposalForReview(
    p: Proposal,
  ): { cause_id: CauseId; sub_topic_id: SubTopicId } | null {
    switch (p.payload.kind) {
      case 'anchor':
      case 'excerpt':
      case 'synthesis':
      case 'open_question':
        return { cause_id: p.payload.cause_id, sub_topic_id: p.payload.home_sub_topic_id };
      case 'membership': {
        const target = this.store.subTopics.get(p.payload.sub_topic_id);
        if (!target) return null;
        return { cause_id: target.cause_id, sub_topic_id: p.payload.sub_topic_id };
      }
      case 'supersedes': {
        const fromNode = this.store.nodes.get(p.payload.from_node_id);
        if (!fromNode) return null;
        const home = this.store.subTopics.get(fromNode.home_sub_topic_id);
        if (!home) return null;
        return { cause_id: home.cause_id, sub_topic_id: fromNode.home_sub_topic_id };
      }
      case 'sub_topic':
      case 'change_of_home':
        return null;
    }
  }

  // Reject supersedes cycles (PRD §Edges: "Supersedes cycles A→B→C→A are
  // forbidden by the verification engine"). We walk the existing active
  // supersedes edges starting from the proposed `to` end and look for the
  // proposed `from` end. If the new edge would close a cycle, reject.
  // Linear in the number of supersedes edges; fine for an in-memory store
  // and the load profile of a single MCP server. When edges move to a
  // proper store the structure can be precomputed.
  private supersedesWouldCycle(fromId: NodeId, toId: NodeId): boolean {
    if (fromId === toId) return true;
    const successors = new Map<NodeId, NodeId[]>();
    for (const e of this.store.edges.values()) {
      if (e.kind !== 'supersedes' || e.status !== 'active') continue;
      const list = successors.get(e.from) ?? [];
      list.push(e.to);
      successors.set(e.from, list);
    }
    const seen = new Set<NodeId>();
    const stack: NodeId[] = [toId];
    while (stack.length > 0) {
      const cur = stack.pop() as NodeId;
      if (cur === fromId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = successors.get(cur);
      if (next) stack.push(...next);
    }
    return false;
  }

  readonly bootstrap = {
    mintIdentity: (input: MintIdentityInput): Identity => {
      const parsed = MintIdentityInput.parse(input);
      const identity: Identity = {
        id: this.idGen.identityId(),
        display_name: parsed.display_name,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.identities.set(identity.id, identity);
      return identity;
    },

    bindAgentCredential: (input: BindAgentCredentialInput): AgentCredential => {
      const parsed = BindAgentCredentialInput.parse(input);
      const identityId = parsed.identity_id as IdentityId;
      const identity = this.store.identities.get(identityId);
      if (!identity) {
        throw new ServerError('not_found', `identity not found: ${parsed.identity_id}`);
      }
      if (identity.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `cannot bind credential to ${identity.status} identity`,
        );
      }
      const credential: AgentCredential = {
        id: this.idGen.agentCredentialId(),
        identity_id: identity.id,
        label: parsed.label,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.agentCredentials.set(credential.id, credential);
      return credential;
    },

    createCause: (input: CreateCauseInput): Cause => {
      const parsed = CreateCauseInput.parse(input);
      const cause: Cause = {
        id: this.idGen.causeId(),
        name: parsed.name,
        description: parsed.description,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.causes.set(cause.id, cause);
      return cause;
    },

    // Curator-seeded sub-topics start `active`; contributor-proposed
    // sub-topics (via the future `propose_sub_topic` tool) start
    // `proposed` and need curator approval to activate. PRD §Sub-topic
    // creation governance.
    seedSubTopic: (input: SeedSubTopicInput): SubTopic => {
      const parsed = SeedSubTopicInput.parse(input);
      const causeId = parsed.cause_id as CauseId;
      const cause = this.store.causes.get(causeId);
      if (!cause) {
        throw new ServerError('not_found', `cause not found: ${parsed.cause_id}`);
      }
      if (cause.status !== 'active') {
        throw new ServerError('invalid_state', `cannot seed sub-topic under ${cause.status} cause`);
      }
      const subTopic: SubTopic = {
        id: this.idGen.subTopicId(),
        cause_id: cause.id,
        name: parsed.name,
        description: parsed.description,
        scope_query: parsed.scope_query,
        status: 'active',
        created_at: this.clock.now(),
      };
      this.store.subTopics.set(subTopic.id, subTopic);
      return subTopic;
    },
  };

  readonly tools = {
    // PRD §Capacity and assignment line 110: set_capacity declares the
    // contributor's availability at the cause level — a maximum rate
    // (a cap, not a schedule) and which kinds of work they will accept.
    // Sub-topic granularity is deliberately not allowed; it would
    // reopen the rep-laundering vector by letting contributors cherry-
    // pick easy sub-topics. Idempotent under (identity, cause): calling
    // set_capacity again replaces the existing declaration. Capacity
    // is the only way the system learns availability — without one
    // the contributor receives no assignments.
    setCapacity: async (caller: Caller, input: SetCapacityInput): Promise<SetCapacityOutput> => {
      const parsed = SetCapacityInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireActiveCause(parsed.cause_id);
      // De-duplicate kinds at the boundary: the schema has min(1) but
      // doesn't enforce uniqueness. A contributor declaring `[review,
      // review]` is almost certainly a client bug; coalescing keeps
      // downstream selection logic from having to special-case it.
      const kinds = [...new Set(parsed.kinds)];
      const now = this.clock.now();
      const capacity: Capacity = {
        identity_id: identity.id,
        cause_id: parsed.cause_id,
        rate: parsed.rate,
        kinds,
        updated_at: now,
      };
      this.store.capacities.set(`${identity.id}|${parsed.cause_id}`, capacity);
      return { ok: true };
    },

    // PRD §Write-path tools: propose_anchor stages an anchor proposal.
    // Synchronous verification at the tool boundary: external_ref must
    // resolve. If verification fails, no proposal record is created
    // (ProposalStatus comment: `rejected` means review-rejected, not
    // verification-rejected).
    proposeAnchor: async (
      caller: Caller,
      input: ProposeAnchorInput,
    ): Promise<ProposeAnchorOutput> => {
      const parsed = ProposeAnchorInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const cause = this.requireActiveCause(parsed.cause_id);
      this.requireActiveSubTopicInCause(parsed.home_sub_topic_id, cause.id, 'home');
      const memberships = parsed.memberships ?? [];
      for (const m of memberships) {
        this.requireActiveSubTopicInCause(m, cause.id, 'membership');
      }

      const verified = await this.verifier.verifyExternalRef(parsed.external_ref);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'anchor',
          cause_id: cause.id,
          home_sub_topic_id: parsed.home_sub_topic_id,
          ...(memberships.length > 0 ? { memberships } : {}),
          content: parsed.content,
          external_ref: parsed.external_ref,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      this.store.verifiedRefs.set(proposal.id, verified);
      return { proposal_id: proposal.id };
    },

    // PRD §Write-path tools: propose_excerpt stages an excerpt
    // proposal under an existing accepted anchor. Span-against-source
    // verification is structural-only here — the schema enforces non-
    // empty `text` and non-negative `offset`. Real fetch+match against
    // the parent anchor's source content waits for the verification
    // engine. Until then, the parent must already be an active node,
    // which is the strictest check we can do without I/O.
    proposeExcerpt: async (
      caller: Caller,
      input: ProposeExcerptInput,
    ): Promise<ProposeExcerptOutput> => {
      const parsed = ProposeExcerptInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const cause = this.requireActiveCause(parsed.cause_id);
      this.requireActiveSubTopicInCause(parsed.home_sub_topic_id, cause.id, 'home');
      const memberships = parsed.memberships ?? [];
      for (const m of memberships) {
        this.requireActiveSubTopicInCause(m, cause.id, 'membership');
      }
      this.requireActiveAnchorInCause(parsed.parent_anchor_id, cause.id);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'excerpt',
          cause_id: cause.id,
          home_sub_topic_id: parsed.home_sub_topic_id,
          ...(memberships.length > 0 ? { memberships } : {}),
          parent_anchor_id: parsed.parent_anchor_id,
          content: parsed.content,
          quoted_span: parsed.quoted_span,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Write-path tools: propose_synthesis covers both `synthesis`
    // and `open_question` via a `kind` field on the input. Internally
    // the contracts split them into separate payloads (cleaner
    // discriminator); this tool routes the input into the right
    // payload variant. Parents may be any active node kind in the
    // same cause — anchors, excerpts, prior syntheses, or open
    // questions — because syntheses pull together evidence across
    // node kinds (PRD §Nodes: synthesis nodes connect 2+ parents).
    proposeSynthesis: async (
      caller: Caller,
      input: ProposeSynthesisInput,
    ): Promise<ProposeSynthesisOutput> => {
      const parsed = ProposeSynthesisInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const cause = this.requireActiveCause(parsed.cause_id);
      this.requireActiveSubTopicInCause(parsed.home_sub_topic_id, cause.id, 'home');
      const memberships = parsed.memberships ?? [];
      for (const m of memberships) {
        this.requireActiveSubTopicInCause(m, cause.id, 'membership');
      }
      // De-duplicate parents at the tool boundary — multiple derives
      // edges between the same pair of nodes would be redundant and
      // would pollute future frontier/credit calculations. The schema
      // requires min(1) but doesn't enforce uniqueness.
      const parent_ids = [...new Set(parsed.parent_ids)];
      if (parent_ids.length !== parsed.parent_ids.length) {
        throw new ServerError('invalid_input', 'parent_ids must be unique');
      }
      for (const p of parent_ids) {
        this.requireActiveNodeInCause(p, cause.id);
      }

      const now = this.clock.now();
      const common = {
        cause_id: cause.id,
        home_sub_topic_id: parsed.home_sub_topic_id,
        ...(memberships.length > 0 ? { memberships } : {}),
        parent_ids,
        content: parsed.content,
      };
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload:
          parsed.kind === 'synthesis'
            ? { kind: 'synthesis', ...common }
            : { kind: 'open_question', ...common },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Write-path tools: propose_supersedes stages a supersedes edge
    // from an old node to its replacement. Unlike the other propose_*
    // tools the input doesn't carry a cause_id — the cause is implicit
    // in the nodes, and re-passing it would just create a surface for
    // inconsistency. Both nodes must be active (PRD §Edges line 74:
    // "the `to` end must be active at proposal time"; we additionally
    // require the `from` end to be active because superseding an
    // already-superseded node is meaningless). Cycle prevention runs
    // here so contributors get a synchronous error rather than a delayed
    // acceptance failure.
    proposeSupersedes: async (
      caller: Caller,
      input: ProposeSupersedesInput,
    ): Promise<ProposeSupersedesOutput> => {
      const parsed = ProposeSupersedesInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      if (parsed.from_node_id === parsed.to_node_id) {
        throw new ServerError('invalid_input', 'from_node_id and to_node_id must differ');
      }

      const fromNode = this.store.nodes.get(parsed.from_node_id);
      if (!fromNode) {
        throw new ServerError('not_found', `from node not found: ${parsed.from_node_id}`);
      }
      if (fromNode.status !== 'active') {
        throw new ServerError('invalid_state', `from node ${fromNode.id} is ${fromNode.status}`);
      }
      const toNode = this.store.nodes.get(parsed.to_node_id);
      if (!toNode) {
        throw new ServerError('not_found', `to node not found: ${parsed.to_node_id}`);
      }
      if (toNode.status !== 'active') {
        throw new ServerError('invalid_state', `to node ${toNode.id} is ${toNode.status}`);
      }

      const fromCause = this.causeOfNode(fromNode);
      const toCause = this.causeOfNode(toNode);
      if (fromCause !== toCause) {
        throw new ServerError(
          'invalid_input',
          `supersedes endpoints belong to different causes (${fromCause} vs ${toCause})`,
        );
      }

      if (this.supersedesWouldCycle(fromNode.id, toNode.id)) {
        throw new ServerError(
          'invalid_input',
          `supersedes from ${fromNode.id} to ${toNode.id} would create a cycle`,
        );
      }

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'supersedes',
          from_node_id: fromNode.id,
          to_node_id: toNode.id,
          rationale: parsed.rationale,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Scope membership: propose_membership stages a claim that an
    // existing node is in scope for an additional sub-topic in the same
    // cause. Membership is what lets a single node serve multiple sub-
    // topics without duplication, forking supersedes chains, or
    // smuggling lineage (PRD line 82). Reviewed by the *target* sub-
    // topic's reviewer pool — that's the pool with the expertise to
    // judge the scope claim — but reviewer assignment lives downstream
    // of this tool.
    proposeMembership: async (
      caller: Caller,
      input: ProposeMembershipInput,
    ): Promise<ProposeMembershipOutput> => {
      const parsed = ProposeMembershipInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const node = this.store.nodes.get(parsed.node_id);
      if (!node) {
        throw new ServerError('not_found', `node not found: ${parsed.node_id}`);
      }
      if (node.status !== 'active') {
        throw new ServerError('invalid_state', `node ${node.id} is ${node.status}`);
      }
      const causeId = this.causeOfNode(node);
      // Membership target must be in the same cause: cross-cause scope
      // claims would smuggle lineage past the cause boundary, which the
      // multi-scale graph deliberately enforces.
      this.requireActiveSubTopicInCause(parsed.sub_topic_id, causeId, 'target');

      // Redundancy checks. A node trivially serves its home sub-topic;
      // re-claiming an existing scope membership creates a duplicate
      // proposal that contributes nothing. Both are caught here so the
      // contributor gets a synchronous, specific error rather than a
      // late acceptance failure or a silent no-op.
      if (node.home_sub_topic_id === parsed.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          `node ${node.id} is already homed in sub-topic ${parsed.sub_topic_id}`,
        );
      }
      if (node.scope_memberships.includes(parsed.sub_topic_id)) {
        throw new ServerError(
          'invalid_input',
          `node ${node.id} already has membership in sub-topic ${parsed.sub_topic_id}`,
        );
      }

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'membership',
          node_id: node.id,
          sub_topic_id: parsed.sub_topic_id,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Change of home: propose_change_of_home moves a node's home
    // sub-topic to a different one within the same cause. Rare in
    // practice — most apparent "wrong sub-topic" cases turn out to be
    // membership-needed cases, which is why the membership tool is the
    // first thing contributors should reach for. PRD line 131 marks
    // this curator-approved; today every proposal is curator-mediated,
    // and when the review loop lands change_of_home stays on the
    // curator path while other proposal kinds move to the reviewer
    // pool.
    proposeChangeOfHome: async (
      caller: Caller,
      input: ProposeChangeOfHomeInput,
    ): Promise<ProposeChangeOfHomeOutput> => {
      const parsed = ProposeChangeOfHomeInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const node = this.store.nodes.get(parsed.node_id);
      if (!node) {
        throw new ServerError('not_found', `node not found: ${parsed.node_id}`);
      }
      if (node.status !== 'active') {
        throw new ServerError('invalid_state', `node ${node.id} is ${node.status}`);
      }
      const causeId = this.causeOfNode(node);
      this.requireActiveSubTopicInCause(parsed.new_home_sub_topic_id, causeId, 'new home');

      if (node.home_sub_topic_id === parsed.new_home_sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          `node ${node.id} is already homed in sub-topic ${parsed.new_home_sub_topic_id}`,
        );
      }

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'change_of_home',
          node_id: node.id,
          new_home_sub_topic_id: parsed.new_home_sub_topic_id,
          rationale: parsed.rationale,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Sub-topic creation: in v0 sub-topics are curator-gated.
    // propose_sub_topic stages the proposal; the SubTopic itself is not
    // materialized until a curator decision (accept-as-active via
    // curator.acceptProposal, or defer-as-proposed via
    // curator.deferSubTopic, per PRD line 218). v1 will add auto-
    // discovery; the tool surface stays the same.
    proposeSubTopic: async (
      caller: Caller,
      input: ProposeSubTopicInput,
    ): Promise<ProposeSubTopicOutput> => {
      const parsed = ProposeSubTopicInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const cause = this.requireActiveCause(parsed.cause_id);

      const now = this.clock.now();
      const proposal: Proposal = {
        id: this.idGen.proposalId(),
        proposer_id: identity.id,
        status: 'staged',
        payload: {
          kind: 'sub_topic',
          cause_id: cause.id,
          name: parsed.name,
          description: parsed.description,
          scope_query: parsed.scope_query,
        },
        created_at: now,
        updated_at: now,
      };
      this.store.proposals.set(proposal.id, proposal);
      return { proposal_id: proposal.id };
    },

    // PRD §Read-path tools and resources line 146: query_frontier
    // returns an ordered list of frontier items (work to be done),
    // optionally filtered by cause, sub-topic, or kind. The frontier
    // is derived from current graph state — see deriveFrontier — so
    // its consistency with the graph is by-construction. Callers must
    // be authenticated; the result is the same for everyone, but the
    // auth check keeps the tool accountable to rate-limit / abuse-
    // signal infrastructure that lives at the caller layer.
    queryFrontier: async (
      caller: Caller,
      input: QueryFrontierInput,
    ): Promise<QueryFrontierOutput> => {
      const parsed = QueryFrontierInput.parse(input);
      resolveCaller(this.store, caller);
      const items = this.deriveFrontier({
        ...(parsed.cause_id !== undefined ? { cause_id: parsed.cause_id } : {}),
        ...(parsed.sub_topic_id !== undefined ? { sub_topic_id: parsed.sub_topic_id } : {}),
        ...(parsed.frontier_kind !== undefined ? { frontier_kind: parsed.frontier_kind } : {}),
      });
      return { items };
    },

    // PRD §Read-path tools and resources line 147: query_proposals
    // returns proposal records, optionally filtered by status, sub-
    // topic, or assignment-to-me. The sub-topic filter routes through
    // locateProposalForReview so the result for a given sub-topic
    // includes membership proposals targeting that sub-topic — which
    // matches where review pressure actually applies (PRD §Scope
    // membership line 80: memberships are evaluated by reviewers from
    // the target sub-topic).
    queryProposals: async (
      caller: Caller,
      input: QueryProposalsInput,
    ): Promise<QueryProposalsOutput> => {
      const parsed = QueryProposalsInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      const proposals = [...this.store.proposals.values()].filter((p) => {
        if (parsed.status && p.status !== parsed.status) return false;
        if (parsed.assigned_to_me) {
          // assigned_to_me is true when there exists an assignment
          // owned by the caller that fulfills *or targets* this
          // proposal: a propose-kind assignment whose fulfilled_by
          // matches, or a review-kind assignment whose task points
          // at this proposal_id.
          let mine = false;
          for (const a of this.store.assignments.values()) {
            if (a.contributor_id !== identity.id) continue;
            if (a.fulfilled_by === p.id) {
              mine = true;
              break;
            }
            if (a.task.kind === 'review' && a.task.proposal_id === p.id) {
              mine = true;
              break;
            }
          }
          if (!mine) return false;
        }
        if (parsed.sub_topic_id) {
          const located = this.locateProposalForReview(p);
          if (!located || located.sub_topic_id !== parsed.sub_topic_id) return false;
        }
        return true;
      });
      // Stable order: created_at ascending, then id alphabetical for
      // determinism. Same rationale as queryFrontier — randomness in
      // selection lives at the assignment layer.
      proposals.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
        return a.id.localeCompare(b.id);
      });
      return { proposals };
    },

    // PRD §cast_review_vote (line 133): reviewer records a vote with
    // required rationale. With assignment_id set, the vote fulfills a
    // review-kind assignment and accrues full assigned-review reputation;
    // without it, the review is contributor-initiated and weighted lower.
    // Self-review is rejected as a conflict-of-interest invariant: the
    // whole point of redundant peer review is that a contributor's own
    // claim be evaluated by other reviewers (PRD §Reviewer assignment
    // and the broader spirit of PRD line 246's stance on self-acting on
    // one's own work). Double-voting on the same proposal is rejected
    // for the same reason a vote tally needs to be coherent.
    castReviewVote: async (
      caller: Caller,
      input: CastReviewVoteInput,
    ): Promise<CastReviewVoteOutput> => {
      const parsed = CastReviewVoteInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const proposal = this.store.proposals.get(parsed.proposal_id);
      if (!proposal) {
        throw new ServerError('not_found', `proposal not found: ${parsed.proposal_id}`);
      }
      if (proposal.status !== 'staged') {
        throw new ServerError(
          'invalid_state',
          `cannot vote on proposal in status ${proposal.status}`,
        );
      }
      if (proposal.proposer_id === identity.id) {
        throw new ServerError(
          'invalid_input',
          `reviewer ${identity.id} cannot review their own proposal ${proposal.id}`,
        );
      }
      // One vote per (reviewer, proposal). The vote tally would be
      // incoherent otherwise, and the abuse-cost story for review
      // requires that revoting be a deliberate operation (currently
      // not exposed; the existing vote can be the curator's reference).
      for (const v of this.store.reviewVotes.values()) {
        if (v.proposal_id === proposal.id && v.reviewer_id === identity.id) {
          throw new ServerError(
            'invalid_state',
            `reviewer ${identity.id} already voted on proposal ${proposal.id}`,
          );
        }
      }

      // If the reviewer asserts assignment fulfillment, the assignment
      // must exist, belong to them, target this proposal, and be in a
      // state that admits fulfillment. Until the assignment-creation
      // tools land (set_capacity, request_assignment), no assignment_id
      // will resolve — which is the correct behavior: a reviewer can't
      // claim assignment credit for an assignment that doesn't exist.
      if (parsed.assignment_id) {
        const assignment = this.store.assignments.get(parsed.assignment_id);
        if (!assignment) {
          throw new ServerError('not_found', `assignment not found: ${parsed.assignment_id}`);
        }
        if (assignment.contributor_id !== identity.id) {
          throw new ServerError(
            'unauthorized',
            `assignment ${assignment.id} does not belong to ${identity.id}`,
          );
        }
        if (assignment.task.kind !== 'review') {
          throw new ServerError(
            'invalid_input',
            `assignment ${assignment.id} is not a review task (got ${assignment.task.kind})`,
          );
        }
        if (assignment.task.proposal_id !== proposal.id) {
          throw new ServerError(
            'invalid_input',
            `assignment ${assignment.id} targets a different proposal`,
          );
        }
        if (assignment.status !== 'accepted' && assignment.status !== 'offered') {
          throw new ServerError(
            'invalid_state',
            `assignment ${assignment.id} is ${assignment.status}`,
          );
        }
      }

      const now = this.clock.now();
      const vote: ReviewVote = {
        id: this.idGen.reviewVoteId(),
        proposal_id: proposal.id,
        reviewer_id: identity.id,
        decision: parsed.decision,
        rationale: parsed.rationale,
        ...(parsed.assignment_id ? { assignment_id: parsed.assignment_id } : {}),
        created_at: now,
      };
      this.store.reviewVotes.set(vote.id, vote);

      // If the vote fulfilled an assignment, mark the assignment
      // submitted and pin the fulfilling proposal. The assignment
      // surface will read this on next request_assignment to know not
      // to re-offer the same task.
      if (parsed.assignment_id) {
        const assignment = this.store.assignments.get(parsed.assignment_id);
        if (assignment) {
          this.store.assignments.set(assignment.id, {
            ...assignment,
            status: 'submitted',
            fulfilled_by: proposal.id,
            updated_at: now,
          });
        }
      }

      return { vote_id: vote.id };
    },
  };

  readonly curator = {
    // Curator-mediated acceptance. Phase 1 surface: until the review
    // loop lands (assignment-driven sampling, vote tallying,
    // convergence resolution), this is how staged proposals advance.
    // Phase 2 keeps it as the curator-escalation path described in
    // PRD §Reviewer assignment (step 4: curator escalation) and as the
    // mechanism the eventual review-convergence code calls when it
    // decides a proposal has accumulated enough accept-votes. The
    // result includes whichever id the proposal materialized: a
    // node_id for graph-creating kinds, a sub_topic_id for sub_topic
    // kind, or neither for in-place mutations (membership, supersedes,
    // change_of_home).
    acceptProposal: (proposalId: ProposalId): { node_id?: NodeId; sub_topic_id?: SubTopicId } => {
      const proposal = this.store.proposals.get(proposalId);
      if (!proposal) {
        throw new ServerError('not_found', `proposal not found: ${proposalId}`);
      }
      if (proposal.status !== 'staged') {
        throw new ServerError(
          'invalid_state',
          `cannot accept proposal in status ${proposal.status}`,
        );
      }

      const result = this.materialize(proposal, 'active');
      const now = this.clock.now();
      this.store.proposals.set(proposal.id, { ...proposal, status: 'accepted', updated_at: now });
      this.applyMaterialization(result);
      if (result.node) return { node_id: result.node.id };
      const created = result.subTopicCreates[0];
      if (created) return { sub_topic_id: created.id };
      return {};
    },

    // PRD §Sub-topic creation line 218: "Curator accepts as `active`,
    // defers as `proposed`, or rejects." This is the deferral path —
    // the curator has decided to record the sub-topic but hold off on
    // activation pending more evidence (corpus density, articulable
    // scope envelope, real audience). The SubTopic is materialized
    // with status `proposed`; a future curator action flips it to
    // `active` without going through the proposal system again. The
    // proposal itself is marked accepted because the curator has
    // resolved it — `proposed` is a SubTopic state, not a Proposal
    // state. Only sub_topic-kind proposals are deferrable.
    deferSubTopic: (proposalId: ProposalId): { sub_topic_id: SubTopicId } => {
      const proposal = this.store.proposals.get(proposalId);
      if (!proposal) {
        throw new ServerError('not_found', `proposal not found: ${proposalId}`);
      }
      if (proposal.status !== 'staged') {
        throw new ServerError(
          'invalid_state',
          `cannot defer proposal in status ${proposal.status}`,
        );
      }
      if (proposal.payload.kind !== 'sub_topic') {
        throw new ServerError(
          'invalid_input',
          `deferSubTopic only applies to sub_topic proposals (got ${proposal.payload.kind})`,
        );
      }
      const result = this.materialize(proposal, 'proposed');
      const now = this.clock.now();
      this.store.proposals.set(proposal.id, { ...proposal, status: 'accepted', updated_at: now });
      this.applyMaterialization(result);
      const created = result.subTopicCreates[0];
      if (!created) {
        // Defensive: the sub_topic materialization branch must have
        // produced exactly one SubTopic.
        throw new ServerError('invalid_state', 'sub_topic deferral did not materialize a SubTopic');
      }
      return { sub_topic_id: created.id };
    },
  };

  // Apply the result of materialize() to the store. Centralized so the
  // accept and defer paths can't drift in how they persist results.
  private applyMaterialization(result: MaterializationResult): void {
    if (result.node) {
      this.store.nodes.set(result.node.id, result.node);
    }
    for (const updated of result.nodeUpdates) {
      this.store.nodes.set(updated.id, updated);
    }
    for (const edge of result.edges) {
      this.store.edges.set(edge.id, edge);
    }
    for (const st of result.subTopicCreates) {
      this.store.subTopics.set(st.id, st);
    }
  }

  // Convert an accepted proposal into the state changes it asserts.
  // Four slots:
  //   `node`            — a newly created node (anchor / excerpt /
  //                       synthesis / open_question), or null for kinds
  //                       that don't create one.
  //   `edges`           — newly created edges (derives or supersedes).
  //   `nodeUpdates`     — existing nodes whose state must be rewritten
  //                       in place (supersedes flipping `from` to
  //                       superseded; change_of_home rewriting
  //                       `home_sub_topic_id`; membership appending to
  //                       `scope_memberships`).
  //   `subTopicCreates` — newly created sub-topics (sub_topic kind).
  // The `subTopicStatus` argument lets the same materialization path
  // produce a SubTopic with different statuses for the curator's two
  // accept variants (PRD line 218: accept-as-active or defer-as-
  // proposed). Other kinds ignore it.
  // Kinds without a materialization path throw `invalid_state` until
  // their path lands.
  private materialize(
    proposal: Proposal,
    subTopicStatus: 'active' | 'proposed',
  ): MaterializationResult {
    const now = this.clock.now();
    if (proposal.payload.kind === 'anchor') {
      const verified = this.store.verifiedRefs.get(proposal.id);
      if (!verified) {
        throw new ServerError(
          'invalid_state',
          `verification metadata missing for proposal ${proposal.id}`,
        );
      }
      const node: AnchorNode = {
        id: this.idGen.nodeId(),
        kind: 'anchor',
        home_sub_topic_id: proposal.payload.home_sub_topic_id,
        scope_memberships: proposal.payload.memberships ?? [],
        content: proposal.payload.content,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
        updated_at: now,
        external_ref: proposal.payload.external_ref,
        content_hash: verified.content_hash,
      };
      return { node, edges: [], nodeUpdates: [], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'excerpt') {
      // PRD §Edges: derives edges are created atomically with their
      // child node. The parent must still be active at acceptance
      // time — re-check, because nothing prevents the parent from
      // being superseded between propose and accept.
      const parent = this.store.nodes.get(proposal.payload.parent_anchor_id);
      if (!parent || parent.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `parent anchor ${proposal.payload.parent_anchor_id} is not active at acceptance`,
        );
      }
      const node: ExcerptNode = {
        id: this.idGen.nodeId(),
        kind: 'excerpt',
        home_sub_topic_id: proposal.payload.home_sub_topic_id,
        scope_memberships: proposal.payload.memberships ?? [],
        content: proposal.payload.content,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
        updated_at: now,
        quoted_span: proposal.payload.quoted_span,
      };
      const edge: DerivesEdge = {
        id: this.idGen.edgeId(),
        kind: 'derives',
        from: parent.id,
        to: node.id,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
      };
      return { node, edges: [edge], nodeUpdates: [], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'synthesis' || proposal.payload.kind === 'open_question') {
      // All parents must be active at acceptance time. Re-checked
      // here for the same reason as excerpt: a parent could have been
      // superseded between propose and accept.
      const parents: Node[] = [];
      for (const pid of proposal.payload.parent_ids) {
        const p = this.store.nodes.get(pid);
        if (!p || p.status !== 'active') {
          throw new ServerError('invalid_state', `parent ${pid} is not active at acceptance`);
        }
        parents.push(p);
      }
      const base = {
        id: this.idGen.nodeId(),
        home_sub_topic_id: proposal.payload.home_sub_topic_id,
        scope_memberships: proposal.payload.memberships ?? [],
        content: proposal.payload.content,
        status: 'active' as const,
        created_by: proposal.proposer_id,
        created_at: now,
        updated_at: now,
      };
      const node: SynthesisNode | OpenQuestionNode =
        proposal.payload.kind === 'synthesis'
          ? { ...base, kind: 'synthesis' }
          : { ...base, kind: 'open_question' };
      const edges: DerivesEdge[] = parents.map((p) => ({
        id: this.idGen.edgeId(),
        kind: 'derives',
        from: p.id,
        to: node.id,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
      }));
      return { node, edges, nodeUpdates: [], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'supersedes') {
      // Re-check both endpoints at acceptance: either could have moved
      // out of `active` between propose and accept. Same defense as the
      // excerpt-parent re-check. Re-run the cycle detector too — a
      // concurrent supersedes acceptance could have introduced a path
      // that wasn't there at propose time.
      const fromNode = this.store.nodes.get(proposal.payload.from_node_id);
      if (!fromNode || fromNode.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `from node ${proposal.payload.from_node_id} is not active at acceptance`,
        );
      }
      const toNode = this.store.nodes.get(proposal.payload.to_node_id);
      if (!toNode || toNode.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `to node ${proposal.payload.to_node_id} is not active at acceptance`,
        );
      }
      if (this.supersedesWouldCycle(fromNode.id, toNode.id)) {
        throw new ServerError(
          'invalid_state',
          `supersedes from ${fromNode.id} to ${toNode.id} would create a cycle at acceptance`,
        );
      }
      const edge: SupersedesEdge = {
        id: this.idGen.edgeId(),
        kind: 'supersedes',
        from: fromNode.id,
        to: toNode.id,
        status: 'active',
        created_by: proposal.proposer_id,
        created_at: now,
        rationale: proposal.payload.rationale,
      };
      // The active-node rule (PRD §Nodes line 69) defines a node as
      // inactive iff it is the `from` of a supersedes edge. We make
      // that explicit on the node's status field too — keeping status
      // and edge state in sync means callers don't have to walk edges
      // to know whether a node is active.
      const updated: Node = { ...fromNode, status: 'superseded', updated_at: now };
      return { node: null, edges: [edge], nodeUpdates: [updated], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'membership') {
      // Re-check the node and target sub-topic at acceptance: either
      // could have moved out of `active` between propose and accept,
      // and the node could have gained the membership through a
      // concurrent acceptance — in which case re-applying it would
      // be a no-op but the duplicate-membership invariant still has
      // to hold.
      const node = this.store.nodes.get(proposal.payload.node_id);
      if (!node || node.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `node ${proposal.payload.node_id} is not active at acceptance`,
        );
      }
      const target = this.store.subTopics.get(proposal.payload.sub_topic_id);
      if (!target || target.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `target sub-topic ${proposal.payload.sub_topic_id} is not active at acceptance`,
        );
      }
      if (node.home_sub_topic_id === proposal.payload.sub_topic_id) {
        throw new ServerError(
          'invalid_state',
          `node ${node.id} is now homed in sub-topic ${proposal.payload.sub_topic_id}`,
        );
      }
      if (node.scope_memberships.includes(proposal.payload.sub_topic_id)) {
        throw new ServerError(
          'invalid_state',
          `node ${node.id} already has membership in sub-topic ${proposal.payload.sub_topic_id}`,
        );
      }
      const updated: Node = {
        ...node,
        scope_memberships: [...node.scope_memberships, proposal.payload.sub_topic_id],
        updated_at: now,
      };
      return { node: null, edges: [], nodeUpdates: [updated], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'change_of_home') {
      const node = this.store.nodes.get(proposal.payload.node_id);
      if (!node || node.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `node ${proposal.payload.node_id} is not active at acceptance`,
        );
      }
      const target = this.store.subTopics.get(proposal.payload.new_home_sub_topic_id);
      if (!target || target.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `new home sub-topic ${proposal.payload.new_home_sub_topic_id} is not active at acceptance`,
        );
      }
      if (node.home_sub_topic_id === proposal.payload.new_home_sub_topic_id) {
        throw new ServerError(
          'invalid_state',
          `node ${node.id} is now homed in sub-topic ${proposal.payload.new_home_sub_topic_id}`,
        );
      }
      // PRD §Change of home: "Other memberships are unaffected; the one
      // exception is that if the new home was previously a scope
      // membership, it is removed from the membership list" — leaving
      // the home in scope_memberships would be a redundant duplicate
      // since the home is implicitly in scope.
      const newHome = proposal.payload.new_home_sub_topic_id;
      const filteredMemberships = node.scope_memberships.filter((s) => s !== newHome);
      const updated: Node = {
        ...node,
        home_sub_topic_id: newHome,
        scope_memberships: filteredMemberships,
        updated_at: now,
      };
      return { node: null, edges: [], nodeUpdates: [updated], subTopicCreates: [] };
    }
    if (proposal.payload.kind === 'sub_topic') {
      // Re-check the parent cause is still active. The cause is the
      // only hard prerequisite — name/description/scope_query are free
      // text and don't need re-validation.
      const cause = this.store.causes.get(proposal.payload.cause_id);
      if (!cause || cause.status !== 'active') {
        throw new ServerError(
          'invalid_state',
          `cause ${proposal.payload.cause_id} is not active at acceptance`,
        );
      }
      const subTopic: SubTopic = {
        id: this.idGen.subTopicId(),
        cause_id: cause.id,
        name: proposal.payload.name,
        description: proposal.payload.description,
        scope_query: proposal.payload.scope_query,
        status: subTopicStatus,
        created_at: now,
      };
      return { node: null, edges: [], nodeUpdates: [], subTopicCreates: [subTopic] };
    }
    // All ProposalPayload variants are handled above; this is an
    // exhaustiveness guard. If a new payload kind lands without a
    // matching materialize branch, TypeScript will widen `payload`'s
    // type past `never` and the assignment below will fail at
    // compile time, forcing the new branch to be added.
    const _exhaustive: never = proposal.payload;
    throw new ServerError(
      'invalid_state',
      `materialization not implemented for proposal kind: ${(_exhaustive as { kind: string }).kind}`,
    );
  }
}
