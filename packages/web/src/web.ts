import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityId, NodeId, ServerError, SubTopicId } from '@anchorage/contracts';
import { renderContributorPage } from './pages/contributor.js';
import { renderHomePage } from './pages/home.js';
import { notFoundBody } from './pages/layout.js';
import { renderNodePage } from './pages/node.js';
import { renderSubTopicPage } from './pages/sub-topic.js';
import type { AnchorageReader } from './reader.js';
import { renderDocument } from './render.js';
import { baselineStylesheet } from './styles.js';

// `node:http`-shaped web handler. The slice 5b commitment is server-
// rendered HTML over the in-process `AnchorageReader` — no client-
// side framework, no JSON API for the browser to call. The handler
// here is the entirety of the web tier: a request comes in, the
// reader reads, an HTML page goes out.
//
// Routes:
//   GET /                  → home page (cause list)
//   GET /sub-topic/:id     → sub-topic page
//   GET /node/:id          → node-detail page (slice 5c)
//   GET /contributor/:id   → contributor profile (slice 5c)
//   GET /healthz           → liveness probe (JSON `{ ok: true }`)
//
// Refusal mapping. A `ServerError` thrown by the reader (e.g. an
// unresolvable sub-topic id, an unauthorized caller — though the
// web service's caller is validated at boot) is caught at the top
// level and rendered as an HTML page (404 for `not_found`,
// 400 for `invalid_input`, 500 otherwise) so the browser sees a
// real page rather than a JSON blob. The `/healthz` probe is a
// JSON endpoint by convention (load balancers parse JSON liveness
// checks more often than HTML); everything else stays HTML.

export interface WebHandlerOpts {
  reader: AnchorageReader;
  // Outbound info log sink. Defaults to `console.log`. Production
  // deployments inject structured-log sinks.
  log?: (message: string, fields?: Record<string, unknown>) => void;
  // Hook for uncaught throws inside the request handler. Defaults
  // to `console.error`. Sibling of the same hook in
  // `packages/server/src/http.ts`.
  onError?: (err: unknown, context: { method: string; pathname: string }) => void;
}

export type WebHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function buildWebHandler(opts: WebHandlerOpts): WebHandler {
  const reader = opts.reader;
  const log = opts.log ?? defaultLog;
  const onError = opts.onError ?? defaultOnError;

  return async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://anchorage.local');
    const pathname = url.pathname;

    try {
      if (pathname === '/healthz') {
        if (method !== 'GET') {
          sendMethodNotAllowed(res, ['GET']);
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendMethodNotAllowed(res, ['GET', 'HEAD']);
        return;
      }

      if (pathname === '/') {
        const data = await reader.getCauseDirectory();
        log('web.page.home', { causes: data.causes.length });
        sendHtml(res, 200, renderHomePage(data), method);
        return;
      }

      const subTopicId = matchSubTopicRoute(pathname);
      if (subTopicId !== undefined) {
        const parsed = SubTopicId.safeParse(subTopicId);
        if (!parsed.success) {
          sendHtmlNotFound(res, 'Unknown sub-topic', `No sub-topic at ${pathname}.`, method);
          return;
        }
        const [detail, subgraph, frontier] = await Promise.all([
          reader.getSubTopicDetail(parsed.data),
          reader.getSubgraph(parsed.data),
          reader.queryFrontier(parsed.data),
        ]);
        log('web.page.sub_topic', { sub_topic_id: parsed.data });
        sendHtml(res, 200, renderSubTopicPage({ detail, subgraph, frontier }), method);
        return;
      }

      const nodeIdRaw = matchNodeRoute(pathname);
      if (nodeIdRaw !== undefined) {
        const parsed = NodeId.safeParse(nodeIdRaw);
        if (!parsed.success) {
          sendHtmlNotFound(res, 'Unknown node', `No node at ${pathname}.`, method);
          return;
        }
        const neighborhood = await reader.getNodeNeighborhood(parsed.data);
        log('web.page.node', { node_id: parsed.data });
        sendHtml(res, 200, renderNodePage(neighborhood), method);
        return;
      }

      const contributorIdRaw = matchContributorRoute(pathname);
      if (contributorIdRaw !== undefined) {
        const parsed = IdentityId.safeParse(contributorIdRaw);
        if (!parsed.success) {
          sendHtmlNotFound(res, 'Unknown contributor', `No contributor at ${pathname}.`, method);
          return;
        }
        const profile = await reader.getContributorProfile(parsed.data);
        log('web.page.contributor', { identity_id: parsed.data });
        sendHtml(res, 200, renderContributorPage(profile), method);
        return;
      }

      sendHtmlNotFound(res, 'Page not found', `No page at ${pathname}.`, method);
    } catch (err) {
      if (err instanceof ServerError) {
        if (err.code === 'not_found') {
          sendHtmlNotFound(res, 'Not found', err.message, method);
          return;
        }
        if (err.code === 'invalid_input') {
          sendHtmlError(res, 400, 'Bad request', err.message, method);
          return;
        }
        // Other typed codes (unauthorized, invalid_state, ...) fall
        // through to 500 — they shouldn't surface on the anonymous
        // read path under correct boot wiring. The handler surfaces
        // the typed message; the operator sees the stack via onError.
        onError(err, { method, pathname });
        sendHtmlError(res, 500, 'Internal error', 'The server encountered an error.', method);
        return;
      }
      onError(err, { method, pathname });
      if (!res.writableEnded) {
        sendHtmlError(res, 500, 'Internal error', 'The server encountered an error.', method);
      }
    }
  };
}

// Path-matching helpers. Each takes a pathname and returns the raw
// id segment (validated by the schema at the call site) or undefined
// when the path doesn't match. Exported for testability of the
// routing surface in isolation from the reader.

export function matchSubTopicRoute(pathname: string): string | undefined {
  return matchSingleSegmentRoute(pathname, '/sub-topic/');
}

export function matchNodeRoute(pathname: string): string | undefined {
  return matchSingleSegmentRoute(pathname, '/node/');
}

export function matchContributorRoute(pathname: string): string | undefined {
  return matchSingleSegmentRoute(pathname, '/contributor/');
}

function matchSingleSegmentRoute(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return undefined;
  return decodeURIComponent(rest);
}

function sendHtml(res: ServerResponse, status: number, body: string, method: string): void {
  if (res.headersSent || res.writableEnded) return;
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.byteLength,
  });
  if (method === 'HEAD') {
    res.end();
  } else {
    res.end(buf);
  }
}

function sendHtmlNotFound(
  res: ServerResponse,
  title: string,
  detail: string,
  method: string,
): void {
  const body = renderDocument({
    title: `${title} — Anchorage`,
    stylesheet: baselineStylesheet,
    body: notFoundBody(title, detail),
  });
  sendHtml(res, 404, body, method);
}

function sendHtmlError(
  res: ServerResponse,
  status: number,
  title: string,
  detail: string,
  method: string,
): void {
  const body = renderDocument({
    title: `${title} — Anchorage`,
    stylesheet: baselineStylesheet,
    body: notFoundBody(title, detail),
  });
  sendHtml(res, status, body, method);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendMethodNotAllowed(res: ServerResponse, allowed: string[]): void {
  if (res.headersSent || res.writableEnded) return;
  const json = JSON.stringify({ error: `method not allowed; expected ${allowed.join(' | ')}` });
  res.writeHead(405, {
    Allow: allowed.join(', '),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function defaultLog(message: string, fields?: Record<string, unknown>): void {
  if (fields && Object.keys(fields).length > 0) {
    console.log(message, fields);
  } else {
    console.log(message);
  }
}

function defaultOnError(err: unknown, ctx: { method: string; pathname: string }): void {
  console.error(`web error ${ctx.method} ${ctx.pathname}:`, err);
}
