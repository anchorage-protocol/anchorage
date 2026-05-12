// Population runner: stand up a fresh Anchorage instance and let a
// small population of real-model contributors work it from scratch —
// pull excerpt tasks off seeded orphan anchors, then review each
// other's staged work until proposals converge into the graph. This
// is the multi-agent counterpart to `run-live.ts` (one agent, one
// orientation pass): here several `runLlmAgent` loops share one Server
// over independent MCP connections, run in rounds, and the script
// reports the graph state after each round so you can watch the loop
// actually close.
//
// This file is the *wiring*: read env, seed the server, mint the
// contributors and connect each to it, then hand off to
// `runPopulationRounds` (population-loop.ts) for the round structure,
// the between-rounds curator-escalation pass, and the termination
// logic — the same core `population-loop.test.ts` drives with scripted
// archetypes to pin the honest baseline in CI.
//
// Like `run-live.ts` this is harness glue, not a test and not part of
// the package's public surface: the archetype (`runLlmAgent`, in the
// testbed package) only ever sees an MCP client; this script stands
// the in-process server up behind those clients and seeds it with a
// small body of work. Sim/prod indistinguishability holds — the agents
// hit the same MCP surface a real client would.
//
// Three things differ from a "real" instance and are deliberate v0
// shortcuts:
//   1. The verifier is the FakeVerifier seeded with a source-text
//      fixture per anchor, so a contributor's quoted span is matched
//      against text it can actually see — there is no live PubMed
//      fetch and no MCP tool to retrieve source bodies, so the seeded
//      anchors carry their source passage inline as their `content`
//      and the fixture mirrors it. A contributor quotes a verbatim
//      substring of the anchor content; the fixture accepts it.
//   2. No calibration corpus is seeded — the review path converges on
//      the real staged proposals; calibration salting (PRD
//      §Calibration batches) is left to the scripted-archetype
//      scenarios and the deep loop.
//   3. The curator-escalation step between rounds (PRD §Reviewer
//      assignment step 4) is a deterministic harness actor, not an
//      agent: it resolves a divergence the population stalled on for a
//      full round toward the majority of the votes cast (accepting on
//      a tie). A real curator reads the proposal; the harness
//      exercises the *path* (curator.acceptProposal /
//      curator.rejectProposal closing a stuck divergence), not the
//      judgment. See `escalateStuckProposals` in population-loop.ts.
//
// Budget: every model turn is an API round-trip and the conversation
// is resent each turn (no prompt caching wired — see llm-agent.ts), so
// cost grows within a run. The runner holds a USD ceiling
// (ANCHORAGE_POPULATION_BUDGET_USD, default 15): it sums the token
// usage `runLlmAgent` reports, prices it at the configured model's
// rate, and stops launching new rounds once the spend would approach
// the ceiling. It's a coarse guard checked between rounds, not a hard
// per-call cap — a single round of the default population is a small
// fraction of the default ceiling.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server population
//   ANCHORAGE_TESTBED_MODEL=claude-sonnet-4-6 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server population
//   ANCHORAGE_POPULATION_BUDGET_USD=5 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server population
//
// Without a key it prints how to set one and exits 0.

import { honestStrongRole, runLlmAgent } from '@anchorage/testbed';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveCassetteFetch } from './cassette-file.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { buildMcpServer } from './mcp.js';
import { graphStatusLine, runPopulationRounds, usdCost } from './population-loop.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_BUDGET_USD = 15;
const CONTRIBUTOR_COUNT = 5;
const MAX_ROUNDS = 6;
const MAX_TURNS_PER_ROUND = 16;

// Approximate Anthropic list pricing, USD per million tokens. Only the
// default model (Haiku 4.5) and the obvious overrides are tabled; an
// unknown model falls back to the Haiku rate with a warning, which is
// fine for a coarse spend guard. Update if prices move — this is a
// safety estimate, not billing.
const HAIKU_RATE = { input: 1, output: 5 } as const;
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': HAIKU_RATE,
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-7': { input: 15, output: 75 },
};

function priceFor(model: string): { input: number; output: number } {
  const p = PRICING_PER_MTOK[model];
  if (p) return p;
  console.warn(`# no price table entry for ${model}; estimating at Haiku 4.5 rates`);
  return HAIKU_RATE;
}

// Seeded orphan anchors. Each carries its source passage inline as
// `content` (see seam note in the file header): the FakeVerifier
// fixture below is keyed by the anchor's external_ref value and holds
// the same text, so a contributor who quotes a verbatim substring of
// the anchor content passes span verification. The passages are
// synthetic but written in the register of CRC / ctDNA-MRD literature
// so the contributors have something real-shaped to extract claims
// from.
const SEED_ANCHORS: { pmid: string; content: string }[] = [
  {
    pmid: '40000001',
    content:
      'In a prospective cohort of patients with resected stage II colon cancer, circulating tumor DNA detected in plasma four to ten weeks after surgery identified a group at sharply elevated risk of recurrence. At three years, the recurrence-free survival rate was 64 percent among ctDNA-positive patients compared with 90 percent among ctDNA-negative patients. The association persisted after adjustment for T stage, lymphovascular invasion, and number of lymph nodes examined.',
  },
  {
    pmid: '40000002',
    content:
      'Among patients with ctDNA-negative status after curative-intent resection of stage II colon cancer, withholding adjuvant chemotherapy was non-inferior to standard adjuvant therapy with respect to two-year recurrence-free survival. The trial reported a recurrence-free survival difference of 1.1 percentage points in favor of the chemotherapy arm, with the lower bound of the confidence interval inside the prespecified non-inferiority margin. Treatment-related adverse events of grade three or higher were roughly halved in the ctDNA-guided arm.',
  },
  {
    pmid: '40000003',
    content:
      'A meta-analysis pooling eleven studies of post-operative ctDNA in colorectal cancer found that a positive landmark ctDNA result was associated with a hazard ratio for recurrence of approximately 7 relative to a negative result. Heterogeneity across studies was moderate and was attributable largely to differences in assay sensitivity and the timing of the landmark draw. The prognostic signal was present across both colon and rectal primaries.',
  },
  {
    pmid: '40000004',
    content:
      'Serial ctDNA surveillance after resection detected molecular recurrence a median of roughly 8 months before recurrence was visible on standard imaging. Lead time was longer for liver-confined recurrence than for peritoneal recurrence. The authors caution that lead time alone does not establish that earlier intervention improves survival, which remains the subject of ongoing interventional trials.',
  },
  {
    pmid: '40000005',
    content:
      'In a tumor-informed assay requiring a bespoke panel built from the resected specimen, the limit of detection reached a variant allele fraction near 0.01 percent, and analytic sensitivity rose with the number of tracked variants. Tumor-naive assays that do not require the primary specimen traded some sensitivity for faster turnaround. Both approaches showed high specificity, with false-positive calls uncommon when stringent variant-calling thresholds were applied.',
  },
  {
    pmid: '40000006',
    content:
      'A cost-effectiveness analysis modeled ctDNA-guided escalation and de-escalation of adjuvant therapy in stage II colon cancer against a usual-care strategy. Under base-case assumptions the ctDNA-guided strategy was cost-saving, driven mainly by avoided chemotherapy in the large ctDNA-negative group, while quality-adjusted life years were similar between strategies. Results were sensitive to assay cost and to the assumed efficacy of escalated therapy in ctDNA-positive patients, which the model acknowledged is not yet established.',
  },
];

// The opening task for a population contributor. The role's own
// `buildTask` frames the first action as declaring *excerpt* capacity;
// in a population both excerpt and review work sit on the frontier, so
// this asks for capacity in both kinds — consistent with the
// honest-strong system prompt, which already names review as frontier
// work. The agent re-enters fresh each round (no cross-round memory),
// so the task also tells it to re-orient via the read tools.
function populationTask(cause_id: string): string {
  return [
    `Cause id: ${cause_id}.`,
    'You are one of several contributors working this cause concurrently.',
    'Begin by declaring your capacity for both excerpt and review work in this cause',
    '(set_capacity with kinds ["excerpt","review"]).',
    'Then work the frontier: pull a task, fulfill it or decline it, repeat.',
    'For an excerpt task, read the parent anchor (it is among the accepted proposals — query_proposals)',
    'and quote a verbatim span from its content. For a review task, read the staged proposal and the',
    'anchor it sits under, then vote on the evidence.',
    'Stop when request_assignment returns not_found — the frontier is drained for now.',
  ].join(' ');
}

interface Contributor {
  identity_id: string;
  display_name: string;
  client: Client;
}

async function main(): Promise<void> {
  const cassette = resolveCassetteFetch();
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  // A `replay` cassette serves every request from disk, so no key is
  // needed; any other configuration (live, or `auto`/`record` with a
  // cassette) still calls the real API on a miss.
  const replayOnly = cassette?.mode === 'replay';
  if (!apiKey && !replayOnly) {
    console.log(
      [
        'No ANTHROPIC_API_KEY set — nothing to run.',
        '',
        'This script runs a small population of real-model contributors against a fresh',
        'Anchorage MCP instance. Set a key and re-run:',
        '',
        '  ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server population',
        '',
        `Optional: override the model (default ${DEFAULT_MODEL}) or the spend ceiling (default $${DEFAULT_BUDGET_USD}):`,
        '',
        '  ANCHORAGE_TESTBED_MODEL=claude-sonnet-4-6 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server population',
        '  ANCHORAGE_POPULATION_BUDGET_USD=5 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server population',
        '',
        'Or replay a previously recorded run with no key and no cost:',
        '',
        '  ANCHORAGE_CASSETTE=run.json ANCHORAGE_CASSETTE_MODE=record ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server population   # record once',
        '  ANCHORAGE_CASSETTE=run.json ANCHORAGE_CASSETTE_MODE=replay pnpm --filter @anchorage/server population                            # replay it',
      ].join('\n'),
    );
    return;
  }
  const effectiveApiKey = apiKey ?? 'cassette-replay-no-key';
  const model = process.env['ANCHORAGE_TESTBED_MODEL'] ?? DEFAULT_MODEL;
  const budgetUsd = Number(process.env['ANCHORAGE_POPULATION_BUDGET_USD'] ?? DEFAULT_BUDGET_USD);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error(`ANCHORAGE_POPULATION_BUDGET_USD must be a positive number, got ${budgetUsd}`);
  }
  const rate = priceFor(model);

  // Seed: one cause, one sub-topic, the orphan anchors above. Source
  // fixture mirrors each anchor's inline content (see seam note).
  const sources = new Map<string, string>(SEED_ANCHORS.map((a) => [a.pmid, a.content]));
  const server = new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('pop'),
    verifier: new FakeVerifier(new Set(), new Map(), sources),
  });
  const seeder = server.bootstrap.mintIdentity({ display_name: 'seeder' });
  const cause = server.bootstrap.createCause({ name: 'CRC', description: 'colon cancer' });
  const subTopic = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'ctDNA minimal residual disease in resected colorectal cancer',
    scope_query: 'ctDNA MRD colorectal cancer adjuvant',
  });
  for (const a of SEED_ANCHORS) {
    const proposal = await server.tools.proposeAnchor(
      { identity_id: seeder.id },
      {
        cause_id: cause.id,
        home_sub_topic_id: subTopic.id,
        content: a.content,
        external_ref: { kind: 'pmid', value: a.pmid },
      },
    );
    server.curator.acceptProposal(proposal.proposal_id);
  }

  // Mint the contributors and wire each its own MCP connection to the
  // shared server.
  const contributors: Contributor[] = [];
  for (let i = 1; i <= CONTRIBUTOR_COUNT; i++) {
    const display_name = `contributor-${i}`;
    const identity = server.bootstrap.mintIdentity({ display_name });
    const mcp = buildMcpServer(server, { caller: { identity_id: identity.id as never } });
    const client = new Client({ name: display_name, version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(st), client.connect(ct)]);
    contributors.push({ identity_id: identity.id, display_name, client });
  }

  console.log(`# anchorage population run — model=${model} budget=$${budgetUsd}`);
  console.log(
    `# cause=${cause.id} sub_topic=${subTopic.id} | ${SEED_ANCHORS.length} orphan anchors | ${CONTRIBUTOR_COUNT} contributors`,
  );
  if (cassette) console.log(`# cassette: ${cassette.path} (mode ${cassette.mode})`);
  console.log(`# round 0 (seeded): ${graphStatusLine(server)}\n`);

  const result = await runPopulationRounds<Contributor>({
    server,
    contributors,
    max_rounds: MAX_ROUNDS,
    budget: { usd: budgetUsd, rate },
    log: (line) => console.log(line),
    // Sequential when a cassette is in play so the recording replays
    // exactly; concurrent otherwise (see the cassette note in
    // `recording-fetch.ts` and the matching wiring in `run-deep-loop.ts`).
    concurrency: cassette ? 'sequential' : 'concurrent',
    runContributor: async (c, { round }) => {
      const r = await runLlmAgent(c.client, {
        apiKey: effectiveApiKey,
        model,
        system: honestStrongRole.system,
        task: populationTask(cause.id),
        max_turns: MAX_TURNS_PER_ROUND,
        ...(cassette ? { fetch: cassette.fetch } : {}),
        on_turn: (turn, index) => {
          const tag = `[r${round} ${c.display_name} t${index}]`;
          if (turn.text.trim()) console.log(`${tag} ${turn.text.trim()}`);
          for (const call of turn.tool_calls) {
            const status = call.is_error ? 'ERROR' : 'ok';
            console.log(
              `${tag} -> ${call.name}(${JSON.stringify(call.input)}) => ${status}: ${call.result_text}`,
            );
          }
        },
      });
      return {
        usage: r.usage,
        log_summary: `stop=${r.stop_reason} turns=${r.turns.length} usage=(${r.usage.input_tokens}in/${r.usage.output_tokens}out)`,
      };
    },
  });

  // Final report.
  console.log('# ── final state ──');
  console.log(`# ${graphStatusLine(server)}`);
  console.log(`# stop reason: ${result.stop_reason}`);
  console.log(
    `# total usage: ${result.total_usage.input_tokens} input + ${result.total_usage.output_tokens} output tokens ≈ $${usdCost(result.total_usage, rate).toFixed(2)}`,
  );
  console.log('# reputation by contributor (cause, sub-topic):');
  for (const c of contributors) {
    const recs = [...server.store.reputations.entries()].filter(([k]) =>
      k.startsWith(`${c.identity_id}|`),
    );
    if (recs.length === 0) {
      console.log(`#   ${c.display_name}: (no reputation record)`);
      continue;
    }
    for (const [, rep] of recs) {
      console.log(`#   ${c.display_name}: ${JSON.stringify(rep)}`);
    }
  }
  console.log('# nodes in the graph:');
  for (const n of server.store.nodes.values()) {
    const span =
      n.kind === 'excerpt'
        ? ` span="${(n as { quoted_span: { text: string } }).quoted_span.text}"`
        : '';
    console.log(
      `#   ${n.kind} ${n.id} status=${n.status} content="${n.content.slice(0, 80)}${n.content.length > 80 ? '…' : ''}"${span}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
