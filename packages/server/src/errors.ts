// Typed server errors. Codes are stable: the testbed and clients pattern-
// match on `code`, never on the human-readable message.
export type ServerErrorCode = 'not_found' | 'invalid_state' | 'invalid_input' | 'unauthorized';

export class ServerError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}
