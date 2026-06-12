import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CauseId, IdentityId, NodeId, ServerError, SubTopicId } from '@anchorage/contracts';
import { renderContributorPage } from './pages/contributor.js';
import { renderCuratorIdentityClustersPage } from './pages/curator-identity-clusters.js';
import { renderCuratorIndexPage } from './pages/curator-index.js';
import { renderCuratorQueuePage } from './pages/curator-queue.js';
import { renderCuratorUnresolvablePage } from './pages/curator-unresolvable.js';
import { renderHomePage } from './pages/home.js';
import { notFoundBody } from './pages/layout.js';
import { renderManuscriptPage } from './pages/manuscript.js';
import { renderNodePage } from './pages/node.js';
import { renderSubTopicPage } from './pages/sub-topic.js';
import type { AnchorageCuratorReader, AnchorageReader } from './reader.js';
import { renderDocument } from './render.js';
import { baselineStylesheet } from './styles.js';

// `node:http`-shaped web handler. The slice 5b commitment is server-
// rendered HTML over the in-process `AnchorageReader` — no client-
// side framework, no JSON API for the browser to call. The handler
// here is the entirety of the web tier: a request comes in, the
// reader reads, an HTML page goes out.
//
// Routes:
//   GET /                                        → home page (cause list)
//   GET /sub-topic/:id                           → sub-topic page
//   GET /node/:id                                → node-detail page (slice 5c)
//   GET /contributor/:id                         → contributor profile (slice 5c)
//   GET /manuscript/:id                          → manuscript projection (slice 6b)
//   GET /curator                                 → curator console index (slice 7b, gated)
//   GET /curator/queue?cause_id=...              → moderation queue (slice 7b, gated)
//   GET /curator/identity-clusters               → identity-clusters view (slice 7b, gated)
//   GET /curator/unresolvable?cause_id=...       → unresolvable-anchor view (slice 7c, gated)
//   GET /healthz                                 → liveness probe (JSON `{ ok: true }`)
//
// Refusal mapping. A `ServerError` thrown by the reader (e.g. an
// unresolvable sub-topic id, an unauthorized caller — though the
// web service's caller is validated at boot) is caught at the top
// level and rendered as an HTML page (404 for `not_found`,
// 400 for `invalid_input`, 403 for `permission_denied`,
// 500 otherwise) so the browser sees a real page rather than a JSON
// blob. The `/healthz` probe is a JSON endpoint by convention (load
// balancers parse JSON liveness checks more often than HTML);
// everything else stays HTML.
//
// Curator console gating (slice 7b). When `curatorReader` is omitted
// from the build, the `/curator/*` routes return 404 by route
// absence — no curator data crosses the wire on a misconfigured
// deployment. When configured, the route mount-point exists; the
// upstream operator is responsible for restricting which network
// origin reaches `/curator/*` (reverse-proxy ACL, basic auth, VPN,
// etc.). The in-process reader holds a curator-role caller for the
// lifetime of the deployment, and `server.resources.*`'s
// `requireCurator` check re-asserts the role on every call so a
// mid-flight identity revocation (`anchorage-admin revoke-identity`
// or a curator firing `curator_revoke_identity` on themselves)
// surfaces as `permission_denied` → 403 on the next request without
// a restart.

export interface WebHandlerOpts {
  reader: AnchorageReader;
  // Curator-side reader (slice 7b). Optional: omit to leave the
  // `/curator/*` routes unmounted (404 by route absence). When
  // present, mounts the curator console pages, all read-only —
  // actions still run through MCP via the curator's agent.
  curatorReader?: AnchorageCuratorReader;
  // Optional in-band second factor for `/curator/*`. The primary gate
  // stays the operator's reverse-proxy ACL (PRD §Curator console);
  // when this token is set, the console additionally requires HTTP
  // Basic credentials whose password equals the token (any username),
  // so a single proxy-config mistake no longer makes the moderation
  // queue and identity-cluster projections world-readable. Refusals
  // are 401 + `WWW-Authenticate: Basic` so a browser prompts.
  curatorToken?: string;
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
  const curatorReader = opts.curatorReader;
  const curatorToken = opts.curatorToken;
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
        sendHtml(res, 200, renderHomePage(data), method, 'public');
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
        sendHtml(res, 200, renderSubTopicPage({ detail, subgraph, frontier }), method, 'public');
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
        sendHtml(res, 200, renderNodePage(neighborhood), method, 'public');
        return;
      }

      const manuscriptIdRaw = matchManuscriptRoute(pathname);
      if (manuscriptIdRaw !== undefined) {
        const parsed = SubTopicId.safeParse(manuscriptIdRaw);
        if (!parsed.success) {
          sendHtmlNotFound(res, 'Unknown sub-topic', `No manuscript at ${pathname}.`, method);
          return;
        }
        const manuscript = await reader.getManuscript(parsed.data);
        log('web.page.manuscript', { sub_topic_id: parsed.data });
        sendHtml(res, 200, renderManuscriptPage(manuscript), method, 'public');
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
        sendHtml(res, 200, renderContributorPage(profile), method, 'public');
        return;
      }

      // Curator console (slice 7b). The whole `/curator/*` namespace
      // is gated by `curatorReader` being configured — without it
      // the routes 404 by absence, so a deployment that didn't
      // wire a curator identity never leaks curator-side data
      // even by accident. The operator gates network access to
      // /curator/* upstream; the in-process reader holds a curator-
      // role caller for the lifetime of the deployment.
      if (curatorReader !== undefined) {
        // In-band second factor (see `curatorToken`): checked before
        // any curator route dispatch, so no curator data is rendered
        // — not even into a response that upstream caching might
        // retain — without the credential.
        if (
          curatorToken !== undefined &&
          (pathname === '/curator' || pathname.startsWith('/curator/')) &&
          !basicAuthPasswordMatches(req, curatorToken)
        ) {
          sendCuratorAuthRequired(res);
          return;
        }
        if (pathname === '/curator' || pathname === '/curator/') {
          const directory = await reader.getCauseDirectory();
          log('web.page.curator.index', { causes: directory.causes.length });
          sendHtml(res, 200, renderCuratorIndexPage(directory), method);
          return;
        }
        if (pathname === '/curator/queue') {
          const causeIdRaw = url.searchParams.get('cause_id');
          let causeId: CauseId | undefined;
          if (causeIdRaw !== null && causeIdRaw.length > 0) {
            const parsed = CauseId.safeParse(causeIdRaw);
            if (!parsed.success) {
              sendHtmlNotFound(res, 'Unknown cause', `No cause with id ${causeIdRaw}.`, method);
              return;
            }
            causeId = parsed.data;
          }
          const queue = await curatorReader.getCuratorQueue(
            causeId !== undefined ? { cause_id: causeId } : undefined,
          );
          log('web.page.curator.queue', {
            proposal_count: queue.proposals.length,
            cause_id: causeId,
          });
          sendHtml(
            res,
            200,
            renderCuratorQueuePage({
              proposals: queue.proposals,
              ...(causeId !== undefined ? { cause_id: causeId } : {}),
            }),
            method,
          );
          return;
        }
        if (pathname === '/curator/identity-clusters') {
          const clusters = await curatorReader.getCuratorIdentityClusters();
          log('web.page.curator.identity_clusters', { pair_count: clusters.pairs.length });
          sendHtml(res, 200, renderCuratorIdentityClustersPage(clusters), method);
          return;
        }
        if (pathname === '/curator/unresolvable') {
          // Slice 7c part 2 — anchors flagged by the re-verification
          // scheduler. Optional `?cause_id=` filter mirrors the
          // moderation-queue page. The underlying projection sorts
          // most-recent-drift-first server-side; the page reflects
          // whatever subset the reader returned.
          const causeIdRaw = url.searchParams.get('cause_id');
          let causeId: CauseId | undefined;
          if (causeIdRaw !== null && causeIdRaw.length > 0) {
            const parsed = CauseId.safeParse(causeIdRaw);
            if (!parsed.success) {
              sendHtmlNotFound(res, 'Unknown cause', `No cause with id ${causeIdRaw}.`, method);
              return;
            }
            causeId = parsed.data;
          }
          const flagged = await curatorReader.getCuratorUnresolvableAnchors(
            causeId !== undefined ? { cause_id: causeId } : undefined,
          );
          log('web.page.curator.unresolvable', {
            anchor_count: flagged.anchors.length,
            cause_id: causeId,
          });
          sendHtml(
            res,
            200,
            renderCuratorUnresolvablePage({
              anchors: flagged.anchors,
              ...(causeId !== undefined ? { cause_id: causeId } : {}),
            }),
            method,
          );
          return;
        }
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
        if (err.code === 'permission_denied') {
          // Slice 7b — a curator route reached the handler but the
          // underlying reader refused the role check. This means
          // the curator reader was wired with a non-curator-role
          // identity (configuration error) or the curator's role
          // was revoked mid-flight. Both surface as 403 to the
          // browser; the operator sees the stack via onError.
          onError(err, { method, pathname });
          sendHtmlError(res, 403, 'Forbidden', err.message, method);
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

export function matchManuscriptRoute(pathname: string): string | undefined {
  return matchSingleSegmentRoute(pathname, '/manuscript/');
}

function matchSingleSegmentRoute(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return undefined;
  // Malformed percent-encoding (`/node/%zz`) is a client-side bad URL:
  // a non-match → 404, not an uncaught URIError → 500 + operator-error
  // log noise from scanner traffic.
  try {
    return decodeURIComponent(rest);
  } catch {
    return undefined;
  }
}

// Cache posture per response. Public pages take a short shared-cache
// TTL (they recompute full store scans per request; a minute of edge
// caching absorbs anonymous bursts). Curator pages and every error
// page are `no-store` — the curator gating posture is a reverse-proxy
// ACL upstream, and a shared cache between proxy and origin must
// never serve curator HTML to a request the ACL would have blocked.
type CachePolicy = 'public' | 'no-store';

function sendHtml(
  res: ServerResponse,
  status: number,
  body: string,
  method: string,
  cache: CachePolicy = 'no-store',
): void {
  if (res.headersSent || res.writableEnded) return;
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.byteLength,
    'Cache-Control': cache === 'public' ? 'public, max-age=60' : 'no-store',
    ...securityHeaders(),
  });
  if (method === 'HEAD') {
    res.end();
  } else {
    res.end(buf);
  }
}

// Zero-JS site: the CSP refuses scripts, frames, and every fetch
// directive outright (also neutralizing `javascript:` navigation as a
// second layer under refs.ts's scheme allowlist); inline styles are
// the one allowance because the stylesheet ships in a <style> block.
function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
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

// HTTP Basic credential check for the curator console's optional
// in-band second factor. Username is ignored; the password must equal
// the configured token. Comparison is over equal-length buffers via
// timingSafeEqual to keep the check constant-time.
function basicAuthPasswordMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m || m[1] === undefined) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const password = decoded.slice(colon + 1);
  const a = Buffer.from(password, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

function sendCuratorAuthRequired(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded) return;
  const body = 'Authentication required.';
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="anchorage-curator", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...securityHeaders(),
  });
  res.end(body);
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
