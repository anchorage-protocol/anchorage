import { describe, expect, it } from 'vitest';
import {
  AnchorNode,
  ExcerptNode,
  ExternalRef,
  Node,
  OpenQuestionNode,
  QuotedSpan,
  SynthesisNode,
} from '../src/index.js';

const baseFields = {
  home_sub_topic_id: 'st_ctdna_mrd',
  scope_memberships: [],
  content: 'placeholder claim text',
  status: 'active' as const,
  created_by: 'id_abc123',
  created_at: '2026-05-06T12:00:00.000Z',
  updated_at: '2026-05-06T12:00:00.000Z',
};

describe('ExternalRef', () => {
  it('parses a valid PMID', () => {
    expect(ExternalRef.parse({ kind: 'pmid', value: '12345678' }).kind).toBe('pmid');
  });

  it('rejects a non-numeric PMID', () => {
    expect(() => ExternalRef.parse({ kind: 'pmid', value: 'PMC123' })).toThrow();
  });

  it('rejects a malformed URL', () => {
    expect(() => ExternalRef.parse({ kind: 'url', value: 'not a url' })).toThrow();
  });
});

describe('QuotedSpan', () => {
  it('parses a valid span', () => {
    expect(QuotedSpan.parse({ text: 'a verbatim slice', offset: 42 }).offset).toBe(42);
  });

  it('rejects a negative offset', () => {
    expect(() => QuotedSpan.parse({ text: 'x', offset: -1 })).toThrow();
  });

  it('rejects empty text', () => {
    expect(() => QuotedSpan.parse({ text: '', offset: 0 })).toThrow();
  });
});

describe('AnchorNode', () => {
  const valid = {
    ...baseFields,
    id: 'n_anchor_1',
    kind: 'anchor' as const,
    external_ref: { kind: 'pmid' as const, value: '34567890' },
    content_hash: 'sha256:abc',
  };

  it('parses a valid anchor', () => {
    expect(AnchorNode.parse(valid).kind).toBe('anchor');
  });

  it('rejects an empty content_hash', () => {
    expect(() => AnchorNode.parse({ ...valid, content_hash: '' })).toThrow();
  });

  it('rejects a quoted_span on an anchor (strict)', () => {
    expect(() => AnchorNode.parse({ ...valid, quoted_span: { text: 'x', offset: 0 } })).toThrow();
  });
});

describe('ExcerptNode', () => {
  const valid = {
    ...baseFields,
    id: 'n_excerpt_1',
    kind: 'excerpt' as const,
    quoted_span: { text: 'verbatim slice supporting the claim', offset: 120 },
  };

  it('parses a valid excerpt', () => {
    expect(ExcerptNode.parse(valid).quoted_span.offset).toBe(120);
  });

  it('rejects an excerpt with external_ref (no duplicated grounding field)', () => {
    expect(() =>
      ExcerptNode.parse({
        ...valid,
        external_ref: { kind: 'pmid' as const, value: '1' },
      }),
    ).toThrow();
  });

  it('rejects when quoted_span is missing', () => {
    const { quoted_span: _omit, ...rest } = valid;
    expect(() => ExcerptNode.parse(rest)).toThrow();
  });
});

describe('SynthesisNode and OpenQuestionNode', () => {
  it('parses a synthesis with no anchor-specific fields', () => {
    const parsed = SynthesisNode.parse({
      ...baseFields,
      id: 'n_synth_1',
      kind: 'synthesis',
    });
    expect(parsed.kind).toBe('synthesis');
  });

  it('parses an open_question with scope memberships', () => {
    const parsed = OpenQuestionNode.parse({
      ...baseFields,
      id: 'n_oq_1',
      kind: 'open_question',
      scope_memberships: ['st_lynch_surveillance'],
    });
    expect(parsed.scope_memberships).toEqual(['st_lynch_surveillance']);
  });
});

describe('Node discriminated union', () => {
  it('discriminates by kind', () => {
    const parsed = Node.parse({
      ...baseFields,
      id: 'n_anchor_2',
      kind: 'anchor',
      external_ref: { kind: 'doi', value: '10.1000/xyz' },
      content_hash: 'sha256:def',
    });
    expect(parsed.kind).toBe('anchor');
  });

  it('rejects an unknown kind', () => {
    expect(() => Node.parse({ ...baseFields, id: 'n_x', kind: 'comment' })).toThrow();
  });

  it('accepts unresolvable as a status', () => {
    const parsed = Node.parse({
      ...baseFields,
      id: 'n_anchor_dead',
      kind: 'anchor',
      external_ref: { kind: 'url', value: 'https://example.invalid/doc' },
      content_hash: 'sha256:old',
      status: 'unresolvable',
    });
    expect(parsed.status).toBe('unresolvable');
  });
});
