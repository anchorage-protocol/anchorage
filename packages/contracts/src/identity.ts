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
