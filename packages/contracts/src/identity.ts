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
  })
  .strict();
export type AgentCredential = z.infer<typeof AgentCredential>;
