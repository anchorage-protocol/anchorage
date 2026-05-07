import type { CauseId, ProposalPayload, ReviewDecision } from '@anchorage/contracts';
import { type AnchorageClient, AnchorageClientError } from '../client.js';

// honest-reviewer: a contributor that pulls review assignments and
// votes on them. The decision is delegated to a `decide` callback so
// the archetype can host different reviewer behaviors over the same
// loop machinery — accept-all (the simplest honest baseline), the
// "principled reviewer" (decides based on the payload's grounding),
// or future adversary variants like "always-accept lazy reviewer"
// (the calibration-trip test target — calibration items are accepted
// proposals from validated history; a lazy-accept reviewer trips
// calibration as soon as a calibration item is reject-worthy in
// context).
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
  // produce a decision and a rationale. Return `null` to decline the
  // assignment instead of voting (e.g. "outside my expertise").
  decide(payload: ProposalPayload): ReviewDecisionWithRationale | null;
}

export interface HonestReviewerConfig {
  cause_id: CauseId;
  rate: number;
  decide: ReviewDecider;
}

export type HonestReviewerAction =
  | { kind: 'set_capacity' }
  | { kind: 'requested'; assignment_id: string; proposal_id: string }
  | { kind: 'voted'; assignment_id: string; decision: ReviewDecision; vote_id: string }
  | { kind: 'declined'; assignment_id: string; reason: string }
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
// model that. Calibration's job (Phase-2 work) is to detect bias
// despite innocuous rationales by seeding the batch with proposals
// of known ground truth.
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

// Payload-conditional decline: returns null (decline the
// assignment) when `declineIf(payload)` is true, falling through to
// `fallback` otherwise. The "decline-pattern abuse" archetype (PRD
// §Adversary testbed: declining everything outside the adversary's
// preferred sub-topic) is a one-line composition built on this:
// declineIf returns true for proposals outside the adversary's
// preferred shape, fallback is whatever vote they cast on the
// shape they accept. The decline path is non-punitive on its own
// (PRD §Capacity and assignment) — it is the *pattern* that the
// curator-side decline-pattern projection picks up.
export interface PayloadDecliningDeciderConfig {
  declineIf: (payload: ProposalPayload) => boolean;
  fallback: ReviewDecider;
}

export function payloadDecliningDecider(config: PayloadDecliningDeciderConfig): ReviewDecider {
  return {
    decide: (payload) => (config.declineIf(payload) ? null : config.fallback.decide(payload)),
  };
}

export async function runHonestReviewer(
  client: AnchorageClient,
  config: HonestReviewerConfig,
): Promise<HonestReviewerResult> {
  const actions: HonestReviewerAction[] = [];

  await client.setCapacity({
    cause_id: config.cause_id,
    rate: config.rate,
    kinds: ['review'],
  });
  actions.push({ kind: 'set_capacity' });

  const MAX_ITERATIONS = 1000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let offered: Awaited<ReturnType<AnchorageClient['requestAssignment']>>;
    try {
      offered = await client.requestAssignment({ cause_id: config.cause_id });
    } catch (err) {
      if (err instanceof AnchorageClientError) {
        actions.push({ kind: 'idle', reason: err.code });
        return { actions };
      }
      throw err;
    }

    if (offered.task.kind !== 'review') {
      // Reviewer archetype only handles review tasks. Honest decline.
      await client.declineAssignment({
        assignment_id: offered.assignment_id,
        reason: `honest-reviewer doesn't handle ${offered.task.kind} tasks`,
      });
      actions.push({
        kind: 'declined',
        assignment_id: offered.assignment_id,
        reason: 'unhandled task kind',
      });
      continue;
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
      // Race: the proposal vanished between our offer and our
      // lookup (a curator-side action — proposals don't otherwise
      // disappear). Decline rather than guess.
      await client.declineAssignment({
        assignment_id: offered.assignment_id,
        reason: 'proposal not visible',
      });
      actions.push({
        kind: 'declined',
        assignment_id: offered.assignment_id,
        reason: 'proposal not visible',
      });
      continue;
    }

    const decision = config.decide.decide(target.payload);
    if (!decision) {
      await client.declineAssignment({
        assignment_id: offered.assignment_id,
        reason: 'outside expertise',
      });
      actions.push({
        kind: 'declined',
        assignment_id: offered.assignment_id,
        reason: 'outside expertise',
      });
      continue;
    }

    await client.acceptAssignment({ assignment_id: offered.assignment_id });
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
