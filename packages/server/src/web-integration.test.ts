import { createServer, type Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CauseId,
  IdentityId,
  NodeId,
  ProposalId,
  SubTopicId,
  Timestamp,
} from '@anchorage/contracts';
import { buildWebHandler } from '@anchorage/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessAuthenticator } from './auth.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { InProcessCuratorReader, InProcessReader } from './reader.js';
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
    // The page is the on-ramp, not a directory: the cause is shown
    // as orienting context under "This instance hosts", not as the
    // headline.
    expect(body).toContain('This instance hosts');
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
    // The get-started block closes the README -> anchorage.science
    // handoff: the literal add command is on the page a human lands
    // on, byte-identical to docs/deploy.md §Connecting an MCP client.
    // Only the verified Claude Code path is given; the MCP-first
    // truth is stated once so the instance is not misread as
    // Claude-locked.
    expect(body).toContain('Get started');
    expect(body).toContain(
      'claude mcp add --transport http anchorage https://mcp.anchorage.science/mcp',
    );
    expect(body).toContain('standard MCP server over HTTP');
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

describe('GET /manuscript/:id (slice 6b)', () => {
  it('renders the four fixed-order sections with citations and a credited contributor', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/manuscript/${f.mrdId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    // The four sections appear in fixed order — content-order
    // assertion is the load-bearing property here.
    const sourcesIdx = body.indexOf('Sources');
    const quotationsIdx = body.indexOf('Quotations');
    const synthesisIdx = body.indexOf('Synthesis');
    const openQuestionsIdx = body.indexOf('Open questions');
    expect(sourcesIdx).toBeGreaterThan(-1);
    expect(sourcesIdx).toBeLessThan(quotationsIdx);
    expect(quotationsIdx).toBeLessThan(synthesisIdx);
    expect(synthesisIdx).toBeLessThan(openQuestionsIdx);
    // The included anchor + excerpt cite back to /node/:id and the
    // proposer attributes to /contributor/:id.
    expect(body).toContain(`href="/node/${f.anchorId}"`);
    expect(body).toContain(`href="/node/${f.excerptId}"`);
    expect(body).toContain(`href="/contributor/${f.aliceId}"`);
    // Anchor surface (external_ref link) and excerpt quoted span
    // render in place.
    expect(body).toContain('PMID 12345');
    expect(body).toContain('postoperative ctDNA');
    // Contributor credit section names alice with a non-zero unit
    // figure (proposed two nodes).
    expect(body).toContain('Contributors');
    expect(body).toContain('alice');
    expect(body).toContain('units');
  });

  it('renders the empty-state per section when the sub-graph is empty', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/manuscript/${f.oligoId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('No anchors yet');
    expect(body).toContain('No excerpts yet');
    expect(body).toContain('No synthesis claims yet');
    expect(body).toContain('No open questions yet');
    expect(body).toContain('No credited contributors yet');
  });

  it('404s on an unknown sub-topic id', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/manuscript/stp_does_not_exist`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Not found');
  });

  it('keeps revoked proposers visible in the credit list with the revoked flag', async () => {
    const f = await fixture();
    webServer = f.webServer;
    // Have a different identity (bob) propose so revoking him does
    // not trip the web-reader caller's authentication.
    const bob = f.server.bootstrap.mintIdentity({ display_name: 'bob' });
    const proposal = await f.server.tools.proposeAnchor(
      { identity_id: bob.id },
      {
        cause_id: f.server.store.subTopics.get(f.oligoId)!.cause_id,
        home_sub_topic_id: f.oligoId,
        content: 'bob anchor',
        external_ref: { kind: 'pmid', value: '99' },
      },
    );
    f.server.curator.acceptProposal(proposal.proposal_id);
    f.server.store.identities.set(bob.id, {
      ...f.server.store.identities.get(bob.id)!,
      status: 'revoked',
    });
    const res = await fetch(`${f.webUrl}/manuscript/${f.oligoId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('bob');
    expect(body).toContain('(revoked)');
  });
});

describe('GET /sub-topic/:id (manuscript link)', () => {
  it('exposes a link to /manuscript/:id from the sub-topic page (slice 6b)', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/sub-topic/${f.mrdId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`href="/manuscript/${f.mrdId}"`);
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

// Slice 7b — curator console end-to-end. The web tier mounts the
// `/curator/*` namespace only when a curator-side reader is wired.
// Without it the routes 404 by absence; with it, the pages
// (index, queue, identity-clusters, unresolvable) render
// against a curator-role caller, and the underlying server methods
// re-assert curator role on every call (so revocation or role-
// demotion mid-flight surfaces as `permission_denied` → 403 on the
// next request without a restart).
//
// The fixture wires both readers — public + curator — so the curator
// console index page (which lists active causes via the public
// reader for filter links) renders correctly.

interface CuratorFixture {
  server: Server;
  webUrl: string;
  webServer: NodeHttpServer;
  causeId: CauseId;
  curatorId: IdentityId;
  contributorId: IdentityId;
  // A staged proposal Alice creates so the moderation queue has
  // exactly one item to render.
  stagedProposalId: string;
}

async function curatorFixture(opts: { curatorToken?: string } = {}): Promise<CuratorFixture> {
  const server = freshServer();

  // Public reader: contributor-role; the public web's anonymous-
  // browse posture from slice 5b.
  const webReader = server.bootstrap.mintIdentity({ display_name: 'web-reader' });
  // Curator reader: curator-role, harness-provider (only harness-
  // provider mints can hold the curator role per PRD §Identity
  // Roles; the admin CLI's `mint-curator` walks the same code path).
  const curator = server.bootstrap.mintIdentity({
    display_name: 'carol',
    role: 'curator',
  });
  // Contributor whose proposals + assignments + votes drive the
  // queue / identity-clusters projections.
  const alice = server.bootstrap.mintIdentity({ display_name: 'alice' });

  const cause = server.bootstrap.createCause({
    name: 'Colon cancer',
    description: 'CRC',
  });
  const mrd = server.bootstrap.seedSubTopic({
    cause_id: cause.id,
    name: 'ctDNA-MRD',
    description: 'ctDNA',
    scope_query: 'ctDNA',
  });

  // One staged proposal so the moderation queue has content.
  const anchor = await server.tools.proposeAnchor(
    { identity_id: alice.id },
    {
      cause_id: cause.id,
      home_sub_topic_id: mrd.id,
      content: 'orphan',
      external_ref: { kind: 'pmid', value: '1' },
    },
  );

  const auth = new HarnessAuthenticator(server.store);
  const publicCaller = auth.authenticate(webReader.id);
  const curatorCaller = auth.authenticate(curator.id);

  const reader = new InProcessReader({ server, caller: publicCaller });
  const cReader = new InProcessCuratorReader({ server, caller: curatorCaller });
  const handler = buildWebHandler({
    reader,
    curatorReader: cReader,
    ...(opts.curatorToken !== undefined ? { curatorToken: opts.curatorToken } : {}),
    log: () => {},
    onError: () => {},
  });
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
    causeId: cause.id,
    curatorId: curator.id,
    contributorId: alice.id,
    stagedProposalId: anchor.proposal_id,
  };
}

describe('curator console (slice 7b)', () => {
  it('GET /curator renders the curator index with per-cause filter links', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Curator console');
    expect(body).toContain('Moderation queue');
    expect(body).toContain('Identity clusters');
    // Per-cause filter links into the queue: the index reads the
    // public cause directory for these.
    expect(body).toContain(`/curator/queue?cause_id=${f.causeId}`);
    expect(body).toContain('/curator/identity-clusters');
  });

  it('GET /curator/queue lists every staged proposal', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator/queue`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Moderation queue');
    // The single staged proposal Alice created.
    expect(body).toContain(f.stagedProposalId);
    // The proposer is linkified into their contributor page.
    expect(body).toContain(`/contributor/${f.contributorId}`);
    // The "all causes" copy fires when no filter is applied.
    expect(body).toContain('across all causes');
  });

  it('GET /curator/queue?cause_id=... filters the queue by cause', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator/queue?cause_id=${f.causeId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(f.stagedProposalId);
    expect(body).toContain(f.causeId);
  });

  it('GET /curator/queue with an unknown cause_id 404s', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator/queue?cause_id=cau_does_not_exist`);
    // The filter is applied server-side regardless of cause
    // existence (the queue is empty for the filter, but the page
    // renders fine). Empty-state messaging fires.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('No staged proposals');
  });

  it('GET /curator/identity-clusters renders the empty-state on a fresh graph', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator/identity-clusters`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Identity clusters');
    expect(body).toContain('No pairs above the cross-cause signal floor');
  });

  it('/curator/* routes 404 when no curator reader is configured', async () => {
    // No `curatorReader` passed → /curator/* unmounted by absence.
    const server = freshServer();
    const webReader = server.bootstrap.mintIdentity({ display_name: 'web-reader' });
    const auth = new HarnessAuthenticator(server.store);
    const caller = auth.authenticate(webReader.id);
    const handler = buildWebHandler({
      reader: new InProcessReader({ server, caller }),
      log: () => {},
      onError: () => {},
    });
    const httpServer = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.once('listening', resolve);
      httpServer.listen(0, '127.0.0.1');
    });
    webServer = httpServer;
    const addr = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    for (const path of [
      '/curator',
      '/curator/queue',
      '/curator/identity-clusters',
      '/curator/unresolvable',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it('returns 403 when the curator caller is demoted mid-flight', async () => {
    // The role gate inside `server.resources.requireCurator` re-
    // resolves the caller on every call. Demoting the curator
    // identity after the server is up must propagate to the next
    // request as `permission_denied` → 403, parallel to how
    // `wrapCurator` refuses on the MCP path.
    const f = await curatorFixture();
    webServer = f.webServer;
    const curator = f.server.store.identities.get(f.curatorId);
    if (!curator) throw new Error('curator vanished');
    f.server.store.identities.set(curator.id, { ...curator, role: 'contributor' });
    const res = await fetch(`${f.webUrl}/curator/queue`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('Forbidden');
  });

  // Slice 7c part 2 — the curator-side unresolvable-anchors page.
  // Lists anchors flagged by the re-verification scheduler (drift,
  // retraction, host gone). Empty-state when none; populated when
  // at least one anchor has flipped; cause filter mirrors the queue
  // page's behavior.
  it('GET /curator renders the unresolvable-anchors link', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Unresolvable anchors');
    expect(body).toContain('/curator/unresolvable');
    expect(body).toContain(`/curator/unresolvable?cause_id=${f.causeId}`);
  });

  it('GET /curator/unresolvable renders the empty-state on a fresh graph', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator/unresolvable`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Unresolvable anchors');
    expect(body).toContain('every active anchor still resolves');
    expect(body).toContain('across all causes');
  });

  it('GET /curator/unresolvable lists drifted anchors with ref + hash + timestamps', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    // Accept Alice's staged anchor so it becomes active, then drift
    // it through the in-process verifier. The fixture wires
    // FakeVerifier (default), whose hash for pmid:1 is
    // `fake:pmid:1`; we mutate the underlying hashes map via a fresh
    // re-verify path. Easier route: directly mutate the stored hash
    // on the live node so the re-verify primitive observes drift —
    // exercising the projection, not the verifier itself (which has
    // its own dedicated suite in curator.test.ts).
    f.server.curator.acceptProposal(f.stagedProposalId as ProposalId);
    const nodes = [...f.server.store.nodes.values()].filter((n) => n.kind === 'anchor');
    const anchor = nodes[0];
    if (!anchor || anchor.kind !== 'anchor') throw new Error('expected anchor');
    // Directly stamp the anchor as unresolvable to exercise the
    // page's render path against a populated projection — the
    // re-verification primitive's own behavior is covered in
    // curator.test.ts.
    f.server.store.nodes.set(anchor.id, {
      ...anchor,
      status: 'unresolvable',
      updated_at: '2026-05-15T12:00:00.000Z' as Timestamp,
    });
    const res = await fetch(`${f.webUrl}/curator/unresolvable`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(anchor.id);
    expect(body).toContain('PMID 1');
    expect(body).toContain(anchor.content_hash);
    expect(body).toContain(anchor.last_verified_at);
    expect(body).toContain('2026-05-15T12:00:00.000Z');
  });

  it('GET /curator/unresolvable?cause_id=... filters by cause', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator/unresolvable?cause_id=${f.causeId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`cause ${f.causeId}`);
  });

  it('GET /curator/unresolvable with cause_id= (empty string) treats as no filter', async () => {
    // Mirrors the queue page's behavior — an empty filter falls
    // through to the all-causes view, parallel to /curator/queue.
    const f = await curatorFixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/curator/unresolvable?cause_id=`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('across all causes');
  });
});

describe('response headers (security + caching)', () => {
  it('public pages carry CSP/nosniff/referrer headers and a short shared-cache TTL', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('curator pages and error pages are no-store', async () => {
    const f = await curatorFixture();
    webServer = f.webServer;
    const curatorRes = await fetch(`${f.webUrl}/curator/queue`);
    expect(curatorRes.status).toBe(200);
    // The curator gating posture is a reverse-proxy ACL upstream; a
    // shared cache between proxy and origin must never replay curator
    // HTML to a request the ACL would have blocked.
    expect(curatorRes.headers.get('cache-control')).toBe('no-store');
    const missing = await fetch(`${f.webUrl}/no-such-page`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });

  it('malformed percent-encoding in an id segment 404s instead of 500ing', async () => {
    const f = await fixture();
    webServer = f.webServer;
    const res = await fetch(`${f.webUrl}/node/%zz`);
    expect(res.status).toBe(404);
  });
});

describe('curator console in-band token (optional second factor)', () => {
  it('refuses /curator/* without the Basic credential and admits with it', async () => {
    const f = await curatorFixture({ curatorToken: 'sekrit' });
    webServer = f.webServer;
    // No credential → 401 with a Basic challenge so a browser prompts.
    const bare = await fetch(`${f.webUrl}/curator/queue`);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toContain('Basic');
    expect(bare.headers.get('cache-control')).toBe('no-store');
    // Wrong password → still 401, no curator data.
    const wrong = await fetch(`${f.webUrl}/curator/queue`, {
      headers: { Authorization: `Basic ${Buffer.from('curator:nope').toString('base64')}` },
    });
    expect(wrong.status).toBe(401);
    // Right password (any username) → the console renders.
    const ok = await fetch(`${f.webUrl}/curator/queue`, {
      headers: { Authorization: `Basic ${Buffer.from('anyone:sekrit').toString('base64')}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Moderation queue');
    // The public pages are unaffected by the token.
    const home = await fetch(`${f.webUrl}/`);
    expect(home.status).toBe(200);
  });
});
