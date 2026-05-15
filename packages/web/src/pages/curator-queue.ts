import type { CauseId, Proposal } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Curator moderation queue (slice 7b). Lists every staged proposal,
// oldest first. PRD §Curator console: this is the read-only surface
// the curator visits to know what's pending; firing the action goes
// through their MCP agent (`curator_accept_proposal`,
// `curator_reject_proposal`, `curator_defer_sub_topic` for sub-topic
// proposals — see PRD §Curator-only tools).
//
// Filterable by cause via `?cause_id=`. The cause filter is applied
// by the underlying `server.resources.getCuratorQueue` server-side;
// the page reflects whatever subset the reader returned.

export interface CuratorQueuePageData {
  proposals: Proposal[];
  // Optional cause filter applied; rendered into the breadcrumb so
  // the curator knows whether they're seeing a filtered or full view.
  cause_id?: CauseId;
}

export function renderCuratorQueuePage(data: CuratorQueuePageData): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · <a href="/curator">Curator</a> · Moderation queue${
      data.cause_id ? html` · cause ${data.cause_id}` : null
    }
  </div>
  <h1>Moderation queue</h1>
  <p>${data.proposals.length} staged proposal${data.proposals.length === 1 ? '' : 's'}${
    data.cause_id ? html` in ${data.cause_id}` : ' across all causes'
  }, oldest first. Click a proposal id to view the staged record (resolve via your curator agent).</p>
  ${renderQueueTable(data.proposals)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: 'Moderation queue — Anchorage',
    stylesheet: baselineStylesheet,
    body,
  });
}

function renderQueueTable(proposals: readonly Proposal[]): Raw {
  if (proposals.length === 0) {
    return emptyState(
      'No staged proposals — the queue is empty, or every staged item has been routed past the filter applied.',
    );
  }
  return html`<table class="queue-table">
<thead><tr><th>Proposal</th><th>Kind</th><th>Proposer</th><th>Created</th></tr></thead>
<tbody>
${proposals.map(
  (p) => html`<tr>
  <td><code>${p.id}</code></td>
  <td>${p.payload.kind}</td>
  <td><a href="/contributor/${p.proposer_id}">${p.proposer_id}</a></td>
  <td>${p.created_at}</td>
</tr>`,
)}
</tbody>
</table>`;
}
