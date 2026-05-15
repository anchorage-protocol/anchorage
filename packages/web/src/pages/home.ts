import type { CauseDirectory } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Home page: the cause list off `cause://`. Each cause shows its
// name, description, and the active sub-topics beneath it (linked
// to their sub-topic pages). Archived causes are excluded by the
// resource itself; the page surfaces what the home view sees.
//
// Layout decisions:
// - Two-line per-cause card: name + description, then a nested
//   sub-topic list. The cause itself is not linked because cause-level
//   browse is a Phase 3 surface for cross-sub-topic frontier, not a v0
//   target (PRD §Read-path tools and resources). The cause name
//   therefore renders as plain text.
// - The cause description renders as plain text — the seed cause has
//   prose, but we don't accept HTML in cause fields by construction
//   (CauseDirectory's schema is `description: string`).
export function renderHomePage(data: CauseDirectory): string {
  const body = html`${siteHeader()}
<main>
  <h1>Open causes</h1>
  ${renderCauseList(data)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: 'Anchorage — open causes',
    stylesheet: baselineStylesheet,
    body,
  });
}

function renderCauseList(data: CauseDirectory): Raw {
  if (data.causes.length === 0) {
    return emptyState('No active causes yet. Anchorage is still seating its first cause.');
  }
  return html`<ul class="cause-list">
${data.causes.map(
  (entry) => html`<li>
  <div class="cause-name">${entry.cause.name}</div>
  <div class="cause-desc">${entry.cause.description}</div>
  ${renderSubTopicList(entry.sub_topics)}
</li>`,
)}
</ul>`;
}

function renderSubTopicList(subTopics: CauseDirectory['causes'][number]['sub_topics']): Raw {
  if (subTopics.length === 0) {
    return emptyState('No active sub-topics in this cause yet.');
  }
  return html`<ul class="sub-topic-list">
${subTopics.map(
  (st) => html`<li>
  <a class="sub-topic-name" href="/sub-topic/${st.id}">${st.name}</a>
  <div class="sub-topic-desc">${st.description}</div>
</li>`,
)}
</ul>`;
}
