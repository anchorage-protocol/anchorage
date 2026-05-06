import type {
  AgentCredential,
  AgentCredentialId,
  Identity,
  IdentityId,
} from '@anchorage/contracts';
import { ServerError } from './errors.js';
import type { MemoryStore } from './store.js';

// Caller posture for tool calls. The MCP transport extracts these from
// the connection's auth context and passes them in. Phase 1 trusts the
// caller-id end-to-end (the testbed sets it directly); Phase 2+ binds
// it to a verified credential at the transport layer. The Server's
// contract is the same either way: every mutating tool resolves a
// caller before doing anything else.
export interface Caller {
  identity_id: IdentityId;
  // Present when the tool was invoked through a delegated agent rather
  // than the human directly. Reputation accrues to the identity either
  // way; the credential id is recorded for revocation/audit.
  agent_credential_id?: AgentCredentialId;
}

export interface ResolvedCaller {
  identity: Identity;
  credential?: AgentCredential;
}

export function resolveCaller(store: MemoryStore, caller: Caller): ResolvedCaller {
  const identity = store.identities.get(caller.identity_id);
  if (!identity) {
    throw new ServerError('unauthorized', `unknown identity: ${caller.identity_id}`);
  }
  if (identity.status !== 'active') {
    throw new ServerError('unauthorized', `identity is ${identity.status}`);
  }
  if (caller.agent_credential_id === undefined) {
    return { identity };
  }
  const credential = store.agentCredentials.get(caller.agent_credential_id);
  if (!credential) {
    throw new ServerError(
      'unauthorized',
      `unknown agent credential: ${caller.agent_credential_id}`,
    );
  }
  if (credential.identity_id !== identity.id) {
    throw new ServerError('unauthorized', 'agent credential does not belong to identity');
  }
  if (credential.status !== 'active') {
    throw new ServerError('unauthorized', `agent credential is ${credential.status}`);
  }
  return { identity, credential };
}
