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
  // Per-(identity, epoch) write-action budget exceeded. PRD §Identity
  // bullet 3 (per-identity rate-limit accounting): observable write
  // tools refuse with this mode when the caller's per-epoch action
  // counter hits the configured cap. Distinct from `unauthorized`
  // (caller is not allowed at all) and `not_found` (no work
  // available) — the recovery path is "wait for the next epoch,"
  // and conflating these would mislead a contributor whose
  // throttling is transient. The new code is justified by the
  // distinct recovery path and the architectural commitment in PRD
  // §Identity (cf. the rate-limit-accounting layer of the
  // four-layer sybil-resistance architecture).
  'rate_limited',
  // Per-(IdP, bucket, epoch) identity-issuance budget exceeded. PRD
  // §Identity bullet 2 (issuance-frequency cap): the IdP-layer
  // primitive that caps new-identity mints per epoch. Slice 3c
  // wires it on the `GithubOAuthAuthenticator.completeSignin` path.
  // Distinct from `unauthorized` (the caller's token is valid but
  // *issuance* is throttled, not authentication) and `rate_limited`
  // (a per-(identity, epoch) write-action cap downstream of identity
  // existence — issuance fires *before* an identity exists for the
  // signing-in caller). The recovery path is "wait for the next
  // epoch and retry signin," same shape as `rate_limited`, but at
  // a different layer of the four-layer sybil-resistance stack.
  'issuance_cap',
]);
export type ServerErrorCode = z.infer<typeof ServerErrorCode>;
