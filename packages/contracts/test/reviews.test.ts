import { describe, expect, it } from 'vitest';
import { ReviewVote } from '../src/index.js';

describe('ReviewVote', () => {
  const valid = {
    id: 'rv_1',
    proposal_id: 'prop_1',
    reviewer_id: 'id_reviewer',
    decision: 'accept' as const,
    rationale: 'span verifies; claim follows from quoted text',
    created_at: '2026-05-06T12:00:00.000Z',
  };

  it('parses a valid vote', () => {
    expect(ReviewVote.parse(valid).decision).toBe('accept');
  });

  it('accepts reject and revise decisions', () => {
    expect(ReviewVote.parse({ ...valid, decision: 'reject' }).decision).toBe('reject');
    expect(ReviewVote.parse({ ...valid, decision: 'revise' }).decision).toBe('revise');
  });

  it('rejects an unknown decision', () => {
    expect(() => ReviewVote.parse({ ...valid, decision: 'abstain' })).toThrow();
  });

  it('rejects empty rationale', () => {
    expect(() => ReviewVote.parse({ ...valid, rationale: '' })).toThrow();
  });

  it('accepts an optional assignment_id', () => {
    expect(ReviewVote.parse({ ...valid, assignment_id: 'assn_1' }).assignment_id).toBe('assn_1');
  });
});
