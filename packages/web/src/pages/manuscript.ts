import type {
  CreditAttribution,
  ExternalRef,
  Manuscript,
  ManuscriptCitation,
  ManuscriptSection,
} from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Manuscript-projection page (slice 6b). Reads
// `manuscript://{sub-topic-id}` through the in-process reader and
// renders the v0 implicit-default projection: four fixed-order
// sections (sources, quotations, synthesis, open questions) of
// cited claims, then a contributor credit list. The page is the
// first surface where a contributor sees their name attached to
// the work the graph carries (PRD §Manuscript projection +
// §Credit).
//
// Editorial register: every section is a list of nodes, each
// linked to its `/node/:id` detail page; each citation shows just
// enough kind-specific context to be readable in place (anchor →
// external_ref + content_hash; excerpt → blockquote + offset;
// synthesis / open_question → in-scope parent links). The
// contributor list links to `/contributor/:id` and surfaces the
// units + proposed/reviewed breakdown so the figure is not
// opaque.

export function renderManuscriptPage(data: Manuscript): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · <a href="/sub-topic/${data.sub_topic.id}">${data.sub_topic.name}</a>
  </div>
  <h1>${data.sub_topic.name}</h1>
  <p class="manuscript-lede">A projection of the active sub-graph as a manuscript outline. The graph is canonical; this view follows from it.</p>
  <p>${data.sub_topic.description}</p>

  ${data.sections.map(renderSection)}

  <h2>Contributors</h2>
  ${renderContributors(data.contributors)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: `${data.sub_topic.name} — manuscript — Anchorage`,
    stylesheet: baselineStylesheet,
    body,
  });
}

function renderSection(section: ManuscriptSection): Raw {
  if (section.items.length === 0) {
    return html`<h2>${section.title}</h2>
${emptyState(emptyStateMessage(section.kind))}`;
  }
  return html`<h2>${section.title}</h2>
<ol class="manuscript-section manuscript-${section.kind}">
${section.items.map(renderCitation)}
</ol>`;
}

function emptyStateMessage(kind: ManuscriptSection['kind']): string {
  switch (kind) {
    case 'sources':
      return 'No anchors yet — the sub-graph has no sources to cite.';
    case 'quotations':
      return 'No excerpts yet — sources are in but no quoted spans have been proposed.';
    case 'synthesis':
      return 'No synthesis claims yet — excerpts are in but no cross-source claims have converged.';
    case 'open_questions':
      return 'No open questions yet — no gaps have been called out as such.';
  }
}

function renderCitation(item: ManuscriptCitation): Raw {
  return html`<li>
  <a class="node-id" href="/node/${item.node_id}">${item.node_id}</a>
  <span class="node-content">${item.content}</span>
  ${kindSpecificCitation(item)}
  <p class="manuscript-attribution">Proposed by <a href="/contributor/${item.proposer_id}">${item.proposer_id}</a></p>
</li>`;
}

function kindSpecificCitation(item: ManuscriptCitation): Raw {
  if (item.kind === 'anchor' && item.external_ref) {
    return html`<p class="anchor-source">Reference: ${renderExternalRef(item.external_ref)}${item.content_hash ? html` · content hash <span class="node-id">${item.content_hash}</span>` : null}</p>`;
  }
  if (item.kind === 'excerpt' && item.quoted_span) {
    return html`<blockquote class="excerpt-span">${item.quoted_span.text}</blockquote>
<p class="node-id">Offset ${item.quoted_span.offset}</p>${renderParents(item.parent_node_ids)}`;
  }
  return renderParents(item.parent_node_ids);
}

function renderParents(parentIds: readonly string[]): Raw {
  if (parentIds.length === 0) return html``;
  return html`<p class="manuscript-parents">Derives from ${parentIds.map(
    (id, i) => html`${i > 0 ? ', ' : ''}<a href="/node/${id}">${id}</a>`,
  )}</p>`;
}

function renderExternalRef(ref: ExternalRef): Raw {
  switch (ref.kind) {
    case 'pmid':
      return html`<a href="https://pubmed.ncbi.nlm.nih.gov/${ref.value}/">PMID ${ref.value}</a>`;
    case 'doi':
      return html`<a href="https://doi.org/${ref.value}">DOI ${ref.value}</a>`;
    case 'url':
      return html`<a href="${ref.value}">${ref.value}</a>`;
  }
}

function renderContributors(contributors: readonly CreditAttribution[]): Raw {
  if (contributors.length === 0) {
    return emptyState(
      'No credited contributors yet — the sub-graph is empty or holds only superseded work.',
    );
  }
  return html`<ol class="credit-list">
${contributors.map(renderCredit)}
</ol>
<p class="empty">Credit is computed from graph state: proposer + accepted-aligned reviewer credit per included node, scaled by survivor and load-bearing factors. Specific weights are testbed-tunable.</p>`;
}

function renderCredit(c: CreditAttribution): Raw {
  return html`<li>
  <a class="credit-name" href="/contributor/${c.contributor_id}">${c.display_name}</a>
  ${c.status === 'revoked' ? html`<span class="revoked-flag">(revoked)</span>` : null}
  <span class="credit-units">${formatUnits(c.units)}</span>
  <span class="credit-breakdown">${c.proposed_node_count} proposed · ${c.reviewed_node_count} reviewed</span>
</li>`;
}

function formatUnits(units: number): string {
  // Two decimals is the natural register for the v0 weights — the
  // smallest weight (reviewer at 0.25) is two decimals; survivor +
  // load bonuses are halves and quarters. Future weight reschemes
  // can refine this without touching the wire shape.
  return `${units.toFixed(2)} units`;
}
