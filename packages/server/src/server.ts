import {
  AcceptAssignmentInput,
  type AcceptAssignmentOutput,
  type AgentCredential,
  type AnchorNode,
  type Assignment,
  type AssignmentId,
  type AssignmentTask,
  type Capacity,
  CastReviewVoteInput,
  type CastReviewVoteOutput,
  type Cause,
  type CauseId,
  DeclineAssignmentInput,
  type DeclineAssignmentOutput,
  type DerivesEdge,
  type Edge,
  type ExcerptNode,
  FetchCalibrationBatchInput,
  type FetchCalibrationBatchOutput,
  type FrontierItem,
  type Identity,
  type IdentityId,
  type Node,
  type NodeId,
  type OpenQuestionNode,
  type Proposal,
  type ProposalId,
  type ProposalPayload,
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
  QueryReputationInput,
  type QueryReputationOutput,
  type ReputationEntry,
  RequestAssignmentInput,
  type RequestAssignmentOutput,
  type ReviewBatchItem,
  type ReviewDecision,
  type ReviewVote,
  SetCapacityInput,
  type SetCapacityOutput,
  type SubTopic,
  type SubTopicId,
  SubmitAssignedProposalInput,
  type SubmitAssignedProposalOutput,
  type SupersedesEdge,
  type SynthesisNode,
  type WorkKind,
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

// Vote-aggregation thresholds and reputation weights (PRD §What's deliberately not specified here,
// testbed-tuned). Defaults here are starting points for the testbed to
// swap as it sweeps; they are deliberately small so basic walking-
// skeleton scenarios converge inside one or two votes and produce
// observable reputation deltas.
export interface ReviewConfig {
  // Number of `accept` votes needed before the proposal auto-accepts
  // (without curator action). PRD §The contribution flow (Resolve step): convergent vote merges.
  votes_to_accept: number;
  // Number of `reject` votes needed before the proposal auto-rejects.
  votes_to_reject: number;
  // Reputation gain to the proposer when their proposal converges to
  // accepted (PRD §Reputation: "Earned through confirmed
  // contributions"). Multiplied by `contributor_initiated_factor` for
  // proposals not tied to an assignment_id (PRD §Reputation).
  proposer_accepted_gain: number;
  // Reputation loss to the proposer when their proposal converges to
  // rejected (PRD §Reputation: "Lost through reverted contributions").
  proposer_rejected_loss: number;
  // Reputation gain to a reviewer who voted with the converged
  // outcome (PRD §Reputation: "reviewing accurately").
  reviewer_accurate_gain: number;
  // Reputation loss to a reviewer who voted against the converged
  // outcome (PRD §Reputation: "inaccurate reviews").
  reviewer_inaccurate_loss: number;
  // Multiplier applied to *proposer* gain/loss when the proposal was
  // contributor-initiated rather than assignment-driven. PRD
  // §Reputation: "Contributor-initiated work earns sub-topic rep at
  // a substantially reduced weight." 0 ≤ factor ≤ 1; defaults to 0.5.
  contributor_initiated_factor: number;
  // Calibration injection cadence. PRD §Calibration batches: reviewer
  // batches mix real proposals with calibration items drawn from
  // validated history; PRD §Why assignment-driven contribution closes several attack surfaces settles that calibration arrives
  // via the same assignment surface as real work, so it is structurally
  // indistinguishable from "the rest of the work." 0 disables; N>0 means
  // every Nth review-task offer to a given (caller, cause) is replaced
  // with a calibration draw (an accepted-from-history proposal). The
  // testbed sweeps this; baseline is disabled so non-calibration
  // scenarios remain unaffected.
  calibration_inject_every_n: number;
  // Reputation gain when a reviewer correctly accepts a calibration
  // item (PRD §Calibration batches: "Reviewers who fail calibration lose
  // reputation" — the dual gain is the symmetric incentive). Smaller
  // than reviewer_accurate_gain by default so calibration is a
  // confirmation channel, not a rep-laundering one.
  calibration_pass_gain: number;
  // Reputation loss when a reviewer rejects (or asks for revision on,
  // by the contrapositive — but revise is a no-op here, see below) a
  // calibration item. PRD §Calibration batches + §Reputation: failing calibration
  // and inaccurate reviews both deduct rep.
  calibration_fail_loss: number;
  // Calibration-aware convergence: when true, resolveByConvergence
  // weights votes by the reviewer's per-(cause, sub-topic) calibration
  // record (passes minus fails) at convergence time. Convergence
  // requires both a minimum count of distinct reviewers AND a minimum
  // *weighted* sum, both equal to votes_to_X. The two conditions
  // collapse to today's count-based behavior when every reviewer's
  // weight is 1 (calibration record (0,0)) and only differ once
  // calibration history starts moving weights. Defaults to off so the
  // existing scenarios that count votes 1:1 are unaffected.
  //
  // The defense closes the convergence half of the strategic-coalition
  // attack: a coalition whose bias misfires on calibration items pays
  // for it twice — once on the rep ledger (already wired) and once at
  // convergence, where their reduced weight no longer drives a
  // bias-aligned suppression past the threshold. The seam relies on
  // the calibration corpus being non-trivial for the bias predicate
  // (PRD §Calibration batches: calibration items "drawn from the
  // graph's own validated history" are by construction not bias-
  // engineered). Calibration-aware adversaries (PRD §Adversary taxonomy (Strategic adversary): passing
  // calibration despite holding bias) are an open testbed target that
  // builds on this seam, not a regression of it.
  calibration_aware_convergence: boolean;
  // Stratified-by-history reviewer assignment (PRD §Reviewer
  // assignment). When true, the assignment selector partitions the
  // eligible reviewer pool into vote-pattern co-occurrence clusters
  // and prefers draws across clusters; convergence reads the same
  // partition to mark proposals that lost their diversity defense as
  // stratification-degraded and tighten thresholds. Defaults to off
  // so existing scenarios that don't sweep stratification are
  // unaffected.
  stratification_enabled: boolean;
  // Two reviewers are co-stratum when they have voted on at least
  // this many shared past proposals AND their pairwise agreement on
  // those shared proposals is >= stratum_agreement_threshold. Below
  // the shared-proposal floor, the pair is treated as no-edge — the
  // signal isn't there yet. Smaller floors detect bias clusters
  // earlier but accept more noise; the testbed sweeps this.
  stratum_min_shared_proposals: number;
  // Pairwise agreement threshold for cluster-edge formation. 1.0 is
  // "always voted the same way on every shared proposal"; 0.5 is
  // chance for binary vote outcomes. Default 0.8 — high enough to
  // distinguish coordinated bias from independent agreement on
  // strongly-grounded proposals, low enough to detect a coalition
  // that doesn't perfectly synchronize.
  stratum_agreement_threshold: number;
  // Target distinct strata count per proposal. When the eligible
  // pool can't furnish at least this many strata, the proposal is
  // marked stratification-degraded and convergence tightens.
  // Defaults to votes_to_accept — same target as the redundant-
  // peer-review invariant.
  stratum_target_count: number;
  // Extra distinct-reviewer count and weighted-sum required for
  // convergence on a stratification-degraded proposal. PRD commits
  // "tighter" without committing the shape; v0 uses a fixed additive
  // bump over both the count and the weighted-sum thresholds for
  // testability. Multiplicative tightening is a future testbed
  // sweep.
  stratification_degraded_extra: number;
  // Contention-weighted edge formation for the cluster primitive
  // (PRD §Reviewer assignment, "weighting shared proposals by
  // contention"). When true, pairwise edges are weighted by per-
  // proposal contention — `2 * min(accepts, rejects) / total_votes`,
  // so unanimous proposals contribute 0 weight and perfect-split
  // proposals contribute 1. The pair edges when (a) at least
  // stratum_min_shared_proposals raw shared votes exist (the brand-
  // new-reviewer floor stays in place) AND (b) weighted_agreement /
  // weighted_shared >= stratum_agreement_threshold AND (c)
  // weighted_shared > 0 (some non-zero contention has accumulated).
  // Closes the over-aggregation failure mode where unanimous-easy
  // priming collapses honest reviewers into one cluster, strangling
  // the cross-stratum draw rule. Does *not* close the decorrelating-
  // coalition vector, since a pair that disagrees on every shared
  // proposal still has weighted_agreement = 0; that vector is closed
  // by stratum_anti_correlation_threshold below. Defaults to off so
  // existing scenarios that rely on raw cluster semantics are
  // unaffected.
  stratum_contention_weighted: boolean;
  // Anti-correlation edge formation (PRD §Reviewer assignment,
  // "detecting anti-correlation as a separate cue"). When > 0, a
  // pair edges into the same stratum when their (weighted)
  // disagreement ratio meets this threshold — i.e., they
  // systematically vote the *opposite* way on shared proposals.
  // Coalition members deliberately decorrelating to defeat the
  // co-occurrence cluster look unmistakably anti-correlated; treating
  // that as co-stratum closes the cross-stratum gate against them.
  // The brand-new-reviewer raw-shared floor still applies, and when
  // stratum_contention_weighted is on the disagreement ratio is
  // weighted by per-proposal contention exactly the way agreement is.
  // 0 disables (default) — existing scenarios are unaffected. 1.0 is
  // "always voted the opposite way on every shared proposal"; values
  // below 1.0 admit organic disagreement as honest false positives,
  // which is the signal/cost trade-off the testbed sweeps.
  stratum_anti_correlation_threshold: number;
}

const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  votes_to_accept: 2,
  votes_to_reject: 2,
  proposer_accepted_gain: 1,
  proposer_rejected_loss: 1,
  reviewer_accurate_gain: 1,
  reviewer_inaccurate_loss: 1,
  contributor_initiated_factor: 0.5,
  calibration_inject_every_n: 0,
  calibration_pass_gain: 1,
  calibration_fail_loss: 1,
  calibration_aware_convergence: false,
  stratification_enabled: false,
  stratum_min_shared_proposals: 3,
  stratum_agreement_threshold: 0.8,
  stratum_target_count: 2,
  stratification_degraded_extra: 1,
  stratum_contention_weighted: false,
  stratum_anti_correlation_threshold: 0,
};

export interface ServerDeps {
  clock?: Clock;
  idGen?: IdGen;
  store?: MemoryStore;
  verifier?: Verifier;
  review?: Partial<ReviewConfig>;
}

// v0 cap on calibration items per fetch. Small enough to keep batch
// composition (real proposals + calibration items) reviewer-tractable;
// the right value is testbed-tuned and changes alongside the broader
// batch-sizing knob.
const CALIBRATION_BATCH_SIZE = 3;

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

// The work kind a task represents. AssignmentTask is keyed by `kind`
// values that already match WorkKind one-to-one — see assignments.ts
// — so the projection is identity in spirit. Made explicit so future
// task-kind additions surface here as compile errors.
function taskWorkKind(task: AssignmentTask): WorkKind {
  return task.kind;
}

// A stable string identifying the *target* of an assignment, for
// double-offer prevention. Two tasks targeting the same proposal-to-
// review or the same parent-anchor-to-excerpt are the same target —
// even if they sit in different assignments at different times.
function assignmentTaskKey(task: AssignmentTask): string {
  switch (task.kind) {
    case 'review':
      return `review:${task.proposal_id}`;
    case 'excerpt':
      return `excerpt:${task.parent_anchor_id}`;
    case 'synthesis':
    case 'open_question':
      return `${task.kind}:${[...task.parent_ids].sort().join(',')}`;
    case 'supersedes':
      return `supersedes:${task.from_node_id}`;
    case 'membership':
      return `membership:${task.node_id}:${task.sub_topic_id}`;
    case 'anchor':
      return `anchor:${task.sub_topic_id}`;
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
  readonly review: ReviewConfig;

  constructor(deps: ServerDeps = {}) {
    this.clock = deps.clock ?? new SystemClock();
    this.idGen = deps.idGen ?? new RandomIdGen();
    this.store = deps.store ?? new MemoryStore();
    this.verifier = deps.verifier ?? new StructuralVerifier();
    this.review = { ...DEFAULT_REVIEW_CONFIG, ...(deps.review ?? {}) };
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
    // An anchor with a *staged* excerpt proposal isn't orphan either.
    // Re-offering it for excerpt work creates duplicate assignments
    // for the same parent across different contributors that the
    // loop's per-contributor double-offer guard can't deduplicate.
    // PRD treats orphan_anchor as "needs work to be productive";
    // staged work-in-flight already covers that need, even before
    // acceptance materializes the derives edge.
    const hasStagedExcerptChild = new Set<NodeId>();
    for (const p of this.store.proposals.values()) {
      if (p.status === 'staged' && p.payload.kind === 'excerpt') {
        hasStagedExcerptChild.add(p.payload.parent_anchor_id);
      }
    }

    for (const node of this.store.nodes.values()) {
      if (node.kind !== 'anchor') continue;
      const home = this.store.subTopics.get(node.home_sub_topic_id);
      if (!home) continue;
      if (
        node.status === 'active' &&
        !hasDerivesChild.has(node.id) &&
        !hasStagedExcerptChild.has(node.id)
      ) {
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

  // Resolve an assignment that belongs to the given identity and is
  // in the `offered` state — the entry point for accept/decline/
  // expiry transitions. Used by accept_assignment, decline_assignment,
  // and (later) the assignment-expiry sweep.
  private requireOwnedOfferedAssignment(
    assignmentId: AssignmentId,
    identityId: IdentityId,
  ): Assignment {
    const a = this.store.assignments.get(assignmentId);
    if (!a) {
      throw new ServerError('not_found', `assignment not found: ${assignmentId}`);
    }
    if (a.contributor_id !== identityId) {
      throw new ServerError(
        'unauthorized',
        `assignment ${assignmentId} does not belong to ${identityId}`,
      );
    }
    if (a.status !== 'offered') {
      throw new ServerError('invalid_state', `assignment ${assignmentId} is ${a.status}`);
    }
    return a;
  }

  // Assert the payload submitted to fulfill an assignment matches
  // the task's pinned context. Same-kind has already been checked by
  // the caller; this validates the per-kind target fields.
  private assertPayloadMatchesTask(payload: ProposalPayload, task: AssignmentTask): void {
    if (payload.kind === 'anchor' && task.kind === 'anchor') {
      if (payload.cause_id !== task.cause_id) {
        throw new ServerError('invalid_input', 'payload cause_id does not match task cause');
      }
      if (payload.home_sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload home_sub_topic_id does not match task sub-topic',
        );
      }
      return;
    }
    if (payload.kind === 'excerpt' && task.kind === 'excerpt') {
      if (payload.cause_id !== task.cause_id) {
        throw new ServerError('invalid_input', 'payload cause_id does not match task cause');
      }
      if (payload.home_sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload home_sub_topic_id does not match task sub-topic',
        );
      }
      if (payload.parent_anchor_id !== task.parent_anchor_id) {
        throw new ServerError(
          'invalid_input',
          'payload parent_anchor_id does not match task parent',
        );
      }
      return;
    }
    if (
      (payload.kind === 'synthesis' || payload.kind === 'open_question') &&
      (task.kind === 'synthesis' || task.kind === 'open_question')
    ) {
      if (payload.cause_id !== task.cause_id) {
        throw new ServerError('invalid_input', 'payload cause_id does not match task cause');
      }
      if (payload.home_sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload home_sub_topic_id does not match task sub-topic',
        );
      }
      // Parent set must match exactly (set equality, order-insensitive).
      const taskParents = new Set(task.parent_ids);
      const payloadParents = new Set(payload.parent_ids);
      if (
        taskParents.size !== payloadParents.size ||
        [...taskParents].some((p) => !payloadParents.has(p))
      ) {
        throw new ServerError('invalid_input', 'payload parent_ids do not match task parents');
      }
      return;
    }
    if (payload.kind === 'supersedes' && task.kind === 'supersedes') {
      if (payload.from_node_id !== task.from_node_id) {
        throw new ServerError(
          'invalid_input',
          'payload from_node_id does not match task from_node',
        );
      }
      return;
    }
    if (payload.kind === 'membership' && task.kind === 'membership') {
      if (payload.node_id !== task.node_id) {
        throw new ServerError('invalid_input', 'payload node_id does not match task node');
      }
      if (payload.sub_topic_id !== task.sub_topic_id) {
        throw new ServerError(
          'invalid_input',
          'payload sub_topic_id does not match task sub-topic',
        );
      }
      return;
    }
    // sub_topic and change_of_home are curator-only and excluded from
    // WorkKind; they shouldn't appear here. Review is filtered
    // earlier in submit_assigned_proposal.
    throw new ServerError(
      'invalid_input',
      `unsupported payload/task pair: ${payload.kind} / ${task.kind}`,
    );
  }

  // Route a propose-kind payload through the matching propose_*
  // tool method. Returns the staged proposal_id. Centralizes the
  // payload-to-tool mapping so submit_assigned_proposal doesn't
  // duplicate per-kind logic.
  private async routePayloadToProposeTool(
    caller: Caller,
    payload: ProposalPayload,
  ): Promise<ProposalId> {
    switch (payload.kind) {
      case 'anchor': {
        const out = await this.tools.proposeAnchor(caller, {
          cause_id: payload.cause_id,
          home_sub_topic_id: payload.home_sub_topic_id,
          ...(payload.memberships ? { memberships: payload.memberships } : {}),
          content: payload.content,
          external_ref: payload.external_ref,
        });
        return out.proposal_id;
      }
      case 'excerpt': {
        const out = await this.tools.proposeExcerpt(caller, {
          cause_id: payload.cause_id,
          home_sub_topic_id: payload.home_sub_topic_id,
          ...(payload.memberships ? { memberships: payload.memberships } : {}),
          parent_anchor_id: payload.parent_anchor_id,
          content: payload.content,
          quoted_span: payload.quoted_span,
        });
        return out.proposal_id;
      }
      case 'synthesis':
      case 'open_question': {
        const out = await this.tools.proposeSynthesis(caller, {
          cause_id: payload.cause_id,
          home_sub_topic_id: payload.home_sub_topic_id,
          ...(payload.memberships ? { memberships: payload.memberships } : {}),
          parent_ids: payload.parent_ids,
          content: payload.content,
          kind: payload.kind,
        });
        return out.proposal_id;
      }
      case 'supersedes': {
        const out = await this.tools.proposeSupersedes(caller, {
          from_node_id: payload.from_node_id,
          to_node_id: payload.to_node_id,
          rationale: payload.rationale,
        });
        return out.proposal_id;
      }
      case 'membership': {
        const out = await this.tools.proposeMembership(caller, {
          node_id: payload.node_id,
          sub_topic_id: payload.sub_topic_id,
        });
        return out.proposal_id;
      }
      case 'change_of_home':
      case 'sub_topic':
        throw new ServerError(
          'invalid_input',
          `${payload.kind} is curator-only and not assignment-driven`,
        );
    }
  }

  // The cause an assignment task is scoped to. Most task variants
  // carry cause_id explicitly; the review variant is scoped via the
  // proposal it targets. Used by the rate-cap counter so the same
  // contributor's assignments under different causes don't share a
  // budget.
  private causeOfTask(task: AssignmentTask): CauseId | null {
    if (task.kind === 'review') {
      const proposal = this.store.proposals.get(task.proposal_id);
      if (!proposal) return null;
      const located = this.locateProposalForReview(proposal);
      return located?.cause_id ?? null;
    }
    return task.cause_id;
  }

  // Map a frontier item to a concrete assignment task. Returns null
  // for frontier kinds that don't have a v0 task mapping
  // (`unresolvable_anchor` needs a re-anchor task variant the schema
  // doesn't carry; `needs_synthesis` has no v0 derivation heuristic).
  private frontierItemToTask(item: FrontierItem): AssignmentTask | null {
    switch (item.kind) {
      case 'orphan_anchor':
        return {
          kind: 'excerpt',
          cause_id: item.cause_id,
          sub_topic_id: item.sub_topic_id,
          parent_anchor_id: item.anchor_id,
        };
      case 'needs_review':
        return { kind: 'review', proposal_id: item.proposal_id };
      case 'unresolvable_anchor':
      case 'needs_synthesis':
        return null;
    }
  }

  // Pick a calibration target for a reviewer in this cause. Calibration
  // items are accepted-from-history proposals (PRD §Calibration batches
  // PRD §Calibration batches: "drawn from the graph's own validated history — proposals
  // that survived multiple confirmations and have been stable"). The
  // task wears the same `review` shape as a real review task; the
  // accepted-status seam is what tells `cast_review_vote` to score
  // against ground truth instead of running convergence. Conflict-of-
  // interest, already-voted, and no-double-offer gates mirror the
  // regular review-assignment path so a calibration item can't be
  // distinguished by being subject to laxer rules. Returns null when
  // no eligible candidate exists — e.g., a fresh sub-topic where no
  // proposal has yet been accepted.
  private drawCalibrationTask(
    causeId: CauseId,
    callerId: IdentityId,
    callerAssignments: readonly Assignment[],
  ): AssignmentTask | null {
    const candidates: Proposal[] = [];
    for (const p of this.store.proposals.values()) {
      if (p.status !== 'accepted') continue;
      if (p.proposer_id === callerId) continue;
      const located = this.locateProposalForReview(p);
      if (!located || located.cause_id !== causeId) continue;
      let voted = false;
      for (const v of this.store.reviewVotes.values()) {
        if (v.proposal_id === p.id && v.reviewer_id === callerId) {
          voted = true;
          break;
        }
      }
      if (voted) continue;
      const taskKey = `review:${p.id}`;
      const alreadySeen = callerAssignments.some(
        (a) =>
          a.status !== 'expired' &&
          a.status !== 'submitted' &&
          assignmentTaskKey(a.task) === taskKey,
      );
      if (alreadySeen) continue;
      candidates.push(p);
    }
    // Recency bias matches `fetchCalibrationBatch` (PRD §Calibration batches:
    // "biased toward fresh-but-validated history"). Tiebreak by id
    // for replay determinism.
    candidates.sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
      return a.id.localeCompare(b.id);
    });
    const top = candidates[0];
    if (!top) return null;
    return { kind: 'review', proposal_id: top.id };
  }

  // Locate the (cause, sub-topic) for review-routing of a staged
  // proposal. Curator-only kinds (`sub_topic`, `change_of_home`)
  // return null — they are not surfaced to the reviewer pool.
  // Membership routes to the *target* sub-topic per PRD §Write-path tools (propose_membership).
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
    // PRD §Capacity and assignment (set_capacity): set_capacity declares the
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

    // PRD §Capacity and assignment (request_assignment): request_assignment pulls
    // a task from the frontier within the caller's declared capacity.
    // The system selects across all sub-topics in the cause based on
    // frontier priority; expertise fit and capacity-balancing are v1
    // refinements (no expertise-history signal exists yet, and
    // capacity-balancing matters once the population is non-trivial —
    // testbed territory).
    //
    // v0 maps two frontier kinds onto assignment tasks:
    //
    //   - `orphan_anchor`  → propose-excerpt task pinning the parent.
    //   - `needs_review`   → review task pinning the proposal.
    //
    // `unresolvable_anchor` and `needs_synthesis` are not assignment-
    // mappable yet — the former needs a re-anchor task variant the
    // current AssignmentTask schema doesn't carry; the latter has no
    // frontier-derivation heuristic. Both surface in query_frontier
    // and are reachable via contributor-initiated propose_* calls.
    //
    // Eligibility gates:
    //
    //   1. Caller has a capacity record for the cause.
    //   2. The work kind is in the caller's declared kinds (and the
    //      optional `kind` argument, treated here as a strict filter
    //      rather than the soft preference PRD §Capacity and assignment (request_assignment) describes —
    //      v0 simplification; the soft path lands when expertise-fit
    //      logic does).
    //   3. Outstanding assignments (offered + accepted) for the
    //      caller in this cause are below the rate cap (PRD §Capacity and assignment:
    //      "rate caps how many will be granted in a window"; v0
    //      windows are "currently outstanding").
    //   4. Caller isn't the proposer of a needs_review task — same
    //      conflict-of-interest invariant cast_review_vote enforces.
    //   5. Caller doesn't already hold an outstanding assignment for
    //      this same task target — no double-offer per contributor.
    //
    // The same review task may be offered to multiple contributors
    // simultaneously (PRD §Reviewer assignment: N reviewers per
    // proposal); cross-contributor exclusion is not enforced here.
    requestAssignment: async (
      caller: Caller,
      input: RequestAssignmentInput,
    ): Promise<RequestAssignmentOutput> => {
      const parsed = RequestAssignmentInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireActiveCause(parsed.cause_id);

      const capacity = this.store.capacities.get(`${identity.id}|${parsed.cause_id}`);
      if (!capacity) {
        throw new ServerError(
          'invalid_state',
          `no capacity declared for cause ${parsed.cause_id} — call set_capacity first`,
        );
      }

      // Rate cap: count outstanding (offered + accepted) assignments
      // owned by this caller in this cause. Submitted/declined/expired
      // don't count — they've left the rate window.
      let outstanding = 0;
      const callerAssignmentsForTarget: Assignment[] = [];
      for (const a of this.store.assignments.values()) {
        if (a.contributor_id !== identity.id) continue;
        const aCause = this.causeOfTask(a.task);
        if (aCause !== parsed.cause_id) continue;
        if (a.status === 'offered' || a.status === 'accepted') outstanding += 1;
        callerAssignmentsForTarget.push(a);
      }
      if (outstanding >= capacity.rate) {
        throw new ServerError(
          'invalid_state',
          `rate cap reached: ${outstanding}/${capacity.rate} outstanding assignments`,
        );
      }

      const allowedKinds = new Set<WorkKind>(capacity.kinds);
      if (parsed.kind && !allowedKinds.has(parsed.kind)) {
        throw new ServerError(
          'invalid_input',
          `requested kind ${parsed.kind} is not in declared capacity kinds`,
        );
      }
      const wantedKinds: ReadonlySet<WorkKind> = parsed.kind
        ? new Set<WorkKind>([parsed.kind])
        : allowedKinds;

      // Calibration injection. PRD §Calibration batches + §Why assignment-driven contribution closes several attack surfaces:
      // calibration items arrive on the same assignment surface as real
      // review work, structurally indistinguishable to the reviewer.
      // Cadence is config-driven so the testbed can sweep it; baseline
      // (every_n=0) is disabled and leaves the frontier-only path
      // unchanged. We count review-task offers to this caller in this
      // cause and inject every Nth one — deterministic given a fixed
      // history, which is what the testbed needs for replay. The draw
      // can fail (no validated history yet, or all candidates excluded
      // by conflict-of-interest / already-voted gates), in which case
      // we fall through to the regular frontier loop rather than fail
      // the request.
      if (this.review.calibration_inject_every_n > 0 && wantedKinds.has('review')) {
        let priorReviewOffers = 0;
        for (const a of callerAssignmentsForTarget) {
          if (a.task.kind === 'review') priorReviewOffers += 1;
        }
        if ((priorReviewOffers + 1) % this.review.calibration_inject_every_n === 0) {
          const calTask = this.drawCalibrationTask(
            parsed.cause_id,
            identity.id,
            callerAssignmentsForTarget,
          );
          if (calTask) {
            const now = this.clock.now();
            const assignment: Assignment = {
              id: this.idGen.assignmentId(),
              contributor_id: identity.id,
              task: calTask,
              status: 'offered',
              created_at: now,
              updated_at: now,
            };
            this.store.assignments.set(assignment.id, assignment);
            return { assignment_id: assignment.id, task: calTask };
          }
        }
      }

      const frontier = this.deriveFrontier({ cause_id: parsed.cause_id });
      for (const item of frontier) {
        const task = this.frontierItemToTask(item);
        if (!task) continue;
        if (!wantedKinds.has(taskWorkKind(task))) continue;

        // Conflict-of-interest: skip review tasks for the caller's
        // own proposals.
        if (task.kind === 'review') {
          const target = this.store.proposals.get(task.proposal_id);
          if (!target) continue;
          if (target.proposer_id === identity.id) continue;
          // And skip if the caller has already voted (their
          // contributor-initiated review already attached to the
          // proposal); re-offering would be redundant and the cast_
          // review_vote double-vote guard would reject submission.
          let voted = false;
          for (const v of this.store.reviewVotes.values()) {
            if (v.proposal_id === task.proposal_id && v.reviewer_id === identity.id) {
              voted = true;
              break;
            }
          }
          if (voted) continue;

          // Cross-stratum draw rule (PRD §Reviewer assignment, "prefer
          // not-yet-represented strata first"). When stratification is
          // enabled, skip this proposal for this caller if a co-stratum
          // reviewer is already routed to it (via offered/accepted
          // assignment OR an existing vote). The selector falls through
          // to the next frontier item, which is the only point in the
          // pull model where "another reviewer should take this slot"
          // can be expressed. Falls back to per-stratum saturation only
          // when the pool is otherwise exhausted; the v0 graceful-
          // degradation comes from convergence tightening on the
          // stratification-degraded flag rather than a second pass
          // through this loop.
          if (this.review.stratification_enabled) {
            const route = this.locateProposalForReview(target);
            if (route) {
              const strata = this.computeReviewerStrata(route.cause_id, route.sub_topic_id);
              const callerStratum = this.stratumIdOf(identity.id, strata);
              const routedReviewers = new Set<IdentityId>();
              for (const a of this.store.assignments.values()) {
                if (a.task.kind !== 'review') continue;
                if (a.task.proposal_id !== target.id) continue;
                if (a.status !== 'offered' && a.status !== 'accepted') continue;
                routedReviewers.add(a.contributor_id);
              }
              for (const v of this.store.reviewVotes.values()) {
                if (v.proposal_id === target.id) routedReviewers.add(v.reviewer_id);
              }
              let coStratumAlreadyRouted = false;
              for (const rid of routedReviewers) {
                if (this.stratumIdOf(rid, strata) === callerStratum) {
                  coStratumAlreadyRouted = true;
                  break;
                }
              }
              if (coStratumAlreadyRouted) continue;
            }
          }
        }

        // No double-offer: skip items where the caller already holds
        // an outstanding (offered/accepted) assignment for the same
        // target. Submitted assignments are fine — that's a different
        // proposal that will land separately. Declined assignments
        // also block re-offer to the same contributor: PRD §Capacity and assignment (decline)
        // expects the system to respect "outside my wheelhouse" as a
        // stable signal, not retry the same target on the same
        // contributor in a loop. Different contributors get the
        // target offered independently.
        const taskKey = assignmentTaskKey(task);
        const alreadySeen = callerAssignmentsForTarget.some(
          (a) =>
            a.status !== 'expired' &&
            a.status !== 'submitted' &&
            assignmentTaskKey(a.task) === taskKey,
        );
        if (alreadySeen) continue;

        const now = this.clock.now();
        const assignment: Assignment = {
          id: this.idGen.assignmentId(),
          contributor_id: identity.id,
          task,
          status: 'offered',
          created_at: now,
          updated_at: now,
        };
        this.store.assignments.set(assignment.id, assignment);
        return { assignment_id: assignment.id, task };
      }

      throw new ServerError(
        'not_found',
        `no eligible frontier item for ${identity.id} in cause ${parsed.cause_id}`,
      );
    },

    // PRD §Capacity and assignment (accept_assignment): accept_assignment moves
    // an offered assignment to `accepted`. Idempotent under the same
    // contributor: re-accepting an already-accepted assignment is a
    // no-op error rather than silent — the contributor likely
    // miscounts their queue.
    acceptAssignment: async (
      caller: Caller,
      input: AcceptAssignmentInput,
    ): Promise<AcceptAssignmentOutput> => {
      const parsed = AcceptAssignmentInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      const a = this.requireOwnedOfferedAssignment(parsed.assignment_id, identity.id);
      const now = this.clock.now();
      this.store.assignments.set(a.id, { ...a, status: 'accepted', updated_at: now });
      return { ok: true };
    },

    // PRD §Capacity and assignment (accept_assignment)-115: decline_assignment
    // moves an offered assignment to `declined`. Reason is required
    // and persisted — pattern-decline is an abuse signal handled at
    // the curator layer (PRD §Verification engine (Rate limits and abuse signals): "suspicious patterns ... flag
    // for curator review"), and the reason is what a curator inspects
    // when a pattern surfaces. Declining individual assignments is
    // explicitly non-punitive on its own (PRD §Capacity and assignment (decline)).
    declineAssignment: async (
      caller: Caller,
      input: DeclineAssignmentInput,
    ): Promise<DeclineAssignmentOutput> => {
      const parsed = DeclineAssignmentInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      const a = this.requireOwnedOfferedAssignment(parsed.assignment_id, identity.id);
      const now = this.clock.now();
      this.store.assignments.set(a.id, {
        ...a,
        status: 'declined',
        decline_reason: parsed.reason,
        updated_at: now,
      });
      return { ok: true };
    },

    // PRD §Capacity and assignment (submit_assigned_proposal): submit_assigned_
    // proposal fulfills an *accepted* propose-kind assignment by
    // staging the proposal under it. Review-kind assignments are
    // fulfilled via cast_review_vote with assignment_id set, not
    // through this tool — that's the explicit PRD branch.
    //
    // The shape of this tool is delegation: it validates that the
    // payload matches the task (kind, sub-topic, pinned parents/
    // anchor), routes through the existing propose_* tool method
    // for the matching kind so verification/staging logic stays in
    // one place, and then transitions the assignment to `submitted`
    // with `fulfilled_by` pointing at the new proposal.
    //
    // The propose_* tools don't carry assignment_id today; we patch
    // it onto the persisted Proposal post-stage. The alternative —
    // threading assignment_id through every propose_* signature —
    // is cleaner long-term but adds a parameter to seven tools for
    // one consumer, so the patch-after stays for now. Marked here
    // so the next refactor pass finds it.
    submitAssignedProposal: async (
      caller: Caller,
      input: SubmitAssignedProposalInput,
    ): Promise<SubmitAssignedProposalOutput> => {
      const parsed = SubmitAssignedProposalInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);

      const a = this.store.assignments.get(parsed.assignment_id);
      if (!a) {
        throw new ServerError('not_found', `assignment not found: ${parsed.assignment_id}`);
      }
      if (a.contributor_id !== identity.id) {
        throw new ServerError(
          'unauthorized',
          `assignment ${a.id} does not belong to ${identity.id}`,
        );
      }
      if (a.status !== 'accepted') {
        throw new ServerError('invalid_state', `assignment ${a.id} is ${a.status}`);
      }
      if (a.task.kind === 'review') {
        throw new ServerError(
          'invalid_input',
          'review-kind assignments are fulfilled via cast_review_vote, not submit_assigned_proposal',
        );
      }

      // Payload-task consistency. Each kind cross-checks the task's
      // pinned context against the payload's claim. The wider rep-
      // laundering vector this closes: a contributor can't accept an
      // excerpt assignment then submit an anchor (or an excerpt
      // against a different parent) to satisfy capacity.
      const { payload } = parsed;
      if (payload.kind !== a.task.kind) {
        throw new ServerError(
          'invalid_input',
          `payload kind ${payload.kind} does not match task kind ${a.task.kind}`,
        );
      }
      this.assertPayloadMatchesTask(payload, a.task);

      // Route through the matching propose_* tool. The propose_*
      // methods own all per-kind verification and staging, so we
      // don't re-implement it here.
      const proposalId = await this.routePayloadToProposeTool(caller, payload);

      // Patch assignment_id onto the staged proposal record so
      // downstream consumers (reputation settlement, query_proposals
      // assigned_to_me filter) can see the assignment-fulfillment
      // attribution. See top-of-method comment for the refactor
      // direction.
      const proposal = this.store.proposals.get(proposalId);
      if (proposal) {
        this.store.proposals.set(proposalId, { ...proposal, assignment_id: a.id });
      }

      const now = this.clock.now();
      this.store.assignments.set(a.id, {
        ...a,
        status: 'submitted',
        fulfilled_by: proposalId,
        updated_at: now,
      });

      return { proposal_id: proposalId };
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

    // PRD §Write-path tools (propose_excerpt): propose_excerpt stages an
    // excerpt proposal under an existing accepted anchor, and the
    // server matches `quoted_span` against the resolved source —
    // mismatch rejects at write time, not at review time (PRD §Verification engine, Span verification).
    // The verifier owns the source-fetching boundary; the test
    // FakeVerifier holds source fixtures, the production verifier
    // will fetch. Schema-level checks (non-empty `text`,
    // non-negative `offset`) are necessary but not sufficient.
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
      const parentAnchor = this.requireActiveAnchorInCause(parsed.parent_anchor_id, cause.id);
      // Span must appear in the parent anchor's source. Failure here
      // throws — the proposal is never staged, never assigned, never
      // shown to a reviewer.
      await this.verifier.verifySpan(parentAnchor.external_ref, parsed.quoted_span);

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
    // inconsistency. Both nodes must be active (PRD §Edges:
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
    // smuggling lineage (PRD §Edges). Reviewed by the *target* sub-
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
    // first thing contributors should reach for. PRD §Write-path tools (propose_change_of_home) marks
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
    // curator.deferSubTopic, per PRD §Sub-topic creation). v1 will add auto-
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

    // PRD §Read-path tools and resources (query_frontier): query_frontier
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

    // PRD §Read-path tools and resources (query_proposals): query_proposals
    // returns proposal records, optionally filtered by status, sub-
    // topic, or assignment-to-me. The sub-topic filter routes through
    // locateProposalForReview so the result for a given sub-topic
    // includes membership proposals targeting that sub-topic — which
    // matches where review pressure actually applies (PRD §Scope
    // membership: memberships are evaluated by reviewers from
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
      // Project the derived stratification-degraded flag at read-path
      // (PRD §Reviewer assignment: "visible to the contributor"). No-op
      // when stratification is disabled or the proposal has reached a
      // terminal status — projectStratificationFlag handles both.
      const projected = proposals.map((p) => this.projectStratificationFlag(p));
      return { proposals: projected };
    },

    // PRD §Reputation: contributors see their own raw scores
    // (otherwise they can't reason about where they sit relative to
    // tier gates); other contributors see only tiers via a separate
    // public read-path. v0 returns the caller's per-sub-topic scores
    // for the requested cause, omitting (cause, sub_topic) pairs the
    // caller has zero reputation in (no pollution from sub-topics
    // they've never been routed into).
    queryReputation: async (
      caller: Caller,
      input: QueryReputationInput,
    ): Promise<QueryReputationOutput> => {
      const parsed = QueryReputationInput.parse(input);
      const { identity } = resolveCaller(this.store, caller);
      this.requireActiveCause(parsed.cause_id);
      const entries: ReputationEntry[] = [];
      for (const r of this.store.reputations.values()) {
        if (r.identity_id !== identity.id) continue;
        if (r.cause_id !== parsed.cause_id) continue;
        entries.push({ sub_topic_id: r.sub_topic_id, score: r.score });
      }
      // Stable order so testbed assertions don't depend on Map
      // iteration order.
      entries.sort((a, b) => a.sub_topic_id.localeCompare(b.sub_topic_id));
      return { entries };
    },

    // PRD §Write-path tools (cast_review_vote): reviewer records a vote with
    // required rationale. With assignment_id set, the vote fulfills a
    // review-kind assignment and accrues full assigned-review reputation;
    // without it, the review is contributor-initiated and weighted lower.
    // Self-review is rejected as a conflict-of-interest invariant: the
    // whole point of redundant peer review is that a contributor's own
    // claim be evaluated by other reviewers (PRD §Reviewer assignment
    // and the broader spirit of PRD §Reputation's stance on self-acting on
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
      // Two valid voting paths: (a) staged proposals — the regular
      // review path that drives convergence; (b) accepted proposals
      // reached via assignment — the calibration path, which scores
      // the reviewer against ground truth without re-resolving a
      // proposal that is already settled. The assignment_id requirement
      // on (b) is what tells the system the reviewer received this
      // item via the calibration injection seam in request_assignment;
      // a contributor-initiated cast_review_vote on an already-accepted
      // proposal has no defined semantics (it cannot move convergence,
      // and treating it as calibration would let a reviewer farm rep
      // by self-selecting easy already-accepted items).
      const isCalibration = proposal.status === 'accepted' && parsed.assignment_id !== undefined;
      if (!isCalibration && proposal.status !== 'staged') {
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

      if (isCalibration) {
        // Calibration scoring against ground truth. The proposal
        // survived to acceptance in validated history, so the
        // expected vote is `accept`. PRD §Calibration batches: "Reviewers who
        // fail calibration lose reputation"; PRD §Reputation: "rejected
        // calibration items both decrease reputation." `revise` is a
        // no-op for symmetry with the convergence-driven rep path,
        // which also doesn't move rep on revise (PRD §Reputation-246
        // are silent on revise; treating it as no-op preserves the
        // "reviewer asked for more" signal without forcing it onto
        // a binary scoring axis). The vote does not run convergence
        // — the proposal is already resolved.
        const subTopicId = this.reputationSubTopicFor(proposal);
        const causeId = this.reputationCauseFor(proposal);
        if (subTopicId && causeId && parsed.decision !== 'revise') {
          const delta =
            parsed.decision === 'accept'
              ? this.review.calibration_pass_gain
              : -this.review.calibration_fail_loss;
          this.bumpReputation(identity.id, causeId, subTopicId, delta);
          // Track the pass/fail counts separately from the rep ledger.
          // The convergence-layer defense reads this when calibration-
          // aware vote weighting is enabled; keeping it on a separate
          // counter avoids conflating calibration signal with
          // convergence-vote-accuracy rep, which a coalition can farm.
          this.bumpCalibrationRecord(
            identity.id,
            causeId,
            subTopicId,
            parsed.decision === 'accept' ? 'pass' : 'fail',
          );
        }
        return { vote_id: vote.id };
      }

      // Convergence check: enough accept-votes auto-accepts; enough
      // reject-votes auto-rejects. Threshold is server-config so the
      // testbed can sweep it (PRD §What's deliberately not specified here names this as a tuned
      // parameter). Curator-only kinds short-circuit inside
      // resolveByConvergence and are unaffected.
      this.resolveByConvergence(proposal.id);

      return { vote_id: vote.id };
    },

    // PRD §Calibration batches (lines 200-201): reviewer batches mix
    // real proposals with calibration items drawn from the graph's
    // validated history. Calibration items must be statistically
    // indistinguishable from real frontier work in the dimensions a
    // reviewer can act on — which is why ReviewBatchItem strips
    // status, proposer, created_at, and assignment_id, leaving just
    // proposal_id and payload.
    //
    // v0 sampling: take up to CALIBRATION_BATCH_SIZE accepted
    // proposals routed to the requested sub-topic, biased toward
    // recency (PRD §Calibration batches: "calibration sampling is biased toward
    // fresh-but-validated history"). Rotation policy and adversary-
    // resistant distribution mixing are testbed territory; this is
    // the seam they tune against.
    //
    // Per the comment in tools.ts §ReviewBatchItem, the omissions
    // are deliberate: a reviewer comparing fields between calibration
    // items and live items shouldn't be able to use those fields to
    // distinguish them.
    fetchCalibrationBatch: async (
      caller: Caller,
      input: FetchCalibrationBatchInput,
    ): Promise<FetchCalibrationBatchOutput> => {
      const parsed = FetchCalibrationBatchInput.parse(input);
      resolveCaller(this.store, caller);
      const target = this.store.subTopics.get(parsed.sub_topic_id);
      if (!target) {
        throw new ServerError('not_found', `sub-topic not found: ${parsed.sub_topic_id}`);
      }
      const candidates: Proposal[] = [];
      for (const p of this.store.proposals.values()) {
        if (p.status !== 'accepted') continue;
        const located = this.locateProposalForReview(p);
        if (!located || located.sub_topic_id !== parsed.sub_topic_id) continue;
        candidates.push(p);
      }
      // Recency-biased: sort by created_at descending. Tiebreak by id
      // for replay determinism. The testbed tunes the actual sampling
      // distribution; the recency bias is the published-default the
      // adversary harness should evaluate against.
      candidates.sort((a, b) => {
        if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
        return a.id.localeCompare(b.id);
      });
      const items: ReviewBatchItem[] = candidates
        .slice(0, CALIBRATION_BATCH_SIZE)
        .map((p) => ({ proposal_id: p.id, payload: p.payload }));
      return { items };
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
      return this.acceptStaged(proposal);
    },

    // PRD §Sub-topic creation: "Curator accepts as `active`,
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

  // Promote a staged proposal to accepted: materialize, persist the
  // status flip, and apply the materialization. Shared between the
  // curator's manual path (curator.acceptProposal) and the auto-
  // convergence path that fires after enough accept-votes accumulate
  // (PRD §The contribution flow (Resolve step): convergent vote merges).
  private acceptStaged(proposal: Proposal): { node_id?: NodeId; sub_topic_id?: SubTopicId } {
    const result = this.materialize(proposal, 'active');
    const now = this.clock.now();
    this.store.proposals.set(proposal.id, { ...proposal, status: 'accepted', updated_at: now });
    this.applyMaterialization(result);
    if (result.node) return { node_id: result.node.id };
    const created = result.subTopicCreates[0];
    if (created) return { sub_topic_id: created.id };
    return {};
  }

  // After a review vote lands, check whether the proposal has reached
  // either convergence threshold and resolve it if so. PRD §The contribution flow (Resolve step):
  // convergent vote merges; divergent vote routes to a richer path.
  // The richer-path branch — more reviewers / curator escalation /
  // open_question carry-forward — isn't implemented in v0; this is
  // the "convergent merges, otherwise hold" half. `revise` votes are
  // counted toward neither threshold (revise is "needs work, not
  // yet"); they remain available as a signal for future divergence
  // resolution.
  //
  // Some proposal kinds are curator-only (sub_topic, change_of_home
  // per PRD §Write-path tools (propose_change_of_home) and §Sub-topic creation) and are excluded from auto-resolution
  // even if votes accumulate against them — the votes can still be
  // recorded as a signal for the curator, but they don't move the
  // proposal's status.
  private resolveByConvergence(proposalId: ProposalId): void {
    const proposal = this.store.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'staged') return;
    if (proposal.payload.kind === 'sub_topic' || proposal.payload.kind === 'change_of_home') {
      return;
    }
    // Distinct-reviewer count (the redundant-peer-review invariant)
    // and weighted sum (the calibration-aware bias-resistance signal)
    // run in parallel. With calibration_aware_convergence off, weights
    // are uniformly 1, so the weighted sum equals the count and the
    // two conditions collapse to today's "two distinct accepts ⇒
    // accepted" behavior. With it on, a reviewer whose calibration
    // record went sour contributes 0 to the weighted sum but still 1
    // to the distinct count — meaning one cred-zero reject can hold a
    // convergence open without itself being able to drive it.
    const weighted = this.review.calibration_aware_convergence;
    let acceptCount = 0;
    let rejectCount = 0;
    let acceptWeight = 0;
    let rejectWeight = 0;
    const causeId = weighted ? this.reputationCauseFor(proposal) : null;
    const subTopicId = weighted ? this.reputationSubTopicFor(proposal) : null;
    for (const v of this.store.reviewVotes.values()) {
      if (v.proposal_id !== proposalId) continue;
      if (v.decision === 'accept') {
        acceptCount += 1;
        acceptWeight +=
          weighted && causeId && subTopicId
            ? this.calibrationVoteWeight(v.reviewer_id, causeId, subTopicId)
            : 1;
      } else if (v.decision === 'reject') {
        rejectCount += 1;
        rejectWeight +=
          weighted && causeId && subTopicId
            ? this.calibrationVoteWeight(v.reviewer_id, causeId, subTopicId)
            : 1;
      }
    }
    // Stratification-degraded tightening (PRD §Reviewer assignment).
    // When the eligible pool can't furnish stratum_target_count
    // distinct strata, both convergence thresholds bump by the
    // configured extra. This is the seam that makes the small-sub-
    // topic case slower-but-not-capturable: a coalition that fits the
    // pool can't drive convergence at the standard threshold because
    // the threshold itself moved.
    const degraded = this.isProposalStratificationDegraded(proposal);
    const acceptThreshold =
      this.review.votes_to_accept + (degraded ? this.review.stratification_degraded_extra : 0);
    const rejectThreshold =
      this.review.votes_to_reject + (degraded ? this.review.stratification_degraded_extra : 0);
    if (acceptCount >= acceptThreshold && acceptWeight >= acceptThreshold) {
      this.acceptStaged(proposal);
      this.applyReputationUpdates(proposal, 'accepted');
      return;
    }
    if (rejectCount >= rejectThreshold && rejectWeight >= rejectThreshold) {
      const now = this.clock.now();
      this.store.proposals.set(proposal.id, { ...proposal, status: 'rejected', updated_at: now });
      this.applyReputationUpdates(proposal, 'rejected');
    }
  }

  // Update per-(identity, cause, sub_topic) reputation in response to
  // a proposal converging. PRD §Reputation:
  //
  //   - Proposer's home-sub-topic rep moves with the outcome:
  //     +proposer_accepted_gain on accept, -proposer_rejected_loss on
  //     reject. Contributor-initiated proposals (no assignment_id)
  //     are scaled by `contributor_initiated_factor` per PRD §Reputation
  //     244's "substantially reduced weight" rule.
  //   - Reviewers who voted *with* the converged outcome get
  //     +reviewer_accurate_gain in the home sub-topic; reviewers who
  //     voted against it get -reviewer_inaccurate_loss. Reviewers
  //     accrue rep in the *home* sub-topic of the proposal they
  //     reviewed (membership proposals route to the target sub-topic
  //     for review, but the reviewer's competence-signal accrues
  //     wherever the review effort was spent — which is the location
  //     they were drawn from).
  //   - Curator-only kinds (sub_topic, change_of_home) never reach
  //     this path; resolveByConvergence short-circuits earlier.
  //   - revise votes count for neither tier and earn no rep movement
  //     (they remain available for the divergence-resolution path
  //     when that lands).
  //   - Self-supersedes carve-outs (PRD §Reputation) don't apply yet —
  //     supersedes acceptance updates the from-node's status but
  //     doesn't flow back into this path; supersedes-driven
  //     reputation lands when survivorship weighting does.
  private applyReputationUpdates(proposal: Proposal, outcome: 'accepted' | 'rejected'): void {
    const subTopicId = this.reputationSubTopicFor(proposal);
    if (!subTopicId) return;
    const causeId = this.reputationCauseFor(proposal);
    if (!causeId) return;

    // Proposer delta. Contributor-initiated (no assignment_id) earns
    // reduced weight per PRD §Reputation.
    const proposerFactor = proposal.assignment_id ? 1 : this.review.contributor_initiated_factor;
    const proposerDelta =
      outcome === 'accepted'
        ? this.review.proposer_accepted_gain * proposerFactor
        : -this.review.proposer_rejected_loss * proposerFactor;
    this.bumpReputation(proposal.proposer_id, causeId, subTopicId, proposerDelta);

    // Reviewer deltas. Each unique reviewer gets exactly one delta
    // per convergence — even if they cast multiple votes (which
    // double-vote prevention forbids today, but the dedup is cheap
    // insurance against future revote semantics).
    const seenReviewers = new Set<IdentityId>();
    for (const v of this.store.reviewVotes.values()) {
      if (v.proposal_id !== proposal.id) continue;
      if (seenReviewers.has(v.reviewer_id)) continue;
      seenReviewers.add(v.reviewer_id);
      if (v.decision === 'revise') continue;
      const wasAccurate =
        (v.decision === 'accept' && outcome === 'accepted') ||
        (v.decision === 'reject' && outcome === 'rejected');
      const reviewerDelta = wasAccurate
        ? this.review.reviewer_accurate_gain
        : -this.review.reviewer_inaccurate_loss;
      this.bumpReputation(v.reviewer_id, causeId, subTopicId, reviewerDelta);
    }
  }

  // The sub-topic where reputation accrues for this proposal. For most
  // kinds it's the payload's home_sub_topic_id; for membership
  // proposals it's the target sub-topic (the review pool that judged
  // the scope claim is the one whose reputation pool absorbs the
  // outcome — same pool that voted, same pool that's tier-gated by
  // the score). Returns null for curator-only kinds, which never
  // reach this path anyway.
  private reputationSubTopicFor(proposal: Proposal): SubTopicId | null {
    switch (proposal.payload.kind) {
      case 'anchor':
      case 'excerpt':
      case 'synthesis':
      case 'open_question':
        return proposal.payload.home_sub_topic_id;
      case 'membership':
        return proposal.payload.sub_topic_id;
      case 'supersedes': {
        const fromNode = this.store.nodes.get(proposal.payload.from_node_id);
        return fromNode?.home_sub_topic_id ?? null;
      }
      case 'sub_topic':
      case 'change_of_home':
        return null;
    }
  }

  // Same shape as locateProposalForReview but returning just the
  // cause_id; locateProposalForReview is keyed by sub-topic-route
  // semantics for the frontier, while this tracks the cause for
  // reputation-keying and they happen to coincide today. Kept
  // separate so future divergence in routing rules doesn't muddle
  // the two concerns.
  private reputationCauseFor(proposal: Proposal): CauseId | null {
    return this.locateProposalForReview(proposal)?.cause_id ?? null;
  }

  private bumpReputation(
    identityId: IdentityId,
    causeId: CauseId,
    subTopicId: SubTopicId,
    delta: number,
  ): void {
    if (delta === 0) return;
    const key = `${identityId}|${causeId}|${subTopicId}` as const;
    const existing = this.store.reputations.get(key);
    const now = this.clock.now();
    this.store.reputations.set(key, {
      identity_id: identityId,
      cause_id: causeId,
      sub_topic_id: subTopicId,
      score: (existing?.score ?? 0) + delta,
      updated_at: now,
    });
  }

  private bumpCalibrationRecord(
    identityId: IdentityId,
    causeId: CauseId,
    subTopicId: SubTopicId,
    outcome: 'pass' | 'fail',
  ): void {
    const key = `${identityId}|${causeId}|${subTopicId}` as const;
    const existing = this.store.calibrationRecords.get(key) ?? { passes: 0, fails: 0 };
    this.store.calibrationRecords.set(key, {
      passes: existing.passes + (outcome === 'pass' ? 1 : 0),
      fails: existing.fails + (outcome === 'fail' ? 1 : 0),
    });
  }

  // Vote weight for a reviewer at convergence time when calibration-
  // aware convergence is enabled. weight = max(0, 1 + passes - fails)
  // — base of 1 collapses to count-mode when every reviewer has zero
  // calibration history, so the flag is a strict superset of the
  // count behavior. Negative net record clips to 0: a reviewer whose
  // calibration record went sour cannot move convergence at all.
  private calibrationVoteWeight(
    identityId: IdentityId,
    causeId: CauseId,
    subTopicId: SubTopicId,
  ): number {
    const key = `${identityId}|${causeId}|${subTopicId}` as const;
    const rec = this.store.calibrationRecords.get(key);
    if (!rec) return 1;
    return Math.max(0, 1 + rec.passes - rec.fails);
  }

  // Vote-pattern co-occurrence clustering (PRD §Reviewer assignment,
  // v0 stratum primitive). Two reviewers fall in the same cluster
  // when they have voted on >= stratum_min_shared_proposals shared
  // past proposals AND their pairwise vote agreement on those shared
  // proposals is >= stratum_agreement_threshold. Connected components
  // over those pairwise edges are the strata. Reviewers below the
  // shared-history floor sit in singleton strata, which is the
  // honest-by-default behavior: a brand-new reviewer with no shared
  // history is independent until they prove otherwise.
  //
  // The function is keyed on (cause_id, sub_topic_id) because PRD
  // commits stratification at the per-(cause, sub-topic) level; vote
  // history elsewhere doesn't speak to bias zones in *this* sub-topic.
  // Members are returned as a Map identity -> stratum id; absence
  // means the identity has no votes in this scope and would be its
  // own singleton stratum if drawn into one.
  //
  // Computed on-the-fly per call. Cheap for v0 testbed pool sizes;
  // a per-(cause, sub-topic) cache with vote-cast invalidation is the
  // production move once pool sizes warrant it.
  private computeReviewerStrata(causeId: CauseId, subTopicId: SubTopicId): Map<IdentityId, string> {
    // Per-reviewer vote history scoped to (cause, sub-topic):
    // proposal_id -> decision, but only for proposals whose home
    // sub-topic matches subTopicId AND whose cause matches causeId.
    // Use the same locateProposalForReview routing the rest of the
    // server uses so membership-cause-routing stays consistent.
    const reviewerVotes = new Map<IdentityId, Map<ProposalId, ReviewDecision>>();
    for (const v of this.store.reviewVotes.values()) {
      const proposal = this.store.proposals.get(v.proposal_id);
      if (!proposal) continue;
      const route = this.locateProposalForReview(proposal);
      if (!route) continue;
      if (route.cause_id !== causeId) continue;
      if (route.sub_topic_id !== subTopicId) continue;
      // revise votes carry no agreement signal in either direction —
      // they mean "needs work, not yet" rather than a position. Drop
      // them from cluster computation.
      if (v.decision === 'revise') continue;
      let perReviewer = reviewerVotes.get(v.reviewer_id);
      if (!perReviewer) {
        perReviewer = new Map();
        reviewerVotes.set(v.reviewer_id, perReviewer);
      }
      // Defensive: if a reviewer has multiple non-revise votes on the
      // same proposal (current double-vote guard prevents this, but
      // future revote semantics may relax it), the latest cast wins —
      // it's the reviewer's standing position.
      perReviewer.set(v.proposal_id, v.decision);
    }

    // Per-proposal vote tallies, used to compute contention weights
    // when stratum_contention_weighted is on. We tally over all
    // (cause, sub-topic)-scoped non-revise votes — the same vote set
    // that feeds the pairwise edge loop below — so contention
    // reflects the broader pool's split on each proposal. Computed
    // once outside the O(N²) pair loop.
    const proposalTally = new Map<ProposalId, { accepts: number; rejects: number }>();
    if (this.review.stratum_contention_weighted) {
      for (const perReviewer of reviewerVotes.values()) {
        for (const [pid, decision] of perReviewer) {
          let t = proposalTally.get(pid);
          if (!t) {
            t = { accepts: 0, rejects: 0 };
            proposalTally.set(pid, t);
          }
          if (decision === 'accept') t.accepts += 1;
          else if (decision === 'reject') t.rejects += 1;
        }
      }
    }

    // Pairwise edge build. We iterate reviewers in a stable order to
    // make cluster id assignment deterministic — same vote state =
    // same cluster ids.
    const reviewers = [...reviewerVotes.keys()].sort();
    const adjacency = new Map<IdentityId, Set<IdentityId>>();
    for (const r of reviewers) adjacency.set(r, new Set());
    for (let i = 0; i < reviewers.length; i++) {
      const a = reviewers[i];
      if (!a) continue;
      const va = reviewerVotes.get(a);
      if (!va) continue;
      for (let j = i + 1; j < reviewers.length; j++) {
        const b = reviewers[j];
        if (!b) continue;
        const vb = reviewerVotes.get(b);
        if (!vb) continue;
        let shared = 0;
        let agreed = 0;
        let weightedShared = 0;
        let weightedAgreed = 0;
        for (const [pid, decisionA] of va) {
          const decisionB = vb.get(pid);
          if (!decisionB) continue;
          shared += 1;
          const agree = decisionA === decisionB;
          if (agree) agreed += 1;
          if (this.review.stratum_contention_weighted) {
            const tally = proposalTally.get(pid);
            if (tally) {
              const total = tally.accepts + tally.rejects;
              if (total > 0) {
                const minor = Math.min(tally.accepts, tally.rejects);
                // Contention in [0,1]: 0 when unanimous, 1 at perfect
                // split. Captures how informative this shared vote is
                // about coalition signal — agreement on uncontentious
                // proposals carries no weight, agreement on split-pool
                // proposals carries the most.
                const contention = (2 * minor) / total;
                weightedShared += contention;
                if (agree) weightedAgreed += contention;
              }
            }
          }
        }
        if (shared < this.review.stratum_min_shared_proposals) continue;
        // Compute both the agreement and disagreement ratios up-front
        // (in raw or contention-weighted form) so the agreement-edge
        // and anti-correlation-edge checks share their ratio source
        // and can never disagree on what "shared" means.
        let agreementRatio = 0;
        let disagreementRatio = 0;
        let signalAvailable = false;
        if (this.review.stratum_contention_weighted) {
          if (weightedShared > 0) {
            agreementRatio = weightedAgreed / weightedShared;
            disagreementRatio = (weightedShared - weightedAgreed) / weightedShared;
            signalAvailable = true;
          }
        } else {
          agreementRatio = agreed / shared;
          disagreementRatio = (shared - agreed) / shared;
          signalAvailable = true;
        }
        // No signal: the pair's entire shared history sits on
        // unanimous proposals (under contention weighting). Brand-new-
        // reviewer floor is preserved by the raw shared-count check
        // above; this is the additional gate that prevents a
        // contention-zero history from forming either kind of edge.
        if (!signalAvailable) continue;
        const positiveEdge = agreementRatio >= this.review.stratum_agreement_threshold;
        const antiThreshold = this.review.stratum_anti_correlation_threshold;
        const negativeEdge = antiThreshold > 0 && disagreementRatio >= antiThreshold;
        if (!positiveEdge && !negativeEdge) continue;
        adjacency.get(a)?.add(b);
        adjacency.get(b)?.add(a);
      }
    }

    // Connected-components over the agreement graph. Component id is
    // the lexicographically smallest identity in the component, which
    // gives stable ids across calls.
    const cluster = new Map<IdentityId, string>();
    for (const r of reviewers) {
      if (cluster.has(r)) continue;
      const queue: IdentityId[] = [r];
      const componentId = r;
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) continue;
        if (cluster.has(cur)) continue;
        cluster.set(cur, componentId);
        const neighbors = adjacency.get(cur);
        if (!neighbors) continue;
        for (const next of neighbors) {
          if (!cluster.has(next)) queue.push(next);
        }
      }
    }
    return cluster;
  }

  // Stratum a given identity occupies in (cause, sub-topic). Returns
  // the cluster id from computeReviewerStrata, or — if the identity
  // has no votes in scope yet — a singleton-stratum id keyed on the
  // identity itself. Singleton ids are formatted distinctly so they
  // can never collide with a multi-member cluster id.
  private stratumIdOf(identityId: IdentityId, strata: Map<IdentityId, string>): string {
    return strata.get(identityId) ?? `singleton:${identityId}`;
  }

  // Eligible-pool snapshot for a proposal: every identity that has
  // declared cause-level capacity covering review work, minus the
  // proposer (PRD §Reviewer assignment conflict-of-interest invariant
  // mirrored from cast_review_vote). Used by the stratification-
  // degraded check to count reachable strata.
  //
  // Doesn't filter on rep tier yet — v0 has no rep gate at the
  // assignment surface; that lands when sufficient-rep eligibility
  // does. Doesn't filter out identities who already voted, either —
  // their vote already counted, and the diversity question is about
  // whether the *pool* could have been diverse, not about who is
  // still pullable right now.
  private eligibleReviewerPool(proposal: Proposal): IdentityId[] {
    const route = this.locateProposalForReview(proposal);
    if (!route) return [];
    const pool: IdentityId[] = [];
    for (const cap of this.store.capacities.values()) {
      if (cap.cause_id !== route.cause_id) continue;
      if (!cap.kinds.includes('review')) continue;
      if (cap.identity_id === proposal.proposer_id) continue;
      pool.push(cap.identity_id);
    }
    return pool;
  }

  // Stratification-degraded check (PRD §Reviewer assignment). True
  // when the eligible reviewer pool covers fewer than
  // stratum_target_count distinct strata. False when stratification
  // is disabled (the flag's behavior is opt-in, mirroring the
  // calibration-aware-convergence pattern). A reviewer with no votes
  // in scope counts as their own singleton stratum, so a thin-history
  // pool is *not* automatically degraded — each reviewer is a stratum
  // until they prove correlated. The degradation case is a pool with
  // history that has already collapsed into too few clusters.
  private isProposalStratificationDegraded(proposal: Proposal): boolean {
    if (!this.review.stratification_enabled) return false;
    const route = this.locateProposalForReview(proposal);
    if (!route) return false;
    const pool = this.eligibleReviewerPool(proposal);
    if (pool.length === 0) return true;
    const strata = this.computeReviewerStrata(route.cause_id, route.sub_topic_id);
    const reachable = new Set<string>();
    for (const identityId of pool) {
      reachable.add(this.stratumIdOf(identityId, strata));
    }
    return reachable.size < this.review.stratum_target_count;
  }

  // Project the stratification-degraded flag onto a Proposal record at
  // read-path time. Returns the input record unchanged when the flag
  // is disabled or the proposal is past staging — terminal proposals
  // don't need a derived diversity signal, and stamping one would
  // muddle their record.
  private projectStratificationFlag(proposal: Proposal): Proposal {
    if (!this.review.stratification_enabled) return proposal;
    if (proposal.status !== 'staged') return proposal;
    return {
      ...proposal,
      stratification_degraded: this.isProposalStratificationDegraded(proposal),
    };
  }

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
  // accept variants (PRD §Sub-topic creation: accept-as-active or defer-as-
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
      // The active-node rule (PRD §Nodes) defines a node as
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
