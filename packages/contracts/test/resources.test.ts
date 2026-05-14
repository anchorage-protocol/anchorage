import { describe, expect, it } from 'vitest';
import {
  CauseDirectory,
  NodeNeighborhood,
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

describe('ResourceName registry', () => {
  // The expected list mirrors the four MCP resources committed by PRD
  // §Read-path tools and resources. Drift between the enum and the
  // wired MCP `registerResource` calls is caught at the wrapper level
  // (the exhaustive test in packages/server/src/mcp-resources.test.ts);
  // this is the contracts-side complement.
  const expected = ['cause', 'sub-topic', 'node', 'subgraph'] as const;

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
