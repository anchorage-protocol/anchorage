import { createHash } from 'node:crypto';
import type { ExternalRef } from '@anchorage/contracts';
import { ServerError } from './errors.js';

// Verifier is the seam where the verifiable-anchor write path meets the
// outside world. PRD §Verification engine: "the server fetches the
// external_ref, confirms resolution, and rejects on failure." That
// fetch is network I/O — async, swappable, faked in the testbed, real
// against PubMed/CrossRef in production. Keeping it behind an interface
// from day one avoids retrofitting async later.
//
// The verifier returns observed metadata (currently `content_hash`,
// later: span-match offsets, fetched-source provenance). This lives on
// the server, not on the contributor's proposal payload, because it is
// server-observed not contributor-asserted.
export interface VerifiedRef {
  content_hash: string;
}

export interface Verifier {
  verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef>;
}

// Phase-1 default: shape is already enforced by the contracts schema,
// so this verifier just synthesizes a deterministic placeholder hash
// from the ref itself. The fetching verifier replaces it once the
// verification engine lands; until then, downstream code can treat
// content_hash as a stable identifier even though it doesn't reflect
// real source content.
export class StructuralVerifier implements Verifier {
  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    const hash = createHash('sha256').update(`${ref.kind}:${ref.value}`).digest('hex');
    return { content_hash: `placeholder:${hash}` };
  }
}

// Test verifier: rejects refs whose `value` is in `unresolvable`;
// otherwise returns either the configured hash or a deterministic
// fallback. Default is "every ref resolves."
export class FakeVerifier implements Verifier {
  constructor(
    private readonly unresolvable: ReadonlySet<string> = new Set(),
    private readonly hashes: ReadonlyMap<string, string> = new Map(),
  ) {}
  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    if (this.unresolvable.has(ref.value)) {
      throw new ServerError('invalid_input', `external_ref does not resolve: ${ref.value}`);
    }
    const content_hash = this.hashes.get(ref.value) ?? `fake:${ref.kind}:${ref.value}`;
    return { content_hash };
  }
}
