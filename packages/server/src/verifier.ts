import type { ExternalRef } from '@anchorage/contracts';
import { ServerError } from './errors.js';

// Verifier is the seam where the verifiable-anchor write path meets the
// outside world. PRD §Verification engine: "the server fetches the
// external_ref, confirms resolution, and rejects on failure." That
// fetch is network I/O — async, swappable, faked in the testbed, real
// against PubMed/CrossRef in production. Keeping it behind an interface
// from day one avoids retrofitting async later.
export interface Verifier {
  verifyExternalRef(ref: ExternalRef): Promise<void>;
}

// Phase-1 default: structural-only. The discriminated-union schema in
// contracts already enforces the shape; this verifier exists so callers
// have a default that *is* a verifier (not `null`). The real fetching
// verifier replaces it once the verification engine lands.
export class StructuralVerifier implements Verifier {
  async verifyExternalRef(_ref: ExternalRef): Promise<void> {
    return;
  }
}

// Test verifier: rejects refs whose `value` matches any unresolvable
// pattern given at construction. Default is "every ref resolves."
export class FakeVerifier implements Verifier {
  constructor(private readonly unresolvable: ReadonlySet<string> = new Set()) {}
  async verifyExternalRef(ref: ExternalRef): Promise<void> {
    if (this.unresolvable.has(ref.value)) {
      throw new ServerError('invalid_input', `external_ref does not resolve: ${ref.value}`);
    }
  }
}
