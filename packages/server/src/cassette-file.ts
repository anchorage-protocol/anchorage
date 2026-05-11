// Cassette-file glue for the runner scripts: turns the
// ANCHORAGE_CASSETTE / ANCHORAGE_CASSETTE_MODE env vars into a recording
// `FetchLike` (testbed package) wired to load from and persist to a JSON
// file on disk. Lives in the server package (which is free to touch
// `node:fs`); `recordingFetch` itself stays I/O-agnostic in the testbed
// package.
//
//   ANCHORAGE_CASSETTE      — path to a JSON cassette file.
//   ANCHORAGE_CASSETTE_MODE — 'auto' (default): replay a hit, record a
//                             miss; 'record': always call through,
//                             overwriting stale entries (re-baseline);
//                             'replay': cassette-only, a miss throws and
//                             no API key is needed.
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

export function resolveCassetteFetch(): ResolvedCassette | undefined {
  const path = process.env['ANCHORAGE_CASSETTE'];
  if (!path) return undefined;
  const modeRaw = process.env['ANCHORAGE_CASSETTE_MODE'] ?? 'auto';
  if (modeRaw !== 'replay' && modeRaw !== 'auto' && modeRaw !== 'record') {
    throw new Error(
      `ANCHORAGE_CASSETTE_MODE: unknown mode ${modeRaw} (expected replay | auto | record)`,
    );
  }
  const mode: CassetteMode = modeRaw;

  let entries: CassetteEntry[] = [];
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: number;
      entries?: CassetteEntry[];
    };
    if (parsed.version !== CASSETTE_FILE_VERSION) {
      throw new Error(
        `ANCHORAGE_CASSETTE: ${path} has version ${parsed.version}; this runner writes version ${CASSETTE_FILE_VERSION}`,
      );
    }
    entries = parsed.entries ?? [];
  } else if (mode === 'replay') {
    throw new Error(
      `ANCHORAGE_CASSETTE: ${path} does not exist — replay mode needs a recorded cassette (run once with ANCHORAGE_CASSETTE_MODE=record)`,
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
