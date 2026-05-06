import { describe, expect, it } from 'vitest';
import type { Caller } from './auth.js';
import { FakeClock } from './clock.js';
import { ServerError } from './errors.js';
import { SeededIdGen } from './id-gen.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

interface Fixture {
  server: Server;
  caller: Caller;
  cause_id: ReturnType<Server['bootstrap']['createCause']>['id'];
  sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
  other_sub_topic_id: ReturnType<Server['bootstrap']['seedSubTopic']>['id'];
}

function fixture(opts: { unresolvable?: ReadonlySet<string> } = {}): Fixture {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('t'),
    verifier: new FakeVerifier(opts.unresolvable),
  });
  const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const cred = server.bootstrap.bindAgentCredential({ identity_id: identity.id, label: 'desktop' });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const st = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'mrd',
    scope_query: 'ctDNA',
  });
  const other = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'screening-adherence',
    description: 'screening',
    scope_query: 'screening',
  });
  return {
    server,
    caller: { identity_id: identity.id, agent_credential_id: cred.id },
    cause_id: cause.id,
    sub_topic_id: st.id,
    other_sub_topic_id: other.id,
  };
}

describe('tools.proposeAnchor', () => {
  it('stages an anchor proposal when verification passes', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'Tie et al., ctDNA-guided adjuvant chemotherapy in stage II colon cancer',
      external_ref: { kind: 'pmid', value: '35657323' },
    });
    const p = f.server.store.proposals.get(proposal_id);
    expect(p?.status).toBe('staged');
    expect(p?.payload.kind).toBe('anchor');
    expect(p?.proposer_id).toBe(f.caller.identity_id);
  });

  it('records optional memberships on the payload', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      memberships: [f.other_sub_topic_id],
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    const p = f.server.store.proposals.get(proposal_id);
    if (p?.payload.kind !== 'anchor') throw new Error('unexpected payload');
    expect(p.payload.memberships).toEqual([f.other_sub_topic_id]);
  });

  it('rejects when the external_ref does not resolve', async () => {
    const f = fixture({ unresolvable: new Set(['9999999999']) });
    await expect(
      f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: f.sub_topic_id,
        content: 'x',
        external_ref: { kind: 'pmid', value: '9999999999' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.server.store.proposals.size).toBe(0);
  });

  it('rejects when the home sub-topic belongs to a different cause', async () => {
    const f = fixture();
    const otherCause = f.server.bootstrap.createCause({ name: 'AMR', description: 'amr' });
    const otherSt = f.server.bootstrap.seedSubTopic({
      cause_id: otherCause.id,
      name: 'x',
      description: 'x',
      scope_query: 'x',
    });
    await expect(
      f.server.tools.proposeAnchor(f.caller, {
        cause_id: f.cause_id,
        home_sub_topic_id: otherSt.id,
        content: 'x',
        external_ref: { kind: 'pmid', value: '1' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects an unknown identity', async () => {
    const f = fixture();
    await expect(
      f.server.tools.proposeAnchor(
        // biome-ignore lint/suspicious/noExplicitAny: fabricating an unauthorized caller
        { identity_id: 'idn_bogus' as any },
        {
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          content: 'x',
          external_ref: { kind: 'pmid', value: '1' },
        },
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects an agent credential that does not belong to the identity', async () => {
    const f = fixture();
    const other = f.server.bootstrap.mintIdentity({ display_name: 'mallory' });
    const otherCred = f.server.bootstrap.bindAgentCredential({
      identity_id: other.id,
      label: 'mallory-bot',
    });
    await expect(
      f.server.tools.proposeAnchor(
        { identity_id: f.caller.identity_id, agent_credential_id: otherCred.id },
        {
          cause_id: f.cause_id,
          home_sub_topic_id: f.sub_topic_id,
          content: 'x',
          external_ref: { kind: 'pmid', value: '1' },
        },
      ),
    ).rejects.toBeInstanceOf(ServerError);
  });
});
