import { z } from 'zod';
import { CauseId, IdentityId, SubTopicId } from './ids.js';
import { Timestamp } from './timestamps.js';

// Per-(identity, cause, sub-topic) reputation record. PRD §Reputation:
// "Anchored at the cause level (the unit of belonging), refined by
// which sub-topics a contributor's *assigned* work has actually landed
// in." Sub-topic rep is therefore an emergent record of where the
// system has routed someone, not a self-declared specialty.
//
// Two-component per PRD §Reputation: a *demonstrated*-competence
// component (slow-decay, intended to gate eligibility tiers) and a
// *recent*-activity component (fast-decay, intended to gate
// assignment). Both fields move together on every reputation event —
// the differential behavior comes from the decay half-lives, applied
// on read at the server layer. The stored values are the snapshots
// at `updated_at`; consumers must decay forward to "now" themselves
// (or read through the server, which does it for them). Decay
// half-lives are testbed-tuned and live in the server's review
// config; the contract is intentionally neutral about the formula.
//
// Eligibility and assignment gating consuming these components is
// wired today via the server's `assignment_min_demonstrated` and
// `assignment_min_recent` review-config knobs (PRD §Reputation,
// ROADMAP §Status); thresholds default to 0 (gates inert) so existing
// scenarios are unaffected, and per-archetype scenarios in
// testbed.test pin the consumption shape under the patient-adversary
// drained-recent and sybil-amplified never-proven signatures. The
// stored fields stay schema-neutral about the gates; specific
// threshold values remain testbed-tuned per PRD §Reputation
// ("Specific formulas tuned in testbed").
export const Reputation = z
  .object({
    identity_id: IdentityId,
    cause_id: CauseId,
    sub_topic_id: SubTopicId,
    demonstrated: z.number(),
    recent: z.number(),
    updated_at: Timestamp,
  })
  .strict();
export type Reputation = z.infer<typeof Reputation>;
