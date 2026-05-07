import { createHash } from 'node:crypto';
import type { ExternalRef, QuotedSpan } from '@anchorage/contracts';
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
  // PRD §Verification engine: for excerpts, the quoted span
  // must be a substring of the fetched source after normalization.
  // Failure rejects at write time, not at review time. Production
  // implementations fetch the source for `ref` and match `span.text`
  // against it; the FakeVerifier holds a fixture map.
  verifySpan(ref: ExternalRef, span: QuotedSpan): Promise<void>;
}

// Phase-1 default: shape is already enforced by the contracts schema,
// so this verifier just synthesizes a deterministic placeholder hash
// from the ref itself. The fetching verifier replaces it once the
// verification engine lands; until then, downstream code can treat
// content_hash as a stable identifier even though it doesn't reflect
// real source content.
//
// Span verification here is a no-op pending the same fetching engine.
// It is *not* a permissive default for tests — tests use FakeVerifier,
// which can be configured with source fixtures to exercise the
// rejection path.
export class StructuralVerifier implements Verifier {
  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    const hash = createHash('sha256').update(`${ref.kind}:${ref.value}`).digest('hex');
    return { content_hash: `placeholder:${hash}` };
  }
  async verifySpan(_ref: ExternalRef, _span: QuotedSpan): Promise<void> {
    // Pending verification engine. See class comment.
  }
}

// Test verifier:
// - `unresolvable` causes verifyExternalRef to throw `invalid_input`.
// - `hashes` overrides the placeholder content hash for a ref.
// - `sources` is the fixture map for span verification: when a ref's
//   source content is configured, verifySpan checks that span.text
//   appears in it after light normalization (whitespace collapse).
//   When not configured, span verification is skipped — most scenarios
//   don't care about span fidelity, and forcing them all to provide
//   source fixtures would be noise. Scenarios that *do* exercise the
//   verification engine populate `sources` explicitly.
export class FakeVerifier implements Verifier {
  constructor(
    private readonly unresolvable: ReadonlySet<string> = new Set(),
    private readonly hashes: ReadonlyMap<string, string> = new Map(),
    private readonly sources: ReadonlyMap<string, string> = new Map(),
  ) {}
  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    if (this.unresolvable.has(ref.value)) {
      throw new ServerError('invalid_input', `external_ref does not resolve: ${ref.value}`);
    }
    const content_hash = this.hashes.get(ref.value) ?? `fake:${ref.kind}:${ref.value}`;
    return { content_hash };
  }
  async verifySpan(ref: ExternalRef, span: QuotedSpan): Promise<void> {
    const source = this.sources.get(ref.value);
    if (source === undefined) return;
    if (!normalize(source).includes(normalize(span.text))) {
      throw new ServerError(
        'invalid_input',
        `quoted_span does not appear in source for ${ref.kind}:${ref.value}`,
      );
    }
  }
}

// Light normalization for span matching: collapse runs of whitespace
// (including newlines) to a single space and trim. Enough to absorb
// reflow differences between the source and a contributor's quote.
// The full normalization spec PRD §Verification engine references will land with
// the verification engine; this is the test-fixture rule, not the
// spec.
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
