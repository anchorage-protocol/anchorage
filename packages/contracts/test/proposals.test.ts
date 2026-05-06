import { describe, expect, it } from 'vitest';
import {
  Proposal,
  ProposalPayload,
  ProposeAnchorPayload,
  ProposeExcerptPayload,
  ProposeMembershipPayload,
  ProposeOpenQuestionPayload,
  ProposeSubTopicPayload,
  ProposeSupersedesPayload,
  ProposeSynthesisPayload,
} from '../src/index.js';

describe('ProposalPayload kinds', () => {
  it('parses an anchor payload', () => {
    const p = ProposeAnchorPayload.parse({
      kind: 'anchor',
      cause_id: 'cause_crc',
      home_sub_topic_id: 'st_ctdna_mrd',
      content: 'landmark trial of ctDNA in stage II CRC',
      external_ref: { kind: 'pmid', value: '34567890' },
    });
    expect(p.kind).toBe('anchor');
  });

  it('rejects an excerpt payload missing quoted_span', () => {
    expect(() =>
      ProposeExcerptPayload.parse({
        kind: 'excerpt',
        cause_id: 'cause_crc',
        home_sub_topic_id: 'st_ctdna_mrd',
        parent_anchor_id: 'n_anchor_1',
        content: 'recurrence-free survival differed by ctDNA status',
      }),
    ).toThrow();
  });

  it('parses synthesis and open_question separately', () => {
    const synth = ProposeSynthesisPayload.parse({
      kind: 'synthesis',
      cause_id: 'cause_crc',
      home_sub_topic_id: 'st_ctdna_mrd',
      parent_ids: ['n_excerpt_1', 'n_excerpt_2'],
      content: 'across two cohorts ctDNA-positive predicts recurrence',
    });
    expect(synth.kind).toBe('synthesis');

    const oq = ProposeOpenQuestionPayload.parse({
      kind: 'open_question',
      cause_id: 'cause_crc',
      home_sub_topic_id: 'st_ctdna_mrd',
      parent_ids: ['n_excerpt_1'],
      content: 'does adjuvant chemo benefit ctDNA-negative stage II patients?',
    });
    expect(oq.kind).toBe('open_question');
  });

  it('rejects synthesis with empty parent_ids', () => {
    expect(() =>
      ProposeSynthesisPayload.parse({
        kind: 'synthesis',
        cause_id: 'cause_crc',
        home_sub_topic_id: 'st_ctdna_mrd',
        parent_ids: [],
        content: 'orphan synthesis',
      }),
    ).toThrow();
  });

  it('parses a supersedes payload with rationale', () => {
    const p = ProposeSupersedesPayload.parse({
      kind: 'supersedes',
      from_node_id: 'n_old',
      to_node_id: 'n_new',
      rationale: 'larger cohort confirms direction; tighter CI',
    });
    expect(p.rationale).toContain('larger cohort');
  });

  it('rejects a supersedes payload with empty rationale', () => {
    expect(() =>
      ProposeSupersedesPayload.parse({
        kind: 'supersedes',
        from_node_id: 'n_old',
        to_node_id: 'n_new',
        rationale: '',
      }),
    ).toThrow();
  });

  it('parses a membership payload', () => {
    const p = ProposeMembershipPayload.parse({
      kind: 'membership',
      node_id: 'n_def_msi_high',
      sub_topic_id: 'st_lynch_surveillance',
    });
    expect(p.sub_topic_id).toBe('st_lynch_surveillance');
  });

  it('parses a sub_topic payload', () => {
    const p = ProposeSubTopicPayload.parse({
      kind: 'sub_topic',
      cause_id: 'cause_crc',
      name: 'ctDNA-MRD in stage II resected CRC',
      description: 'circulating tumor DNA for minimal residual disease',
      scope_query: 'pubmed:(ctDNA AND CRC AND "stage II")',
    });
    expect(p.name).toContain('ctDNA');
  });

  it('discriminates the union by kind', () => {
    const p = ProposalPayload.parse({
      kind: 'anchor',
      cause_id: 'cause_crc',
      home_sub_topic_id: 'st_ctdna_mrd',
      content: 'x',
      external_ref: { kind: 'doi', value: '10.1000/xyz' },
    });
    expect(p.kind).toBe('anchor');
  });

  it('rejects unknown payload kinds', () => {
    expect(() => ProposalPayload.parse({ kind: 'cross_link', from: 'a', to: 'b' })).toThrow();
  });
});

describe('Proposal record', () => {
  const validPayload = {
    kind: 'membership' as const,
    node_id: 'n_def_msi_high',
    sub_topic_id: 'st_lynch_surveillance',
  };

  const valid = {
    id: 'prop_1',
    proposer_id: 'id_abc123',
    status: 'staged' as const,
    payload: validPayload,
    created_at: '2026-05-06T12:00:00.000Z',
    updated_at: '2026-05-06T12:00:00.000Z',
  };

  it('parses a valid proposal', () => {
    expect(Proposal.parse(valid).status).toBe('staged');
  });

  it('accepts an optional assignment_id', () => {
    const p = Proposal.parse({ ...valid, assignment_id: 'assn_1' });
    expect(p.assignment_id).toBe('assn_1');
  });

  it('accepts unresolved-archived as a status', () => {
    expect(Proposal.parse({ ...valid, status: 'unresolved-archived' }).status).toBe(
      'unresolved-archived',
    );
  });

  it('rejects an unknown status', () => {
    expect(() => Proposal.parse({ ...valid, status: 'verifying' })).toThrow();
  });

  it('rejects a payload with an unknown kind', () => {
    expect(() => Proposal.parse({ ...valid, payload: { kind: 'cross_link' } })).toThrow();
  });
});
