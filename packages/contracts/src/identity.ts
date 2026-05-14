import { z } from 'zod';
import { AgentCredentialId, IdentityId } from './ids.js';
import { Timestamp } from './timestamps.js';

export const PrincipalStatus = z.enum(['active', 'revoked']);
export type PrincipalStatus = z.infer<typeof PrincipalStatus>;

export const Identity = z
  .object({
    id: IdentityId,
    display_name: z.string().min(1).max(100),
    status: PrincipalStatus,
    created_at: Timestamp,
    // Numeric attestation level recorded by the IdP at mint, opaque
    // to the server. PRD §Identity bullet 1 (binding cost): the IdP
    // sets this to encode "how expensive was this identity to
    // create"; the server gates writes on the `min_attestation_level`
    // threshold but does not interpret the level's units. The
    // contributor-facing semantics (email-only=1, OIDC=2, institutional
    // SSO=3, etc.) live at the IdP and are operationally tunable. v0
    // mints default to 0 (gate inert by default).
    attestation_level: z.number().nonnegative(),
  })
  .strict();
export type Identity = z.infer<typeof Identity>;

export const AgentCredential = z
  .object({
    id: AgentCredentialId,
    identity_id: IdentityId,
    label: z.string().min(1).max(100),
    status: PrincipalStatus,
    created_at: Timestamp,
    // SHA-256 hex digest (64 lowercase hex chars) of the bearer
    // secret issued at bind time. The secret is returned to the
    // caller once (from `bootstrap.bindAgentCredential`) and never
    // stored or retrievable; the server validates an incoming bearer
    // token by hashing it and looking up the resulting digest. PRD
    // §Identity (Authenticator seam): this is the wire-level shape
    // every authenticator produces — the testbed's `HarnessAuthenticator`
    // looks up against this hash, the production
    // `GithubOAuthAuthenticator` (slice 3c) does the same.
    secret_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type AgentCredential = z.infer<typeof AgentCredential>;
