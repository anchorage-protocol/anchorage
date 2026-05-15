import type { Cause, IdentityId } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Curator decline-patterns view (slice 7b). Per-(cause, reviewer)
// cumulative offer / decline / rate, ordered by rate descending.
// PRD §Curator console + PRD §Curator-only tools: this is the same
// projection `curator_decline_patterns` returns to a curator's
// agent over MCP — the web view is the human-browsable mirror.
// Specific thresholds (small-sample floor, rate cutoff) stay
// operationally private; the projection shape is public.

export interface CuratorDeclinePatternsPageData {
  cause: Cause;
  entries: Array<{
    identity_id: IdentityId;
    offers: number;
    declines: number;
    decline_rate: number;
  }>;
}

export function renderCuratorDeclinePatternsPage(data: CuratorDeclinePatternsPageData): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · <a href="/curator">Curator</a> · Decline patterns · ${data.cause.name}
  </div>
  <h1>Decline patterns</h1>
  <p>Cause: <strong>${data.cause.name}</strong></p>
  <p>Per-reviewer cumulative decline rate within this cause, small-sample-filtered (the deployment's <code>min_offers</code> floor). High rates suggest sustained selectivity beyond the legitimate-narrow-specialist baseline; the <code>assignment_max_decline_rate</code> gate at <code>request_assignment</code> reads off the same signal and refuses callers above threshold.</p>
  ${renderDeclineTable(data.entries)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: `Decline patterns · ${data.cause.name} — Anchorage`,
    stylesheet: baselineStylesheet,
    body,
  });
}

function renderDeclineTable(entries: CuratorDeclinePatternsPageData['entries']): Raw {
  if (entries.length === 0) {
    return emptyState(
      'No entries above the small-sample floor. Either reviewers in this cause have not yet been offered enough work to surface a pattern, or every reviewer is below the rate cutoff.',
    );
  }
  return html`<table class="decline-table">
<thead><tr><th>Reviewer</th><th>Offers</th><th>Declines</th><th>Rate</th></tr></thead>
<tbody>
${entries.map(
  (e) => html`<tr>
  <td><a href="/contributor/${e.identity_id}">${e.identity_id}</a></td>
  <td>${e.offers}</td>
  <td>${e.declines}</td>
  <td>${formatRate(e.decline_rate)}</td>
</tr>`,
)}
</tbody>
</table>`;
}

function formatRate(rate: number): string {
  // Two decimal places + percent: a curator scanning the table
  // wants the magnitude, not infinite precision. The projection
  // itself stays exact at the wire shape.
  return `${(rate * 100).toFixed(1)}%`;
}
