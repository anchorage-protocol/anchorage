import type {
  FrontierItem,
  Node,
  QueryFrontierOutput,
  Subgraph,
  SubTopicDetail,
} from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Sub-topic page: the synthesis of three reads — `sub-topic://{id}`,
// `subgraph://{id}`, and `query_frontier`. Renders the sub-topic's
// metadata, activity counters, the current active node set
// (convex-hull view), and the frontier (work-to-be-done).
//
// What it deliberately does NOT show, deferred to slice 5c:
// - The edge set (each Subgraph carries edges but the v0 page is a
//   node list; the graph projection lands in 5c alongside the
//   node-detail page).
// - Per-proposal review pressure (staged_proposals is a count; the
//   proposal-queue surface is a contributor-view concern, not
//   anonymous-browse).
// - Contributor attribution (PRD §Reputation commits a separate
//   public reputation-tier projection from query_reputation;
//   the tier definition itself is a slice 5c piece).
export interface SubTopicPageData {
  detail: SubTopicDetail;
  subgraph: Subgraph;
  frontier: QueryFrontierOutput;
}

export function renderSubTopicPage(data: SubTopicPageData): string {
  const { detail, subgraph, frontier } = data;
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · ${detail.cause.name}
  </div>
  <h1>${detail.sub_topic.name}</h1>
  <p>${detail.sub_topic.description}</p>
  <p><span class="scope-query">${detail.sub_topic.scope_query}</span></p>

  <div class="counters">
    <div>
      <span class="num">${detail.activity.active_nodes}</span>
      <span class="label">Active nodes</span>
    </div>
    <div>
      <span class="num">${detail.activity.staged_proposals}</span>
      <span class="label">Staged proposals</span>
    </div>
    <div>
      <span class="num">${detail.activity.frontier_items}</span>
      <span class="label">Frontier items</span>
    </div>
  </div>

  <p class="manuscript-link"><a href="/manuscript/${detail.sub_topic.id}">Read the manuscript projection &rarr;</a></p>

  <h2>Active nodes</h2>
  ${renderNodeList(subgraph.nodes)}

  <h2>Frontier — work to be done</h2>
  ${renderFrontier(frontier)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: `${detail.sub_topic.name} — Anchorage`,
    stylesheet: baselineStylesheet,
    body,
  });
}

// Render cap for the active-node list. The page recomputes a full
// store scan per anonymous request; without a cap a few thousand
// nodes make the public face a multi-megabyte page and the slowest
// path in the system. Honest truncation ("showing first N of M")
// over pagination machinery — the manuscript projection is the
// long-form read surface; this list is orientation.
const NODE_LIST_CAP = 500;

function renderNodeList(nodes: readonly Node[]): Raw {
  if (nodes.length === 0) {
    return emptyState(
      'No active nodes in this sub-topic yet. The graph fills in as proposals are reviewed and accepted.',
    );
  }
  const shown = nodes.slice(0, NODE_LIST_CAP);
  return html`<ul class="node-list">
${shown.map(
  (n) => html`<li>
  <span class="node-kind">${n.kind}</span>
  <a class="node-id" href="/node/${n.id}">${n.id}</a>
  <span class="node-content">${n.content}</span>
</li>`,
)}
</ul>${
    nodes.length > shown.length
      ? html`<p class="empty">Showing the first ${String(shown.length)} of ${String(nodes.length)} active nodes.</p>`
      : html``
  }`;
}

function renderFrontier(frontier: QueryFrontierOutput): Raw {
  if (frontier.items.length === 0) {
    return emptyState(
      'No open frontier items in this sub-topic. Either nothing is staged, or the active graph has no visible gaps yet.',
    );
  }
  return html`<ul class="frontier-list">
${frontier.items.map(renderFrontierItem)}
</ul>`;
}

function renderFrontierItem(item: FrontierItem): Raw {
  // Each kind references a different id field; the page surfaces
  // the kind label and the relevant id so a reader can correlate
  // with the rest of the graph view. Node-referencing kinds link
  // to `/node/{id}` (slice 5c); `needs_review` references a
  // proposal_id, whose dedicated per-proposal page is a later
  // slice — the id renders as plain text until then.
  switch (item.kind) {
    case 'orphan_anchor':
      return html`<li>
  <span class="frontier-kind">orphan anchor</span>
  <a class="frontier-id" href="/node/${item.anchor_id}">${item.anchor_id}</a>
</li>`;
    case 'needs_synthesis':
      return html`<li>
  <span class="frontier-kind">needs synthesis</span>
  <span class="frontier-id">${item.parent_ids.map(
    (id, i) => html`${i > 0 ? ', ' : ''}<a href="/node/${id}">${id}</a>`,
  )}</span>
</li>`;
    case 'needs_review':
      return html`<li>
  <span class="frontier-kind">needs review</span>
  <span class="frontier-id">${item.proposal_id}</span>
</li>`;
    case 'unresolvable_anchor':
      return html`<li>
  <span class="frontier-kind">unresolvable anchor</span>
  <a class="frontier-id" href="/node/${item.anchor_id}">${item.anchor_id}</a>
</li>`;
  }
}
