import { describe, expect, it } from 'vitest';
import {
  AcceptAssignmentInput,
  CastReviewVoteInput,
  DeclineAssignmentInput,
  FetchCalibrationBatchInput,
  FetchCalibrationBatchOutput,
  ProposeAnchorInput,
  ProposeExcerptInput,
  ProposeMembershipInput,
  ProposeSubTopicInput,
  ProposeSupersedesInput,
  ProposeSynthesisInput,
  QueryFrontierInput,
  QueryProposalsInput,
  RequestAssignmentInput,
  RequestAssignmentOutput,
  ReviewBatchItem,
  SetCapacityInput,
  SubmitAssignedProposalInput,
  ToolName,
} from '../src/index.js';

describe('Capacity & assignment tool I/O', () => {
  it('parses a set_capacity input', () => {
    const i = SetCapacityInput.parse({
      cause_id: 'cause_crc',
      rate: 5,
      kinds: ['excerpt', 'review'],
    });
    expect(i.rate).toBe(5);
  });

  it('rejects set_capacity with empty kinds', () => {
    expect(() => SetCapacityInput.parse({ cause_id: 'cause_crc', rate: 5, kinds: [] })).toThrow();
  });

  it('parses a request_assignment input with optional kind', () => {
    expect(RequestAssignmentInput.parse({ cause_id: 'cause_crc', kind: 'excerpt' }).kind).toBe(
      'excerpt',
    );
    expect(RequestAssignmentInput.parse({ cause_id: 'cause_crc' }).cause_id).toBe('cause_crc');
  });

  it('parses a request_assignment output (id + task)', () => {
    const o = RequestAssignmentOutput.parse({
      assignment_id: 'assn_1',
      task: { kind: 'review', proposal_id: 'prop_1' },
    });
    expect(o.task.kind).toBe('review');
  });

  it('parses accept/decline inputs', () => {
    expect(AcceptAssignmentInput.parse({ assignment_id: 'assn_1' }).assignment_id).toBe('assn_1');
    expect(
      DeclineAssignmentInput.parse({ assignment_id: 'assn_1', reason: 'out of scope' }).reason,
    ).toContain('scope');
  });

  it('rejects decline with empty reason', () => {
    expect(() => DeclineAssignmentInput.parse({ assignment_id: 'assn_1', reason: '' })).toThrow();
  });

  it('parses submit_assigned_proposal input with a payload', () => {
    const i = SubmitAssignedProposalInput.parse({
      assignment_id: 'assn_1',
      payload: {
        kind: 'membership',
        node_id: 'n_def',
        sub_topic_id: 'st_lynch',
      },
    });
    expect(i.payload.kind).toBe('membership');
  });
});

describe('Contributor-initiated propose_* inputs', () => {
  it('parses propose_anchor', () => {
    const i = ProposeAnchorInput.parse({
      cause_id: 'cause_crc',
      home_sub_topic_id: 'st_ctdna_mrd',
      content: 'landmark trial',
      external_ref: { kind: 'pmid', value: '12345' },
    });
    expect(i.external_ref.kind).toBe('pmid');
  });

  it('parses propose_excerpt with quoted_span', () => {
    const i = ProposeExcerptInput.parse({
      cause_id: 'cause_crc',
      home_sub_topic_id: 'st_ctdna_mrd',
      parent_anchor_id: 'n_anchor_1',
      content: 'rfs differed by ctDNA status',
      quoted_span: { text: 'recurrence-free survival differed', offset: 200 },
    });
    expect(i.quoted_span.offset).toBe(200);
  });

  it('parses propose_synthesis with kind=synthesis or open_question', () => {
    expect(
      ProposeSynthesisInput.parse({
        cause_id: 'cause_crc',
        home_sub_topic_id: 'st_ctdna_mrd',
        parent_ids: ['n_e1'],
        content: 'consolidates two cohorts',
        kind: 'synthesis',
      }).kind,
    ).toBe('synthesis');

    expect(
      ProposeSynthesisInput.parse({
        cause_id: 'cause_crc',
        home_sub_topic_id: 'st_ctdna_mrd',
        parent_ids: ['n_e1'],
        content: 'gap question',
        kind: 'open_question',
      }).kind,
    ).toBe('open_question');
  });

  it('rejects propose_synthesis with kind outside the set', () => {
    expect(() =>
      ProposeSynthesisInput.parse({
        cause_id: 'cause_crc',
        home_sub_topic_id: 'st_ctdna_mrd',
        parent_ids: ['n_e1'],
        content: 'x',
        kind: 'anchor',
      }),
    ).toThrow();
  });

  it('parses supersedes / membership / sub_topic inputs', () => {
    expect(
      ProposeSupersedesInput.parse({
        from_node_id: 'n_old',
        to_node_id: 'n_new',
        rationale: 'larger cohort',
      }).rationale,
    ).toContain('larger');

    expect(
      ProposeMembershipInput.parse({
        node_id: 'n_def',
        sub_topic_id: 'st_lynch',
      }).sub_topic_id,
    ).toBe('st_lynch');

    expect(
      ProposeSubTopicInput.parse({
        cause_id: 'cause_crc',
        name: 'ctDNA-MRD in stage II',
        description: 'd',
        scope_query: 'pubmed:(ctDNA AND CRC)',
      }).name,
    ).toContain('ctDNA');
  });
});

describe('Review and read-path tool I/O', () => {
  it('parses cast_review_vote input', () => {
    const i = CastReviewVoteInput.parse({
      proposal_id: 'prop_1',
      decision: 'accept',
      rationale: 'span verifies',
    });
    expect(i.decision).toBe('accept');
  });

  it('parses query_frontier with all filters optional', () => {
    expect(QueryFrontierInput.parse({}).cause_id).toBeUndefined();
    expect(QueryFrontierInput.parse({ frontier_kind: 'needs_review' }).frontier_kind).toBe(
      'needs_review',
    );
  });

  it('parses query_proposals with status + assigned_to_me', () => {
    const i = QueryProposalsInput.parse({ status: 'staged', assigned_to_me: true });
    expect(i.assigned_to_me).toBe(true);
  });

  it('parses a calibration batch output', () => {
    const o = FetchCalibrationBatchOutput.parse({
      items: [
        {
          proposal_id: 'prop_1',
          payload: {
            kind: 'membership',
            node_id: 'n_def',
            sub_topic_id: 'st_lynch',
          },
        },
      ],
    });
    expect(o.items[0]?.proposal_id).toBe('prop_1');
  });

  it('parses fetch_calibration_batch input', () => {
    expect(FetchCalibrationBatchInput.parse({ sub_topic_id: 'st_ctdna_mrd' }).sub_topic_id).toBe(
      'st_ctdna_mrd',
    );
  });

  it('rejects ReviewBatchItem leaking status (indistinguishability)', () => {
    expect(() =>
      ReviewBatchItem.parse({
        proposal_id: 'prop_1',
        payload: {
          kind: 'membership',
          node_id: 'n_def',
          sub_topic_id: 'st_lynch',
        },
        status: 'accepted',
      }),
    ).toThrow();
  });

  it('rejects ReviewBatchItem leaking created_at (age-based attack surface)', () => {
    expect(() =>
      ReviewBatchItem.parse({
        proposal_id: 'prop_1',
        payload: {
          kind: 'membership',
          node_id: 'n_def',
          sub_topic_id: 'st_lynch',
        },
        created_at: '2026-05-06T12:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('ToolName registry', () => {
  it('enumerates all 16 tools', () => {
    const expected = [
      'set_capacity',
      'request_assignment',
      'accept_assignment',
      'decline_assignment',
      'submit_assigned_proposal',
      'propose_anchor',
      'propose_excerpt',
      'propose_synthesis',
      'propose_supersedes',
      'propose_membership',
      'propose_change_of_home',
      'propose_sub_topic',
      'cast_review_vote',
      'query_frontier',
      'query_proposals',
      'fetch_calibration_batch',
    ];
    for (const name of expected) {
      expect(ToolName.parse(name)).toBe(name);
    }
  });

  it('rejects an unknown tool name', () => {
    expect(() => ToolName.parse('propose_cross_link')).toThrow();
  });
});
