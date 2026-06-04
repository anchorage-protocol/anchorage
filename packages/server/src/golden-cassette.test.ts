import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type CassetteEntry,
  type FetchLike,
  honestStrongRole,
  recordingFetch,
  runLlmAgent,
} from '@anchorage/testbed';
import { describe, expect, it } from 'vitest';
import {
  buildLiveScenario,
  buildLiveTask,
  LIVE_AGENT_MAX_TURNS,
  LIVE_DEFAULT_MODEL,
} from './live-scenario.js';

// Golden cassette: `test/fixtures/golden-live-honest.json` is a recorded
// real-model run of the honest-strong role against the live fixture
// (`buildLiveScenario`) — recorded with
//   ANCHORAGE_CASSETTE=test/fixtures/golden-live-honest.json \
//   ANCHORAGE_CASSETTE_MODE=record pnpm --filter @anchorage/server live
// This test replays it deterministically with no key and no network:
// `cassette-replay.test.ts` proves the record→replay machinery works on
// a *scripted* model; this one pins that a *real* model's recorded run
// stays reproducible, so a regression in the agent loop, the MCP tool
// surface, or `runLlmAgent`'s request shaping shows up as a cassette
// miss here rather than only on the next on-demand live run.
//
// Re-record (and re-commit the fixture) when `live-scenario.ts`, the
// honest-strong role prompt, or the tool surface changes — that is the
// same same-seed/same-config discipline `recording-fetch.ts` documents:
// the replay server is `buildLiveScenario()` byte-for-byte, so it mints
// the same ids and every request body matches a recorded one.

const CASSETTE_PATH = fileURLToPath(
  new URL('../test/fixtures/golden-live-honest.json', import.meta.url),
);

function loadGoldenCassette(): CassetteEntry[] {
  const parsed = JSON.parse(readFileSync(CASSETTE_PATH, 'utf8')) as {
    version: number;
    entries: CassetteEntry[];
  };
  return parsed.entries;
}

// Re-recorded 2026-06-04 for the backlog-aware idle guidance (the tool
// surface + idle response bytes moved); against the single-slot surface (PRD
// §Assignment): no set_capacity and no accept_assignment —
// request_assignment returns the slot already held. The cassette
// captures the request → propose_excerpt cycle (no accept turn); the
// agent drains the three-anchor frontier and stops on not_found.
describe('golden cassette: a recorded honest-strong live run replays deterministically', () => {
  it('reproduces the checked-in real-model run from the cassette alone, untouched transport', async () => {
    const entries = loadGoldenCassette();
    expect(entries.length).toBeGreaterThan(0);

    const { server, client, cause_id } = await buildLiveScenario();
    let transportCalled = false;
    const wouldThrow: FetchLike = async () => {
      transportCalled = true;
      throw new Error('transport must not be called in replay mode');
    };

    const result = await runLlmAgent(client, {
      apiKey: 'golden-cassette-no-key',
      model: LIVE_DEFAULT_MODEL,
      system: honestStrongRole.system,
      task: buildLiveTask(cause_id),
      max_turns: LIVE_AGENT_MAX_TURNS,
      fetch: recordingFetch({ mode: 'replay', entries, fetch: wouldThrow }),
    });

    expect(transportCalled).toBe(false);
    expect(result.stop_reason).toBe('end_turn');

    // The recorded run had the agent pull single-slot assignments and
    // land a staged excerpt on each of the three seeded anchors (see
    // live-scenario.ts). Replaying the cassette must reproduce that
    // server-state effect exactly.
    const excerpts = [...server.store.proposals.values()].filter(
      (p) => p.payload.kind === 'excerpt',
    );
    expect(excerpts.length).toBe(3);
    expect(excerpts.every((p) => p.status === 'staged')).toBe(true);
  });
});
