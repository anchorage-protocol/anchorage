import { describe, expect, it } from 'vitest';
import { Assignment, AssignmentTask } from '../src/index.js';

describe('AssignmentTask', () => {
  it('parses an anchor task', () => {
    expect(
      AssignmentTask.parse({
        kind: 'anchor',
        cause_id: 'cause_crc',
        sub_topic_id: 'st_ctdna_mrd',
      }).kind,
    ).toBe('anchor');
  });

  it('parses an excerpt task with parent_anchor_id', () => {
    expect(
      AssignmentTask.parse({
        kind: 'excerpt',
        cause_id: 'cause_crc',
        sub_topic_id: 'st_ctdna_mrd',
        parent_anchor_id: 'n_anchor_1',
      }).kind,
    ).toBe('excerpt');
  });

  it('parses a synthesis task with parent_ids', () => {
    const task = AssignmentTask.parse({
      kind: 'synthesis',
      cause_id: 'cause_crc',
      sub_topic_id: 'st_ctdna_mrd',
      parent_ids: ['n_excerpt_1', 'n_excerpt_2'],
    });
    if (task.kind !== 'synthesis') throw new Error('discriminator failed');
    expect(task.parent_ids.length).toBe(2);
  });

  it('rejects a synthesis task with no parents', () => {
    expect(() =>
      AssignmentTask.parse({
        kind: 'synthesis',
        cause_id: 'cause_crc',
        sub_topic_id: 'st_ctdna_mrd',
        parent_ids: [],
      }),
    ).toThrow();
  });

  it('parses a review task with proposal_id only', () => {
    expect(AssignmentTask.parse({ kind: 'review', proposal_id: 'prop_1' }).kind).toBe('review');
  });

  it('rejects review task with cause_id (strict)', () => {
    expect(() =>
      AssignmentTask.parse({
        kind: 'review',
        proposal_id: 'prop_1',
        cause_id: 'cause_crc',
      }),
    ).toThrow();
  });
});

describe('Assignment record', () => {
  const valid = {
    id: 'assn_1',
    contributor_id: 'id_abc123',
    task: {
      kind: 'review' as const,
      proposal_id: 'prop_1',
    },
    status: 'accepted' as const,
    created_at: '2026-05-06T12:00:00.000Z',
    updated_at: '2026-05-06T12:00:00.000Z',
  };

  it('parses a valid assignment', () => {
    expect(Assignment.parse(valid).status).toBe('accepted');
  });

  it('walks the lifecycle states', () => {
    for (const status of ['accepted', 'submitted', 'lapsed'] as const) {
      expect(Assignment.parse({ ...valid, status }).status).toBe(status);
    }
  });

  it('rejects retired statuses (offered, declined, expired)', () => {
    expect(() => Assignment.parse({ ...valid, status: 'offered' })).toThrow();
    expect(() => Assignment.parse({ ...valid, status: 'declined' })).toThrow();
    expect(() => Assignment.parse({ ...valid, status: 'expired' })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => Assignment.parse({ ...valid, status: 'completed' })).toThrow();
  });

  it('accepts optional fulfilled_by, shadow_of, and ttl_at', () => {
    const a = Assignment.parse({
      ...valid,
      status: 'submitted',
      fulfilled_by: 'prop_1',
      shadow_of: 'assn_orig',
      ttl_at: '2026-05-07T12:00:00.000Z',
    });
    expect(a.fulfilled_by).toBe('prop_1');
    expect(a.shadow_of).toBe('assn_orig');
    expect(a.ttl_at).toContain('2026-05-07');
  });
});
