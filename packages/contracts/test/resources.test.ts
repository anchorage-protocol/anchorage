import { describe, expect, it } from 'vitest';
import {
  CauseDirectory,
  ContributorProfile,
  NodeNeighborhood,
  PublicReputation,
  PublicReputationTier,
  ResourceName,
  Subgraph,
  SubTopicActivityCounters,
  SubTopicDetail,
} from '../src/index.js';

describe('CauseDirectory', () => {
  it('accepts an empty list', () => {
    expect(CauseDirectory.parse({ causes: [] })).toEqual({ causes: [] });
  });

  it('requires each entry to carry its cause + sub-topics', () => {
    expect(() => CauseDirectory.parse({ causes: [{}] })).toThrow();
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(() => CauseDirectory.parse({ causes: [], extra: 1 })).toThrow();
  });
});

describe('SubTopicActivityCounters', () => {
  it('rejects negative counters', () => {
    expect(() =>
      SubTopicActivityCounters.parse({
        active_nodes: -1,
        staged_proposals: 0,
        frontier_items: 0,
      }),
    ).toThrow();
  });

  it('rejects non-integer counters', () => {
    expect(() =>
      SubTopicActivityCounters.parse({
        active_nodes: 1.5,
        staged_proposals: 0,
        frontier_items: 0,
      }),
    ).toThrow();
  });
});

describe('SubTopicDetail', () => {
  it('rejects when activity is missing', () => {
    expect(() =>
      SubTopicDetail.parse({
        sub_topic: {},
        cause: {},
      }),
    ).toThrow();
  });
});

describe('NodeNeighborhood', () => {
  it('accepts an empty edge set (isolated node)', () => {
    // We can't parse a real Node without setting up valid shape; the
    // shape-check on the wrapping object itself is what matters here.
    expect(() => NodeNeighborhood.parse({})).toThrow();
  });
});

describe('Subgraph', () => {
  it('rejects unknown extra keys (strict)', () => {
    expect(() =>
      Subgraph.parse({
        sub_topic: {},
        nodes: [],
        edges: [],
        extra: true,
      }),
    ).toThrow();
  });
});

describe('PublicReputationTier', () => {
  // The v0 tier mapping committed in PRD §Reputation slice 5c:
  // three tiers derived from a contributor's (`demonstrated`,
  // `recent`) for the specific (cause, sub-topic) against the
  // server's `assignment_min_demonstrated` and `assignment_min_recent`
  // thresholds. Drift between the enum and the spec is caught here.
  it('exposes exactly the three v0 tiers', () => {
    expect([...PublicReputationTier.options].sort()).toEqual(
      ['none', 'quiet', 'contributing'].sort(),
    );
  });

  it('rejects an unknown tier (no leakage of numeric ranks)', () => {
    expect(() => PublicReputationTier.parse('tier-3')).toThrow();
  });
});

describe('PublicReputation / ContributorProfile', () => {
  it('PublicReputation rejects unknown extra keys (strict)', () => {
    expect(() => PublicReputation.parse({ entries: [], extra: 1 })).toThrow();
  });

  it('ContributorProfile rejects unknown extra keys (strict)', () => {
    expect(() =>
      ContributorProfile.parse({
        contributor: {},
        reputation: { entries: [] },
        extra: 1,
      }),
    ).toThrow();
  });
});

describe('ResourceName registry', () => {
  // The expected list mirrors the five MCP resources committed by PRD
  // §Read-path tools and resources (slice 5a: cause, sub-topic, node,
  // subgraph; slice 5c: contributor). Drift between the enum and the
  // wired MCP `registerResource` calls is caught at the wrapper level
  // (the exhaustive test in packages/server/src/mcp-resources.test.ts);
  // this is the contracts-side complement.
  const expected = ['cause', 'sub-topic', 'node', 'subgraph', 'contributor'] as const;

  it('parses every expected resource name', () => {
    for (const name of expected) {
      expect(ResourceName.parse(name)).toBe(name);
    }
  });

  it('exposes exactly the expected resources (no drift between enum and spec)', () => {
    expect([...ResourceName.options].sort()).toEqual([...expected].sort());
  });

  it('rejects an unknown resource name', () => {
    expect(() => ResourceName.parse('manuscript')).toThrow();
  });
});
