import type { Edge, ExternalRef, Node, NodeId, NodeNeighborhood } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Node-detail page (slice 5c). Renders the node itself plus its
// immediate active-edge neighborhood, with the provenance the graph
// already carries (created_by → contributor profile, kind-specific
// fields per `Node` discriminated-union: anchor external_ref +
// content_hash, excerpt quoted_span). Edge endpoints (neighbors)
// link back to their own node pages.
//
// What's deliberately NOT here (consciously deferred):
// - A graph-diagram projection — readers reading source HTML get a
//   useful list, not a canvas they can't navigate.
// - Per-supersedes survivorship metadata (slice 6 manuscript
//   projection territory).
// - Review/voting history (contributor-view concern, not anonymous-
//   browse).

export function renderNodePage(data: NodeNeighborhood): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · <a href="/sub-topic/${data.node.home_sub_topic_id}">${data.node.home_sub_topic_id}</a>
  </div>
  <h1>
    <span class="node-kind">${data.node.kind}</span>
    ${data.node.content}
  </h1>
  <p class="node-id">${data.node.id}</p>

  ${kindSpecificDetails(data.node)}

  <h2>Provenance</h2>
  <ul class="provenance">
    <li>Proposed by <a href="/contributor/${data.node.created_by}">${data.node.created_by}</a></li>
    <li>Created ${data.node.created_at}</li>
    <li>Status: ${data.node.status}</li>
  </ul>

  <h2>Neighbors</h2>
  ${renderNeighbors(data)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: `${data.node.kind} ${data.node.id} — Anchorage`,
    stylesheet: baselineStylesheet,
    body,
  });
}

function kindSpecificDetails(node: Node): Raw {
  switch (node.kind) {
    case 'anchor':
      return html`<h2>Source</h2>
<ul class="anchor-source">
  <li>Reference: ${renderExternalRef(node.external_ref)}</li>
  <li>Content hash: <span class="node-id">${node.content_hash}</span></li>
</ul>`;
    case 'excerpt':
      return html`<h2>Quoted span</h2>
<blockquote class="excerpt-span">${node.quoted_span.text}</blockquote>
<p class="node-id">Offset ${node.quoted_span.offset}</p>`;
    case 'synthesis':
    case 'open_question':
      // Synthesis and open-question carry only the common
      // `content`/`status` fields; the inbound `derives` edges in
      // the Neighbors section surface the parents.
      return html``;
  }
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

function renderNeighbors(data: NodeNeighborhood): Raw {
  if (data.edges.length === 0) {
    return emptyState(
      'No active edges touch this node yet — an isolated point in the graph (or, for a freshly accepted anchor, awaiting an excerpt).',
    );
  }
  // Hydrate the neighbor lookup once so each edge can render the
  // counterpart node's kind + display content.
  const neighborById = new Map<NodeId, Node>();
  for (const n of data.neighbors) {
    neighborById.set(n.id, n);
  }
  return html`<ul class="edge-list">
${data.edges.map((edge) => renderEdgeRow(data.node.id, edge, neighborById))}
</ul>`;
}

function renderEdgeRow(thisNodeId: NodeId, edge: Edge, neighbors: Map<NodeId, Node>): Raw {
  // Edge direction: render which side of the edge *this* node sits
  // on, and link to the counterpart. The arrow direction in the
  // text follows the edge's semantic direction (from → to) so a
  // reader sees the relationship even when this node is on the
  // `to` side.
  const otherId = edge.from === thisNodeId ? edge.to : edge.from;
  const other = neighbors.get(otherId);
  const direction = edge.from === thisNodeId ? '→' : '←';
  const otherLink = other
    ? html`<a href="/node/${other.id}"><span class="node-kind">${other.kind}</span> ${truncate(other.content, 80)}</a>`
    : html`<a href="/node/${otherId}">${otherId}</a>`;
  return html`<li><span class="edge-kind">${edge.kind}</span> <span class="edge-arrow">${direction}</span> ${otherLink}</li>`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
