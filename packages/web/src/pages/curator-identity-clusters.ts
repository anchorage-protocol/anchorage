import type { IdentityId } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Curator identity-clusters view (slice 7b). Cross-cause identity-
// pair fingerprints surfacing coordination patterns — the fourth
// of the four sybil-resistance layers PRD §Identity names. Same
// projection `curator_identity_clusters` returns to an agent.
// The curator decides what counts as coordination vs. coincidence
// — the projection is descriptive, not adjudicative.

export interface CuratorIdentityClustersPageData {
  pairs: Array<{
    identity_a: IdentityId;
    identity_b: IdentityId;
    cross_cause_count: number;
    shared_proposal_count: number;
  }>;
}

export function renderCuratorIdentityClustersPage(data: CuratorIdentityClustersPageData): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · <a href="/curator">Curator</a> · Identity clusters
  </div>
  <h1>Identity clusters</h1>
  <p>Identity pairs whose vote co-occurrence <em>across causes</em> suggests coordination. Honest reviewers typically work in one cause (per-cause reputation), so cross-cause pair co-occurrence is the behavioral fingerprint a sybil farm working multiple causes lights up. Specific thresholds and the small-sample floor remain operationally private.</p>
  ${renderClusterTable(data.pairs)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: 'Identity clusters — Anchorage',
    stylesheet: baselineStylesheet,
    body,
  });
}

function renderClusterTable(pairs: CuratorIdentityClustersPageData['pairs']): Raw {
  if (pairs.length === 0) {
    return emptyState(
      'No pairs above the cross-cause signal floor. Either no two identities co-vote across multiple causes yet, or every observed pair sits below the cutoff.',
    );
  }
  return html`<table class="cluster-table">
<thead><tr><th>Identity A</th><th>Identity B</th><th>Causes</th><th>Shared proposals</th></tr></thead>
<tbody>
${pairs.map(
  (p) => html`<tr>
  <td><a href="/contributor/${p.identity_a}">${p.identity_a}</a></td>
  <td><a href="/contributor/${p.identity_b}">${p.identity_b}</a></td>
  <td>${p.cross_cause_count}</td>
  <td>${p.shared_proposal_count}</td>
</tr>`,
)}
</tbody>
</table>`;
}
