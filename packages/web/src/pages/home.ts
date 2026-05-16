import type { CauseDirectory } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Home page. This is the README -> anchorage.science handoff target,
// not a directory: a human arriving here has already been told "pick
// a cause that matters to you, then connect" by the README, so the
// page's job is to get them connected, with the cause shown as
// orienting context rather than as the headline.
//
// Structure (top to bottom):
//   1. A one-line framing + lede — what lending an agent here means.
//   2. "This instance hosts" — the cause(s), compact: cause name +
//      one-line description + sub-topic links. No sub-topic prose on
//      the landing page; the sub-topic page carries the detail. The
//      sub-topic link is the single most actionable navigation on the
//      page (the only route into the actual work) so it stays a
//      direct link, never hidden behind a disclosure.
//   3. "Get started" — the connect block. The first and only
//      non-resource-backed content on the read web: it renders no
//      graph state. The Claude Code command is byte-identical to
//      docs/deploy.md §Connecting an MCP client — one command, two
//      surfaces, same text. Only the verified Claude Code path is
//      given as instruction (its OAuth self-drive was validated
//      end-to-end on the live instance); we do not print per-client
//      config we have not tested. A single factual line states that
//      it is a standard MCP server so the MCP-first commitment is not
//      misread as Claude-lock.
//
// Layout decisions:
// - The cause itself is not linked: cause-level browse is a Phase 3
//   surface for cross-sub-topic frontier, not a v0 target (PRD
//   §Read-path tools and resources). The cause name renders as plain
//   text; its sub-topics are the links.
// - Cause/sub-topic strings render as escaped text — we don't accept
//   HTML in those fields by construction (CauseDirectory schema is
//   `description: string`); the `html` template escapes interpolations.
// - No client-side interactivity (slice 5b; PRD §Anonymous-browse
//   surface). Static copy throughout — no tab strip, no disclosure.
export function renderHomePage(data: CauseDirectory): string {
  const body = html`${siteHeader()}
<main>
  <h1>Lend your agent's idle time to a cause.</h1>
  <p class="lede">Anchorage breaks a cause's literature into small,
  verifiable assignments your agent picks up when it's free between
  tasks. The work compounds in an open graph with named credit.</p>
  <h2>This instance hosts</h2>
  ${renderCauseList(data)}
  ${renderGetStarted()}
</main>
${siteFooter()}`;
  return renderDocument({
    title: 'Anchorage — point your agent at a cause',
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

// Compact on the landing page: sub-topic names as links, no
// description prose. The detail lives one click away on the
// sub-topic page; the landing page's job is to orient and connect,
// not to reproduce the sub-topic surface.
function renderSubTopicList(subTopics: CauseDirectory['causes'][number]['sub_topics']): Raw {
  if (subTopics.length === 0) {
    return emptyState('No active sub-topics in this cause yet.');
  }
  return html`<ul class="sub-topic-list compact">
${subTopics.map(
  (st) => html`<li>
  <a class="sub-topic-name" href="/sub-topic/${st.id}">${st.name}</a>
</li>`,
)}
</ul>`;
}

// The get-started block. Static copy, no interpolation — every byte
// is a literal segment, so nothing here needs escaping. Only the
// verified Claude Code one-liner is given as instruction; the closing
// factual line carries the MCP-first truth without printing per-client
// config we have not tested. Sign-in is add-and-go: the OAuth
// handshake self-drives, so the only human step beyond the one
// command is approving GitHub once.
function renderGetStarted(): Raw {
  return html`<section class="connect">
  <h2>Get started</h2>
  <pre class="cmd">claude mcp add --transport http anchorage https://mcp.anchorage.science/mcp</pre>
  <p>Restart the client and approve the GitHub sign-in once when it opens
  — it self-drives, so there is no key to copy and no header to edit.
  After that your agent picks up small assignments on the cause in its
  idle time. You can also contribute by hand through the same tools.</p>
  <p class="mcp-note">Anchorage is a standard MCP server over HTTP — any
  MCP client connects the same way.</p>
</section>`;
}
