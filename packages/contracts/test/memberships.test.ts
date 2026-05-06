import { describe, expect, it } from 'vitest';
import { Membership } from '../src/index.js';

describe('Membership', () => {
  const valid = {
    id: 'mem_1',
    node_id: 'n_excerpt_1',
    sub_topic_id: 'st_lynch_surveillance',
    proposed_by: 'id_abc123',
    status: 'active' as const,
    created_at: '2026-05-06T12:00:00.000Z',
    updated_at: '2026-05-06T12:00:00.000Z',
  };

  it('parses a valid membership', () => {
    expect(Membership.parse(valid).status).toBe('active');
  });

  it('accepts staged and revoked statuses', () => {
    expect(Membership.parse({ ...valid, status: 'staged' }).status).toBe('staged');
    expect(Membership.parse({ ...valid, status: 'revoked' }).status).toBe('revoked');
  });

  it('rejects an unknown status', () => {
    expect(() => Membership.parse({ ...valid, status: 'pending' })).toThrow();
  });

  it('rejects an unknown field (strict)', () => {
    expect(() => Membership.parse({ ...valid, extra: 1 })).toThrow();
  });
});
