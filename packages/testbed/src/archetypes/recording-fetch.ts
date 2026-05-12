import type { FetchLike } from './llm-agent.js';

// recording-fetch: a record/replay wrapper around a `FetchLike` (the
// transport seam `runLlmAgent` already exposes for tests and recording).
// It is the cassette layer for model-backed runs — record a real run's
// Messages-API round-trips once, then replay them deterministically with
// no key and no cost.
//
// Why record/replay and not "seed": the Anthropic Messages API has no
// seed knob (and `temperature: 0` is not bit-deterministic), so a run
// can't be replayed by re-deriving the model's outputs — only by
// replaying the exact responses it produced. Matching is by a hash of
// the request (URL + body, which `runLlmAgent` builds deterministically
// from system + messages + tools + max_tokens — no secrets, no
// timestamps), so a recorded response is replayed whenever the identical
// conversation state recurs.
//
// What this is good for, and what it isn't:
//   - Single-agent runs (`run-live.ts`) replay exactly: no other agent,
//     so the request sequence is fully determined.
//   - Population runs replay exactly *only if recorded against a
//     sequential round* (`runPopulationRounds` with
//     `concurrency: 'sequential'`, which `run-population.ts` and
//     `run-deep-loop.ts` switch to whenever a cassette is in play): an
//     agent's turn-N request depends on the tool results it saw, which
//     depend on what other agents did first — under concurrent execution
//     that ordering is latency-dependent and a replay run's interleaving
//     differs, so some requests miss the cassette (partial hits still
//     cut cost; a miss in `replay` mode throws — re-record, or use
//     `auto`). Sequential execution makes the request sequence a pure
//     function of the seeded fixture, so the recording is exactly
//     reproducible.
//   - Replaying against a changed *server* or changed *prompts* is
//     invalid by construction — the recorded responses were to a
//     different surface; the hashes won't match (prompt change) or the
//     replayed response is stale (server change). Re-record after either.
//
// Persistence is the caller's job: this wrapper holds the cassette
// `entries` array and mutates it on misses (`auto`/`record`); the caller
// loads it from / writes it to wherever (a JSON file, typically) and
// passes an `onRecord` hook to flush after each new recording so a crash
// mid-run doesn't lose it. Keeping I/O out of here keeps the testbed
// package free of `node:fs`.

export interface CassetteEntry {
  // SHA-256 hex of `${url}\n${body}` — the match key.
  key: string;
  // First ~200 chars of the request body — for human grep/diff of a
  // cassette file; not used for matching.
  preview: string;
  response: { status: number; body: string };
}

export type CassetteMode =
  // Cassette-only: a request not in `entries` throws. No key needed.
  | 'replay'
  // Replay on hit; on miss call the real fetch and append the result.
  | 'auto'
  // Always call the real fetch; on a key collision overwrite the entry.
  // Use this to re-baseline a cassette whose recordings have gone stale.
  | 'record';

export interface RecordingFetchOptions {
  mode: CassetteMode;
  // The recorded interactions. Mutated in place on `auto`/`record`
  // misses (and `record` overwrites). The caller owns load/save.
  entries: CassetteEntry[];
  // Called with the (mutated) entries after each new or overwritten
  // recording — the caller's hook to flush to disk.
  onRecord?: (entries: CassetteEntry[]) => void;
  // The transport to use on a miss. Defaults to the global `fetch`.
  // Never called in `replay` mode.
  fetch?: FetchLike;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function syntheticResponse(response: { status: number; body: string }) {
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    text: async () => response.body,
  };
}

export function recordingFetch(opts: RecordingFetchOptions): FetchLike {
  return async (url, init) => {
    const key = await sha256Hex(`${url}\n${init.body}`);
    if (opts.mode !== 'record') {
      const hit = opts.entries.find((e) => e.key === key);
      if (hit) return syntheticResponse(hit.response);
      if (opts.mode === 'replay') {
        throw new Error(
          `recordingFetch: cassette miss in replay mode for ${url} — request preview: ${init.body.slice(0, 200)}. Re-record (mode "record") or use mode "auto".`,
        );
      }
    }
    const real = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (!real) throw new Error('recordingFetch: no real fetch available for a cassette miss');
    const res = await real(url, init);
    const body = await res.text();
    const entry: CassetteEntry = {
      key,
      preview: init.body.slice(0, 200),
      response: { status: res.status, body },
    };
    const existing = opts.entries.findIndex((e) => e.key === key);
    if (existing >= 0) opts.entries[existing] = entry;
    else opts.entries.push(entry);
    opts.onRecord?.(opts.entries);
    return syntheticResponse(entry.response);
  };
}
