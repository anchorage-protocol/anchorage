import type { CauseId } from '@anchorage/contracts';
import { type AnchorageClient, AnchorageClientError } from '../client.js';
import type { ContentProvider } from './honest-strong.js';

// honest-weak: PRD §Adversary taxonomy (Honest-weak) — "modest-
// capability honest contributor (e.g. small local model). Should
// largely succeed; failure-to-contribute rate measures friction."
// The archetype is the operational test of the friction claim:
// whatever fraction of work the contributor *fails* to land, that's
// the friction the regime is imposing on legitimate weak contributors.
//
// The behavioral signature that distinguishes honest-weak from both
// honest-strong and hallucinator:
//
//   - Honest-strong: every accepted assignment produces a verifying
//     span; success rate is 1.
//   - Hallucinator: every accepted assignment produces a fabricated
//     span; success rate is 0. Rate budget burns down to idle.
//   - Honest-weak: most accepted assignments verify, some don't —
//     not from bad faith but from a weaker model occasionally
//     producing near-but-wrong spans. Success rate sits between 0
//     and 1, and *that fraction is the friction measurement*.
//
// Implementation: structurally the same loop as honest-strong, with
// one crucial difference — verifier rejection is caught, recorded
// as `submit_rejected`, and the loop continues. Honest-strong
// propagates verifier errors because by contract its content
// provider only returns verifying spans; if it throws at the
// verifier, that's a bug. Honest-weak's contract is the opposite:
// the content provider may return wrong spans, and that's expected.
//
// Like the hallucinator, a verifier rejection leaves the assignment
// `accepted` (the status flip to `submitted` only happens after the
// propose_* layer returns). Under the single-slot model (PRD
// §Assignment) that wedges the contributor's one slot: the next
// request_assignment answers not_found until the slot is recovered
// by TTL shadow-reassignment, so a weak contributor that fails
// verification is parked rather than free to keep churning. Friction
// is paid as: the proposal never reaches `staged`, and the slot is
// held until shadow recovery. Both are measurable via the action log.
//
// Decision intentionally pushed to the ContentProvider: this
// archetype takes the same ContentProvider interface as honest-
// strong and runs whatever spans it returns through the verifier.
// "Weakness" is modeled by the caller's provider — for the
// friction-rate test, a deterministic every-Nth-mismatch provider;
// for richer simulations, a model-driven one. Keeping the archetype
// dumb about competence-modeling means the same loop covers any
// weak-contributor variant a future test wants to add.

export interface HonestWeakConfig {
  cause_id: CauseId;
  content: ContentProvider;
}

export type HonestWeakAction =
  | { kind: 'requested'; assignment_id: string; task_kind: string }
  | { kind: 'submitted'; assignment_id: string; proposal_id: string }
  | { kind: 'submit_rejected'; assignment_id: string; code: string }
  | { kind: 'idle'; reason: string };

export interface HonestWeakResult {
  actions: HonestWeakAction[];
}

export async function runHonestWeak(
  client: AnchorageClient,
  config: HonestWeakConfig,
): Promise<HonestWeakResult> {
  const actions: HonestWeakAction[] = [];

  const MAX_ITERATIONS = 1000;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let offered: Awaited<ReturnType<AnchorageClient['requestAssignment']>>;
    try {
      offered = await client.requestAssignment({
        cause_id: config.cause_id,
        kind: 'excerpt',
      });
    } catch (err) {
      if (err instanceof AnchorageClientError) {
        actions.push({ kind: 'idle', reason: err.code });
        return { actions };
      }
      throw err;
    }
    actions.push({
      kind: 'requested',
      assignment_id: offered.assignment_id,
      task_kind: offered.task.kind,
    });

    if (offered.task.kind !== 'excerpt') {
      // Unreachable given the `kind: 'excerpt'` filter; a non-excerpt
      // offer is a server bug. No decline channel (PRD §Assignment) —
      // record a defect signal and stop.
      actions.push({ kind: 'idle', reason: 'unexpected_task_kind' });
      return { actions };
    }

    const excerpt = config.content.forAnchor(offered.task.parent_anchor_id);
    if (!excerpt) {
      // Weakness is modeled as wrong spans, not absent ones; a null
      // is a fixture defect. With no decline the held slot stalls
      // until TTL shadow-reassignment, so the archetype stops.
      actions.push({ kind: 'idle', reason: 'no_content' });
      return { actions };
    }

    try {
      const submitted = await client.proposeExcerpt({
        cause_id: offered.task.cause_id,
        home_sub_topic_id: offered.task.sub_topic_id,
        parent_anchor_id: offered.task.parent_anchor_id,
        content: excerpt.content,
        quoted_span: excerpt.quoted_span,
        assignment_id: offered.assignment_id,
      });
      actions.push({
        kind: 'submitted',
        assignment_id: offered.assignment_id,
        proposal_id: submitted.proposal_id,
      });
    } catch (err) {
      if (!(err instanceof AnchorageClientError)) throw err;
      actions.push({
        kind: 'submit_rejected',
        assignment_id: offered.assignment_id,
        code: err.code,
      });
    }
  }

  actions.push({ kind: 'idle', reason: 'iteration_bound_reached' });
  return { actions };
}
