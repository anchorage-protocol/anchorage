import {
  type CassetteEntry,
  type FetchLike,
  recordingFetch,
  runLlmAgent,
} from '@anchorage/testbed';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { runPopulationRounds } from './population-loop.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Record/replay end-to-end through `runLlmAgent` + a real wired MCP
// server. `recording-fetch.test.ts` unit-tests the wrapper in
// isolation; this test pins the property that makes a checked-in golden
// cassette viable: a `record` pass produces a cassette, and a `replay`
// pass against a freshly-seeded-but-identical server reproduces the same
// run from that cassette alone — never touching the transport.
//
// The seed discipline is the load-bearing bit: a turn-N request body is
// `JSON.stringify({ model, system, messages, tools, max_tokens })`, and
// `messages` carries the prior tool results, which include server-
// generated ids (an assignment_id from request_assignment, etc.). Two
// servers built with the same `SeededIdGen` seed and the same bootstrap
// sequence mint the same ids, so the recording run's request bodies and
// the replay run's are byte-identical and every request hits the
// cassette. (This is also why a real golden cassette must be recorded
// against the same seeded fixture it's replayed against, and re-recorded
// if the fixture or the tool surface changes — noted in
// recording-fetch.ts.)

async function seededServer(seed: string): Promise<{
  server: Server;
  causeId: string;
  agentId: string;
}> {
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen(seed),
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
  const anchor = await server.tools.proposeAnchor(
    { identity_id: seeder.id },
    {
      cause_id: cause.id,
      home_sub_topic_id: subTopic.id,
      content: 'landmark trial',
      external_ref: { kind: 'pmid', value: '1' },
    },
  );
  server.curator.acceptProposal(anchor.proposal_id);
  const agent = server.bootstrap.mintIdentity({ display_name: 'agent' });
  return { server, causeId: cause.id, agentId: agent.id };
}

async function wireMcpClient(server: Server, identityId: string): Promise<Client> {
  const mcp = buildMcpServer(server, { caller: { identity_id: identityId as never } });
  const client = new Client({ name: 'cassette-agent', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  return client;
}

// A tiny scripted "model": set_capacity → request_assignment → done.
// Three turns, three Messages-API round-trips — enough that turn 2's
// tool result (a server-minted assignment) flows back into turn 3's
// request body, so the round-trip exercises id-threading, not just
// stateless calls.
function scriptedFetch(causeId: string): FetchLike {
  let turn = 0;
  return async (_url, _init) => {
    turn += 1;
    const reply = (content: unknown[], stopReason: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          stop_reason: stopReason,
          content,
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
    });
    if (turn === 1) {
      return reply(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'set_capacity',
            input: { cause_id: causeId, rate: 5, kinds: ['excerpt'] },
          },
        ],
        'tool_use',
      );
    }
    if (turn === 2) {
      return reply(
        [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'request_assignment',
            input: { cause_id: causeId },
          },
        ],
        'tool_use',
      );
    }
    return reply([{ type: 'text', text: 'oriented; stopping here.' }], 'end_turn');
  };
}

function runConfig(causeId: string, fetch: FetchLike) {
  return {
    apiKey: 'cassette-test-no-key',
    model: 'fake-model',
    system: 'You are an Anchorage contributor.',
    task: `You are connected to the Anchorage MCP server. Cause id: ${causeId}. Set excerpt capacity, pull a task, then stop.`,
    max_turns: 8,
    fetch,
  };
}

function transcriptShape(turns: { tool_calls: { name: string; is_error: boolean }[] }[]): string[] {
  return turns.flatMap((t) => t.tool_calls).map((c) => `${c.name}:${c.is_error ? 'err' : 'ok'}`);
}

describe('cassette record/replay through runLlmAgent', () => {
  it('a replay run reproduces a recorded run from the cassette alone, untouched transport', async () => {
    // Record pass.
    const rec = await seededServer('cassette-fixture');
    const recClient = await wireMcpClient(rec.server, rec.agentId);
    const entries: CassetteEntry[] = [];
    const recResult = await runLlmAgent(
      recClient,
      runConfig(
        rec.causeId,
        recordingFetch({ mode: 'record', entries, fetch: scriptedFetch(rec.causeId) }),
      ),
    );
    expect(entries.length).toBe(3);
    expect(recResult.stop_reason).toBe('end_turn');
    const recShape = transcriptShape(recResult.turns);
    expect(recShape).toEqual(['set_capacity:ok', 'request_assignment:ok']);

    // Replay pass: fresh server, *same seed* → same ids → byte-identical
    // requests → every request hits the cassette. The transport here
    // throws if consulted, proving replay never reached it.
    const rep = await seededServer('cassette-fixture');
    const repClient = await wireMcpClient(rep.server, rep.agentId);
    let transportCalled = false;
    const wouldThrow: FetchLike = async () => {
      transportCalled = true;
      throw new Error('transport must not be called in replay mode');
    };
    const repResult = await runLlmAgent(
      repClient,
      runConfig(rep.causeId, recordingFetch({ mode: 'replay', entries, fetch: wouldThrow })),
    );

    expect(transportCalled).toBe(false);
    expect(repResult.stop_reason).toBe(recResult.stop_reason);
    expect(transcriptShape(repResult.turns)).toEqual(recShape);
    expect(repResult.usage).toEqual(recResult.usage);
    // Server state reached the same place.
    expect([...rep.server.store.assignments.values()].length).toBe(
      [...rec.server.store.assignments.values()].length,
    );
    expect([...rep.server.store.capacities.values()].length).toBe(
      [...rec.server.store.capacities.values()].length,
    );
  });

  it('a sequential population round replays exactly from one shared cassette', async () => {
    // The population analogue of the single-agent round-trip above, and
    // the regression handle for `runPopulationRounds`' `concurrency`
    // knob: when a round runs *sequentially* (the regime
    // `run-population.ts` / `run-deep-loop.ts` switch to whenever a
    // cassette is in play) the whole multi-agent run's request sequence
    // is a pure function of the seeded fixture — each agent finishes
    // before the next starts, so the ids the server mints, and therefore
    // the request bodies that thread them, fall in a fixed order. One
    // shared cassette recorded that way replays every agent's every turn
    // exactly, transport untouched — which is what makes a deep-loop
    // golden cassette viable the same way the single-agent round-trip
    // makes `run-live`'s viable. (A *concurrent* recording would not:
    // the agents' mints would interleave latency-dependently, so a
    // replay's request bodies would diverge and miss — hence the
    // `concurrency: 'sequential'` wiring this pins.)
    interface PopAgent {
      display_name: string;
      client: Client;
    }
    async function seededPopulation(
      seed: string,
      size: number,
    ): Promise<{ server: Server; causeId: string; agents: PopAgent[] }> {
      const server = new Server({
        clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
        idGen: new SeededIdGen(seed),
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
      const anchor = await server.tools.proposeAnchor(
        { identity_id: seeder.id },
        {
          cause_id: cause.id,
          home_sub_topic_id: subTopic.id,
          content: 'landmark trial',
          external_ref: { kind: 'pmid', value: '1' },
        },
      );
      server.curator.acceptProposal(anchor.proposal_id);
      const agents: PopAgent[] = [];
      for (let i = 1; i <= size; i++) {
        const identity = server.bootstrap.mintIdentity({ display_name: `agent-${i}` });
        agents.push({
          display_name: `agent-${i}`,
          client: await wireMcpClient(server, identity.id),
        });
      }
      return { server, causeId: cause.id, agents };
    }

    // Record pass: a one-round sequential population. The shared scripted
    // model is the same set_capacity → request_assignment → stop walk
    // the single-agent test uses; with one orphan anchor and two agents,
    // agent-1 (running first) gets the assignment, agent-2's request
    // comes back not_found — so the two agents' turn-3 request bodies
    // differ, which is exactly the per-agent divergence the cassette has
    // to key on.
    const rec = await seededPopulation('pop-cassette', 2);
    const entries: CassetteEntry[] = [];
    const recTranscripts: Record<string, string[]> = {};
    const recResult = await runPopulationRounds<PopAgent>({
      server: rec.server,
      contributors: rec.agents,
      max_rounds: 1,
      concurrency: 'sequential',
      runContributor: async (a) => {
        const r = await runLlmAgent(
          a.client,
          runConfig(
            rec.causeId,
            recordingFetch({ mode: 'record', entries, fetch: scriptedFetch(rec.causeId) }),
          ),
        );
        recTranscripts[a.display_name] = transcriptShape(r.turns);
        return { usage: r.usage };
      },
    });
    expect(recResult.rounds_run).toBe(1);
    expect(recTranscripts['agent-1']).toEqual(['set_capacity:ok', 'request_assignment:ok']);
    expect(recTranscripts['agent-2']).toEqual(['set_capacity:ok', 'request_assignment:err']);

    // Replay pass: fresh population, *same seed* → the same ids minted in
    // the same order → byte-identical request bodies → every request
    // hits the cassette. The transport throws if consulted.
    const rep = await seededPopulation('pop-cassette', 2);
    let transportCalled = false;
    const wouldThrow: FetchLike = async () => {
      transportCalled = true;
      throw new Error('transport must not be called in replay mode');
    };
    const repTranscripts: Record<string, string[]> = {};
    const repResult = await runPopulationRounds<PopAgent>({
      server: rep.server,
      contributors: rep.agents,
      max_rounds: 1,
      concurrency: 'sequential',
      runContributor: async (a) => {
        const r = await runLlmAgent(
          a.client,
          runConfig(rep.causeId, recordingFetch({ mode: 'replay', entries, fetch: wouldThrow })),
        );
        repTranscripts[a.display_name] = transcriptShape(r.turns);
        return { usage: r.usage };
      },
    });

    expect(transportCalled).toBe(false);
    expect(repResult.rounds_run).toBe(recResult.rounds_run);
    expect(repTranscripts).toEqual(recTranscripts);
    // Server state reached the same place: both agents declared capacity,
    // one assignment was handed out.
    expect([...rep.server.store.capacities.values()].length).toBe(
      [...rec.server.store.capacities.values()].length,
    );
    expect([...rep.server.store.assignments.values()].length).toBe(
      [...rec.server.store.assignments.values()].length,
    );
  });

  it('replaying an incomplete cassette throws a cassette-miss error', async () => {
    const rec = await seededServer('cassette-fixture-2');
    const recClient = await wireMcpClient(rec.server, rec.agentId);
    const entries: CassetteEntry[] = [];
    await runLlmAgent(
      recClient,
      runConfig(
        rec.causeId,
        recordingFetch({ mode: 'record', entries, fetch: scriptedFetch(rec.causeId) }),
      ),
    );
    // Drop the last recorded round-trip — the replay run will get
    // through the early turns and then miss.
    entries.pop();

    const rep = await seededServer('cassette-fixture-2');
    const repClient = await wireMcpClient(rep.server, rep.agentId);
    const wouldThrow: FetchLike = async () => {
      throw new Error('transport must not be called in replay mode');
    };
    await expect(
      runLlmAgent(
        repClient,
        runConfig(rep.causeId, recordingFetch({ mode: 'replay', entries, fetch: wouldThrow })),
      ),
    ).rejects.toThrow(/cassette miss in replay mode/);
  });
});
