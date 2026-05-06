import { z } from 'zod';
import { AssignmentId, IdentityId, ProposalId, ReviewVoteId } from './ids.js';
import { Timestamp } from './timestamps.js';

export const ReviewDecision = z.enum(['accept', 'reject', 'revise']);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

// A reviewer's vote on a proposal. `rationale` is required (PRD
// §cast_review_vote) — promotion of a rationale to a graph node
// (typically an open_question) is a curator action and does not affect
// this record's shape. `assignment_id` is present when the vote
// fulfills a review-kind assignment; absent for contributor-initiated
// review (which is weighted lower for reputation).
export const ReviewVote = z
  .object({
    id: ReviewVoteId,
    proposal_id: ProposalId,
    reviewer_id: IdentityId,
    decision: ReviewDecision,
    rationale: z.string().min(1),
    assignment_id: AssignmentId.optional(),
    created_at: Timestamp,
  })
  .strict();
export type ReviewVote = z.infer<typeof ReviewVote>;
