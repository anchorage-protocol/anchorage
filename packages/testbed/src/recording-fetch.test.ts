import { describe, expect, it } from 'vitest';
import type { FetchLike } from './archetypes/llm-agent.js';
import { type CassetteEntry, recordingFetch } from './archetypes/recording-fetch.js';

// A fake underlying transport that records the calls it received and
// returns a canned response. Throws if `shouldNotBeCalled` is set —
// used to prove replay-on-hit doesn't touch the network.
function fakeFetch(opts: { status?: number; body?: string; shouldNotBeCalled?: boolean }): {
  fetch: FetchLike;
  calls: { url: string; body: string }[];
} {
  const calls: { url: string; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (opts.shouldNotBeCalled) throw new Error('underlying fetch should not have been called');
    calls.push({ url, body: init.body });
    const status = opts.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => opts.body ?? '{}' };
  };
  return { fetch, calls };
}

const REQ = {
  url: 'https://api.anthropic.com/v1/messages',
  init: { method: 'POST', headers: { 'x-api-key': 'secret' }, body: '{"model":"m","messages":[]}' },
} as const;

describe('recordingFetch', () => {
  it('record mode: calls through, returns the response, and appends an entry', async () => {
    const entries: CassetteEntry[] = [];
    const recorded: CassetteEntry[][] = [];
    const { fetch, calls } = fakeFetch({ status: 200, body: '{"stop_reason":"end_turn"}' });
    const rf = recordingFetch({
      mode: 'record',
      entries,
      fetch,
      onRecord: (e) => recorded.push([...e]),
    });

    const res = await rf(REQ.url, REQ.init);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"stop_reason":"end_turn"}');
    expect(calls).toHaveLength(1);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error('expected a recorded entry');
    expect(entry.response).toEqual({ status: 200, body: '{"stop_reason":"end_turn"}' });
    expect(entry.preview).toBe(REQ.init.body);
    // The key never embeds headers (the api key lives there) — it's a
    // hash of url + body only.
    expect(entry.key).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.key).not.toContain('secret');
    expect(recorded).toHaveLength(1);
  });

  it('replay mode: returns a recorded response on a hit without touching the transport', async () => {
    const { fetch } = fakeFetch({ shouldNotBeCalled: true });
    // First record an entry, then replay it with a would-throw transport.
    const entries: CassetteEntry[] = [];
    await recordingFetch({ mode: 'record', entries, fetch: fakeFetch({ body: 'RECORDED' }).fetch })(
      REQ.url,
      REQ.init,
    );
    const replay = recordingFetch({ mode: 'replay', entries, fetch });
    const res = await replay(REQ.url, REQ.init);
    expect(await res.text()).toBe('RECORDED');
  });

  it('replay mode: throws on a miss', async () => {
    const replay = recordingFetch({ mode: 'replay', entries: [] });
    await expect(replay(REQ.url, REQ.init)).rejects.toThrow(/cassette miss in replay mode/);
  });

  it('auto mode: replays a hit, records a miss', async () => {
    const entries: CassetteEntry[] = [];
    const first = fakeFetch({ body: 'FIRST' });
    const auto1 = recordingFetch({ mode: 'auto', entries, fetch: first.fetch });
    expect(await (await auto1(REQ.url, REQ.init)).text()).toBe('FIRST');
    expect(first.calls).toHaveLength(1);
    expect(entries).toHaveLength(1);

    // Same request again, now with a would-throw transport: it's a hit,
    // so the transport is not consulted and the recorded body comes back.
    const auto2 = recordingFetch({
      mode: 'auto',
      entries,
      fetch: fakeFetch({ shouldNotBeCalled: true }).fetch,
    });
    expect(await (await auto2(REQ.url, REQ.init)).text()).toBe('FIRST');
    expect(entries).toHaveLength(1);

    // A different request misses and is appended.
    const other = fakeFetch({ body: 'OTHER' });
    const auto3 = recordingFetch({ mode: 'auto', entries, fetch: other.fetch });
    const otherInit = { ...REQ.init, body: '{"model":"m","messages":["different"]}' };
    expect(await (await auto3(REQ.url, otherInit)).text()).toBe('OTHER');
    expect(entries).toHaveLength(2);
  });

  it('record mode: overwrites a stale entry for the same request', async () => {
    const entries: CassetteEntry[] = [];
    await recordingFetch({ mode: 'record', entries, fetch: fakeFetch({ body: 'OLD' }).fetch })(
      REQ.url,
      REQ.init,
    );
    expect(entries).toHaveLength(1);
    const res = await recordingFetch({
      mode: 'record',
      entries,
      fetch: fakeFetch({ body: 'NEW' }).fetch,
    })(REQ.url, REQ.init);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.response.body).toBe('NEW');
    expect(await res.text()).toBe('NEW');
  });

  it('propagates a non-2xx status as ok=false', async () => {
    const entries: CassetteEntry[] = [];
    const res = await recordingFetch({
      mode: 'record',
      entries,
      fetch: fakeFetch({ status: 429, body: '{"error":"rate_limited"}' }).fetch,
    })(REQ.url, REQ.init);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
    // Replaying it preserves the failure shape.
    const replay = recordingFetch({ mode: 'replay', entries });
    const replayed = await replay(REQ.url, REQ.init);
    expect(replayed.ok).toBe(false);
    expect(replayed.status).toBe(429);
    expect(await replayed.text()).toBe('{"error":"rate_limited"}');
  });
});
