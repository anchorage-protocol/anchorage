import { z } from 'zod';

// Wire-level error codes returned by the MCP tool surface. Stable
// pattern-matchable handles — clients (testbed adversaries, real
// agent clients) branch on these to decide what to do without
// inspecting the human-readable message. New codes here are
// breaking-change territory; prefer reusing an existing code with
// a more specific message.
export const ServerErrorCode = z.enum([
  'not_found',
  'invalid_state',
  'invalid_input',
  'unauthorized',
]);
export type ServerErrorCode = z.infer<typeof ServerErrorCode>;
