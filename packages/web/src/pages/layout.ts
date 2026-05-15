import type { CauseDirectory } from '@anchorage/contracts';
import { html, type Raw } from '../render.js';

// Shared page chrome. The header is intentionally minimal — brand
// + tagline + link back home. No navigation menu, no search box: the
// slice 5b commitment is no interactivity beyond navigation, and the
// content surfaces (cause list, sub-topic detail) are themselves
// the navigation. The footer links to the public repo so a reader
// who lands on the site can find the protocol's source and licensing
// without hunting.

export function siteHeader(): Raw {
  return html`<header class="site">
  <a class="brand" href="/">Anchorage</a>
  <span class="tagline">Cooperative open research with auditable lineage.</span>
</header>`;
}

export function siteFooter(): Raw {
  return html`<footer class="site">
  Open protocol · <a href="https://github.com/anchorage-protocol/anchorage">source on GitHub</a> · code AGPL-3.0, data CC BY-SA 4.0
</footer>`;
}

// Convenience: render an empty-state phrase. Used by the home page
// when no causes are active and by the sub-topic page when the
// graph or frontier is empty. Kept as a helper so the wording is
// consistent and so future copy passes touch one place.
export function emptyState(text: string): Raw {
  return html`<p class="empty">${text}</p>`;
}

// Render the "no such resource" body. Both pages 404 with the same
// shell as the success cases so the chrome stays consistent — the
// reader sees a real page, not a generic browser error.
export function notFoundBody(title: string, detail: string): Raw {
  return html`${siteHeader()}
<main>
  <h1>${title}</h1>
  <p>${detail}</p>
  <p><a href="/">Back to the home page.</a></p>
</main>
${siteFooter()}`;
}

// Convenience for tests / callers that need to inspect cause IDs
// referenced by the home page. Re-exported so the page modules
// import a single namespace.
export type { CauseDirectory };
