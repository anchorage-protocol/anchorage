import type { CauseId, WorkKind } from '@anchorage/contracts';
import { type AnchorageClient, AnchorageClientError } from '../client.js';

// honest-strong: a competent, well-intentioned contributor (PRD
// §Adversary taxonomy names this archetype as "Honest-strong:
// frontier-model honest contributor on hard synthesis tasks. Should
// succeed even on cases where simpler contributors stall."). For the v0 walking
// skeleton the archetype is much narrower than that aspirational
// definition: it pulls excerpt assignments under an active cause and
// fulfills them with verbatim spans pulled from a fixture map.
//
// The archetype is *deterministic* given its inputs. Randomness in
// the simulation belongs at a higher layer (population mixing, task
// arrival order, decline-pattern injection); the archetype itself
// behaves the same way on the same inputs so failures replay.
//
// Archetype contract:
//
//   - Take an AnchorageClient (already connected to a server).
//   - Take a cause to work on and a content provider that can produce
//     a quoted span + content for any orphan anchor it gets assigned.
//   - Run until no more eligible assignments are available, recording
//     a small log of what it did.
//
// Future archetypes (lazy, hallucinator, strategic adversary, …) all
// implement the same shape but with different behaviors — selective
// declines, fabricated spans, calibration-trip targeting, etc.

export interface ContentForExcerpt {
  content: string;
  quoted_span: { text: string; offset: number };
}

export interface ContentProvider {
  // Given a parent anchor's id, produce a verbatim span + a
  // paraphrased atomic claim. v0 looks the value up in a fixture map;
  // a full implementation would call out to a model. Returning
  // `null` means "I can't produce work for this anchor" — the
  // archetype declines the assignment with that reason.
  forAnchor(anchorId: string): ContentForExcerpt | null;
}

export interface HonestStrongConfig {
  cause_id: CauseId;
  rate: number;
  // The archetype declares capacity for these kinds. v0 only
  // implements excerpt fulfillment (PRD's frontier-mapping covers
  // orphan_anchor → excerpt and needs_review → review; review
  // archetype lands in a follow-up).
  kinds: WorkKind[];
  content: ContentProvider;
}

export type HonestStrongAction =
  | { kind: 'set_capacity' }
  | { kind: 'requested'; assignment_id: string; task_kind: string }
  | { kind: 'accepted'; assignment_id: string }
  | { kind: 'declined'; assignment_id: string; reason: string }
  | { kind: 'submitted'; assignment_id: string; proposal_id: string }
  | { kind: 'idle'; reason: string };

export interface HonestStrongResult {
  actions: HonestStrongAction[];
}

// Run the archetype to exhaustion. Returns the action log so tests
// (and the harness's later result-aggregator) can assert on what
// happened.
export async function runHonestStrong(
  client: AnchorageClient,
  config: HonestStrongConfig,
): Promise<HonestStrongResult> {
  const actions: HonestStrongAction[] = [];

  await client.setCapacity({
    cause_id: config.cause_id,
    rate: config.rate,
    kinds: config.kinds,
  });
  actions.push({ kind: 'set_capacity' });

  // Bound the loop to avoid runaway iteration if a future bug ever
  // makes request_assignment return work the archetype can't drain.
  // The bound is chosen high enough that real workloads land well
  // under it; if it ever trips in practice it's a bug to investigate,
  // not a knob to raise.
  const MAX_ITERATIONS = 1000;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let offered: Awaited<ReturnType<AnchorageClient['requestAssignment']>>;
    try {
      offered = await client.requestAssignment({ cause_id: config.cause_id });
    } catch (err) {
      // Empty frontier or rate-cap reached → archetype stops. Both
      // are normal terminal states; the harness distinguishes them
      // via the recorded reason if it cares.
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
      // v0 only handles excerpt tasks. Decline cleanly so the
      // assignment doesn't sit forever (PRD §Capacity and assignment:
      // declining outside-wheelhouse is non-punitive).
      await client.declineAssignment({
        assignment_id: offered.assignment_id,
        reason: `honest-strong v0 doesn't handle ${offered.task.kind} tasks`,
      });
      actions.push({
        kind: 'declined',
        assignment_id: offered.assignment_id,
        reason: 'unhandled task kind',
      });
      continue;
    }

    const excerpt = config.content.forAnchor(offered.task.parent_anchor_id);
    if (!excerpt) {
      await client.declineAssignment({
        assignment_id: offered.assignment_id,
        reason: 'no content available for this anchor',
      });
      actions.push({
        kind: 'declined',
        assignment_id: offered.assignment_id,
        reason: 'no content',
      });
      continue;
    }

    await client.acceptAssignment({ assignment_id: offered.assignment_id });
    actions.push({ kind: 'accepted', assignment_id: offered.assignment_id });

    const submitted = await client.submitAssignedProposal({
      assignment_id: offered.assignment_id,
      payload: {
        kind: 'excerpt',
        cause_id: offered.task.cause_id,
        home_sub_topic_id: offered.task.sub_topic_id,
        parent_anchor_id: offered.task.parent_anchor_id,
        content: excerpt.content,
        quoted_span: excerpt.quoted_span,
      },
    });
    actions.push({
      kind: 'submitted',
      assignment_id: offered.assignment_id,
      proposal_id: submitted.proposal_id,
    });
  }

  // Loop bound hit. Return what we have — the harness should treat
  // this as a defect signal rather than a normal terminal state.
  actions.push({ kind: 'idle', reason: 'iteration_bound_reached' });
  return { actions };
}
