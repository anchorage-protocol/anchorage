import { z } from 'zod';
import { CauseId, SubTopicId } from './ids.js';
import { Timestamp } from './timestamps.js';

export const CauseStatus = z.enum(['active', 'archived']);
export type CauseStatus = z.infer<typeof CauseStatus>;

export const Cause = z
  .object({
    id: CauseId,
    name: z.string().min(1).max(200),
    description: z.string().min(1),
    status: CauseStatus,
    created_at: Timestamp,
  })
  .strict();
export type Cause = z.infer<typeof Cause>;

export const SubTopicStatus = z.enum(['proposed', 'active', 'archived']);
export type SubTopicStatus = z.infer<typeof SubTopicStatus>;

export const SubTopic = z
  .object({
    id: SubTopicId,
    cause_id: CauseId,
    name: z.string().min(1).max(200),
    description: z.string().min(1),
    scope_query: z.string().min(1),
    status: SubTopicStatus,
    created_at: Timestamp,
  })
  .strict();
export type SubTopic = z.infer<typeof SubTopic>;
