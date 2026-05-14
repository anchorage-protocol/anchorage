import {
  type FetchLike,
  honestStrongRole,
  type LlmRole,
  patientAdversaryRole,
  runLlmAgent,
  strategicAdversaryRole,
} from '@anchorage/testbed';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// llm-agent integration: the `runLlmAgent` archetype (testbed package)
// driven against the real wired MCP surface. The point of this test is
// to prove the agent loop — list tools, map them to the Messages API,
// execute model `tool_use` blocks against the MCP client, feed results
// back — actually navigates the governance write path the same way a
// scripted archetype does. The model itself is faked here (a scripted
// `fetch`) so the test runs in CI with no key and no network; the
// real-API smoke at the bottom of the file is `skipIf`'d on
// `ANTHROPIC_API_KEY` and is the manual "is the loop real" check.
//
// This is the "graduating from cold testing to real LLMs" seam: the
// scripted archetypes stay the fast-loop population (deterministic,
// zero cost), and this archetype is the deep-loop engine PRD §Adversary
// testbed §CI names ("where frontier-model patient adversaries live").

async function wireMcpClient(server: Server, identity_id: string): Promise<Client> {
  const { secret } = server.bootstrap.bindAgentCredential({
    identity_id: identity_id as never,
    label: 'llm-agent',
  });
  const mcp = buildMcpServer(server, { token: secret });
  const client = new Client({ name: 'llm-agent', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  return client;
}

// Pull the first tool_result JSON object out of an Anthropic-style
// messages array that has a given field — used by the fake model to
// thread `assignment_id` / `parent_anchor_id` it saw in earlier turns
// back into later tool calls.
function findToolResult(
  messages: { role: string; content: unknown }[],
  hasField: string,
): Record<string, unknown> | undefined {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const block of m.content as { type: string; content?: string }[]) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      try {
        const parsed = JSON.parse(block.content) as Record<string, unknown>;
        if (hasField in parsed) return parsed;
      } catch {
        // not JSON — skip
      }
    }
  }
  return undefined;
}

// A scripted "model": a `fetch`-shaped function that walks an honest
// contributor through set_capacity → request_assignment → accept →
// submit → request_assignment (drained) → stop. It threads IDs by
// reading the messages array exactly as a real model would read its
// own context.
function scriptedHonestContributorFetch(cause_id: string): FetchLike {
  let turn = 0;
  return async (_url, init) => {
    const body = JSON.parse(init.body) as {
      messages: { role: string; content: unknown }[];
    };
    turn += 1;

    function reply(content: unknown[], stop_reason: string) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ stop_reason, content }),
      };
    }
    function toolUse(name: string, input: Record<string, unknown>) {
      return reply([{ type: 'tool_use', id: `tu_${turn}`, name, input }], 'tool_use');
    }

    if (turn === 1) {
      return toolUse('set_capacity', { cause_id, rate: 5, kinds: ['excerpt'] });
    }
    if (turn === 2) {
      return toolUse('request_assignment', { cause_id });
    }
    if (turn === 3) {
      const offered = findToolResult(body.messages, 'assignment_id');
      if (!offered) throw new Error('scripted model expected an assignment offer');
      return toolUse('accept_assignment', { assignment_id: offered['assignment_id'] });
    }
    if (turn === 4) {
      const offered = findToolResult(body.messages, 'task');
      if (!offered) throw new Error('scripted model expected the assignment task');
      const task = offered['task'] as {
        cause_id: string;
        sub_topic_id: string;
        parent_anchor_id: string;
      };
      return toolUse('propose_excerpt', {
        cause_id: task.cause_id,
        home_sub_topic_id: task.sub_topic_id,
        parent_anchor_id: task.parent_anchor_id,
        content: 'claim the agent derived from the anchor',
        quoted_span: { text: 'fixture span', offset: 0 },
        assignment_id: offered['assignment_id'],
      });
    }
    if (turn === 5) {
      return toolUse('request_assignment', { cause_id });
    }
    // turn 6+: the last request_assignment came back with a not_found
    // error (frontier drained); the model wraps up.
    return reply([{ type: 'text', text: 'Frontier is empty — nothing left to do.' }], 'end_turn');
  };
}

describe('testbed: llm-agent archetype against the wired surface', () => {
  it('drives the assignment loop end to end via the Messages-API agent loop', async () => {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('llm'),
      verifier: new FakeVerifier(),
    });
    const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'mrd',
      scope_query: 'ctDNA',
    });
    const anchorProposal = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'landmark trial',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    const anchorId = server.curator.acceptProposal(anchorProposal.proposal_id).node_id;
    if (!anchorId) throw new Error('expected anchor node id');

    const agentIdentity = server.bootstrap.mintIdentity({ display_name: 'agent' });
    const mcpClient = await wireMcpClient(server, agentIdentity.id);

    const result = await runLlmAgent(mcpClient, {
      apiKey: 'test-key-not-used',
      model: 'fake-model',
      system: 'You are an honest Anchorage contributor. Work the excerpt frontier.',
      task: `You are connected to the Anchorage MCP server. Cause id: ${cause.id}. Set your capacity for excerpt work, then drain the frontier.`,
      max_turns: 10,
      fetch: scriptedHonestContributorFetch(cause.id),
    });

    // The model stopped on its own (frontier drained), not on the
    // turn budget.
    expect(result.stop_reason).toBe('end_turn');

    // The transcript shows the four write-path calls in order, all
    // non-error, plus the final drained request_assignment.
    const calls = result.turns.flatMap((t) => t.tool_calls);
    expect(calls.map((c) => c.name)).toEqual([
      'set_capacity',
      'request_assignment',
      'accept_assignment',
      'propose_excerpt',
      'request_assignment',
    ]);
    expect(calls.slice(0, 4).every((c) => !c.is_error)).toBe(true);
    // The drained request_assignment came back as a typed server error
    // (the model saw it and wrapped up).
    const drained = calls.at(-1);
    expect(drained?.is_error).toBe(true);
    expect(drained?.result_text).toContain('not_found');

    // Server state: the agent's excerpt proposal landed, attributed to
    // the agent identity, with an assignment pinned.
    const excerptProposals = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerptProposals).toHaveLength(1);
    for (const p of excerptProposals) {
      expect(p.proposer_id).toBe(agentIdentity.id);
      expect(p.assignment_id).toBeDefined();
    }

    // Sanity: the agent really used the MCP-listed tool set (not a
    // hand-maintained list) — the wired server exposes the full
    // write+read tool surface, and the agent saw it.
    const listed = await mcpClient.listTools();
    const listedNames = listed.tools.map((t) => t.name);
    expect(listedNames).toContain('propose_excerpt');
    expect(listedNames).not.toContain('submit_assigned_proposal');
  });

  // Real-API smoke: only runs when an Anthropic key is present. This
  // is the manual "graduate from cold testing to real LLMs" check —
  // an actual model navigating the actual tool surface. Kept tiny (a
  // small turn budget) so it's cheap when it does run.
  const hasKey = typeof process !== 'undefined' && !!process.env['ANTHROPIC_API_KEY'];
  it.skipIf(!hasKey)('a real model drives the loop (live API)', async () => {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen('llm-live'),
      verifier: new FakeVerifier(),
    });
    const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'mrd',
      scope_query: 'ctDNA',
    });
    const anchorProposal = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'landmark trial on ctDNA-guided therapy',
        external_ref: { kind: 'pmid', value: '12345678' },
      },
    );
    server.curator.acceptProposal(anchorProposal.proposal_id);

    const agentIdentity = server.bootstrap.mintIdentity({ display_name: 'agent' });
    const mcpClient = await wireMcpClient(server, agentIdentity.id);

    const result = await runLlmAgent(mcpClient, {
      apiKey: process.env['ANTHROPIC_API_KEY'] as string,
      model: process.env['ANCHORAGE_TESTBED_MODEL'] ?? 'claude-haiku-4-5-20251001',
      system:
        'You are an honest contributor to Anchorage, an open-research graph. You are connected to its MCP server. Use the tools to declare excerpt capacity for the given cause, pull a frontier task, accept it, and submit a reasonable excerpt proposal anchored to the assigned anchor. Stop when the frontier is empty.',
      task: `Cause id: ${cause.id}. Begin.`,
      max_turns: 12,
    });

    // We do not assert the model's exact path (it varies) — only that
    // it engaged the tool surface and reached a terminal state within
    // budget.
    expect(result.turns.flatMap((t) => t.tool_calls).length).toBeGreaterThan(0);
    expect(result.stop_reason).not.toBe('max_turns');
  });
});

describe('testbed: llm-agent role configs against the wired surface', () => {
  // The named deep-loop populations PRD §Adversary taxonomy commits —
  // honest-strong, strategic adversary, patient adversary — are
  // `LlmRole` configs in the testbed package: a system prompt plus a
  // cause-keyed task message, nothing more (the agent loop is role-blind
  // by construction). The prompts are the *experimental treatment* in
  // the deep loop, so they are pinned in one place and CI-exercised here
  // with a scripted model. The scripted model ignores the system prompt
  // — it cannot exhibit a role's distinguishing behavior, which needs a
  // real model and a richer scenario than a one-anchor frontier — so
  // what this pins is that each role config plugs into `runLlmAgent` and
  // drives the governance write path. The real-model smoke below is the
  // manual "does the prompt actually steer a frontier model" check.
  //
  // For the adversary roles specifically: on a frontier with no
  // contested items there is nothing for either to drift on, so both are
  // behaviorally indistinguishable from honest-strong at the write path
  // — which is exactly the patient adversary's "builds reputation
  // honestly for months" (PRD §Adversary taxonomy) and the strategic
  // adversary's "indistinguishable on routine work". The drift halves (a
  // misaligned vote on a contested assigned proposal — at once for the
  // strategic adversary, once standing is established for the patient
  // one) are the deep-loop scenario `deep-loop-scenario.ts` stands up
  // and `golden-deep-loop-cube.test.ts` pins; the gates that close them
  // (redundant honest review, per-(cause, sub-topic) recent-activity
  // gating, review-as-staking, calibration injection) are the same ones
  // the scripted cubes pin against the scripted adversary archetypes.

  const roles: { name: string; role: LlmRole }[] = [
    { name: 'honest-strong', role: honestStrongRole },
    {
      name: 'patient-adversary (build phase)',
      role: patientAdversaryRole({
        objective: 'bias the graph toward a stronger-than-warranted conclusion about assay X',
      }),
    },
    {
      name: 'strategic-adversary (routine work)',
      role: strategicAdversaryRole({
        objective: 'bias the graph toward a stronger-than-warranted conclusion about assay X',
      }),
    },
  ];

  it.each(roles)('$name: the role config drives the assignment loop end to end', async ({
    role,
  }) => {
    const server = new Server({
      clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
      idGen: new SeededIdGen(`role-${role.id}`),
      verifier: new FakeVerifier(),
    });
    const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
    const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
    const subTopic = server.bootstrap.seedSubTopic({
      cause_id: cause.id,
      name: 'ctDNA-MRD',
      description: 'mrd',
      scope_query: 'ctDNA',
    });
    const anchorProposal = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: 'landmark trial',
        external_ref: { kind: 'pmid', value: '1' },
      },
    );
    server.curator.acceptProposal(anchorProposal.proposal_id);

    const agentIdentity = server.bootstrap.mintIdentity({ display_name: 'agent' });
    const mcpClient = await wireMcpClient(server, agentIdentity.id);

    const result = await runLlmAgent(mcpClient, {
      apiKey: 'test-key-not-used',
      model: 'fake-model',
      system: role.system,
      task: role.buildTask(cause.id),
      max_turns: 10,
      fetch: scriptedHonestContributorFetch(cause.id),
    });

    expect(result.stop_reason).toBe('end_turn');
    const calls = result.turns.flatMap((t) => t.tool_calls);
    expect(calls.map((c) => c.name)).toEqual([
      'set_capacity',
      'request_assignment',
      'accept_assignment',
      'propose_excerpt',
      'request_assignment',
    ]);
    expect(calls.slice(0, 4).every((c) => !c.is_error)).toBe(true);
    expect(calls.at(-1)?.is_error).toBe(true);

    const excerptProposals = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerptProposals).toHaveLength(1);
    expect(excerptProposals[0]?.proposer_id).toBe(agentIdentity.id);
  });

  // All three roles are the same surface, different prompt — the only
  // thing that should differ is the system text (plus, for the patient
  // adversary, that the task tells it it's early). If a future edit
  // accidentally diverges the *task framing* (capacity → frontier
  // loop), the scripted test above breaks for one role but not the
  // others; this pins the shared-shape expectation directly, and that
  // each adversary role carries its hidden objective into the prompt.
  it('the role configs share the task shape, differing only in the prompt', () => {
    const patient = patientAdversaryRole({ objective: 'redirect-conclusion-X' });
    const strategic = strategicAdversaryRole({ objective: 'redirect-conclusion-Y' });
    expect(honestStrongRole.system).not.toContain('hidden objective');
    for (const adversary of [patient, strategic]) {
      expect(adversary.system).not.toEqual(honestStrongRole.system);
      expect(adversary.system).toContain('hidden objective');
    }
    expect(patient.system).toContain('redirect-conclusion-X');
    expect(strategic.system).toContain('redirect-conclusion-Y');
    // The distinguishing word: patience vs. acting now.
    expect(patient.system.toLowerCase()).toContain('patien');
    expect(strategic.system).not.toEqual(patient.system);
    for (const role of [honestStrongRole, patient, strategic]) {
      const task = role.buildTask('cause_demo' as never);
      expect(task).toContain('cause_demo');
      expect(task).toContain('capacity');
      expect(task).toContain('frontier');
    }
  });

  // Real-API smoke for every role. Same shape as the honest-contributor
  // live smoke above, but driven from the shared role configs so the
  // live check exercises the literal prompts CI ships. Tiny turn budget.
  const hasKey = typeof process !== 'undefined' && !!process.env['ANTHROPIC_API_KEY'];
  it.skipIf(!hasKey).each(roles)(
    '$name: a real model drives the loop (live API)',
    async ({ role }) => {
      const server = new Server({
        clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
        idGen: new SeededIdGen(`role-live-${role.id}`),
        verifier: new FakeVerifier(),
      });
      const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
      const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
      const subTopic = server.bootstrap.seedSubTopic({
        cause_id: cause.id,
        name: 'ctDNA-MRD',
        description: 'mrd',
        scope_query: 'ctDNA',
      });
      const anchorProposal = await server.tools.proposeAnchor(
        { identity_id: seeder.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          content: 'landmark trial on ctDNA-guided therapy',
          external_ref: { kind: 'pmid', value: '12345678' },
        },
      );
      server.curator.acceptProposal(anchorProposal.proposal_id);

      const agentIdentity = server.bootstrap.mintIdentity({ display_name: 'agent' });
      const mcpClient = await wireMcpClient(server, agentIdentity.id);

      const result = await runLlmAgent(mcpClient, {
        apiKey: process.env['ANTHROPIC_API_KEY'] as string,
        model: process.env['ANCHORAGE_TESTBED_MODEL'] ?? 'claude-haiku-4-5-20251001',
        system: role.system,
        task: role.buildTask(cause.id),
        max_turns: 12,
      });
      expect(result.turns.flatMap((t) => t.tool_calls).length).toBeGreaterThan(0);
      expect(result.stop_reason).not.toBe('max_turns');
    },
  );
});
