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
}

function fixture(): Fixture {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('t'),
    verifier: new FakeVerifier(),
  });
  const identity = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'x' });
  const st = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'x',
    scope_query: 'x',
  });
  return {
    server,
    caller: { identity_id: identity.id },
    cause_id: cause.id,
    sub_topic_id: st.id,
  };
}

describe('curator.acceptProposal', () => {
  it('materializes an AnchorNode from an accepted anchor proposal', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'Tie et al., ctDNA-guided adjuvant chemotherapy in stage II colon cancer',
      external_ref: { kind: 'pmid', value: '35657323' },
    });

    const { node_id } = f.server.curator.acceptProposal(proposal_id);
    if (!node_id) throw new Error('expected materialized node_id');

    const proposal = f.server.store.proposals.get(proposal_id);
    expect(proposal?.status).toBe('accepted');

    const node = f.server.store.nodes.get(node_id);
    if (node?.kind !== 'anchor') throw new Error('expected anchor node');
    expect(node.status).toBe('active');
    expect(node.created_by).toBe(f.caller.identity_id);
    expect(node.home_sub_topic_id).toBe(f.sub_topic_id);
    expect(node.external_ref).toEqual({ kind: 'pmid', value: '35657323' });
    expect(node.content_hash).toBe('fake:pmid:35657323');
  });

  it('rejects accepting a non-staged proposal', async () => {
    const f = fixture();
    const { proposal_id } = await f.server.tools.proposeAnchor(f.caller, {
      cause_id: f.cause_id,
      home_sub_topic_id: f.sub_topic_id,
      content: 'x',
      external_ref: { kind: 'pmid', value: '1' },
    });
    f.server.curator.acceptProposal(proposal_id);
    expect(() => f.server.curator.acceptProposal(proposal_id)).toThrow(ServerError);
  });

  it('rejects an unknown proposal id', () => {
    const f = fixture();
    try {
      // biome-ignore lint/suspicious/noExplicitAny: fabricating an unknown id
      f.server.curator.acceptProposal('prp_nope' as any);
      expect.fail('expected ServerError');
    } catch (err) {
      expect((err as ServerError).code).toBe('not_found');
    }
  });
});
