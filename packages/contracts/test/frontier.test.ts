import { describe, expect, it } from 'vitest';
import { FrontierItem } from '../src/index.js';

describe('FrontierItem', () => {
  const baseFields = { priority: 0.5, cause_id: 'cause_crc' };

  it('parses an orphan_anchor item', () => {
    const item = FrontierItem.parse({
      ...baseFields,
      kind: 'orphan_anchor',
      sub_topic_id: 'st_ctdna_mrd',
      anchor_id: 'n_anchor_1',
    });
    expect(item.kind).toBe('orphan_anchor');
  });

  it('parses a needs_synthesis item with parents', () => {
    const item = FrontierItem.parse({
      ...baseFields,
      kind: 'needs_synthesis',
      sub_topic_id: 'st_ctdna_mrd',
      parent_ids: ['n_excerpt_1', 'n_excerpt_2'],
    });
    if (item.kind !== 'needs_synthesis') throw new Error('discriminator failed');
    expect(item.parent_ids.length).toBe(2);
  });

  it('rejects needs_synthesis with empty parents', () => {
    expect(() =>
      FrontierItem.parse({
        ...baseFields,
        kind: 'needs_synthesis',
        sub_topic_id: 'st_ctdna_mrd',
        parent_ids: [],
      }),
    ).toThrow();
  });

  it('parses a needs_review item', () => {
    const item = FrontierItem.parse({
      ...baseFields,
      kind: 'needs_review',
      sub_topic_id: 'st_ctdna_mrd',
      proposal_id: 'prop_1',
    });
    expect(item.kind).toBe('needs_review');
  });

  it('parses an unresolvable_anchor item', () => {
    const item = FrontierItem.parse({
      ...baseFields,
      kind: 'unresolvable_anchor',
      sub_topic_id: 'st_ctdna_mrd',
      anchor_id: 'n_anchor_dead',
    });
    expect(item.kind).toBe('unresolvable_anchor');
  });

  it('rejects an unknown frontier kind', () => {
    expect(() =>
      FrontierItem.parse({ ...baseFields, kind: 'idle_review', sub_topic_id: 's' }),
    ).toThrow();
  });
});
