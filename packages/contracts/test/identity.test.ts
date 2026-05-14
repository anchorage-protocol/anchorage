import { describe, expect, it } from 'vitest';
import { AgentCredential, Identity } from '../src/index.js';

describe('Identity', () => {
  const valid = {
    id: 'id_abc123',
    display_name: 'aurelius',
    status: 'active' as const,
    created_at: '2026-05-06T12:00:00.000Z',
    attestation_level: 0,
  };

  it('parses a valid identity', () => {
    const parsed = Identity.parse(valid);
    expect(parsed.display_name).toBe('aurelius');
    expect(parsed.status).toBe('active');
    expect(parsed.attestation_level).toBe(0);
  });

  it('rejects a negative attestation_level', () => {
    expect(() => Identity.parse({ ...valid, attestation_level: -1 })).toThrow();
  });

  it('rejects a missing attestation_level (required field)', () => {
    const { attestation_level: _omit, ...rest } = valid;
    expect(() => Identity.parse(rest)).toThrow();
  });

  it('rejects an unknown field (strict)', () => {
    expect(() => Identity.parse({ ...valid, unexpected: 1 })).toThrow();
  });

  it('rejects empty display_name', () => {
    expect(() => Identity.parse({ ...valid, display_name: '' })).toThrow();
  });

  it('rejects an invalid status', () => {
    expect(() => Identity.parse({ ...valid, status: 'pending' })).toThrow();
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => Identity.parse({ ...valid, created_at: '2026-05-06' })).toThrow();
  });
});

describe('AgentCredential', () => {
  const valid = {
    id: 'ac_desktop',
    identity_id: 'id_abc123',
    label: 'desktop client',
    status: 'active' as const,
    created_at: '2026-05-06T12:00:00.000Z',
    // 64 lowercase hex chars — sha256 digest shape.
    secret_hash: 'a'.repeat(64),
  };

  it('parses a valid credential', () => {
    const parsed = AgentCredential.parse(valid);
    expect(parsed.label).toBe('desktop client');
    expect(parsed.secret_hash).toHaveLength(64);
  });

  it('rejects when identity_id is missing', () => {
    const { identity_id: _omit, ...rest } = valid;
    expect(() => AgentCredential.parse(rest)).toThrow();
  });

  it('rejects when secret_hash is missing', () => {
    const { secret_hash: _omit, ...rest } = valid;
    expect(() => AgentCredential.parse(rest)).toThrow();
  });

  it('rejects a secret_hash that is not 64 lowercase hex chars', () => {
    expect(() => AgentCredential.parse({ ...valid, secret_hash: 'A'.repeat(64) })).toThrow();
    expect(() => AgentCredential.parse({ ...valid, secret_hash: 'a'.repeat(63) })).toThrow();
    expect(() => AgentCredential.parse({ ...valid, secret_hash: `${'a'.repeat(63)}g` })).toThrow();
  });
});
