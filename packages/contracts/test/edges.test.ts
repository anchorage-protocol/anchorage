import { describe, expect, it } from 'vitest';
import { DerivesEdge, Edge, SupersedesEdge } from '../src/index.js';

const edgeBase = {
  from: 'n_parent',
  to: 'n_child',
  status: 'active' as const,
  created_by: 'id_abc123',
  created_at: '2026-05-06T12:00:00.000Z',
};

describe('DerivesEdge', () => {
  const valid = { ...edgeBase, id: 'e_d_1', kind: 'derives' as const };

  it('parses a valid derives edge', () => {
    expect(DerivesEdge.parse(valid).kind).toBe('derives');
  });

  it('rejects rationale on a derives edge (strict)', () => {
    expect(() => DerivesEdge.parse({ ...valid, rationale: 'because' })).toThrow();
  });
});

describe('SupersedesEdge', () => {
  const valid = {
    ...edgeBase,
    id: 'e_s_1',
    kind: 'supersedes' as const,
    rationale: 'newer trial supersedes the prior estimate',
  };

  it('parses a valid supersedes edge', () => {
    expect(SupersedesEdge.parse(valid).rationale).toContain('newer trial');
  });

  it('rejects empty rationale', () => {
    expect(() => SupersedesEdge.parse({ ...valid, rationale: '' })).toThrow();
  });
});

describe('Edge discriminated union', () => {
  it('discriminates by kind', () => {
    const parsed = Edge.parse({
      ...edgeBase,
      id: 'e_d_2',
      kind: 'derives',
    });
    expect(parsed.kind).toBe('derives');
  });

  it('rejects an unknown edge kind', () => {
    expect(() => Edge.parse({ ...edgeBase, id: 'e_x', kind: 'cross_link' })).toThrow();
  });

  it('rejects superseded as an edge status', () => {
    expect(() =>
      Edge.parse({ ...edgeBase, id: 'e_d_3', kind: 'derives', status: 'superseded' }),
    ).toThrow();
  });
});
