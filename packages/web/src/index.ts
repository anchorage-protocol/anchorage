// Public surface of @anchorage/web. The package is consumed by
// `packages/server/src/run-prod.ts` (slice 5b integration), which
// constructs an `InProcessReader` (defined in `@anchorage/server`)
// against the live `Server`, passes it to `buildWebHandler`, and
// mounts the resulting handler onto the same `node:http` listener
// as the MCP `/mcp` route. The dependency direction is one-way:
// `@anchorage/web` depends only on `@anchorage/contracts` at
// runtime; the server composes the two.
export { renderContributorPage } from './pages/contributor.js';
export { renderCuratorDeclinePatternsPage } from './pages/curator-decline-patterns.js';
export { renderCuratorIdentityClustersPage } from './pages/curator-identity-clusters.js';
export { renderCuratorIndexPage } from './pages/curator-index.js';
export { renderCuratorQueuePage } from './pages/curator-queue.js';
export { renderHomePage } from './pages/home.js';
export { renderManuscriptPage } from './pages/manuscript.js';
export { renderNodePage } from './pages/node.js';
export { renderSubTopicPage, type SubTopicPageData } from './pages/sub-topic.js';
export type { AnchorageCuratorReader, AnchorageReader } from './reader.js';
export { escapeHtml, html, Raw, raw, renderDocument } from './render.js';
export { baselineStylesheet } from './styles.js';
export {
  buildWebHandler,
  matchContributorRoute,
  matchCuratorDeclinePatternsRoute,
  matchManuscriptRoute,
  matchNodeRoute,
  matchSubTopicRoute,
  type WebHandler,
  type WebHandlerOpts,
} from './web.js';
