import { createServer, type Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  FakeClock,
  FakeVerifier,
  HarnessAuthenticator,
  SeededIdGen,
  Server,
} from '@anchorage/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InProcessReader } from './reader.js';
import { escapeHtml, html, raw, renderDocument } from './render.js';
import { buildWebHandler, matchSubTopicRoute } from './web.js';

// Slice 5b — web read-UI end-to-end. The web service runs in-process
// with the MCP server, holding a privileged read-only `Caller`. The
// suite drives the production-shaped wiring: a real `Server`, real
// graph state, a real `InProcessReader`, the `buildWebHandler` route
// table, bound to an ephemeral `node:http` socket so tests fetch real
// HTTP responses.
//
// What's pinned here:
// - Routing surface: home, sub-topic, 404, method-not-allowed, healthz.
// - Reader-coupling: the home page renders cause/sub-topic names from
//   the graph; the sub-topic page renders counters / nodes / frontier
//   from the same graph state the MCP resources project.
// - Escape discipline: graph contents containing HTML metacharacters
//   round-trip into the HTML response as escaped text, not as live
//   markup (the only XSS line of defense for server-rendered pages).
// - HEAD method: same headers as GET, no body — load balancers
//   issue HEADs to check pages, the handler must not 405 them.

function freshServer(): Server {
  return new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('web'),
    verifier: new FakeVerifier(),
  });
}

interface Fixture {
  server: Server;
  webUrl: string;
  webServer: NodeHttpServer;
  crcId: string;
  mrdId: string;
  oligoId: string;
  anchorId: string;
  excerptId: string;
}

async function fixture(): Promise<Fixture> {
  const server = freshServer();

  // Mint two identities: a contributor who creates the graph
  // (alice) and the web reader (web). Both are harness-minted
  // contributor-role identities — the web reader is the slice-5b
  // shape of "service caller for anonymous browse": an active
  // identity in the store, bound to no human, used only for
  // read-path traffic. resolveCaller-side, it's indistinguishable
  // from any other contributor caller.
  const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });
  const webReader = server.bootstrap.mintIdentity({ display_name: 'web-reader' });

  const crc = server.bootstrap.createCause({
    name: 'Colon cancer',
    description: '<colon> cancer — synthesis and replication',
  });
  const mrd = server.bootstrap.seedSubTopic({
    cause_id: crc.id,
    name: 'ctDNA-MRD',
    description: 'circulating-tumor DNA, minimal residual disease',
    scope_query: 'ctDNA AND MRD',
  });
  const oligo = server.bootstrap.seedSubTopic({
    cause_id: crc.id,
    name: 'Oligometastatic CRC',
    description: 'limited-burden metastatic disease, local-treatment evidence',
    scope_query: 'oligometastatic',
  });

  // Seed an anchor + excerpt under mrd so the subgraph projection
  // has content.
  const anchorRes = await server.tools.proposeAnchor(
    { identity_id: alice.id },
    {
      cause_id: crc.id,
      home_sub_topic_id: mrd.id,
      content: 'Reinert 2019 — ctDNA-MRD recurrence prediction',
      external_ref: { kind: 'pmid', value: '12345' },
    },
  );
  const accAnchor = server.curator.acceptProposal(anchorRes.proposal_id);
  const anchorId = accAnchor.node_id;
  if (!anchorId) throw new Error('anchor accept did not return node_id');

  const excerptRes = await server.tools.proposeExcerpt(
    { identity_id: alice.id },
    {
      cause_id: crc.id,
      home_sub_topic_id: mrd.id,
      parent_anchor_id: anchorId,
      content: 'Postoperative ctDNA detection predicts recurrence',
      quoted_span: { text: 'postoperative ctDNA', offset: 0 },
    },
  );
  const accExcerpt = server.curator.acceptProposal(excerptRes.proposal_id);
  const excerptId = accExcerpt.node_id;
  if (!excerptId) throw new Error('excerpt accept did not return node_id');

  // Authenticator validates the web-reader caller end-to-end the
  // way the production runtime will (slice 5b integration commit).
  // We resolve the identity through the seam (HarnessAuthenticator's
  // direct-identity-id grammar) and construct the Caller from the
  // resolved identity.
  const auth = new HarnessAuthenticator(server.store);
  const caller = auth.authenticate(webReader.id);

  const reader = new InProcessReader({ server, caller });
  const handler = buildWebHandler({ reader, log: () => {}, onError: () => {} });
  const httpServer = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.once('listening', resolve);
    httpServer.listen(0, '127.0.0.1');
  });
  const addr = httpServer.address() as AddressInfo;
  return {
    server,
    webUrl: `http://127.0.0.1:${addr.port}`,
    webServer: httpServer,
    crcId: crc.id,
    mrdId: mrd.id,
    oligoId: oligo.id,
    anchorId,
    excerptId,
  };
}

let webServer: NodeHttpServer | undefined;

beforeEach(() => {
  webServer = undefined;
});

afterEach(async () => {
  if (webServer) {
    await new Promise<void>((resolve, reject) => {
      webServer!.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('render primitives', () => {
  it('escapes HTML metacharacters by default', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('"&\'<>')).toBe('&quot;&amp;&#39;&lt;&gt;');
  });

  it('html`` escapes interpolated values but passes Raw through verbatim', () => {
    const safe = html`<p>${'<b>nope</b>'}</p>`;
    expect(safe.value).toBe('<p>&lt;b&gt;nope&lt;/b&gt;</p>');
    const composed = html`<div>${raw('<b>yes</b>')}</div>`;
    expect(composed.value).toBe('<div><b>yes</b></div>');
  });

  it('renderDocument wraps a body in the HTML5 shell with escaped title', () => {
    const out = renderDocument({
      title: 'Title <with> tags',
      stylesheet: raw('body{color:red}'),
      body: html`<p>hi</p>`,
    });
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<title>Title &lt;with&gt; tags</title>');
    expect(out).toContain('<style>body{color:red}</style>');
    expect(out).toContain('<p>hi</p>');
  });
});

describe('matchSubTopicRoute', () => {
  it('returns the id segment for /sub-topic/:id', () => {
    expect(matchSubTopicRoute('/sub-topic/abc')).toBe('abc');
    expect(matchSubTopicRoute('/sub-topic/sub-topic_01HXXXX')).toBe('sub-topic_01HXXXX');
  });
  it('returns undefined for unrelated paths', () => {
    expect(matchSubTopicRoute('/')).toBeUndefined();
    expect(matchSubTopicRoute('/sub-topic')).toBeUndefined();
    expect(matchSubTopicRoute('/sub-topic/')).toBeUndefined();
    expect(matchSubTopicRoute('/sub-topic/abc/extra')).toBeUndefined();
  });
  it('decodes percent-encoded segments', () => {
    expect(matchSubTopicRoute('/sub-topic/abc%20def')).toBe('abc def');
  });
});

describe('GET /healthz', () => {
  it('returns 200 { ok: true } as JSON', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('405s non-GET methods', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/healthz`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('GET /', () => {
  it('renders the home page with the cause list', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('Open causes');
    // Cause name is rendered.
    expect(body).toContain('Colon cancer');
    // Cause description is escaped — the `<colon>` text reaches the
    // page as escaped text, not as a live <colon> tag.
    expect(body).toContain('&lt;colon&gt; cancer');
    expect(body).not.toContain('<colon>');
    // Each active sub-topic links to its page.
    expect(body).toContain(`href="/sub-topic/${f.mrdId}"`);
    expect(body).toContain(`href="/sub-topic/${f.oligoId}"`);
    // The site chrome is present.
    expect(body).toContain('class="brand"');
  });

  it('HEAD / returns headers without a body', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-length')).toBeTruthy();
    expect(await res.text()).toBe('');
  });

  it('renders an empty-state message when no causes are active', async () => {
    // Fresh server, no causes seeded.
    const server = freshServer();
    const webReader = server.bootstrap.mintIdentity({ display_name: 'web-reader' });
    const auth = new HarnessAuthenticator(server.store);
    const caller = auth.authenticate(webReader.id);
    const handler = buildWebHandler({
      reader: new InProcessReader({ server, caller }),
      log: () => {},
      onError: () => {},
    });
    const httpServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/`);
      const body = await res.text();
      expect(body).toContain('No active causes yet');
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe('GET /sub-topic/:id', () => {
  it('renders the sub-topic page with counters, nodes, and frontier', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/sub-topic/${f.mrdId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Title + name + description.
    expect(body).toContain('ctDNA-MRD');
    expect(body).toContain('circulating-tumor DNA');
    // Scope query rendered in mono span.
    expect(body).toContain('ctDNA AND MRD');
    // Counters: at least 2 active nodes (anchor + excerpt), 0
    // staged proposals, 0+ frontier items.
    expect(body).toMatch(/<span class="num">2<\/span>\s*<span class="label">Active nodes<\/span>/);
    // Node list contains the seeded content.
    expect(body).toContain('Reinert 2019');
    expect(body).toContain('Postoperative ctDNA detection');
    // Active-nodes section header.
    expect(body).toContain('Active nodes');
    // Frontier section header.
    expect(body).toContain('Frontier');
    // Breadcrumb back to home.
    expect(body).toContain('<a href="/">Causes</a>');
  });

  it('404s on an unknown sub-topic id', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/sub-topic/sub-topic_unknown`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Not found');
    expect(body).toContain('<a href="/">Back to the home page.</a>');
  });

  it('404s on a malformed sub-topic id', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/sub-topic/`);
    // /sub-topic/ does not match the route — falls through to the
    // generic 404, which is the same shell.
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Page not found');
  });
});

describe('method not allowed', () => {
  it('405s POST / since the web is read-only', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('unknown routes', () => {
  it('404s with a styled HTML shell', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/totally-not-a-page`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('Page not found');
  });
});
