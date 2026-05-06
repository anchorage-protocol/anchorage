import { describe, expect, it } from 'vitest';
import { Cause, SubTopic } from '../src/index.js';

describe('Cause', () => {
  const valid = {
    id: 'cause_crc',
    name: 'colon cancer',
    description: 'umbrella cause for colorectal cancer research',
    status: 'active' as const,
    created_at: '2026-05-06T12:00:00.000Z',
  };

  it('parses a valid cause', () => {
    const parsed = Cause.parse(valid);
    expect(parsed.name).toBe('colon cancer');
  });

  it('rejects an invalid status', () => {
    expect(() => Cause.parse({ ...valid, status: 'proposed' })).toThrow();
  });
});

describe('SubTopic', () => {
  const valid = {
    id: 'st_ctdna_mrd',
    cause_id: 'cause_crc',
    name: 'ctDNA-MRD in stage II resected CRC',
    description: 'circulating tumor DNA for minimal residual disease detection',
    scope_query: 'pubmed:(ctDNA AND CRC AND "stage II")',
    status: 'active' as const,
    created_at: '2026-05-06T12:00:00.000Z',
  };

  it('parses a valid sub-topic', () => {
    const parsed = SubTopic.parse(valid);
    expect(parsed.scope_query).toContain('ctDNA');
    expect(parsed.cause_id).toBe('cause_crc');
  });

  it('accepts a proposed status', () => {
    const parsed = SubTopic.parse({ ...valid, status: 'proposed' });
    expect(parsed.status).toBe('proposed');
  });

  it('rejects empty scope_query', () => {
    expect(() => SubTopic.parse({ ...valid, scope_query: '' })).toThrow();
  });
});
