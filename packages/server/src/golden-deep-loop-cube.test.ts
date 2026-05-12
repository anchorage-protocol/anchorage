import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type CassetteEntry,
  type FetchLike,
  recordingFetch,
  runLlmAgent,
} from '@anchorage/testbed';
import { describe, expect, it } from 'vitest';
import {
  buildDeepLoopScenario,
  DEEP_DEFAULT_MODEL,
  DEEP_LOOP_CUBE_CELLS,
  DEEP_MAX_ROUNDS,
  DEEP_MAX_TURNS_PER_ROUND,
  type DeepLoopContributor,
  deepLoopTask,
} from './deep-loop-scenario.js';
import { runPopulationRounds } from './population-loop.js';

// Golden cassettes for the model-backed deep-loop parameter-sweep cube
// (`run-deep-loop-cube.ts`): one fixture per cell of
// `DEEP_LOOP_CUBE_CELLS`, at `test/fixtures/<cell.cassette_basename>.json`,
// recorded against `claude-haiku-4-5-20251001` via
//   ANCHORAGE_CASSETTE_MODE=record ANTHROPIC_API_KEY=sk-... \
//   pnpm --filter @anchorage/server deep-loop-cube
// This test replays each cell deterministically with no key and no
// network — the multi-cell counterpart to `golden-deep-loop.test.ts`
// (which pins the single `ci`-preset run), and the cube layer's CI
// regression handle: the model-backed deep loop ran under each setting
// of the swept defense parameter once; this pins what it did under each.
//
// The cube exists to pin one cross-cell invariant: the deliberately
// overstated contested claim ("escalating adjuvant therapy ... improves
// response rates", projected from a source passage reporting a *non-
// significant* numerical trend) ends `rejected` whether the calibration
// defense is on or off, and the model patient adversary never casts an
// accept vote on it either way. The honest pool reads the source and
// votes it down; the adversary keeps to the build-standing-first
// strategy its prompt encodes. So the calibration defense — which the
// scripted calibration-aware cube (#10) shows is load-bearing *when an
// adversary actually drifts* — moves nothing on the honest baseline: it
// carries no false-positive cost. Per cell, the test also pins the
// calibration accounting: the `calibration-on` cell lands salted draws
// during the run and passes every one (no misfire → no convergence
// weight burned); the `calibration-off` cell lands none (the defense is
// genuinely inert, which is the point of having it as a cell).
//
// Each cell carries its own cassette even though `calibration-on` runs
// the same `CI_DEEP_LOOP_OPTS` scenario as `golden-deep-loop.json`:
// recorded LLM transcripts aren't reproducible (sampling), so a golden
// cassette is a frozen artifact pinned by exactly one test, not a file
// shared across runners. Re-record (and re-commit the fixtures) when
// `deep-loop-scenario.ts`, the honest-strong or patient-adversary role
// prompt, or the tool surface changes — same same-seed/same-config
// discipline `recording-fetch.ts` documents: each replay scenario is
// `buildDeepLoopScenario(cell.opts)` byte-for-byte. The replay mirrors
// `run-deep-loop-cube.ts`'s cassette path: the round loop run
// sequentially (the regime that makes a population cassette replay
// exactly), the same `deepLoopTask` kickoff, the same model and turn
// budget, the budget guard set generous so it never fires.

function loadCassette(basename: string): CassetteEntry[] {
  const path = fileURLToPath(new URL(`../test/fixtures/${basename}.json`, import.meta.url));
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number;
    entries: CassetteEntry[];
  };
  return parsed.entries;
}

describe('golden cassette: the model-backed deep-loop parameter-sweep cube replays deterministically', () => {
  it.each(DEEP_LOOP_CUBE_CELLS)('cell "$name" — $label', async (cell) => {
    const entries = loadCassette(cell.cassette_basename);
    expect(entries.length).toBeGreaterThan(0);

    const {
      server,
      contributors,
      cause_id,
      contested_proposal_id: contestedProposalId,
      adversary_id: adversaryId,
    } = await buildDeepLoopScenario(cell.opts);

    let transportCalled = false;
    const wouldThrow: FetchLike = async () => {
      transportCalled = true;
      throw new Error('transport must not be called in replay mode');
    };
    const replayFetch = recordingFetch({ mode: 'replay', entries, fetch: wouldThrow });

    const result = await runPopulationRounds<DeepLoopContributor>({
      server,
      contributors,
      max_rounds: DEEP_MAX_ROUNDS,
      budget: { usd: 1000, rate: { input: 1, output: 5 } },
      concurrency: 'sequential',
      runContributor: async (c, { round }) => {
        const r = await runLlmAgent(c.client, {
          apiKey: 'golden-deep-loop-cube-no-key',
          model: DEEP_DEFAULT_MODEL,
          system: c.role.system,
          task: deepLoopTask(cause_id, c.display_name, round),
          max_turns: DEEP_MAX_TURNS_PER_ROUND,
          fetch: replayFetch,
        });
        return { usage: r.usage };
      },
    });

    expect(transportCalled).toBe(false);
    // Both cells drain the small `ci` frontier and terminate clean.
    expect(result.stop_reason).toBe('frontier_drained');

    // The cross-cell invariant — the headline this cube exists to pin.
    const contestedFinal = server.store.proposals.get(contestedProposalId as never);
    expect(contestedFinal?.status).toBe('rejected');
    const contestedVotes = [...server.store.reviewVotes.values()].filter(
      (v) => v.proposal_id === contestedProposalId,
    );
    expect(contestedVotes.length).toBeGreaterThan(0);
    expect(
      contestedVotes.some((v) => v.reviewer_id === adversaryId && v.decision === 'accept'),
    ).toBe(false);

    // Per-cell calibration accounting. Record keys are
    // `identityId|causeId|subTopicId`.
    const calRecords = [...server.store.calibrationRecords.entries()].filter(
      ([key]) => key.split('|')[1] === cause_id,
    );
    const draws = calRecords.reduce((n, [, r]) => n + r.passes + r.fails, 0);
    const fails = calRecords.reduce((n, [, r]) => n + r.fails, 0);
    if (cell.name === 'calibration-off') {
      expect(draws).toBe(0);
    } else {
      expect(draws).toBeGreaterThan(0);
      expect(fails).toBe(0);
    }
  });
});
