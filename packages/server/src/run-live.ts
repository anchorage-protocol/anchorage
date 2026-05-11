// Live runner: point a real model at the wired Anchorage MCP surface
// and watch it work. This is the manual counterpart to the
// `llm-agent.test.ts` integration test — the test proves the agent
// loop drives the governance write path with a *scripted* model (so it
// runs in CI with no key); this script runs the same loop against an
// *actual* model so you can read the transcript.
//
// It is deliberately not a test and not part of the package's public
// surface — it is harness glue, in the same category as the in-process
// wiring in `testbed.test.ts`: the archetype itself (`runLlmAgent`,
// in the testbed package) only ever sees the MCP client, and this
// script is the bit that stands a concrete in-process server up behind
// that client and seeds it with a small amount of work.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server live
//   ANCHORAGE_TESTBED_MODEL=claude-sonnet-4-6 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server live
//
// Without a key it prints how to set one and exits 0 (so it is safe to
// invoke unconditionally).

import { runLlmAgent } from '@anchorage/testbed';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

async function main(): Promise<void> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.log(
      [
        'No ANTHROPIC_API_KEY set — nothing to run.',
        '',
        'This script points a real model at the wired Anchorage MCP server.',
        'Set a key and re-run:',
        '',
        '  ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server live',
        '',
        `Optionally override the model (default ${DEFAULT_MODEL}):`,
        '',
        '  ANCHORAGE_TESTBED_MODEL=claude-sonnet-4-6 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server live',
      ].join('\n'),
    );
    return;
  }
  const model = process.env['ANCHORAGE_TESTBED_MODEL'] ?? DEFAULT_MODEL;

  // Stand up a server with a tiny seeded graph: one cause, one
  // sub-topic, three orphan anchors waiting for excerpts.
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('live'),
    verifier: new FakeVerifier(),
  });
  const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
  const cause = server.bootstrap.createCause({
    name: 'CRC',
    description: 'colon cancer',
  });
  const subTopic = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'ctDNA minimal residual disease in resected CRC',
    scope_query: 'ctDNA MRD CRC',
  });
  for (let i = 1; i <= 3; i++) {
    const proposal = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: `seed anchor ${i}`,
        external_ref: { kind: 'pmid', value: String(10_000_000 + i) },
      },
    );
    server.curator.acceptProposal(proposal.proposal_id);
  }

  const agentIdentity = server.bootstrap.mintIdentity({ display_name: 'live-agent' });
  const mcp = buildMcpServer(server, { caller: { identity_id: agentIdentity.id as never } });
  const client = new Client({ name: 'live-agent', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);

  console.log(`# live llm-agent run — model=${model}`);
  console.log(`# cause=${cause.id} sub_topic=${subTopic.id} (3 orphan anchors seeded)\n`);

  const result = await runLlmAgent(client, {
    apiKey,
    model,
    system: [
      'You are an honest contributor to Anchorage, an open cooperative-research graph.',
      'You are connected to its MCP server. The graph is organized as cause -> sub-topic -> claims.',
      'Your job: declare excerpt capacity for the given cause, then repeatedly pull a frontier task,',
      'accept it, and submit a reasonable excerpt proposal anchored to the assigned anchor (a short',
      'atomic claim plus a verbatim quoted span). Decline tasks you cannot do. Stop when the frontier',
      'is empty (request_assignment returns a not_found error). Keep going until then.',
    ].join(' '),
    task: `Cause id: ${cause.id}. Begin by setting your capacity, then work the frontier.`,
    max_turns: 24,
    on_turn: (turn, index) => {
      if (turn.text.trim()) console.log(`[turn ${index}] ${turn.text.trim()}`);
      for (const call of turn.tool_calls) {
        const tag = call.is_error ? 'ERROR' : 'ok';
        console.log(
          `[turn ${index}] -> ${call.name}(${JSON.stringify(call.input)}) => ${tag}: ${call.result_text}`,
        );
      }
    },
  });

  console.log(`\n# stop_reason=${result.stop_reason}, turns=${result.turns.length}`);
  const excerpts = [...server.store.proposals.values()].filter((p) => p.payload.kind === 'excerpt');
  console.log(`# excerpt proposals landed by the agent: ${excerpts.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
