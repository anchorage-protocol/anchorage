import { createServer, type Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IdentityId, NodeId, SubTopicId } from '@anchorage/contracts';
import { buildWebHandler } from '@anchorage/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessAuthenticator } from './auth.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { InProcessReader } from './reader.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// Slice 5b — end-to-end coverage of the production composition: the
// in-process `InProcessReader` (this package) feeding
// `buildWebHandler` (from `@anchorage/web`), bound to an ephemeral
// `node:http` socket, exercised through real HTTP requests. Lives
// here, not in `packages/web`, because (a) the integration is what
// `run-prod.ts` actually wires, (b) the workspace dependency graph
// stays one-way at runtime (web → contracts only) so the
// integration test imports the server-runtime symbols where they
// natively live.
//
// What's pinned:
// - Routing surface: home, sub-topic, healthz, unknown route,
//   method-not-allowed, HEAD semantics.
// - Reader-coupling: home page renders cause/sub-topic names from
//   the graph; sub-topic page renders counters / nodes / frontier
//   from the same graph state the MCP resources project.
// - Escape discipline: graph contents containing HTML
//   metacharacters round-trip into the HTML response as escaped
//   text, not as live markup (the only XSS line of defense for
//   server-rendered pages).

function freshServer(): Server {
  return new Server({
    clock: new FakeClock('2026-01-01T00:00:00.000Z', 1000),
    idGen: new SeededIdGen('webint'),
    verifier: new FakeVerifier(),
  });
}

interface Fixture {
  server: Server;
  webUrl: string;
  webServer: NodeHttpServer;
  mrdId: SubTopicId;
  oligoId: SubTopicId;
  aliceId: IdentityId;
  anchorId: NodeId;
  excerptId: NodeId;
}

async function fixture(): Promise<Fixture> {
  const server = freshServer();

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

  // HarnessAuthenticator resolves the web-reader caller end-to-end
  // the way the production runtime will — through the direct
  // identity-id grammar the testbed already exercises. In
  // production, `run-prod.ts` synthesizes the same Caller directly
  // from the env-configured identity id; this end of the
  // composition is what `mcp.test.ts`'s seam suite already pins.
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
    mrdId: mrd.id,
    oligoId: oligo.id,
    aliceId: alice.id,
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
      webServer?.close((err) => (err ? reject(err) : resolve()));
    });
  }
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
    expect(body).toContain('Colon cancer');
    // Cause description is escaped — the `<colon>` text reaches the
    // page as escaped text, not as a live `<colon>` tag.
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
    expect(body).toContain('ctDNA-MRD');
    expect(body).toContain('circulating-tumor DNA');
    expect(body).toContain('ctDNA AND MRD');
    expect(body).toMatch(/<span class="num">2<\/span>\s*<span class="label">Active nodes<\/span>/);
    expect(body).toContain('Reinert 2019');
    expect(body).toContain('Postoperative ctDNA detection');
    expect(body).toContain('Active nodes');
    expect(body).toContain('Frontier');
    expect(body).toContain('<a href="/">Causes</a>');
    // Node ids in the list link to the node-detail page (slice 5c).
    expect(body).toContain(`href="/node/${f.anchorId}"`);
    expect(body).toContain(`href="/node/${f.excerptId}"`);
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

  it('404s on a trailing-slash bare /sub-topic/ (no id segment)', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/sub-topic/`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Page not found');
  });
});

describe('GET /node/:id (slice 5c)', () => {
  it('renders the node-detail page for an anchor with its source ref and content hash', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/node/${f.anchorId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Reinert 2019');
    // Anchor-specific surface.
    expect(body).toContain('Source');
    expect(body).toContain('PMID 12345');
    expect(body).toContain('href="https://pubmed.ncbi.nlm.nih.gov/12345/"');
    expect(body).toContain('Content hash');
    // Provenance — created_by links to the contributor profile.
    expect(body).toContain(`href="/contributor/${f.aliceId}"`);
    // Breadcrumb links back to the home sub-topic.
    expect(body).toContain(`href="/sub-topic/${f.mrdId}"`);
    // Neighbor list links to the excerpt's node page.
    expect(body).toContain(`href="/node/${f.excerptId}"`);
    expect(body).toContain('Neighbors');
  });

  it('renders the node-detail page for an excerpt with its quoted span', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/node/${f.excerptId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Postoperative ctDNA detection');
    expect(body).toContain('Quoted span');
    expect(body).toContain('<blockquote class="excerpt-span">postoperative ctDNA</blockquote>');
    // The reverse edge to the anchor renders too.
    expect(body).toContain(`href="/node/${f.anchorId}"`);
  });

  it('404s on an unknown node id', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/node/nod_does_not_exist`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Not found');
  });
});

describe('GET /contributor/:id (slice 5c)', () => {
  it('renders display fields + tier list, never raw demonstrated/recent', async () => {
    const f = await fixture();
    webServer = f.webServer;
    // Seed a rep entry for alice directly — curator-accepted
    // proposals don't always grant rep through the testbed clock,
    // and we want the tier list populated deterministically. The
    // tier mapping under default 0/0 thresholds collapses any
    // non-negative entry to `contributing`.
    const now = f.server.clock.now();
    const subTopic = f.server.store.subTopics.get(f.mrdId);
    if (!subTopic) throw new Error('mrd sub-topic vanished from store');
    const causeId = subTopic.cause_id;
    f.server.store.reputations.set(`${f.aliceId}|${causeId}|${f.mrdId}`, {
      identity_id: f.aliceId,
      cause_id: causeId,
      sub_topic_id: f.mrdId,
      demonstrated: 1.0,
      recent: 1.0,
      updated_at: now,
    });
    const res = await fetch(`${f.webUrl}/contributor/${f.aliceId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('alice');
    expect(body).toContain(f.aliceId);
    expect(body).toContain('Eligibility tiers');
    expect(body).toContain('actively contributing');
    expect(body).toContain(`href="/sub-topic/${f.mrdId}"`);
    // The page must not surface raw numeric reputation. The wire
    // shape guarantees absence; the page-level check confirms no
    // accidental leakage through formatting.
    expect(body).not.toMatch(/\b1\.0\b/);
    expect(body).not.toMatch(/demonstrated|recent/i);
  });

  it('surfaces a revocation notice when the contributor identity is revoked', async () => {
    const f = await fixture();
    webServer = f.webServer;
    // Revoke a *different* identity than the web-reader caller so
    // the resolveCaller step doesn't trip.
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    f.server.store.identities.set(bob.id, {
      ...f.server.store.identities.get(bob.id)!,
      status: 'revoked',
    });
    const res = await fetch(`${f.webUrl}/contributor/${bob.id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('bob');
    expect(body).toContain("This contributor's identity has been revoked");
    expect(body).toContain('No contribution history yet');
  });

  it('renders the empty-state when the contributor has no rep entries', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const carol = f.server.bootstrap.mintIdentity({ display_name: 'carol' });
    const res = await fetch(`${f.webUrl}/contributor/${carol.id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('carol');
    expect(body).toContain('No contribution history yet');
  });

  it('404s on an unknown contributor id', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/contributor/idn_unknown`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Not found');
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
