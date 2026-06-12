import type { CauseId, ExternalRef, NodeId, SubTopicId, Timestamp } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';
import { renderExternalRef } from './refs.js';

// Curator unresolvable-anchors view (slice 7c). Surfaces anchors the
// re-verification scheduler flagged — content drift, retraction, host
// gone, or transient network failure (the verifier seam does not
// distinguish them). Same projection
// `server.resources.getCuratorUnresolvableAnchors` returns to an agent
// over MCP; the page is the human-readable companion the seated
// curator reads to decide what to do next.
//
// Read-only, like every other /curator/* page: recovery from
// unresolvable is via `propose_supersedes` from a contributor
// proposing a fresh `external_ref`, fired through the curator's agent
// over MCP. Re-running the verifier on the same anchor is not exposed
// here — `unresolvable` is terminal at the anchor level and the
// scheduler's batch primitive skips it on every subsequent tick.

export interface CuratorUnresolvablePageData {
  anchors: Array<{
    anchor_id: NodeId;
    home_sub_topic_id: SubTopicId;
    cause_id: CauseId;
    external_ref: ExternalRef;
    content_hash: string;
    last_verified_at: Timestamp;
    updated_at: Timestamp;
  }>;
  // Optional cause filter applied (passed through the breadcrumb so
  // the curator knows whether the empty state means "no drift in this
  // cause" or "no drift across the whole instance").
  cause_id?: CauseId;
}

export function renderCuratorUnresolvablePage(data: CuratorUnresolvablePageData): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · <a href="/curator">Curator</a> · Unresolvable anchors${
      data.cause_id ? html` · cause ${data.cause_id}` : null
    }
  </div>
  <h1>Unresolvable anchors</h1>
  <p>${data.anchors.length} anchor${data.anchors.length === 1 ? '' : 's'} flagged by the re-verification scheduler${
    data.cause_id ? html` in ${data.cause_id}` : ' across all causes'
  }, most-recent-drift-first. Each row is an anchor whose live source no longer matches the stored content hash, or whose external reference no longer resolves. Recovery: a contributor proposes a <code>supersedes</code> with a fresh <code>external_ref</code> pointing at the same claim; the curator accepts via their MCP agent.</p>
  ${renderTable(data.anchors)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: 'Unresolvable anchors — Anchorage',
    stylesheet: baselineStylesheet,
    body,
  });
}

function renderTable(anchors: CuratorUnresolvablePageData['anchors']): Raw {
  if (anchors.length === 0) {
    return emptyState(
      'No unresolvable anchors — every active anchor still resolves to its stored content hash.',
    );
  }
  return html`<table class="cluster-table">
<thead><tr><th>Anchor</th><th>Reference</th><th>Content hash</th><th>Last known good</th><th>Drift detected</th></tr></thead>
<tbody>
${anchors.map(
  (a) => html`<tr>
  <td><a href="/node/${a.anchor_id}">${a.anchor_id}</a></td>
  <td>${renderExternalRef(a.external_ref)}</td>
  <td><span class="node-id">${a.content_hash}</span></td>
  <td>${a.last_verified_at}</td>
  <td>${a.updated_at}</td>
</tr>`,
)}
</tbody>
</table>`;
}
