import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
import { SeededIdGen } from './id-gen.js';
import { Server } from './server.js';

function newServer() {
  return new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('t'),
  });
}

describe('bootstrap.mintIdentity', () => {
  it('creates an active identity with deterministic id and timestamp', () => {
    const server = newServer();
    const ident = server.bootstrap.mintIdentity({ display_name: 'alice' });
    expect(ident).toEqual({
      id: 'idn_t_0001',
      display_name: 'alice',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      attestation_level: 0,
      identity_provider: 'harness',
    });
    expect(server.store.identities.get(ident.id)).toEqual(ident);
  });

  it('rejects empty display name', () => {
    const server = newServer();
    expect(() => server.bootstrap.mintIdentity({ display_name: '' })).toThrow();
  });
});

describe('bootstrap.bindAgentCredential', () => {
  it('binds a credential to an existing identity and returns a one-shot secret', () => {
    const server = newServer();
    const ident = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const { credential: cred, secret } = server.bootstrap.bindAgentCredential({
      identity_id: ident.id,
      label: 'desktop',
    });
    expect(cred.identity_id).toBe(ident.id);
    expect(cred.label).toBe('desktop');
    expect(cred.status).toBe('active');
    expect(server.store.agentCredentials.get(cred.id)).toEqual(cred);
    // Secret is a non-trivial URL-safe base64 string of the
    // 32-byte random source; hash is 64 lowercase hex chars and
    // indexes back to the credential id (the seam-side lookup).
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(cred.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(server.store.agentCredentialSecrets.get(cred.secret_hash)).toBe(cred.id);
  });

  it('mints a fresh secret on each call (no collision across credentials)', () => {
    const server = newServer();
    const ident = server.bootstrap.mintIdentity({ display_name: 'alice' });
    const a = server.bootstrap.bindAgentCredential({ identity_id: ident.id, label: 'a' });
    const b = server.bootstrap.bindAgentCredential({ identity_id: ident.id, label: 'b' });
    expect(a.secret).not.toBe(b.secret);
    expect(a.credential.secret_hash).not.toBe(b.credential.secret_hash);
    expect(server.store.agentCredentialSecrets.size).toBe(2);
  });

  it('errors not_found when identity is missing', () => {
    const server = newServer();
    try {
      server.bootstrap.bindAgentCredential({
        identity_id: 'idn_does_not_exist',
        label: 'desktop',
      });
      expect.fail('expected ServerError');
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).code).toBe('not_found');
    }
  });

  it('errors invalid_state when identity is revoked', () => {
    const server = newServer();
    const ident = server.bootstrap.mintIdentity({ display_name: 'alice' });
    server.store.identities.set(ident.id, { ...ident, status: 'revoked' });
    try {
      server.bootstrap.bindAgentCredential({ identity_id: ident.id, label: 'x' });
      expect.fail('expected ServerError');
    } catch (err) {
      expect((err as ServerError).code).toBe('invalid_state');
    }
  });
});

describe('bootstrap.createCause', () => {
  it('creates an active cause', () => {
    const server = newServer();
    const cause = server.bootstrap.createCause({
      name: 'Colon cancer',
      description: 'CRC research synthesis.',
    });
    expect(cause.id).toBe('cau_t_0001');
    expect(cause.status).toBe('active');
    expect(server.store.causes.get(cause.id)).toEqual(cause);
  });
});

describe('bootstrap.seedSubTopic', () => {
  it('seeds a sub-topic as active under an existing cause', () => {
    const server = newServer();
    const cause = server.bootstrap.createCause({
      name: 'Colon cancer',
      description: 'CRC research synthesis.',
    });
    const st = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD in stage II resected CRC',
      description: 'Minimal residual disease detection via ctDNA.',
      scope_query: 'ctDNA[Title/Abstract] AND MRD AND stage II',
    });
    expect(st.cause_id).toBe(cause.id);
    expect(st.status).toBe('active');
    expect(server.store.subTopics.get(st.id)).toEqual(st);
  });

  it('errors not_found when cause is missing', () => {
    const server = newServer();
    try {
      server.bootstrap.seedSubTopic({
        cause_id: 'cau_missing',
        name: 'x',
        description: 'x',
        scope_query: 'x',
      });
      expect.fail('expected ServerError');
    } catch (err) {
      expect((err as ServerError).code).toBe('not_found');
    }
  });
});
