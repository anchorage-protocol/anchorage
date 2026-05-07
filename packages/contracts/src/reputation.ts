import { z } from 'zod';
import { CauseId, IdentityId, SubTopicId } from './ids.js';
import { Timestamp } from './timestamps.js';

// Per-(identity, cause, sub-topic) reputation record. PRD §Reputation:
// "Anchored at the cause level (the unit of belonging), refined by
// which sub-topics a contributor's *assigned* work has actually landed
// in." Sub-topic rep is therefore an emergent record of where the
// system has routed someone, not a self-declared specialty.
//
// PRD names a *two-component* model: a slow-decay demonstrated-
// competence component and a fast-decay recent-activity component
// (§Reputation). v0 ships a single scalar that maps onto neither
// directly — time-windowing and decay are testbed-tuned and land
// alongside the testbed sweeps that need them. The contract leaves
// room: future versions add `demonstrated` and `recent` fields and
// migrate `score` → `demonstrated`.
export const Reputation = z
  .object({
    identity_id: IdentityId,
    cause_id: CauseId,
    sub_topic_id: SubTopicId,
    score: z.number(),
    updated_at: Timestamp,
  })
  .strict();
export type Reputation = z.infer<typeof Reputation>;
