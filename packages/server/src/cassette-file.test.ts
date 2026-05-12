import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cassetteFetchAt, cassetteModeFromEnv } from './cassette-file.js';

// Unit tests for the cassette-file glue (`cassette-file.ts`) — the
// `node:fs` layer between the runner scripts and the I/O-agnostic
// `recordingFetch` wrapper. `recording-fetch.test.ts` covers the
// wrapper itself and `cassette-replay.test.ts` the record→replay
// round-trip through a real server; this covers the file/env edge
// cases the multi-cassette cube runner (`run-deep-loop-cube.ts`) leans
// on: mode parsing, the replay-needs-a-file precondition, and the
// cassette-version guard.

describe('cassetteModeFromEnv', () => {
  const KEY = 'ANCHORAGE_CASSETTE_MODE';
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env[KEY];
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[KEY];
    else process.env[KEY] = prior;
  });

  it('returns undefined when unset or empty (run live, touch no fixtures)', () => {
    delete process.env[KEY];
    expect(cassetteModeFromEnv()).toBeUndefined();
    process.env[KEY] = '';
    expect(cassetteModeFromEnv()).toBeUndefined();
  });

  it('passes through the three known modes', () => {
    for (const m of ['record', 'replay', 'auto'] as const) {
      process.env[KEY] = m;
      expect(cassetteModeFromEnv()).toBe(m);
    }
  });

  it('throws on an unknown mode', () => {
    process.env[KEY] = 'rewind';
    expect(() => cassetteModeFromEnv()).toThrow(/unknown mode rewind/);
  });
});

describe('cassetteFetchAt', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anchorage-cassette-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws in replay mode when the cassette file is absent', () => {
    expect(() => cassetteFetchAt(join(dir, 'missing.json'), 'replay')).toThrow(
      /does not exist — replay mode needs a recorded cassette/,
    );
  });

  it('tolerates an absent file in record / auto mode (it gets created on first write)', () => {
    for (const mode of ['record', 'auto'] as const) {
      const path = join(dir, `${mode}.json`);
      const resolved = cassetteFetchAt(path, mode);
      expect(resolved.mode).toBe(mode);
      expect(resolved.path).toBe(path);
      expect(typeof resolved.fetch).toBe('function');
    }
  });

  it('rejects a cassette file written by a different format version', () => {
    const path = join(dir, 'stale.json');
    writeFileSync(path, JSON.stringify({ version: 99, entries: [] }));
    expect(() => cassetteFetchAt(path, 'auto')).toThrow(/version 99.*writes version 1/s);
  });

  it('loads an existing current-version cassette in replay mode', () => {
    const path = join(dir, 'ok.json');
    writeFileSync(path, JSON.stringify({ version: 1, entries: [] }));
    const resolved = cassetteFetchAt(path, 'replay');
    expect(resolved.mode).toBe('replay');
    expect(typeof resolved.fetch).toBe('function');
  });
});
