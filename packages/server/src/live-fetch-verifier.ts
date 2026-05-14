import { createHash } from 'node:crypto';
import type { ExternalRef, QuotedSpan } from '@anchorage/contracts';
import { ServerError } from './errors.js';
import { normalizeForSpanMatch, type VerifiedRef, type Verifier } from './verifier.js';

// LiveFetchVerifier is the production verifier — the real implementation
// of the PRD §Verification engine commitment ("external references must
// resolve. PMIDs hit NCBI E-utilities; DOIs resolve via Crossref"). It
// replaces the `StructuralVerifier` placeholder anywhere a production
// runtime stands an Anchorage server up; the testbed continues to use
// `FakeVerifier` with seeded source maps (cassette-deterministic CI
// requires no production verifier in the loop — sim≡prod posture).
//
// The verifier owns the source-fetching boundary in two halves:
//
//   1. `verifyExternalRef(ref)` fetches the source, hashes it (sha256 of
//      the normalized content per PRD §Verification engine,
//      "content-addressed: the hash of the fetched content is stored
//      alongside the `external_ref`, and re-verification compares against
//      the stored hash"), and returns the hash. The fetched source is
//      cached in-process under the ref so that —
//
//   2. `verifySpan(ref, span)` can substring-match the span against the
//      cached source without re-fetching. A cache miss falls back to a
//      fresh fetch (the re-verification path); the cache is not load-
//      bearing for correctness, only for the common case of an anchor
//      proposal followed by an excerpt proposal in the same process.
//
// URL anchors are refused in v0 per PRD §Verification engine:
// "URL-anchors are second-class — metadata-unstable and cloaking-prone —
// and may be subject to stricter regimes (or refused entirely in v0)."
// The refusal happens at the verifier seam with a clear message; the
// `reject_url` option allows opt-in URL fetching for callers (e.g. a
// curator console verifying a manually-vetted source) but the default is
// refusal. Re-enabling URL fetching by default is a Phase 3 decision
// pending a content-extraction story that's harder than "HTTP GET and
// hope" (the v0 URL fetch returns raw response text — no HTML stripping,
// no cloaking defense, no archival fallback — so a span match against
// it is brittle in ways the PRD already calls out).
//
// Re-verification (the path that transitions an anchor to `unresolvable`
// on content drift, retraction, or host death) is a separate slice — the
// verifier-side primitive is `verifyExternalRef` itself (fetch + hash,
// callable on demand against a stored hash for comparison), but the
// scheduler that triggers it and the curator surface that surfaces the
// transition land alongside the operational tooling (slice 7 of the
// Phase 2 plan).

// Narrow fetch interface. Matches `globalThis.fetch` for the methods this
// verifier uses, and is injectable so unit tests can drive the verifier
// without hitting the network. Kept distinct from `@anchorage/testbed`'s
// `FetchLike` because that one is shaped for the Messages API loop (POST
// with a body); the verifier issues GETs and reads JSON for Crossref.
export interface VerifierResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export type VerifierFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<VerifierResponse>;

export interface LiveFetchVerifierOpts {
  // Fetch implementation. Defaults to `globalThis.fetch`. Tests pass a
  // mock; a recording wrapper could be plugged in here too if a future
  // testbed scenario wanted to cassette real PubMed responses (slice 1
  // does not need this — testbed scenarios continue to use FakeVerifier).
  fetch?: VerifierFetch;
  // NCBI E-utilities API key. Anonymous access is permitted at low
  // volume (3 req/sec/IP); with a key the limit rises to 10 req/sec.
  // PRD §Verification engine doesn't commit to a specific rate posture;
  // the production deployment supplies a key in environment config.
  ncbi_api_key?: string;
  // User-Agent header. NCBI and Crossref both request identification of
  // bot traffic; sending a stable User-Agent is good citizenship and is
  // what they ask their rate-limit ladders against.
  user_agent?: string;
  // Refuse URL anchors. Defaults to true per PRD §Verification engine.
  reject_url?: boolean;
}

const DEFAULT_USER_AGENT = 'anchorage-protocol/0.1 (+https://anchorage.science)';

const NCBI_EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const CROSSREF_WORKS = 'https://api.crossref.org/works';

export class LiveFetchVerifier implements Verifier {
  private readonly fetch: VerifierFetch;
  private readonly api_key: string | undefined;
  private readonly user_agent: string;
  private readonly reject_url: boolean;
  // Process-local source cache: `verifySpan` after `verifyExternalRef`
  // for the same ref skips the second network round-trip. Bounded only
  // by process lifetime; production deployments living long enough for
  // this to matter pin a real cache (slice 2 persistence, or a follow-up
  // LRU here) — slice 1 explicitly punts on cache eviction because the
  // common case is anchor-then-excerpt in one contributor session.
  private readonly cache = new Map<string, string>();

  constructor(opts: LiveFetchVerifierOpts = {}) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as VerifierFetch);
    this.api_key = opts.ncbi_api_key;
    this.user_agent = opts.user_agent ?? DEFAULT_USER_AGENT;
    this.reject_url = opts.reject_url ?? true;
  }

  async verifyExternalRef(ref: ExternalRef): Promise<VerifiedRef> {
    const source = await this.fetchSource(ref);
    this.cache.set(cacheKey(ref), source);
    const normalized = normalizeForSpanMatch(source);
    const content_hash = createHash('sha256').update(normalized).digest('hex');
    return { content_hash };
  }

  async verifySpan(ref: ExternalRef, span: QuotedSpan): Promise<void> {
    let source = this.cache.get(cacheKey(ref));
    if (source === undefined) {
      source = await this.fetchSource(ref);
      this.cache.set(cacheKey(ref), source);
    }
    if (!normalizeForSpanMatch(source).includes(normalizeForSpanMatch(span.text))) {
      throw new ServerError(
        'invalid_input',
        `quoted_span does not appear in source for ${ref.kind}:${ref.value}`,
      );
    }
  }

  private async fetchSource(ref: ExternalRef): Promise<string> {
    switch (ref.kind) {
      case 'pmid':
        return this.fetchPmid(ref.value);
      case 'doi':
        return this.fetchDoi(ref.value);
      case 'url':
        if (this.reject_url) {
          throw new ServerError(
            'invalid_input',
            `url anchors are not accepted in v0 (PRD §Verification engine: URL-anchors are second-class and may be refused entirely)`,
          );
        }
        return this.fetchUrl(ref.value);
    }
  }

  // PMID via NCBI E-utilities efetch. `rettype=abstract&retmode=text`
  // returns plain text: bibliographic header (journal, volume, doi),
  // title, authors, abstract, PMID footer. Span verification matches
  // against this full text — for a typical contributor quoting from the
  // abstract, that's what they're quoting.
  //
  // Failure modes: HTTP non-200, empty response body (NCBI returns 200
  // with empty content for a PMID that doesn't exist), network error.
  // All three surface as `invalid_input` — the wire-level distinction
  // between transient (network) and permanent (not found) failure is
  // not modeled today; the contributor retries either way. Adding a
  // distinct error code is breaking-change territory per the comment
  // in `packages/contracts/src/errors.ts`, deferred until a real
  // contributor experience argues for it.
  private async fetchPmid(pmid: string): Promise<string> {
    const params = new URLSearchParams({
      db: 'pubmed',
      id: pmid,
      rettype: 'abstract',
      retmode: 'text',
    });
    if (this.api_key !== undefined) params.set('api_key', this.api_key);
    const url = `${NCBI_EFETCH}?${params.toString()}`;
    const res = await this.fetchWithUserAgent(url);
    if (!res.ok) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: pmid:${pmid} (HTTP ${res.status})`,
      );
    }
    const body = await res.text();
    if (body.trim().length === 0) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: pmid:${pmid} (empty response)`,
      );
    }
    return body;
  }

  // DOI via Crossref `works/{doi}`. Returns JSON metadata; we compose
  // title + abstract for span matching. Abstracts in Crossref are often
  // JATS-XML-wrapped (`<jats:p>...</jats:p>`); tags are stripped. Many
  // DOIs have no abstract field at all — the v0 limitation is that for
  // those records, a contributor can only span-match against the title.
  // PRD §Verification engine doesn't promise fuller source retrieval; a
  // Phase 3 fallback (Unpaywall, publisher fetch, full-text DBs) would
  // broaden this without changing the verifier's contract.
  private async fetchDoi(doi: string): Promise<string> {
    const url = `${CROSSREF_WORKS}/${encodeURIComponent(doi)}`;
    const res = await this.fetchWithUserAgent(url, { Accept: 'application/json' });
    if (!res.ok) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: doi:${doi} (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as CrossrefResponse;
    const message = body.message;
    if (!message) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: doi:${doi} (no message in Crossref response)`,
      );
    }
    const title = (message.title ?? []).join(' ').trim();
    const abstract = stripJatsTags(message.abstract ?? '').trim();
    const composed = [title, abstract].filter((s) => s.length > 0).join('\n\n');
    if (composed.length === 0) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: doi:${doi} (no title or abstract in Crossref response)`,
      );
    }
    return composed;
  }

  // URL via direct HTTP GET. Off by default (`reject_url`). When enabled
  // — e.g. a curator console verifying a manually-vetted source — the
  // response body is returned as-is, no HTML stripping, no archival
  // fallback. A real URL-anchor regime needs more (content-extraction,
  // archive.org snapshot for the stored-hash baseline, cloaking
  // defense); slice 1 commits the seam, not the regime.
  private async fetchUrl(url: string): Promise<string> {
    const res = await this.fetchWithUserAgent(url);
    if (!res.ok) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: url:${url} (HTTP ${res.status})`,
      );
    }
    const body = await res.text();
    if (body.trim().length === 0) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: url:${url} (empty response)`,
      );
    }
    return body;
  }

  private async fetchWithUserAgent(
    url: string,
    extra: Record<string, string> = {},
  ): Promise<VerifierResponse> {
    return this.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': this.user_agent, ...extra },
    });
  }
}

function cacheKey(ref: ExternalRef): string {
  return `${ref.kind}:${ref.value}`;
}

interface CrossrefResponse {
  message?: {
    title?: string[];
    abstract?: string;
  };
}

// Strip JATS XML tags from Crossref abstract fields. Crossref returns
// abstracts wrapped in `<jats:p>...</jats:p>` (sometimes with `<jats:sec>`,
// `<jats:title>`, inline `<italic>`, etc.). We're not parsing JATS — we
// strip the tags and let the text fall through, which is enough for
// substring span matching.
function stripJatsTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}
