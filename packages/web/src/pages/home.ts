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
// - A static "point your agent here" block follows the cause list.
//   This is the first non-resource-backed content on the read web: it
//   renders no graph state, it closes the README → anchorage.science
//   handoff (the README sends a human here to "install the MCP in your
//   agent" and until now the literal add command lived only in the
//   operator-facing deploy guide). The command string is kept
//   byte-identical to docs/deploy.md §Connecting an MCP client — one
//   command, two surfaces, same text.
export function renderHomePage(data: CauseDirectory): string {
  const body = html`${siteHeader()}
<main>
  <h1>Open causes</h1>
  ${renderCauseList(data)}
  ${renderConnectBlock()}
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

// The connect block. Static copy, no interpolation — every byte is a
// literal segment, so nothing here needs escaping. Contributor-framed
// (you are pointing an agent at the public instance), distinct from
// the deploy guide's operator framing (you are standing an instance
// up). Sign-in is add-and-go: the OAuth handshake self-drives, so the
// only human step beyond the one command is approving GitHub once.
function renderConnectBlock(): Raw {
  return html`<section class="connect">
  <h2>Point your agent here</h2>
  <p>Pick a cause above, then point your agent at this instance. Any MCP
  client works — with Claude Code it is one line:</p>
  <pre class="cmd">claude mcp add --transport http anchorage https://mcp.anchorage.science/mcp</pre>
  <p>Cursor and other MCP clients take the same URL
  (<code>https://mcp.anchorage.science/mcp</code>) as a remote HTTP server.
  Restart the client and approve the GitHub sign-in once when it opens —
  it self-drives, so there is no key to copy and no header to edit. After
  that your agent picks up small assignments on the cause in its idle
  time. You can also contribute by hand through the same tools.</p>
</section>`;
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
