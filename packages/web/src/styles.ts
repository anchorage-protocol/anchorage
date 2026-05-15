import { type Raw, raw } from './render.js';

// Baseline stylesheet for the read-only web. Slice 5b commits to a
// single static CSS string with no preprocessor and no utility
// framework — two pages of read-only content do not need a build
// pipeline. Theme tokens are exposed as CSS custom properties so
// slice 5c can introduce a dark-mode variant or a contributor-view
// accent without rewriting the rules.
//
// The visual register is intentionally restrained: dense
// information, narrow column, generous line-height. The README and
// manifesto tone (substantive, no fake-mature signals) is the style
// reference for the surface this stylesheet renders.
const CSS = `
:root {
  --fg: #1a1a1a;
  --fg-muted: #5a5a5a;
  --bg: #fdfcf8;
  --bg-card: #ffffff;
  --rule: #e6e3da;
  --link: #2a4d8f;
  --link-hover: #18305a;
  --accent: #8c5a2a;
  --mono: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --serif: ui-serif, "Iowan Old Style", "Charter", "Georgia", serif;
  --max-w: 44rem;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--serif);
  font-size: 17px;
  line-height: 1.55;
}

main {
  max-width: var(--max-w);
  margin: 0 auto;
  padding: 2.5rem 1.25rem 6rem;
}

header.site {
  max-width: var(--max-w);
  margin: 0 auto;
  padding: 1.5rem 1.25rem 0.5rem;
  border-bottom: 1px solid var(--rule);
}

header.site .brand {
  font-family: var(--sans);
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--fg);
  text-decoration: none;
}

header.site .tagline {
  display: block;
  color: var(--fg-muted);
  font-family: var(--sans);
  font-size: 0.82rem;
  margin-top: 0.25rem;
}

h1 {
  font-family: var(--sans);
  font-size: 1.6rem;
  line-height: 1.25;
  margin: 1.5rem 0 0.25rem;
}

h2 {
  font-family: var(--sans);
  font-size: 1.05rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  margin: 2.25rem 0 0.5rem;
}

p { margin: 0.5rem 0 1rem; }

a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: var(--link-hover); }

.cause-list, .sub-topic-list, .frontier-list, .node-list { list-style: none; padding: 0; margin: 0; }

.cause-list > li { padding: 1rem 0; border-bottom: 1px solid var(--rule); }
.cause-list > li:last-child { border-bottom: none; }

.cause-name { font-family: var(--sans); font-size: 1.15rem; font-weight: 600; }
.cause-desc { color: var(--fg-muted); margin-top: 0.25rem; }

.sub-topic-list { margin-top: 0.5rem; }
.sub-topic-list > li { padding: 0.5rem 0; }
.sub-topic-name { font-family: var(--sans); font-weight: 500; }
.sub-topic-desc { color: var(--fg-muted); font-size: 0.92rem; }

.counters {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  margin: 1rem 0 1.5rem;
  padding: 0.75rem 1rem;
  background: var(--bg-card);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
.counters > div { display: flex; flex-direction: column; }
.counters .num {
  font-family: var(--sans);
  font-size: 1.4rem;
  font-weight: 600;
  line-height: 1;
}
.counters .label {
  font-family: var(--sans);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  margin-top: 0.2rem;
}

.scope-query {
  font-family: var(--mono);
  font-size: 0.88rem;
  background: var(--bg-card);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 0.4rem 0.6rem;
  display: inline-block;
}

.node-list > li, .frontier-list > li {
  padding: 0.5rem 0;
  border-bottom: 1px dashed var(--rule);
}
.node-list > li:last-child, .frontier-list > li:last-child { border-bottom: none; }

.node-kind, .frontier-kind {
  font-family: var(--mono);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent);
  margin-right: 0.4rem;
}
.node-content {
  display: block;
  margin-top: 0.15rem;
  color: var(--fg);
  font-family: var(--serif);
}
.node-id, .frontier-id {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--fg-muted);
}

.empty {
  color: var(--fg-muted);
  font-style: italic;
}

.crumb {
  font-family: var(--sans);
  font-size: 0.85rem;
  color: var(--fg-muted);
  margin-bottom: 0.25rem;
}

.crumb a { color: var(--fg-muted); }

footer.site {
  max-width: var(--max-w);
  margin: 0 auto;
  padding: 1.5rem 1.25rem;
  border-top: 1px solid var(--rule);
  font-family: var(--sans);
  font-size: 0.8rem;
  color: var(--fg-muted);
}
footer.site a { color: var(--fg-muted); }

/* Slice 5c — node-detail + contributor page chrome */
.provenance, .anchor-source, .edge-list, .tier-list { list-style: none; padding: 0; margin: 0; }
.provenance > li, .anchor-source > li, .edge-list > li, .tier-list > li {
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--rule);
}
.provenance > li:last-child, .anchor-source > li:last-child, .edge-list > li:last-child, .tier-list > li:last-child { border-bottom: none; }

.excerpt-span {
  font-family: var(--serif);
  font-style: italic;
  border-left: 3px solid var(--accent);
  padding: 0.25rem 0 0.25rem 0.75rem;
  margin: 0.5rem 0;
  color: var(--fg);
}

.edge-kind { color: var(--accent); }
.edge-arrow { color: var(--fg-muted); margin: 0 0.25rem; font-family: var(--mono); }

.tier-pill {
  display: inline-block;
  font-family: var(--sans);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--rule);
  background: var(--bg-card);
  color: var(--fg-muted);
  margin-right: 0.4rem;
}
.tier-contributing { color: var(--link); border-color: var(--link); }
.tier-quiet { color: var(--accent); border-color: var(--accent); }
.tier-none { color: var(--fg-muted); }

.revoked-notice {
  background: var(--bg-card);
  border-left: 3px solid var(--accent);
  padding: 0.5rem 0.75rem;
  font-family: var(--sans);
  font-size: 0.9rem;
  color: var(--fg-muted);
}
`;

export const baselineStylesheet: Raw = raw(CSS);
