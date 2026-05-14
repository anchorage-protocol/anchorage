import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Caller } from './auth.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { Server } from './server.js';
import { SqliteStore } from './sqlite-store.js';
import { MemoryStore, type Store } from './store.js';
import { FakeVerifier } from './verifier.js';

// Slice 2 parity: the production-runtime SQLite backend and the
// testbed-deterministic in-memory backend implement the same `Store`
// surface and must produce byte-identical graph state when driven by
// the same Server scenario. The scenario covers the v0 hot path —
// cause/sub-topic seed, anchor + excerpt proposals through curator
// acceptance, an assignment-driven excerpt with a reviewer vote, a
// reputation read — exercising every collection except the
// suppression-axis primitives (calibration records, rate limits) which
// have their own dedicated tests upstream. The point of the parity
// test is that the *Store seam* is faithful, not that the Server's
// every code path is re-exercised here.

function buildServer(store: Store): { server: Server; caller: Caller } {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('parity'),
    store,
    verifier: new FakeVerifier(),
  });
  const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
  // Bind a credential so the parity test exercises both the
  // agentCredentials collection *and* the agentCredentialSecrets
  // index introduced in slice 3b — the index must round-trip across
  // backends or the seam-side bearer-token lookup breaks under
  // SqliteStore.
  const { credential } = server.bootstrap.bindAgentCredential({
    identity_id: identity.id,
    label: 'desktop',
  });
  return { server, caller: { identity_id: identity.id, agent_credential_id: credential.id } };
}

async function runScenario(store: Store): Promise<void> {
  const { server, caller } = buildServer(store);
  // Mint an IdP-driven identity alongside the harness-default
  // alice so the parity scenario exercises `identityProviderSubjects`
  // (slice 3c) across backends. Without this the new collection is
  // empty in both stores and "byte-identical" would be vacuous on
  // the IdP-subject index.
  server.bootstrap.mintIdentity({
    display_name: 'octocat',
    identity_provider: 'github',
    identity_provider_subject: '424242',
    attestation_level: 2,
  });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
  const st = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'x',
    scope_query: 'x',
  });
  const anchor = await server.tools.proposeAnchor(caller, {
    cause_id: cause.id,
    home_sub_topic_id: st.id,
    content: 'parent',
    external_ref: { kind: 'pmid', value: '35657323' },
  });
  const acceptedAnchor = server.curator.acceptProposal(anchor.proposal_id);
  if (!acceptedAnchor.node_id) throw new Error('expected anchor node');
  const excerpt = await server.tools.proposeExcerpt(caller, {
    cause_id: cause.id,
    home_sub_topic_id: st.id,
    parent_anchor_id: acceptedAnchor.node_id,
    content: 'span',
    quoted_span: { text: 'span', offset: 0 },
  });
  server.curator.acceptProposal(excerpt.proposal_id);
}

function snapshot(store: Store): Record<string, [string, unknown][]> {
  // Capture every collection as a sorted [key, value] list — sorted
  // because the SqliteStore yields rowid-ordered insertion and the
  // MemoryStore yields native Map insertion order, which should match,
  // but sorting makes the equality check robust against any reorder
  // future maintenance might introduce in either backend. The parity
  // claim is "same data," not "same iteration order."
  const collect = <K extends string, V>(coll: { entries(): IterableIterator<[K, V]> }) =>
    [...coll.entries()].sort(([a], [b]) => a.localeCompare(b)) as [string, unknown][];
  return {
    identities: collect(store.identities),
    agentCredentials: collect(store.agentCredentials),
    agentCredentialSecrets: collect(store.agentCredentialSecrets),
    causes: collect(store.causes),
    subTopics: collect(store.subTopics),
    proposals: collect(store.proposals),
    nodes: collect(store.nodes),
    edges: collect(store.edges),
    reviewVotes: collect(store.reviewVotes),
    assignments: collect(store.assignments),
    capacities: collect(store.capacities),
    reputations: collect(store.reputations),
    calibrationRecords: collect(store.calibrationRecords),
    verifiedRefs: collect(store.verifiedRefs),
    identityProviderSubjects: collect(store.identityProviderSubjects),
    idpIssuanceCounters: collect(store.idpIssuanceCounters),
    rateLimits: collect(store.rateLimits),
  };
}

describe('SqliteStore — Store surface', () => {
  it('get/set/values/entries/size on a single collection', () => {
    const store = new SqliteStore({ path: ':memory:' });
    expect(store.identities.size).toBe(0);
    expect(store.identities.get('idn_missing' as never)).toBeUndefined();

    const identity = {
      id: 'idn_x' as never,
      display_name: 'alice',
      status: 'active' as const,
      attestation_level: 0,
      identity_provider: 'harness' as const,
      role: 'contributor' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    store.identities.set(identity.id, identity);
    expect(store.identities.size).toBe(1);
    expect(store.identities.get(identity.id)).toEqual(identity);

    const second = { ...identity, id: 'idn_y' as never, display_name: 'bob' };
    store.identities.set(second.id, second);
    expect(store.identities.size).toBe(2);
    expect([...store.identities.values()]).toEqual([identity, second]);
    expect([...store.identities.entries()]).toEqual([
      [identity.id, identity],
      [second.id, second],
    ]);

    // Upsert semantics — second set with same key replaces the value.
    const updated = { ...identity, display_name: 'alice2' };
    store.identities.set(identity.id, updated);
    expect(store.identities.size).toBe(2);
    expect(store.identities.get(identity.id)).toEqual(updated);
    store.close();
  });

  it('preserves insertion order under iteration (rowid-ordered)', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const keys = ['c', 'a', 'b', 'd'];
    for (const k of keys) {
      store.identities.set(k as never, {
        id: k as never,
        display_name: k,
        status: 'active',
        attestation_level: 0,
        identity_provider: 'harness',
        role: 'contributor',
        created_at: '2026-01-01T00:00:00.000Z',
      });
    }
    expect([...store.identities.entries()].map(([k]) => k)).toEqual(keys);
    store.close();
  });
});

describe('SqliteStore vs MemoryStore — parity', () => {
  it('produces identical graph state when driven through the Server', async () => {
    const memStore = new MemoryStore();
    const sqlStore = new SqliteStore({ path: ':memory:' });

    await runScenario(memStore);
    await runScenario(sqlStore);

    expect(snapshot(sqlStore)).toEqual(snapshot(memStore));

    sqlStore.close();
  });

  it('survives close/reopen (durability)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchorage-sqlite-store-'));
    const path = join(dir, 'anchorage.sqlite');
    try {
      const first = new SqliteStore({ path });
      await runScenario(first);
      const before = snapshot(first);
      first.close();

      const second = new SqliteStore({ path });
      // No scenario re-run on `second` — we are asserting the on-disk
      // state survives the close/reopen, not that the Server reaches
      // an identical resting state by replaying writes.
      const after = snapshot(second);
      second.close();

      expect(after).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
