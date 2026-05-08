import { Timestamp } from '@anchorage/contracts';

// Clock is injected so the testbed and unit tests can run the server
// against deterministic time without any sim-vs-prod branching.
export interface Clock {
  now(): Timestamp;
}

export class SystemClock implements Clock {
  now(): Timestamp {
    return Timestamp.parse(new Date().toISOString());
  }
}

// Advances by `tickMs` on each call, starting from `start`. Useful for
// tests that need monotonic, distinct timestamps without depending on
// wall-clock resolution. `advance(ms)` lets a test jump the clock
// forward explicitly without consuming a tick — needed by scenarios
// that exercise time-dependent server behavior (reputation decay,
// divergence-closure archival) on a deterministic horizon.
export class FakeClock implements Clock {
  private current: number;
  constructor(
    start: Date | string = '2026-01-01T00:00:00.000Z',
    private readonly tickMs: number = 1000,
  ) {
    this.current = (typeof start === 'string' ? new Date(start) : start).getTime();
  }
  now(): Timestamp {
    const t = Timestamp.parse(new Date(this.current).toISOString());
    this.current += this.tickMs;
    return t;
  }
  advance(ms: number): void {
    if (ms < 0) throw new Error(`FakeClock.advance: negative ms (${ms})`);
    this.current += ms;
  }
}
