import { createHash } from 'node:crypto';
import type { ExternalRef, QuotedSpan, SourceMetadata } from '@anchorage/contracts';
import { ServerError } from './errors.js';
import {
  normalizeForSpanMatch,
  TransientFetchError,
  type VerifiedRef,
  type Verifier,
} from './verifier.js';

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
    const { text, metadata } = await this.fetchSource(ref);
    this.cache.set(cacheKey(ref), text);
    const normalized = normalizeForSpanMatch(text);
    const content_hash = createHash('sha256').update(normalized).digest('hex');
    return { content_hash, ...(metadata ? { metadata } : {}) };
  }

  async verifySpan(ref: ExternalRef, span: QuotedSpan): Promise<void> {
    let source = this.cache.get(cacheKey(ref));
    if (source === undefined) {
      source = (await this.fetchSource(ref)).text;
      this.cache.set(cacheKey(ref), source);
    }
    if (!normalizeForSpanMatch(source).includes(normalizeForSpanMatch(span.text))) {
      throw new ServerError(
        'invalid_input',
        `quoted_span does not appear in source for ${ref.kind}:${ref.value}`,
      );
    }
  }

  // Each source fetch returns the `text` used for hashing and span
  // matching, plus best-effort canonical `metadata` parsed from the same
  // response (no extra round-trip). Metadata is absent for URL anchors
  // (no structured record) and whenever a record yields nothing
  // parseable; it never gates the fetch.
  private async fetchSource(ref: ExternalRef): Promise<FetchedSource> {
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
  // Failure modes: HTTP 429/5xx surface as `TransientFetchError` (the
  // upstream said nothing about the ref — the re-verification scheduler
  // must not flip an anchor terminal on its own rate limit, and the
  // propose path tells the contributor to retry); any other non-200 and
  // an empty response body (NCBI returns 200 with empty content for a
  // PMID that doesn't exist) surface as `invalid_input`. The wire-level
  // error-code vocabulary is unchanged — the transient/permanent split
  // is a server-internal seam, not a new ServerErrorCode (which is
  // breaking-change territory per the comment in
  // `packages/contracts/src/errors.ts`).
  private async fetchPmid(pmid: string): Promise<FetchedSource> {
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
      throw refusalFor(res.status, `pmid:${pmid}`);
    }
    const body = await res.text();
    if (body.trim().length === 0) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: pmid:${pmid} (empty response)`,
      );
    }
    const metadata = parsePmidMetadata(body);
    return { text: body, ...(metadata ? { metadata } : {}) };
  }

  // DOI via Crossref `works/{doi}`. Returns JSON metadata; we compose
  // title + abstract for span matching. Abstracts in Crossref are often
  // JATS-XML-wrapped (`<jats:p>...</jats:p>`); tags are stripped. Many
  // DOIs have no abstract field at all — the v0 limitation is that for
  // those records, a contributor can only span-match against the title.
  // PRD §Verification engine doesn't promise fuller source retrieval; a
  // Phase 3 fallback (Unpaywall, publisher fetch, full-text DBs) would
  // broaden this without changing the verifier's contract.
  private async fetchDoi(doi: string): Promise<FetchedSource> {
    const url = `${CROSSREF_WORKS}/${encodeURIComponent(doi)}`;
    const res = await this.fetchWithUserAgent(url, { Accept: 'application/json' });
    if (!res.ok) {
      throw refusalFor(res.status, `doi:${doi}`);
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
    const metadata = parseCrossrefMetadata(message);
    return { text: composed, ...(metadata ? { metadata } : {}) };
  }

  // URL via direct HTTP GET. Off by default (`reject_url`). When enabled
  // — e.g. a curator console verifying a manually-vetted source — the
  // response body is returned as-is, no HTML stripping, no archival
  // fallback. A real URL-anchor regime needs more (content-extraction,
  // archive.org snapshot for the stored-hash baseline, cloaking
  // defense); slice 1 commits the seam, not the regime.
  private async fetchUrl(url: string): Promise<FetchedSource> {
    const res = await this.fetchWithUserAgent(url);
    if (!res.ok) {
      throw refusalFor(res.status, `url:${url}`);
    }
    const body = await res.text();
    if (body.trim().length === 0) {
      throw new ServerError(
        'invalid_input',
        `external_ref does not resolve: url:${url} (empty response)`,
      );
    }
    // No structured record to mine — a raw URL fetch yields text only.
    return { text: body };
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

// Map a non-200 upstream status onto the verifier's two refusal
// classes: 429 and 5xx say nothing about the ref (the upstream is
// rate-limiting us or down) and surface as `TransientFetchError`;
// everything else (404, 400, ...) is the upstream telling us the ref
// does not resolve and surfaces as the usual `invalid_input`.
function refusalFor(status: number, label: string): Error {
  if (status === 429 || status >= 500) {
    return new TransientFetchError(
      status,
      `source fetch temporarily unavailable: ${label} (HTTP ${status}); retry later`,
    );
  }
  return new ServerError('invalid_input', `external_ref does not resolve: ${label} (HTTP ${status})`);
}

function cacheKey(ref: ExternalRef): string {
  return `${ref.kind}:${ref.value}`;
}

// What a source fetch yields: the text used for hashing and span
// matching, plus the best-effort canonical metadata mined from the same
// response. `metadata` is undefined when nothing parseable was found.
interface FetchedSource {
  text: string;
  metadata?: SourceMetadata;
}

interface CrossrefResponse {
  message?: CrossrefMessage;
}

interface CrossrefMessage {
  title?: string[];
  abstract?: string;
  author?: Array<{ given?: string; family?: string; name?: string }>;
  'container-title'?: string[];
  issued?: { 'date-parts'?: number[][] };
  published?: { 'date-parts'?: number[][] };
}

// Strip JATS XML tags from Crossref abstract fields. Crossref returns
// abstracts wrapped in `<jats:p>...</jats:p>` (sometimes with `<jats:sec>`,
// `<jats:title>`, inline `<italic>`, etc.). We're not parsing JATS — we
// strip the tags and let the text fall through, which is enough for
// substring span matching.
function stripJatsTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}

// ---------------------------------------------------------------------------
// Canonical-metadata extraction (PRD §Verification engine, Canonical
// metadata). Both parsers are best-effort: they mine what the resolver's
// own response states about the work and omit anything they can't read
// cleanly. A return of `undefined` means "nothing parseable" — never an
// error, never a block on acceptance. The point is to give a reviewer the
// source's self-reported title/authors/year/venue next to the proposer's
// free-text citation, so a transposed author or wrong venue is visible at
// a glance instead of costing a manual lookup.
// ---------------------------------------------------------------------------

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Assemble a SourceMetadata only if at least one field carries signal;
// otherwise undefined, so callers never store an empty husk.
function makeMetadata(m: {
  title?: string | undefined;
  authors: string[];
  year?: number | undefined;
  container_title?: string | undefined;
}): SourceMetadata | undefined {
  const hasSignal =
    (m.title !== undefined && m.title.length > 0) ||
    m.authors.length > 0 ||
    m.year !== undefined ||
    (m.container_title !== undefined && m.container_title.length > 0);
  if (!hasSignal) return undefined;
  return {
    ...(m.title ? { title: m.title } : {}),
    authors: m.authors,
    ...(m.year !== undefined ? { year: m.year } : {}),
    ...(m.container_title ? { container_title: m.container_title } : {}),
  };
}

// Blocks that sit where a title or author list would but are clearly
// neither — efetch interleaves these into the same blank-line-delimited
// stream, so a naive "block[1] is the title" would otherwise capture them.
const NON_BIBLIO_BLOCK =
  /^(author information|erratum|comment|comment in|comment on|update of|updated in|republished|expression of concern|retraction|©|copyright|doi:|pmid:|pmcid:)/i;

// PubMed efetch (rettype=abstract&retmode=text) layout, blank-line
// delimited: [0] citation line ("J Clin Oncol. 2022 Mar 10;40(8):892-910.
// doi: ..."), [1] title, [2] author list ("Baxter NN(1), Kennedy EB(2),
// ..."), then author-information / abstract / identifiers. We read the
// venue and year from the citation line and the title/authors from the
// next two blocks, guarding each against the non-bibliographic blocks
// efetch can interleave.
function parsePmidMetadata(text: string): SourceMetadata | undefined {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (blocks.length === 0) return undefined;

  // Citation line: strip the leading "N. " record enumerator efetch
  // prepends, then take the venue as the text up to the first ". " and
  // the year as the first 19xx/20xx in the line.
  const citation = (blocks[0] ?? '').replace(/^\d+\.\s+/, '');
  const yearMatch = citation.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;
  const venue = citation.split('. ')[0]?.trim();
  const container_title = venue && venue.length > 0 ? venue : undefined;

  const titleBlock = blocks[1];
  const title =
    titleBlock && !NON_BIBLIO_BLOCK.test(titleBlock) ? collapseWs(titleBlock) : undefined;

  const authorBlock = blocks[2];
  const authors =
    authorBlock && !NON_BIBLIO_BLOCK.test(authorBlock) ? parsePmidAuthors(authorBlock) : [];

  return makeMetadata({ title, authors, year, container_title });
}

// "Baxter NN(1)(2), Kennedy EB(3), Berlin J(5)." -> ["Baxter NN",
// "Kennedy EB", "Berlin J"]. Numeric affiliation markers and the trailing
// period are stripped; commas separate authors.
function parsePmidAuthors(block: string): string[] {
  return collapseWs(block)
    .replace(/\(\d+\)/g, '')
    .replace(/\.\s*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseCrossrefMetadata(message: CrossrefMessage): SourceMetadata | undefined {
  const title = (message.title ?? [])[0]?.trim();
  const container_title = (message['container-title'] ?? [])[0]?.trim();
  const year = crossrefYear(message);
  const authors = (message.author ?? [])
    .map((a) => {
      const composed = [a.given, a.family]
        .filter((p) => p && p.length > 0)
        .join(' ')
        .trim();
      return composed.length > 0 ? composed : (a.name ?? '').trim();
    })
    .filter((s) => s.length > 0);
  return makeMetadata({
    title: title && title.length > 0 ? title : undefined,
    authors,
    year,
    container_title: container_title && container_title.length > 0 ? container_title : undefined,
  });
}

// Crossref dates are nested arrays: issued.date-parts = [[year, month,
// day]]. Prefer `issued` (publication date) and fall back to `published`.
function crossrefYear(message: CrossrefMessage): number | undefined {
  const y = message.issued?.['date-parts']?.[0]?.[0] ?? message.published?.['date-parts']?.[0]?.[0];
  return typeof y === 'number' ? y : undefined;
}
