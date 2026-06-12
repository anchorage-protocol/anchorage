import type { ExternalRef } from '@anchorage/contracts';
import { html, type Raw } from '../render.js';

// Shared external-ref renderer for every page that links a source
// (node detail, manuscript, curator unresolvable list). One copy so
// the two safety properties below cannot half-land across pages.
//
// 1. URL anchors render as a link only for http/https. The `html`
//    template escapes attribute breakout, but escaping does nothing
//    about the *scheme* — a stored `javascript:` URI would be a
//    click-to-execute XSS the moment URL anchors are enabled
//    (`reject_url` is an explicit verifier opt-out, and the renderer
//    must not borrow its safety from a default two packages away).
//    Anything else renders as escaped plain text.
//
// 2. DOI suffixes are percent-encoded with `/` preserved. DOIs
//    legitimately contain `#`, `?`, and `%` (the Crossref charset);
//    unencoded they truncate or corrupt the doi.org resolver path.
//    Same treatment the server's own Crossref client applies.
export function renderExternalRef(ref: ExternalRef): Raw {
  switch (ref.kind) {
    case 'pmid':
      return html`<a href="https://pubmed.ncbi.nlm.nih.gov/${ref.value}/">PMID ${ref.value}</a>`;
    case 'doi':
      return html`<a href="https://doi.org/${encodeDoiSuffix(ref.value)}">DOI ${ref.value}</a>`;
    case 'url': {
      if (isHttpUrl(ref.value)) {
        return html`<a href="${ref.value}">${ref.value}</a>`;
      }
      return html`<span class="node-id">${ref.value}</span>`;
    }
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function encodeDoiSuffix(doi: string): string {
  return doi.split('/').map(encodeURIComponent).join('/');
}
