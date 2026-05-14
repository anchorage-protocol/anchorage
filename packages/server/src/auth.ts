import { createHash } from 'node:crypto';
import type {
  AgentCredential,
  AgentCredentialId,
  Identity,
  IdentityId,
} from '@anchorage/contracts';
import { ServerError } from './errors.js';
import type { Store } from './store.js';

// SHA-256 hex of an opaque bearer secret. The secret itself is minted
// at `bindAgentCredential` via `IdGen.bearerSecret()` (random in
// production, seeded in tests), returned to the caller once, and
// never stored — the server keeps only this hash, indexed in
// `Store.agentCredentialSecrets`. PRD §Identity (Authenticator seam).
export function hashBearerSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

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

// Testbed Authenticator. Accepts two token grammars, both private to
// the harness — downstream gates see only the resolved `Caller`,
// regardless of which grammar produced it (PRD §Identity, Authenticator
// seam).
//
//   - **Bearer secret** (production-shaped path). The token is the
//     opaque secret issued by `bootstrap.bindAgentCredential`. The
//     authenticator hashes it and looks up the credential through
//     `store.agentCredentialSecrets` — the same hash-lookup shape the
//     production `GithubOAuthAuthenticator` (slice 3c) will use for
//     OAuth-issued session secrets. Caller carries both
//     `identity_id` and `agent_credential_id`.
//
//   - **Direct identity id** (testbed-convenience path, transitional).
//     The token is an `IdentityId` known to the store. Resolves to
//     `{ identity_id }` with no `agent_credential_id`. This grammar
//     exists so that the checked-in golden cassettes
//     (`golden-deep-loop.json`, `golden-deep-loop-cube/*.json`) — which
//     pin exact LLM request/response bytes against a fixed
//     `FakeClock`-driven timeline — replay without re-recording.
//     Adding a `bindAgentCredential` call per contributor consumes
//     one FakeClock tick and shifts every downstream timestamp in
//     the tool-result chain, which propagates into the next-round
//     LLM request body and breaks the cassette key. The grammar will
//     be retired when the cassettes are re-recorded against the
//     bearer-secret path in a follow-up commit.
//
// Bearer-secret lookup is attempted first; the direct-identity-id
// fallback only fires when the hash misses. Production-side tests
// exercise the bearer-secret path (mcp.test.ts's `authenticator seam`
// suite); cassette scenarios stay on the direct-identity-id path.
//
// Any mismatch (unknown token, revoked credential, revoked identity)
// refuses with `unauthorized` at the seam — before any per-tool gate
// runs, no rate-limit budget burned.
export class HarnessAuthenticator implements Authenticator {
  constructor(private readonly store: Store) {}

  authenticate(token: string): Caller {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ServerError('unauthorized', 'missing token');
    }
    // Bearer-secret grammar (prod-shaped path).
    const hash = hashBearerSecret(token);
    const credentialId = this.store.agentCredentialSecrets.get(hash);
    if (credentialId !== undefined) {
      const credential = this.store.agentCredentials.get(credentialId);
      if (!credential) {
        throw new ServerError('unauthorized', 'credential record missing for valid secret');
      }
      const caller: Caller = {
        identity_id: credential.identity_id,
        agent_credential_id: credential.id,
      };
      resolveCaller(this.store, caller);
      return caller;
    }
    // Direct-identity-id fallback (transitional testbed grammar). The
    // identity must exist in the store and be active; `resolveCaller`
    // enforces that. Tokens that look like identity ids but name an
    // unknown identity refuse with `unauthorized`, the same code as
    // the bearer-secret-not-found case.
    const caller: Caller = { identity_id: token as IdentityId };
    resolveCaller(this.store, caller);
    return caller;
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
