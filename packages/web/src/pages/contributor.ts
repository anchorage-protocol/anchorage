import type {
  ContributorProfile,
  PublicReputationEntry,
  PublicReputationTier,
} from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Contributor profile page (slice 5c). The anonymous-browse-safe
// projection of a contributor: display fields + per-(cause,
// sub-topic) eligibility-tier records. The page never shows raw
// `demonstrated`/`recent` numbers — PRD §Reputation commits
// "eligibility tiers public; numeric reputation private" — and
// the `ContributorProfile` wire shape enforces that by carrying
// tier labels only.
//
// Status surfacing: a `revoked` contributor renders normally (their
// graph history is preserved per PRD §Identity Revocation), with a
// clear inline notice so readers can correlate revocation against
// past contributions. Slice 5c does not yet show *which* edges /
// nodes the contributor proposed (that's a graph-walk projection
// that lands alongside the manuscript projection in slice 6).

export function renderContributorPage(data: ContributorProfile): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · Contributor
  </div>
  <h1>${data.contributor.display_name}</h1>
  <p class="node-id">${data.contributor.id}</p>
  ${data.contributor.status === 'revoked' ? revokedNotice() : null}
  <p>Joined ${data.contributor.created_at}.</p>

  <h2>Eligibility tiers</h2>
  ${renderTierTable(data.reputation.entries)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: `${data.contributor.display_name} — Anchorage`,
    stylesheet: baselineStylesheet,
    body,
  });
}

function revokedNotice(): Raw {
  return html`<p class="revoked-notice">This contributor's identity has been revoked. Past contributions remain in the graph; future participation is not authorized.</p>`;
}

function renderTierTable(entries: readonly PublicReputationEntry[]): Raw {
  if (entries.length === 0) {
    return emptyState(
      'No contribution history yet — this contributor has not earned reputation in any (cause, sub-topic) the system has routed them through.',
    );
  }
  return html`<ul class="tier-list">
${entries.map(
  (e) => html`<li>
  <span class="tier-pill tier-${e.tier}">${tierLabel(e.tier)}</span>
  in <a href="/sub-topic/${e.sub_topic_id}">${e.sub_topic_id}</a>
</li>`,
)}
</ul>
<p class="empty">Tiers are derived from per-(cause, sub-topic) reputation against the deployment's eligibility thresholds. The public projection carries the tier only; raw competence numbers stay private to the contributor.</p>`;
}

function tierLabel(tier: PublicReputationTier): string {
  // Human-readable rephrasing of the wire enum. Kept stable so
  // future tier additions (the PRD reserves the right to refine) are
  // a one-spot edit. The label is purely cosmetic — the wire shape
  // is what consumers branch on.
  switch (tier) {
    case 'none':
      return 'not in pool';
    case 'quiet':
      return 'proven, currently dormant';
    case 'contributing':
      return 'actively contributing';
  }
}
