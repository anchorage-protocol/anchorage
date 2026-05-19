import type { CauseDirectory } from '@anchorage/contracts';
import { html, type Raw, renderDocument } from '../render.js';
import { baselineStylesheet } from '../styles.js';
import { emptyState, siteFooter, siteHeader } from './layout.js';

// Curator console index (slice 7b). The home page of the /curator/*
// namespace — a hub that links into the moderation queue and the
// cross-cause identity-clustering view. PRD §Curator console:
// read-only workspace; the
// curator visits this page, sees what's queued or flagged, and
// directs their agent to fire `curator_*` MCP tools over the wire.
// No action buttons here; the agent-as-delegate framing is what
// makes the console safe to expose with read-only-style auth.

export function renderCuratorIndexPage(directory: CauseDirectory): string {
  const body = html`${siteHeader()}
<main>
  <div class="crumb">
    <a href="/">Causes</a> · Curator console
  </div>
  <h1>Curator console</h1>
  <p>Read-only workspace. Actions (accept, reject, defer, revoke, archive) run through the curator's MCP agent (Claude Desktop, Cursor, custom client) firing the <code>curator_*</code> tools — the console surfaces what's queued or flagged.</p>

  <h2>Moderation queue</h2>
  <p><a href="/curator/queue">All staged proposals (all causes)</a> — the cross-cause backlog, oldest first.</p>
  ${renderPerCauseQueueLinks(directory)}

  <h2>Cross-cause identity clusters</h2>
  <p><a href="/curator/identity-clusters">Identity clusters</a> — pairs of identities whose vote co-occurrence across causes suggests coordination.</p>

  <h2>Unresolvable anchors</h2>
  <p><a href="/curator/unresolvable">Flagged by the re-verification scheduler</a> — anchors whose live source no longer matches the stored content hash (drift), or whose external reference no longer resolves (retraction, host gone). Recovery is via <code>propose_supersedes</code> from a contributor.</p>
  ${renderPerCauseUnresolvableLinks(directory)}
</main>
${siteFooter()}`;
  return renderDocument({
    title: 'Curator console — Anchorage',
    stylesheet: baselineStylesheet,
    body,
  });
}

function renderPerCauseQueueLinks(directory: CauseDirectory): Raw {
  if (directory.causes.length === 0) {
    return emptyState('No active causes — no per-cause filter is available.');
  }
  return html`<ul>
${directory.causes.map(
  (c) => html`<li>
  <a href="/curator/queue?cause_id=${c.cause.id}">${c.cause.name}</a> — staged proposals in this cause only.
</li>`,
)}
</ul>`;
}

function renderPerCauseUnresolvableLinks(directory: CauseDirectory): Raw {
  if (directory.causes.length === 0) return html``;
  return html`<ul>
${directory.causes.map(
  (c) => html`<li>
  <a href="/curator/unresolvable?cause_id=${c.cause.id}">${c.cause.name}</a> — flagged anchors in this cause only.
</li>`,
)}
</ul>`;
}
