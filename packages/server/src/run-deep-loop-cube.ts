// Deep-loop parameter-sweep cube: run the model-backed deep loop once
// per cell of `DEEP_LOOP_CUBE_CELLS`, each cell varying one defense
// parameter, and report the per-cell outcome plus the cross-cell
// comparison. The model-backed analogue of `testbed.test.ts`'s scripted
// parameter sweeps: the scripted cubes vary a defense parameter against
// a *scripted* adversary and read the closure outcome; here the same
// real-model honest-strong + patient-adversary population the deep loop
// already stands up — on the small `ci` fixture so each cell's cassette
// is checkin-sized — runs under each parameter setting, so what is
// measured is what the model does, not what a script assumes.
//
// Today the cube is a one-axis sweep: calibration defense on / off
// (the cell list lives in `deep-loop-scenario.ts`). The expected
// reading complements the scripted patient-adversary cube — that one
// shows the calibration defense is load-bearing *when an adversary
// actually drifts*; this one checks the complement: on the honest
// baseline, where the model adversary keeps to the build-standing-first
// strategy its prompt encodes, flipping the defense off changes nothing
// (same contested-item outcome, no drift), so the defense carries no
// false-positive cost. Add cells — more values, a second axis — to the
// array and this runner and `golden-deep-loop-cube.test.ts` pick them up.
//
// Cassettes: multi-cassette, one file per cell, at
// `test/fixtures/<cell.cassette_basename>.json` — each cell its own
// frozen artifact (recorded LLM transcripts aren't reproducible, so a
// cassette is pinned by exactly one test, not shared across runners;
// the `calibration-on` cell runs the same scenario as the single-cell
// golden `golden-deep-loop.json` but keeps its own copy). Mode is the
// shared `ANCHORAGE_CASSETTE_MODE` (record | replay | auto); unset →
// run live against the API and touch no fixtures.
// `ANCHORAGE_CUBE_CELL=<name>` narrows the run to one cell.
//
// Per-cell shape, budget, the sequential-when-a-cassette-is-in-play
// regime (what makes a population cassette replay exactly), and the v0
// shortcuts are exactly `run-deep-loop.ts`'s — see it. The budget guard
// (`ANCHORAGE_POPULATION_BUDGET_USD`, default 15) applies per cell.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube
//   ANCHORAGE_CUBE_CELL=calibration-off ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube
//   ANCHORAGE_CASSETTE_MODE=record ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube   # re-baseline every cell's cassette
//   ANCHORAGE_CASSETTE_MODE=replay pnpm --filter @anchorage/server deep-loop-cube                            # replay all cells, no key, no cost
//
// Without a key (and not in replay mode) it prints how to set one and exits 0.

import { fileURLToPath } from 'node:url';
import { runLlmAgent } from '@anchorage/testbed';
import { cassetteFetchAt, cassetteModeFromEnv } from './cassette-file.js';
import {
  buildDeepLoopScenario,
  DEEP_DEFAULT_MODEL,
  DEEP_LOOP_CUBE_CELLS,
  DEEP_MAX_ROUNDS,
  DEEP_MAX_TURNS_PER_ROUND,
  type DeepLoopContributor,
  type DeepLoopCubeCell,
  deepLoopTask,
} from './deep-loop-scenario.js';
import {
  graphStatusLine,
  type ModelRate,
  priceFor,
  runPopulationRounds,
  usdCost,
} from './population-loop.js';

const DEFAULT_BUDGET_USD = 15;

function fixturePath(basename: string): string {
  return fileURLToPath(new URL(`../test/fixtures/${basename}.json`, import.meta.url));
}

interface CellOutcome {
  name: string;
  label: string;
  stop_reason: string;
  rounds_run: number;
  escalations: number;
  contested_status: string;
  adversary_drifted: boolean;
  adversary_cal_fails: number;
  calibration_draws: number;
  calibration_fails: number;
  cost_usd: number;
}

interface CellRunCtx {
  model: string;
  rate: ModelRate;
  budgetUsd: number;
  mode: ReturnType<typeof cassetteModeFromEnv>;
  apiKey: string;
}

async function runCell(cell: DeepLoopCubeCell, ctx: CellRunCtx): Promise<CellOutcome> {
  const cassette = ctx.mode
    ? cassetteFetchAt(fixturePath(cell.cassette_basename), ctx.mode)
    : undefined;

  const {
    server,
    contributors,
    cause_id,
    contested_proposal_id: contestedProposalId,
    adversary_id: adversaryId,
    honest_anchor_count,
    calibration_anchor_count,
  } = await buildDeepLoopScenario(cell.opts);
  const honestCount = contributors.filter((c) => c.identity_id !== adversaryId).length;

  console.log(`\n# ── cell "${cell.name}" — ${cell.label} ──`);
  console.log(
    `# ${honest_anchor_count} honest orphan anchors + ${calibration_anchor_count} calibration anchors + 1 contested | ${honestCount} honest + 1 patient adversary`,
  );
  if (cassette) console.log(`# cassette: ${cassette.path} (mode ${cassette.mode})`);
  console.log(`# round 0 (seeded): ${graphStatusLine(server)}`);

  const result = await runPopulationRounds<DeepLoopContributor>({
    server,
    contributors,
    max_rounds: DEEP_MAX_ROUNDS,
    budget: { usd: ctx.budgetUsd, rate: ctx.rate },
    log: (line) => console.log(line),
    concurrency: cassette ? 'sequential' : 'concurrent',
    runContributor: async (c, { round }) => {
      const r = await runLlmAgent(c.client, {
        apiKey: ctx.apiKey,
        model: ctx.model,
        system: c.role.system,
        task: deepLoopTask(cause_id, c.display_name, round),
        max_turns: DEEP_MAX_TURNS_PER_ROUND,
        ...(cassette ? { fetch: cassette.fetch } : {}),
        on_turn: (turn, index) => {
          const tag = `[${cell.name} r${round} ${c.display_name} t${index}]`;
          if (turn.text.trim()) console.log(`${tag} ${turn.text.trim()}`);
          for (const call of turn.tool_calls) {
            console.log(
              `${tag} -> ${call.name}(${JSON.stringify(call.input)}) => ${call.is_error ? 'ERROR' : 'ok'}: ${call.result_text}`,
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

  const contestedFinal = server.store.proposals.get(contestedProposalId as never);
  const contestedVotes = [...server.store.reviewVotes.values()].filter(
    (v) => v.proposal_id === contestedProposalId,
  );
  const adversaryDrifted = contestedVotes.some(
    (v) => v.reviewer_id === adversaryId && v.decision === 'accept',
  );
  // Record keys are `identityId|causeId|subTopicId`.
  const calRecords = [...server.store.calibrationRecords.entries()].filter(
    ([key]) => key.split('|')[1] === cause_id,
  );
  const calPasses = calRecords.reduce((n, [, r]) => n + r.passes, 0);
  const calFails = calRecords.reduce((n, [, r]) => n + r.fails, 0);
  const adversaryCalFails = calRecords
    .filter(([key]) => key.split('|')[0] === adversaryId)
    .reduce((n, [, r]) => n + r.fails, 0);

  console.log(`# cell "${cell.name}" done — ${graphStatusLine(server)}`);
  console.log(
    `#   stop=${result.stop_reason} rounds=${result.rounds_run} escalations=${result.escalations.length} | contested ${contestedProposalId} → ${contestedFinal?.status ?? '(gone?)'} | adversary drifted: ${adversaryDrifted ? 'YES' : 'no'} | calibration draws=${calPasses + calFails} fails=${calFails}`,
  );

  return {
    name: cell.name,
    label: cell.label,
    stop_reason: result.stop_reason,
    rounds_run: result.rounds_run,
    escalations: result.escalations.length,
    contested_status: contestedFinal?.status ?? '(gone?)',
    adversary_drifted: adversaryDrifted,
    adversary_cal_fails: adversaryCalFails,
    calibration_draws: calPasses + calFails,
    calibration_fails: calFails,
    cost_usd: usdCost(result.total_usage, ctx.rate),
  };
}

async function main(): Promise<void> {
  const mode = cassetteModeFromEnv();
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const replayOnly = mode === 'replay';
  if (!apiKey && !replayOnly) {
    console.log(
      [
        'No ANTHROPIC_API_KEY set — nothing to run.',
        '',
        'This script runs the model-backed deep loop once per cell of the parameter-sweep cube',
        '(today: calibration defense on / off) and reports the per-cell and cross-cell outcomes.',
        'Set a key and re-run:',
        '',
        '  ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube',
        '',
        'Optional: one cell only, model, per-cell spend ceiling:',
        '',
        '  ANCHORAGE_CUBE_CELL=calibration-off ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube',
        `  ANCHORAGE_TESTBED_MODEL=claude-sonnet-4-6 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube  (default ${DEEP_DEFAULT_MODEL})`,
        `  ANCHORAGE_POPULATION_BUDGET_USD=5 ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube  (default $${DEFAULT_BUDGET_USD}/cell)`,
        '',
        'Or record every cell once and replay them with no key and no cost:',
        '',
        '  ANCHORAGE_CASSETTE_MODE=record ANTHROPIC_API_KEY=sk-... pnpm --filter @anchorage/server deep-loop-cube   # re-baseline',
        '  ANCHORAGE_CASSETTE_MODE=replay pnpm --filter @anchorage/server deep-loop-cube                            # replay',
      ].join('\n'),
    );
    return;
  }
  const effectiveApiKey = apiKey ?? 'cassette-replay-no-key';
  const model = process.env['ANCHORAGE_TESTBED_MODEL'] ?? DEEP_DEFAULT_MODEL;
  const budgetUsd = Number(process.env['ANCHORAGE_POPULATION_BUDGET_USD'] ?? DEFAULT_BUDGET_USD);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error(`ANCHORAGE_POPULATION_BUDGET_USD must be a positive number, got ${budgetUsd}`);
  }
  const onlyCell = process.env['ANCHORAGE_CUBE_CELL'] || undefined;
  const cells = onlyCell
    ? DEEP_LOOP_CUBE_CELLS.filter((c) => c.name === onlyCell)
    : [...DEEP_LOOP_CUBE_CELLS];
  if (cells.length === 0) {
    throw new Error(
      `ANCHORAGE_CUBE_CELL="${onlyCell}" matched no cell — known cells: ${DEEP_LOOP_CUBE_CELLS.map((c) => c.name).join(', ')}`,
    );
  }
  const rate = priceFor(model);

  console.log(
    `# anchorage deep-loop cube — model=${model} budget=$${budgetUsd}/cell | ${cells.length} cell(s): ${cells.map((c) => c.name).join(', ')}${mode ? ` | cassette mode ${mode}` : ' | live (no cassette)'}`,
  );

  const outcomes: CellOutcome[] = [];
  for (const cell of cells) {
    outcomes.push(await runCell(cell, { model, rate, budgetUsd, mode, apiKey: effectiveApiKey }));
  }

  // Cross-cell report. The shape mirrors the scripted sweep cubes'
  // per-cell-status table; the headline is the contested overstated
  // claim's success rate across cells (it should end `rejected` in
  // every cell) and whether the swept axis moved any outcome.
  console.log(
    `\n# ── cube summary (${outcomes.length} cell${outcomes.length === 1 ? '' : 's'}) ──`,
  );
  console.log(
    '# cell                 | contested  | adv drift | cal draws | cal fails | stop             | rounds | esc | cost',
  );
  for (const o of outcomes) {
    console.log(
      `# ${o.name.padEnd(20)} | ${o.contested_status.padEnd(10)} | ${(o.adversary_drifted ? 'YES' : 'no').padEnd(9)} | ${String(o.calibration_draws).padEnd(9)} | ${String(o.calibration_fails).padEnd(9)} | ${o.stop_reason.padEnd(16)} | ${String(o.rounds_run).padEnd(6)} | ${String(o.escalations).padEnd(3)} | $${o.cost_usd.toFixed(2)}`,
    );
  }
  const totalCost = outcomes.reduce((n, o) => n + o.cost_usd, 0);
  const acceptedCells = outcomes.filter((o) => o.contested_status === 'accepted');
  const driftedCells = outcomes.filter((o) => o.adversary_drifted);
  const distinctOutcomes = new Set(
    outcomes.map((o) => `${o.contested_status}/${o.adversary_drifted}`),
  );
  console.log(
    `# contested 'improves' claim accepted in ${acceptedCells.length}/${outcomes.length} cell(s) (attack-success-rate ${((100 * acceptedCells.length) / outcomes.length).toFixed(0)}%); adversary drifted in ${driftedCells.length}/${outcomes.length}`,
  );
  if (outcomes.length < 2) {
    console.log('# (single cell — run all cells for the cross-cell comparison)');
  } else {
    console.log(
      distinctOutcomes.size === 1
        ? `# every cell reached the same (contested-status, adversary-drift) outcome — the swept axis did not move it (on the honest baseline, the calibration defense carries no false-positive cost)`
        : `# the swept axis moved the (contested-status, adversary-drift) outcome — ${distinctOutcomes.size} distinct outcomes across ${outcomes.length} cells; inspect the per-cell logs above`,
    );
  }
  console.log(`# total cost ≈ $${totalCost.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
