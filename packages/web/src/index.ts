// Public surface of @anchorage/web. The package is consumed by
// `packages/server/src/run-prod.ts` (slice 5b integration commit),
// which constructs an `InProcessReader` against the live `Server`
// and mounts the resulting handler onto the same `node:http`
// listener as the MCP `/mcp` route.
export { renderHomePage } from './pages/home.js';
export { renderSubTopicPage, type SubTopicPageData } from './pages/sub-topic.js';
export {
  type AnchorageReader,
  InProcessReader,
  type InProcessReaderOpts,
} from './reader.js';
export { escapeHtml, html, Raw, raw, renderDocument } from './render.js';
export { baselineStylesheet } from './styles.js';
export {
  buildWebHandler,
  matchSubTopicRoute,
  type WebHandler,
  type WebHandlerOpts,
} from './web.js';
