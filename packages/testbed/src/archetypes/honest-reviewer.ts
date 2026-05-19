import type { CauseId, ProposalPayload, ReviewDecision } from '@anchorage/contracts';
import { type AnchorageClient, AnchorageClientError } from '../client.js';

// honest-reviewer: a contributor that pulls review assignments and
// votes on them. The decision is delegated to a `decide` callback so
// the archetype can host different reviewer behaviors over the same
// loop machinery. The wired deciders below cover the lazy /
// strategic-coalition axes of the adversary taxonomy:
// `acceptAllDecider` is the always-accept lazy reviewer that
// calibration injection traps when a calibration item lands
// reject-worthy in context (calibration items are accepted-from-
// validated-history proposals, scored against ground truth on
// `cast_review_vote`); `payloadBiasedDecider` is the strategic-
// adversary primitive (configurable hidden objective + biased
// rationale strings). The decline-pattern axis is gone: the
// single-slot model (PRD §Assignment) removes decline entirely, so
// decline-shopping and decline-ring abuse cannot occur and need no
// archetype.
//
// The rationale string is part of the contract — PRD §Write-path
// tools (cast_review_vote) requires a rationale on every vote. The `decide` callback supplies
// it alongside the decision.

export interface ReviewDecisionWithRationale {
  decision: ReviewDecision;
  rationale: string;
}

export interface ReviewDecider {
  // Given the proposal payload (the fields a reviewer can see — the
  // ReviewBatchItem contract strips status/proposer/created_at),
  // produce a decision and a rationale. There is no "decline this
  // one" return: the single-slot model (PRD §Assignment) has no
  // decline, and competence-based opt-out is incoherent under it
  // (all review work is corpus judgement any contributor can pull).
  decide(payload: ProposalPayload): ReviewDecisionWithRationale;
}

export interface HonestReviewerConfig {
  cause_id: CauseId;
  decide: ReviewDecider;
}

export type HonestReviewerAction =
  | { kind: 'requested'; assignment_id: string; proposal_id: string }
  | { kind: 'voted'; assignment_id: string; decision: ReviewDecision; vote_id: string }
  | { kind: 'idle'; reason: string };

export interface HonestReviewerResult {
  actions: HonestReviewerAction[];
}

// A common decider: accept everything with a generic rationale. This
// is the lenient-honest baseline; a pure measure of "does the loop
// converge?" without modeling reviewer judgment. Adversary variants
// (always-reject, calibration-trip, etc.) implement the same
// interface.
export const acceptAllDecider: ReviewDecider = {
  decide: () => ({ decision: 'accept', rationale: 'spot-checked, looks correct' }),
};

// A common decider: reject everything. The "principled adversary"
// shape is "accept everything," but reject-all is useful as the
// counterpart for testing the rejection-convergence path. PRD
// §Adversary taxonomy includes the lazy-reject pattern as a wedge
// against productive consensus.
export const rejectAllDecider: ReviewDecider = {
  decide: () => ({ decision: 'reject', rationale: 'declined as out of scope' }),
};

// A common decider: vote `revise` on everything. Not endorsing,
// not rejecting outright — the careful "this needs work" signal.
// The v0 escalation tally ignored revise votes; the v1 knob
// `ReviewConfig.escalation_revise_counts_as_reject` counts them
// toward reject. Pairing this with `acceptAllDecider` +
// `rejectAllDecider` in a 3-reviewer scenario is the smallest
// fixture that reads the load-bearing v0/v1 delta (1 accept + 1
// reject + 1 revise → accept under v0, reject under v1).
export const reviseAllDecider: ReviewDecider = {
  decide: () => ({ decision: 'revise', rationale: 'needs work but not outright wrong' }),
};

// Payload-biased decider: votes accept when `acceptIf(payload)` is
// true, reject otherwise. The strategic-adversary archetype (PRD
// §Adversary taxonomy, Strategic adversary — "hidden-objective
// model — instructed to bias the graph toward outcome X while
// passing calibration") is built from this primitive: the predicate
// is the hidden objective. Coalitions are just N reviewers sharing
// the same predicate — assignment is system-driven so the
// coalition's leverage is vote bias, not vote selection (PRD §Why
// assignment-driven contribution closes several attack surfaces:
// "Coalition pre-arrangement closed by construction").
//
// The rationale strings are surfaced over the wire and visible to
// reviewers and curators. A real strategic adversary would phrase
// rationales innocuously; the configurable strings let scenarios
// model that. Calibration is the v0-wired defense that detects bias
// despite innocuous rationales: assignment-injected items drawn from
// validated history, scored against ground truth on `cast_review_vote`
// (PRD §Calibration batches). The strategic-coalition standalone
// scenarios exercise both halves — the rep-ledger cost on bias-
// misaligned calibration items, and the calibration-aware convergence
// weighting that compounds it. The calibration-aware variant of the
// strategic archetype (votes with ground truth on calibration items
// but biased on real proposals) is the bypass that the calibration-
// aware-coalition standalone scenario pins, with stratification + the
// cluster-signal refinements (contention-weighted, anti-correlation)
// as the next layers the testbed exercises.
export interface PayloadBiasedDeciderConfig {
  acceptIf: (payload: ProposalPayload) => boolean;
  rationaleAccept?: string;
  rationaleReject?: string;
}

export function payloadBiasedDecider(config: PayloadBiasedDeciderConfig): ReviewDecider {
  const accept = config.rationaleAccept ?? 'aligned with my read of the literature';
  const reject = config.rationaleReject ?? 'inconsistent with my read of the literature';
  return {
    decide: (payload) =>
      config.acceptIf(payload)
        ? { decision: 'accept', rationale: accept }
        : { decision: 'reject', rationale: reject },
  };
}

export async function runHonestReviewer(
  client: AnchorageClient,
  config: HonestReviewerConfig,
): Promise<HonestReviewerResult> {
  const actions: HonestReviewerAction[] = [];

  const MAX_ITERATIONS = 1000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let offered: Awaited<ReturnType<AnchorageClient['requestAssignment']>>;
    try {
      offered = await client.requestAssignment({
        cause_id: config.cause_id,
        kind: 'review',
      });
    } catch (err) {
      if (err instanceof AnchorageClientError) {
        actions.push({ kind: 'idle', reason: err.code });
        return { actions };
      }
      throw err;
    }

    if (offered.task.kind !== 'review') {
      // Unreachable given the `kind: 'review'` filter; a non-review
      // offer is a server bug. No decline channel (PRD §Assignment).
      actions.push({ kind: 'idle', reason: 'unexpected_task_kind' });
      return { actions };
    }

    // Pin the review-task fields locally so async callbacks below
    // don't lose the discriminated-union narrowing across `await`s
    // and closures.
    const reviewProposalId = offered.task.proposal_id;
    actions.push({
      kind: 'requested',
      assignment_id: offered.assignment_id,
      proposal_id: reviewProposalId,
    });

    // To decide the reviewer needs the proposal payload.
    // ReviewBatchItem (PRD §Calibration batches) is the canonical
    // reviewer view; for v0
    // we get it via query_proposals filtered to assigned-to-me, then
    // look up the specific proposal_id. We deliberately do *not*
    // filter by status here: a review-kind assignment may target a
    // staged proposal (real review) or an accepted proposal
    // (calibration injection per PRD §Calibration batches), and the
    // reviewer is supposed to be unable to tell them apart. Filtering
    // on status would leak the seam to the decider via "I got an item
    // that's never returned to me" and break the indistinguishability
    // commitment. The decider only sees `target.payload`, which is
    // identical in shape across both.
    const { proposals } = await client.queryProposals({ assigned_to_me: true });
    const target = proposals.find((p) => p.id === reviewProposalId);
    if (!target) {
      // Race: the proposal vanished between our offer and our lookup
      // (a curator-side action — proposals don't otherwise disappear).
      // With no decline channel (PRD §Assignment) the held slot
      // stalls until the precondition-lapse / TTL shadow path
      // recovers it, so the archetype stops rather than guess.
      actions.push({ kind: 'idle', reason: 'proposal_not_visible' });
      return { actions };
    }

    const decision = config.decide.decide(target.payload);

    const { vote_id } = await client.castReviewVote({
      proposal_id: reviewProposalId,
      decision: decision.decision,
      rationale: decision.rationale,
      assignment_id: offered.assignment_id,
    });
    actions.push({
      kind: 'voted',
      assignment_id: offered.assignment_id,
      decision: decision.decision,
      vote_id,
    });
  }

  actions.push({ kind: 'idle', reason: 'iteration_bound_reached' });
  return { actions };
}
