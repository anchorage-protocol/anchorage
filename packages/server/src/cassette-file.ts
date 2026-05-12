// Cassette-file glue for the runner scripts: turns a cassette path + mode
// into a recording `FetchLike` (testbed package) wired to load from and
// persist to a JSON file on disk. Lives in the server package (which is
// free to touch `node:fs`); `recordingFetch` itself stays I/O-agnostic
// in the testbed package.
//
//   ANCHORAGE_CASSETTE      — path to a JSON cassette file (single-
//                             cassette runners: `run-live`, `run-
//                             population`, `run-deep-loop`).
//   ANCHORAGE_CASSETTE_MODE — 'auto' (default when a path is set):
//                             replay a hit, record a miss; 'record':
//                             always call through, overwriting stale
//                             entries (re-baseline); 'replay': cassette-
//                             only, a miss throws and no API key is
//                             needed.
//
// `run-deep-loop-cube.ts` is multi-cassette (one file per cube cell): it
// reads `ANCHORAGE_CASSETTE_MODE` via `cassetteModeFromEnv()` and calls
// `cassetteFetchAt(path, mode)` itself for each cell's fixture, rather
// than going through the single-`ANCHORAGE_CASSETTE` `resolveCassetteFetch`.
//
// On 'auto'/'record' the file is rewritten after each new recording, so
// a crash mid-run doesn't lose the cassette. On 'replay' the file must
// already exist.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type CassetteEntry,
  type CassetteMode,
  type FetchLike,
  recordingFetch,
} from '@anchorage/testbed';

export interface ResolvedCassette {
  fetch: FetchLike;
  mode: CassetteMode;
  path: string;
}

const CASSETTE_FILE_VERSION = 1;

// Parse `ANCHORAGE_CASSETTE_MODE`. Unset → undefined (no cassette);
// an unknown value throws. Note this has no "default to auto" — that
// default belongs to `resolveCassetteFetch`, which keys off the
// *path* var being set; a multi-cassette runner with no path var
// treats an unset mode as "run live, don't touch any fixtures."
export function cassetteModeFromEnv(): CassetteMode | undefined {
  const raw = process.env['ANCHORAGE_CASSETTE_MODE'];
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'replay' && raw !== 'auto' && raw !== 'record') {
    throw new Error(
      `ANCHORAGE_CASSETTE_MODE: unknown mode ${raw} (expected replay | auto | record)`,
    );
  }
  return raw;
}

// Build a recording `FetchLike` for an explicit cassette file path and
// mode. On 'replay' the file must already exist; on 'auto'/'record' it
// is created (with parent dirs) and rewritten after each new recording.
export function cassetteFetchAt(path: string, mode: CassetteMode): ResolvedCassette {
  let entries: CassetteEntry[] = [];
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: number;
      entries?: CassetteEntry[];
    };
    if (parsed.version !== CASSETTE_FILE_VERSION) {
      throw new Error(
        `cassette ${path} has version ${parsed.version}; this runner writes version ${CASSETTE_FILE_VERSION}`,
      );
    }
    entries = parsed.entries ?? [];
  } else if (mode === 'replay') {
    throw new Error(
      `cassette ${path} does not exist — replay mode needs a recorded cassette (run once with ANCHORAGE_CASSETTE_MODE=record)`,
    );
  }

  const save =
    mode === 'replay'
      ? undefined
      : (e: CassetteEntry[]) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(
            path,
            `${JSON.stringify({ version: CASSETTE_FILE_VERSION, entries: e }, null, 2)}\n`,
          );
        };

  return {
    mode,
    path,
    fetch: recordingFetch({ mode, entries, ...(save ? { onRecord: save } : {}) }),
  };
}

export function resolveCassetteFetch(): ResolvedCassette | undefined {
  const path = process.env['ANCHORAGE_CASSETTE'];
  if (!path) return undefined;
  const modeRaw = process.env['ANCHORAGE_CASSETTE_MODE'] ?? 'auto';
  if (modeRaw !== 'replay' && modeRaw !== 'auto' && modeRaw !== 'record') {
    throw new Error(
      `ANCHORAGE_CASSETTE_MODE: unknown mode ${modeRaw} (expected replay | auto | record)`,
    );
  }
  return cassetteFetchAt(path, modeRaw);
}
