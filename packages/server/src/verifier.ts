import { createHash } from 'node:crypto';
import type { ExternalRef, QuotedSpan, SourceMetadata } from '@anchorage/contracts';
import { ServerError } from './errors.js';

// Verifier is the seam where the verifiable-anchor write path meets the
// outside world. PRD §Verification engine: "the server fetches the
// external_ref, confirms resolution, and rejects on failure." That
// fetch is network I/O — async, swappable, faked in the testbed, real
// against PubMed/Crossref in production. The production implementation
// is `LiveFetchVerifier` (`live-fetch-verifier.ts`); the testbed uses
// `FakeVerifier` below; `StructuralVerifier` is the no-network
// placeholder for tests that don't exercise the verifier at all.
//
// The verifier returns observed metadata (the `content_hash`, and the
// canonical bibliographic `metadata` the source reports about itself).
// This lives on the server, not on the contributor's proposal payload,
// because it is server-observed not contributor-asserted: the
// contributor writes a free-text citation in `content`; the verifier
// records what the resolved source actually says.
export interface VerifiedRef {
  content_hash: string;
  // Canonical bibliographic metadata captured from the resolved source
  // (title, authors, year, venue). Best-effort and optional: omitted
  // when the source yields nothing parseable, and never load-bearing for
  // acceptance. Surfaced to reviewers via query_proposals and
  // materialized onto the anchor node. PRD §Verification engine
  // (Canonical metadata).
  metadata?: SourceMetadata;
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

// StructuralVerifier is the no-network placeholder for tests and in-
// process scenarios that don't exercise the verifier itself — schema
// shape is already enforced by the contracts, so this verifier just
// synthesizes a deterministic placeholder hash from the ref. The
// production verifier is `LiveFetchVerifier` (`live-fetch-verifier.ts`)
// and is wired by production deployments that point at real PubMed and
// Crossref; testbed scenarios that need source-fixture-backed span
// verification use `FakeVerifier` below.
//
// Span verification here is a no-op: tests that care about span
// fidelity reach for `FakeVerifier` with a populated `sources` map. The
// `Server` ctor defaults to this verifier so existing in-process tests
// continue to construct cleanly without an explicit verifier; any
// production runtime overrides it with `LiveFetchVerifier`.
export class StructuralVerifier implements Verifier {
  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    const hash = createHash('sha256').update(`${ref.kind}:${ref.value}`).digest('hex');
    return { content_hash: `placeholder:${hash}` };
  }
  async verifySpan(_ref: ExternalRef, _span: QuotedSpan): Promise<void> {
    // No-op; see class comment.
  }
}

// Test verifier:
// - `unresolvable` causes verifyExternalRef to throw `invalid_input`.
// - `hashes` overrides the placeholder content hash for a ref.
// - `sources` is the fixture map for span verification: when a ref's
//   source content is configured, verifySpan checks that span.text
//   appears in it after normalization. When not configured, span
//   verification is skipped — most scenarios don't care about span
//   fidelity, and forcing them all to provide source fixtures would be
//   noise. Scenarios that *do* exercise the verification engine
//   populate `sources` explicitly.
// - `metadata` is the canonical-metadata fixture map: when a ref's
//   metadata is configured, verifyExternalRef returns it, mirroring what
//   LiveFetchVerifier parses out of PubMed/Crossref. Unconfigured refs
//   return no metadata (the common case). This keeps the sim≡prod
//   posture — a testbed scenario can exercise the metadata-surfacing
//   path identically to production.
export class FakeVerifier implements Verifier {
  constructor(
    private readonly unresolvable: ReadonlySet<string> = new Set(),
    private readonly hashes: ReadonlyMap<string, string> = new Map(),
    private readonly sources: ReadonlyMap<string, string> = new Map(),
    private readonly metadata: ReadonlyMap<string, SourceMetadata> = new Map(),
  ) {}
  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    if (this.unresolvable.has(ref.value)) {
      throw new ServerError('invalid_input', `external_ref does not resolve: ${ref.value}`);
    }
    const content_hash = this.hashes.get(ref.value) ?? `fake:${ref.kind}:${ref.value}`;
    const metadata = this.metadata.get(ref.value);
    return { content_hash, ...(metadata ? { metadata } : {}) };
  }
  async verifySpan(ref: ExternalRef, span: QuotedSpan): Promise<void> {
    const source = this.sources.get(ref.value);
    if (source === undefined) return;
    if (!normalizeForSpanMatch(source).includes(normalizeForSpanMatch(span.text))) {
      throw new ServerError(
        'invalid_input',
        `quoted_span does not appear in source for ${ref.kind}:${ref.value}`,
      );
    }
  }
}

// Normalization for span matching. PRD §Verification engine commits to
// "whitespace, quote-style, and a small set of typographic equivalences
// specified in the verification spec, not left to 'light normalization'
// hand-waving." Three layers, applied in order:
//
//   1. Quote-style fold: smart quotes (curly singles/doubles, prime
//      marks, low-9 quotation marks) collapse to ASCII straight quotes.
//      Source publishers and contributor inputs use these inconsistently
//      and an excerpt that quoted a source with "" rendered as "" would
//      otherwise fail the substring match for cosmetic reasons.
//   2. Typographic fold: en-dash, em-dash, and minus-sign to ASCII
//      hyphen; horizontal ellipsis to three dots. The set is
//      deliberately small — these are the typographic equivalences
//      source publishers routinely substitute for ASCII without
//      changing meaning, and a contributor's quote should match
//      regardless of which form their copy-paste preserved.
//      (Non-breaking spaces — U+00A0 and U+202F — collapse via the
//      whitespace step below; JS `\s` already includes them.)
//   3. Whitespace collapse: any run of whitespace (newlines included)
//      to a single space, then trim. Absorbs reflow differences between
//      source rendering and a contributor's quote.
//
// Both `LiveFetchVerifier` (`live-fetch-verifier.ts`) and `FakeVerifier`
// route through this single function so the test fixtures and the
// production fetcher agree on what counts as a match.
export function normalizeForSpanMatch(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}
