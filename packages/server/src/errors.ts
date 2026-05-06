import type { ServerErrorCode } from '@anchorage/contracts';

// Typed server errors. The code set lives in @anchorage/contracts
// because it's wire-level — clients pattern-match on it across the
// MCP boundary. The class lives here because it's a server-internal
// concept (`throw`'s home).
export type { ServerErrorCode };

export class ServerError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}
