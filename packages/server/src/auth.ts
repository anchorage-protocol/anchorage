import type {
  AgentCredential,
  AgentCredentialId,
  Identity,
  IdentityId,
} from '@anchorage/contracts';
import { ServerError } from './errors.js';
import type { Store } from './store.js';

// Caller posture for tool calls. Produced by an `Authenticator` at the
// transport layer (one resolution per connection / per request) and
// then carried into every Server tool invocation; downstream gates
// (binding-cost, rate-limit, reputation) re-resolve through the Store
// on every call so revocation observed mid-connection is honored.
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

// Trust boundary at the transport layer. Every MCP connection presents
// a bearer token; the Authenticator resolves it to a Caller posture
// once per connection (or per request, for the HTTP transport). PRD
// §Identity (Authenticator seam): both sim and prod go through this
// surface — the testbed instantiates `HarnessAuthenticator` against
// harness-minted identities with no network, the production runtime
// instantiates `GithubOAuthAuthenticator` (slice 3c) verifying real
// OAuth-issued session tokens. No `if (sim) ...` branching downstream:
// the gates beyond the seam see only a `Caller`.
export interface Authenticator {
  authenticate(token: string): Caller;
}

// Testbed Authenticator. Tokens encode the caller directly — no
// session table, no expiry, no network. Two grammars:
//
//   "I-xyz"            → { identity_id: 'I-xyz' }
//   "I-xyz/A-abc"      → { identity_id: 'I-xyz',
//                          agent_credential_id: 'A-abc' }
//
// The trailing `/A-…` is optional and only present when the caller is
// acting through a delegated agent. The encoding is symmetric: any
// caller round-trips through `tokenFor` and back. Validity is checked
// against the Store at `authenticate` time (the identity must exist
// and be active; the credential, when named, must belong to the
// identity and be active) — same invariants the per-tool
// `resolveCaller` re-checks downstream, so a token issued by a prior
// session for a now-revoked identity refuses at the seam rather than
// burning rate-limit budget downstream.
const HARNESS_TOKEN_SEP = '/';

export class HarnessAuthenticator implements Authenticator {
  constructor(private readonly store: Store) {}

  authenticate(token: string): Caller {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ServerError('unauthorized', 'missing token');
    }
    const sepIndex = token.indexOf(HARNESS_TOKEN_SEP);
    const identityPart = sepIndex < 0 ? token : token.slice(0, sepIndex);
    const credentialPart = sepIndex < 0 ? undefined : token.slice(sepIndex + 1);
    if (identityPart.length === 0) {
      throw new ServerError('unauthorized', 'malformed token: empty identity');
    }
    if (credentialPart !== undefined && credentialPart.length === 0) {
      throw new ServerError('unauthorized', 'malformed token: empty credential');
    }
    const caller: Caller = { identity_id: identityPart as IdentityId };
    if (credentialPart !== undefined) {
      caller.agent_credential_id = credentialPart as AgentCredentialId;
    }
    // Validate against the store now so a malformed/stale token fails
    // at the seam rather than at the first downstream tool call. The
    // checks mirror `resolveCaller` exactly — the per-tool path still
    // re-checks because revocation may happen mid-connection.
    resolveCaller(this.store, caller);
    return caller;
  }

  // Symmetric serialization — used by the testbed to mint a token
  // from a Caller it constructed. Production tokens are opaque session
  // ids and do not have a symmetric inverse.
  tokenFor(caller: Caller): string {
    return caller.agent_credential_id === undefined
      ? caller.identity_id
      : `${caller.identity_id}${HARNESS_TOKEN_SEP}${caller.agent_credential_id}`;
  }
}

export function resolveCaller(store: Store, caller: Caller): ResolvedCaller {
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
