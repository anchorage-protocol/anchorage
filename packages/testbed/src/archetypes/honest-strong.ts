import type { CauseId } from '@anchorage/contracts';
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
// arrival order); the archetype itself behaves the same way on the
// same inputs so failures replay.
//
// Archetype contract:
//
//   - Take an AnchorageClient (already connected to a server).
//   - Take a cause to work on and a content provider that can produce
//     a quoted span + content for any orphan anchor it gets assigned.
//   - Run until no more eligible assignments are available, recording
//     a small log of what it did.
//
// Sibling archetypes implement the same shape but with different
// behaviors: honest-weak (verifier-rejection-tolerant content provider
// for the friction-rate axis), hallucinator (fabricated spans the
// verifier rejects), and the reviewer archetypes (`runHonestReviewer`
// with `acceptAllDecider` for the lazy pattern, `payloadBiasedDecider`
// for the strategic-coalition pattern). All wired in the testbed
// today; the contract above is the shared shape.

export interface ContentForExcerpt {
  content: string;
  quoted_span: { text: string; offset: number };
}

export interface ContentProvider {
  // Given a parent anchor's id, produce a verbatim span + a
  // paraphrased atomic claim. v0 looks the value up in a fixture map;
  // a full implementation would call out to a model. Returning
  // `null` means "I can't produce work for this anchor" — under the
  // single-slot model (PRD §Assignment) there is no decline, so the
  // archetype stalls on the held slot and stops; the slot is later
  // recovered by TTL shadow-reassignment, not by contributor action.
  forAnchor(anchorId: string): ContentForExcerpt | null;
}

export interface HonestStrongConfig {
  cause_id: CauseId;
  content: ContentProvider;
}

export type HonestStrongAction =
  | { kind: 'requested'; assignment_id: string; task_kind: string }
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

  // Bound the loop to avoid runaway iteration if a future bug ever
  // makes request_assignment return work the archetype can't drain.
  // The bound is chosen high enough that real workloads land well
  // under it; if it ever trips in practice it's a bug to investigate,
  // not a knob to raise.
  const MAX_ITERATIONS = 1000;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let offered: Awaited<ReturnType<AnchorageClient['requestAssignment']>>;
    try {
      // Single-slot (PRD §Assignment): one assignment in hand at a
      // time. A fresh request only lands work once the prior slot
      // resolves; while a slot is held (or the frontier is empty)
      // the server answers not_found, structurally indistinguishable.
      offered = await client.requestAssignment({
        cause_id: config.cause_id,
        kind: 'excerpt',
      });
    } catch (err) {
      // Empty frontier or held slot → archetype stops. Both are
      // normal terminal states; the harness distinguishes them via
      // the recorded reason if it cares.
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
      // The `kind: 'excerpt'` filter means the server never offers a
      // non-excerpt task here; reaching this is a server bug, not a
      // routine outcome. There is no decline to fall back on (PRD
      // §Assignment) — record it as a defect signal and stop.
      actions.push({ kind: 'idle', reason: 'unexpected_task_kind' });
      return { actions };
    }

    const excerpt = config.content.forAnchor(offered.task.parent_anchor_id);
    if (!excerpt) {
      // honest-strong's content provider returns a span for every
      // anchor it is assigned by contract; a null here is a fixture
      // defect. With no decline channel the held slot stalls (TTL
      // shadow-reassignment recovers it, not the contributor), so
      // the archetype stops rather than spin.
      actions.push({ kind: 'idle', reason: 'no_content' });
      return { actions };
    }

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
  }

  // Loop bound hit. Return what we have — the harness should treat
  // this as a defect signal rather than a normal terminal state.
  actions.push({ kind: 'idle', reason: 'iteration_bound_reached' });
  return { actions };
}
