import { z } from 'zod';
import { AgentCredentialId, IdentityId } from './ids.js';
import { Timestamp } from './timestamps.js';

export const PrincipalStatus = z.enum(['active', 'revoked']);
export type PrincipalStatus = z.infer<typeof PrincipalStatus>;

// Which IdP issued the identity. Slice 3c locks GitHub as the v1
// production IdP per PRD §Identity (Authenticator seam); `harness` is
// the testbed/admin-mint path. New IdPs are added here when the
// authenticator seam grows a new concrete implementation.
export const IdentityProvider = z.enum(['harness', 'github']);
export type IdentityProvider = z.infer<typeof IdentityProvider>;

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
    // IdP that issued this identity. PRD §Identity (Authenticator
    // seam): the production runtime mints identities through
    // `GithubOAuthAuthenticator` (slice 3c) at `'github'`; admin and
    // testbed mints (`bootstrap.mintIdentity`) default to
    // `'harness'`. The field is server-side metadata — downstream
    // gates do not branch on it (sim≡prod invariant); it is recorded
    // for the curator-side identity-clustering projection (PRD
    // §Identity bullet 4) and for revocation cascades when an IdP
    // signals a compromised account.
    identity_provider: IdentityProvider,
    // Stable IdP-side subject the identity was minted against. For
    // GitHub this is the numeric user id (as a string), captured at
    // first signin so subsequent signins by the same GitHub account
    // resolve to the same Anchorage identity (identity-on-first-
    // signin; PRD §Identity, Authenticator seam). Absent for
    // `'harness'` mints (no external subject to bind against);
    // required for IdP-driven providers in slice 3c+.
    identity_provider_subject: z.string().min(1).max(200).optional(),
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
