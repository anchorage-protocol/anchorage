import type { CauseId } from '@anchorage/contracts';
import { type AnchorageClient, AnchorageClientError } from '../client.js';

// hallucinator: PRD adversary taxonomy line 305 — "high-temperature
// model with no grounding discipline. Should be caught at the
// verification engine (span mismatch, unresolved citations) before
// review." This archetype is the operational test of that claim. It
// pulls excerpt assignments and submits excerpts whose `quoted_span`
// is fabricated — text that does not appear in the parent anchor's
// source. The server's span verifier rejects at write time
// (ServerError invalid_input).
//
// After a verifier rejection the assignment stays `accepted` (the
// status flip to `submitted` only happens after the propose_* layer
// returns). decline_assignment requires `offered`, so the archetype
// can't tidy up — and it shouldn't anyway, because a real adversary
// wouldn't volunteer to clear its own failed slots. The capacity slot
// stays consumed; under rate=N the hallucinator wedges at N stuck
// `accepted` assignments across N distinct anchors and then goes
// idle. That's the right shape for the testbed: the cost of
// hallucinating is paid in rate-budget exhaustion, which the harness
// will measure as a throughput metric in later sweeps.
//
// The Phase-1 measurement claim that hangs on this archetype:
//
//   - No fabricated excerpt ever reaches `staged`, so no reviewer is
//     burned reading it.
//   - The hallucinator earns no reputation in either direction —
//     verification-rejected proposals are not the same as
//     review-rejected ones (ProposalStatus comment in
//     @anchorage/contracts: `rejected` means review-rejected; this
//     path never creates a proposal record at all).
//
// Both are observable through tools alone — query_proposals returns
// nothing of kind 'excerpt', query_reputation returns no entry — so
// the testbed can assert them without server internals.
//
// The fabricator is a callback so future variants (calibration-aware
// hallucinator that fabricates only on uncalibrated tasks; partial
// hallucinator that fabricates a fraction of submissions) can share
// the same loop. The default fabricator returns a fixed
// not-in-source string for every anchor.

export interface HallucinatedExcerpt {
  content: string;
  quoted_span: { text: string; offset: number };
}

export interface HallucinationFabricator {
  fabricateForAnchor(anchorId: string): HallucinatedExcerpt;
}

export interface HallucinatorConfig {
  cause_id: CauseId;
  rate: number;
  fabricator: HallucinationFabricator;
}

export type HallucinatorAction =
  | { kind: 'set_capacity' }
  | { kind: 'requested'; assignment_id: string; task_kind: string }
  | { kind: 'accepted'; assignment_id: string }
  | { kind: 'declined'; assignment_id: string; reason: string }
  // The signature failure mode: submit threw at the verifier seam.
  // The action records the typed code so the harness can distinguish
  // verifier rejections from other failures (e.g. invalid_state) when
  // measuring attack success rates.
  | { kind: 'submit_rejected'; assignment_id: string; code: string }
  | { kind: 'idle'; reason: string };

export interface HallucinatorResult {
  actions: HallucinatorAction[];
}

// Default fabricator: returns the same not-in-any-real-source string
// for every anchor. Enough to test the verifier seam; sweep variants
// can swap in something more elaborate.
export const constantFabricator: HallucinationFabricator = {
  fabricateForAnchor: () => ({
    content: 'fabricated synthesis with no source grounding',
    quoted_span: { text: 'this exact sentence does not appear in the source', offset: 0 },
  }),
};

export async function runHallucinator(
  client: AnchorageClient,
  config: HallucinatorConfig,
): Promise<HallucinatorResult> {
  const actions: HallucinatorAction[] = [];

  await client.setCapacity({
    cause_id: config.cause_id,
    rate: config.rate,
    kinds: ['excerpt'],
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
    actions.push({
      kind: 'requested',
      assignment_id: offered.assignment_id,
      task_kind: offered.task.kind,
    });

    if (offered.task.kind !== 'excerpt') {
      await client.declineAssignment({
        assignment_id: offered.assignment_id,
        reason: `hallucinator only handles excerpt tasks, got ${offered.task.kind}`,
      });
      actions.push({
        kind: 'declined',
        assignment_id: offered.assignment_id,
        reason: 'unhandled task kind',
      });
      continue;
    }

    await client.acceptAssignment({ assignment_id: offered.assignment_id });
    actions.push({ kind: 'accepted', assignment_id: offered.assignment_id });

    const fabricated = config.fabricator.fabricateForAnchor(offered.task.parent_anchor_id);

    try {
      await client.submitAssignedProposal({
        assignment_id: offered.assignment_id,
        payload: {
          kind: 'excerpt',
          cause_id: offered.task.cause_id,
          home_sub_topic_id: offered.task.sub_topic_id,
          parent_anchor_id: offered.task.parent_anchor_id,
          content: fabricated.content,
          quoted_span: fabricated.quoted_span,
        },
      });
      // If we got here the verifier let a fabricated span through —
      // a verifier failure, not the archetype's. The scenario test
      // catches this via "no staged excerpts" assertions; the loop
      // just keeps going.
    } catch (err) {
      if (!(err instanceof AnchorageClientError)) throw err;
      actions.push({
        kind: 'submit_rejected',
        assignment_id: offered.assignment_id,
        code: err.code,
      });
      // No tidy-up: the assignment stays `accepted` and burns a rate
      // slot for the rest of the loop. See top-of-file comment.
    }
  }

  actions.push({ kind: 'idle', reason: 'iteration_bound_reached' });
  return { actions };
}
