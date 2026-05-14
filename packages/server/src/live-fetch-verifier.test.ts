import type { ExternalRef } from '@anchorage/contracts';
import { describe, expect, it } from 'vitest';
import { ServerError } from './errors.js';
import {
  LiveFetchVerifier,
  type VerifierFetch,
  type VerifierResponse,
} from './live-fetch-verifier.js';

// Unit tests for LiveFetchVerifier (`live-fetch-verifier.ts`). The
// verifier is the production-side implementation of the PRD §Verification
// engine contract — PMID resolution via NCBI E-utilities, DOI resolution
// via Crossref, URL refusal in v0, content-addressed hashing, and span
// verification against fetched content. These tests drive the verifier
// through an injected mock `fetch` so they exercise the real branching
// without hitting the network.

interface RecordedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string> } | undefined;
}

// Build a fetch stub from a (url predicate → response) table. The
// recorder lets a test assert what URL the verifier hit and with what
// headers — load-bearing for the PubMed/Crossref boundary (a regression
// that pointed PMIDs at Crossref or dropped the User-Agent would
// otherwise pass any "the verifier returned a hash" assertion).
function stubFetch(
  routes: Array<{ match: (url: string) => boolean; response: VerifierResponse }>,
): { fetch: VerifierFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: VerifierFetch = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (r.match(url)) return r.response;
    }
    throw new Error(`stubFetch: no route matched ${url}`);
  };
  return { fetch, calls };
}

function ok(body: string | object): VerifierResponse {
  return {
    ok: true,
    status: 200,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

function notOk(status: number, body = ''): VerifierResponse {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  };
}

const PMID_ABSTRACT = [
  '1. J Foo. 2025 May 14;1(1):1-2. doi: 10.0/test.',
  '',
  'A study of CRC ctDNA.',
  '',
  'Author, A.',
  '',
  'In a prospective cohort, ctDNA detected after surgery identified a high-risk group.',
  '',
  'PMID: 40010001',
].join('\n');

const PMID_REF: ExternalRef = { kind: 'pmid', value: '40010001' };
const DOI_REF: ExternalRef = { kind: 'doi', value: '10.1234/example' };
const URL_REF: ExternalRef = { kind: 'url', value: 'https://example.com/paper' };

describe('LiveFetchVerifier.verifyExternalRef', () => {
  it('resolves PMIDs against NCBI E-utilities efetch', async () => {
    const { fetch, calls } = stubFetch([
      { match: (u) => u.startsWith('https://eutils.ncbi.nlm.nih.gov/'), response: ok(PMID_ABSTRACT) },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    const { content_hash } = await v.verifyExternalRef(PMID_REF);

    expect(content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toContain('db=pubmed');
    expect(c.url).toContain('id=40010001');
    expect(c.url).toContain('rettype=abstract');
    expect(c.url).toContain('retmode=text');
    expect(c.init?.headers?.['User-Agent']).toMatch(/anchorage/);
  });

  it('attaches the api_key to the PMID request when supplied', async () => {
    const { fetch, calls } = stubFetch([
      { match: (u) => u.includes('eutils'), response: ok(PMID_ABSTRACT) },
    ]);
    const v = new LiveFetchVerifier({ fetch, ncbi_api_key: 'secret-key' });

    await v.verifyExternalRef(PMID_REF);

    expect(calls[0]!.url).toContain('api_key=secret-key');
  });

  it('rejects a PMID that returns HTTP non-200', async () => {
    const { fetch } = stubFetch([
      { match: () => true, response: notOk(500, 'oops') },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    await expect(v.verifyExternalRef(PMID_REF)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/pmid:40010001.*HTTP 500/),
    });
  });

  it('rejects a PMID whose body is empty (E-utilities not-found returns 200 + empty)', async () => {
    const { fetch } = stubFetch([
      { match: () => true, response: ok('   \n\n  ') },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    await expect(v.verifyExternalRef(PMID_REF)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/empty response/),
    });
  });

  it('resolves DOIs against Crossref works and composes title + abstract', async () => {
    const crossrefBody = {
      message: {
        title: ['A study of CRC ctDNA'],
        abstract: '<jats:p>The abstract <italic>body</italic>.</jats:p>',
      },
    };
    const { fetch, calls } = stubFetch([
      { match: (u) => u.startsWith('https://api.crossref.org/'), response: ok(crossrefBody) },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    const { content_hash } = await v.verifyExternalRef(DOI_REF);
    expect(content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]!.url).toBe('https://api.crossref.org/works/10.1234%2Fexample');
    expect(calls[0]!.init?.headers?.Accept).toBe('application/json');
  });

  it('accepts a DOI with only a title (no abstract) — title-only span match is the v0 limitation', async () => {
    const { fetch } = stubFetch([
      {
        match: () => true,
        response: ok({ message: { title: ['Title-only paper'] } }),
      },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    const { content_hash } = await v.verifyExternalRef(DOI_REF);
    expect(content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a DOI whose Crossref record has neither title nor abstract', async () => {
    const { fetch } = stubFetch([
      { match: () => true, response: ok({ message: {} }) },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    await expect(v.verifyExternalRef(DOI_REF)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/doi:10\.1234\/example.*no title or abstract/),
    });
  });

  it('refuses URL anchors by default (PRD §Verification engine: URL anchors are second-class in v0)', async () => {
    const { fetch, calls } = stubFetch([{ match: () => true, response: ok('content') }]);
    const v = new LiveFetchVerifier({ fetch });

    await expect(v.verifyExternalRef(URL_REF)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/url anchors are not accepted in v0/),
    });
    expect(calls).toHaveLength(0); // never hit the network
  });

  it('allows URL anchors when reject_url=false (opt-in seam for curator-vetted sources)', async () => {
    const { fetch } = stubFetch([
      { match: (u) => u === 'https://example.com/paper', response: ok('content here') },
    ]);
    const v = new LiveFetchVerifier({ fetch, reject_url: false });

    const { content_hash } = await v.verifyExternalRef(URL_REF);
    expect(content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable, normalized content hash (reflow + smart quotes do not change the hash)', async () => {
    const plain = ok('Pages 1-2: "data" and \'span\'...');
    const fancy = ok('Pages 1–2:\n“data”  and ‘span’…');
    const v1 = new LiveFetchVerifier({ fetch: stubFetch([{ match: () => true, response: plain }]).fetch });
    const v2 = new LiveFetchVerifier({ fetch: stubFetch([{ match: () => true, response: fancy }]).fetch });

    const h1 = (await v1.verifyExternalRef(PMID_REF)).content_hash;
    const h2 = (await v2.verifyExternalRef(PMID_REF)).content_hash;
    expect(h1).toBe(h2);
  });
});

describe('LiveFetchVerifier.verifySpan', () => {
  it('accepts a span that is a verbatim substring of the fetched PMID source', async () => {
    const { fetch, calls } = stubFetch([
      { match: () => true, response: ok(PMID_ABSTRACT) },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    await v.verifyExternalRef(PMID_REF); // populates the cache
    await v.verifySpan(PMID_REF, {
      text: 'ctDNA detected after surgery identified a high-risk group',
      offset: 0,
    });

    expect(calls).toHaveLength(1); // span verification reused the cache
  });

  it('falls back to a fresh fetch when the cache is cold (re-verification path)', async () => {
    const { fetch, calls } = stubFetch([
      { match: () => true, response: ok(PMID_ABSTRACT) },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    // No prior verifyExternalRef call — cache is empty.
    await v.verifySpan(PMID_REF, { text: 'high-risk group', offset: 0 });
    expect(calls).toHaveLength(1);
  });

  it('rejects a span that does not appear in the source', async () => {
    const { fetch } = stubFetch([{ match: () => true, response: ok(PMID_ABSTRACT) }]);
    const v = new LiveFetchVerifier({ fetch });

    await v.verifyExternalRef(PMID_REF);
    await expect(
      v.verifySpan(PMID_REF, { text: 'a finding that is not in the source', offset: 0 }),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it('accepts a span whose typography differs from the source (normalization is load-bearing)', async () => {
    const sourceWithSmartQuotes = '... reports that “ctDNA-positive” patients—a high-risk subset—had worse outcomes.';
    const { fetch } = stubFetch([
      { match: () => true, response: ok(sourceWithSmartQuotes) },
    ]);
    const v = new LiveFetchVerifier({ fetch });

    await v.verifyExternalRef(PMID_REF);
    // Quote rendered straight, em-dash as ASCII hyphen — should still match.
    await v.verifySpan(PMID_REF, {
      text: '"ctDNA-positive" patients-a high-risk subset-had worse outcomes',
      offset: 0,
    });
  });

  it('accepts a span quoted from a JATS-tagged Crossref abstract (tag stripping is load-bearing)', async () => {
    const crossrefBody = {
      message: {
        title: ['Title'],
        abstract:
          '<jats:p>The cohort showed <italic>significant</italic> reduction in recurrence.</jats:p>',
      },
    };
    const { fetch } = stubFetch([{ match: () => true, response: ok(crossrefBody) }]);
    const v = new LiveFetchVerifier({ fetch });

    await v.verifyExternalRef(DOI_REF);
    await v.verifySpan(DOI_REF, {
      text: 'The cohort showed significant reduction in recurrence',
      offset: 0,
    });
  });
});
