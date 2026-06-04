import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeGithubApi, GithubOAuthAuthenticator } from './auth-github.js';
import { FakeClock } from './clock.js';
import { SeededIdGen } from './id-gen.js';
import { OAuthProvider, type OAuthResult } from './oauth.js';
import { Server } from './server.js';
import { FakeVerifier } from './verifier.js';

// MCP-spec OAuth 2.1 AS (PRD §MCP authorization). Coverage pins:
//   1. RFC 9728 / RFC 8414 metadata shapes — PKCE advertisement is
//      load-bearing (clients refuse a server without it).
//   2. RFC 7591 dynamic client registration: redirect-uri policy.
//   3. /authorize validation: client, redirect_uri, PKCE, resource.
//   4. Full bridge register → authorize → github callback → token,
//      and the issued access token authenticates at the same seam
//      every other authenticator uses (sim≡prod invariant).
//   5. Token failure modes: PKCE mismatch, replay, expiry,
//      redirect_uri / resource mismatch, wrong grant.

const BASE = 'https://mcp.anchorage.test';

function setup(clock = new FakeClock('2026-05-14T00:00:00.000Z', 0)) {
  const server = new Server({
    clock,
    idGen: new SeededIdGen('oauth'),
    verifier: new FakeVerifier(),
  });
  const gh = new GithubOAuthAuthenticator({ server, githubApi: new FakeGithubApi() });
  const oauth = new OAuthProvider({ gh, baseUrl: BASE });
  return { server, gh, oauth, clock };
}

// PKCE S256 helper (RFC 7636).
function pkce(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function jsonBody(r: OAuthResult): Record<string, unknown> {
  if (r.kind !== 'json') throw new Error(`expected json result, got ${r.kind}`);
  return r.body as Record<string, unknown>;
}

function registerClient(oauth: OAuthProvider, redirect = 'https://client.test/callback'): string {
  const r = oauth.register({ redirect_uris: [redirect], client_name: 'Test MCP Client' });
  expect(r.status).toBe(201);
  return jsonBody(r)['client_id'] as string;
}

// Drive register → authorize → extract the AS session id GitHub
// would echo back as `state` → callback → returns the 302 to the
// client with the one-time code.
async function authorizeThroughGithub(
  oauth: OAuthProvider,
  clientId: string,
  redirect: string,
  challenge: string,
  resource = `${BASE}/mcp`,
): Promise<{ code: string; state: string | null }> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
    state: 'client-xyz',
  });
  const page = oauth.authorize(q);
  if (page.kind !== 'html') throw new Error(`expected consent html, got ${page.kind}`);
  const ghUrl = /href="([^"]*github\.test[^"]*)"/.exec(page.body)?.[1];
  if (!ghUrl) throw new Error('consent page missing github authorize link');
  const sid = new URL(ghUrl.replace(/&amp;/g, '&')).searchParams.get('state');
  expect(sid).toBeTruthy();
  const cb = await oauth.githubCallback(
    new URLSearchParams({ state: sid as string, code: 'gh_web_code_test' }),
  );
  if (cb.kind !== 'redirect') throw new Error(`expected redirect, got ${cb.kind}`);
  const loc = new URL(cb.location);
  return { code: loc.searchParams.get('code') as string, state: loc.searchParams.get('state') };
}

describe('OAuthProvider — discovery metadata', () => {
  it('serves RFC 9728 protected-resource metadata pointing at the co-hosted AS', () => {
    const { oauth } = setup();
    const m = jsonBody(oauth.protectedResourceMetadata());
    expect(m['resource']).toBe(`${BASE}/mcp`);
    expect(m['authorization_servers']).toEqual([BASE]);
  });

  it('advertises PKCE S256 in RFC 8414 metadata (clients refuse otherwise)', () => {
    const { oauth } = setup();
    const m = jsonBody(oauth.authorizationServerMetadata());
    expect(m['code_challenge_methods_supported']).toEqual(['S256']);
    expect(m['authorization_endpoint']).toBe(`${BASE}/authorize`);
    expect(m['token_endpoint']).toBe(`${BASE}/token`);
    expect(m['registration_endpoint']).toBe(`${BASE}/register`);
    expect(m['token_endpoint_auth_methods_supported']).toEqual(['none']);
  });

  it('emits a WWW-Authenticate value pointing at the resource metadata', () => {
    const { oauth } = setup();
    expect(oauth.wwwAuthenticate()).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
  });
});

describe('OAuthProvider — dynamic client registration', () => {
  it('registers a public client with https or loopback redirect URIs', () => {
    const { oauth } = setup();
    const r = oauth.register({
      redirect_uris: ['https://client.test/cb', 'http://127.0.0.1:33418/cb'],
      client_name: 'Claude Code',
    });
    expect(r.status).toBe(201);
    const b = jsonBody(r);
    expect(typeof b['client_id']).toBe('string');
    expect(b['token_endpoint_auth_method']).toBe('none');
  });

  it('registers a native-app client with a private-use scheme redirect URI', () => {
    // RFC 8252 §7.1: installed apps may use a private-use URI scheme.
    // Cursor registers both a loopback URI and a `cursor://` callback in
    // one batch; the all-or-nothing policy must accept the batch.
    const { oauth } = setup();
    const r = oauth.register({
      redirect_uris: [
        'http://127.0.0.1:54321/callback',
        'cursor://anysphere.cursor-mcp/oauth/callback',
      ],
      client_name: 'Cursor',
    });
    expect(r.status).toBe(201);
    expect(jsonBody(r)['redirect_uris']).toEqual([
      'http://127.0.0.1:54321/callback',
      'cursor://anysphere.cursor-mcp/oauth/callback',
    ]);
  });

  it('rejects missing, non-loopback http, or browser-dangerous redirect URIs', () => {
    const { oauth } = setup();
    expect(oauth.register({}).status).toBe(400);
    expect(oauth.register({ redirect_uris: [] }).status).toBe(400);
    expect(oauth.register({ redirect_uris: ['http://evil.test/cb'] }).status).toBe(400);
    expect(oauth.register({ redirect_uris: ['javascript:alert(1)'] }).status).toBe(400);
    expect(oauth.register({ redirect_uris: ['file:///etc/passwd'] }).status).toBe(400);
    // All-or-nothing: one bad URI rejects the whole batch.
    expect(
      oauth.register({ redirect_uris: ['cursor://app/cb', 'http://evil.test/cb'] }).status,
    ).toBe(400);
  });
});

describe('OAuthProvider — authorize validation', () => {
  const base = (clientId: string) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://client.test/callback',
      code_challenge: pkce('v'.repeat(64)),
      code_challenge_method: 'S256',
      resource: `${BASE}/mcp`,
    });

  it('renders the per-client consent page on a valid request', () => {
    const { oauth } = setup();
    const id = registerClient(oauth);
    const r = oauth.authorize(base(id));
    expect(r.kind).toBe('html');
    if (r.kind === 'html') {
      expect(r.body).toContain('Test MCP Client');
      expect(r.body).toContain('client.test');
      expect(r.body).toContain('github.test/login/oauth/authorize');
    }
  });

  it('rejects unknown client_id', () => {
    const { oauth } = setup();
    const r = oauth.authorize(base('anc_client_nope'));
    expect(jsonBody(r)['error']).toBe('invalid_client');
  });

  it('rejects a redirect_uri that does not match registration', () => {
    const { oauth } = setup();
    const id = registerClient(oauth);
    const q = base(id);
    q.set('redirect_uri', 'https://client.test/evil');
    expect(jsonBody(oauth.authorize(q))['error']).toBe('invalid_request');
  });

  it('requires PKCE S256', () => {
    const { oauth } = setup();
    const id = registerClient(oauth);
    const q = base(id);
    q.delete('code_challenge');
    expect(jsonBody(oauth.authorize(q))['error']).toBe('invalid_request');
    const q2 = base(id);
    q2.set('code_challenge_method', 'plain');
    expect(jsonBody(oauth.authorize(q2))['error']).toBe('invalid_request');
  });

  it('requires the resource to be the canonical MCP URI', () => {
    const { oauth } = setup();
    const id = registerClient(oauth);
    const q = base(id);
    q.set('resource', 'https://elsewhere.test/mcp');
    expect(jsonBody(oauth.authorize(q))['error']).toBe('invalid_target');
    const q2 = base(id);
    q2.delete('resource');
    expect(jsonBody(oauth.authorize(q2))['error']).toBe('invalid_target');
  });

  it('accepts the canonical resource with a trailing slash (RFC 8707 normalization)', () => {
    const { oauth } = setup();
    const id = registerClient(oauth);
    const q = base(id);
    q.set('resource', `${BASE}/mcp/`);
    expect(oauth.authorize(q).kind).toBe('html');
  });
});

describe('OAuthProvider — full bridge and token exchange', () => {
  it('issues an access token that authenticates at the Authenticator seam', async () => {
    const { server, oauth } = setup();
    const redirect = 'https://client.test/callback';
    const verifier = 'verifier-'.repeat(8);
    const id = registerClient(oauth, redirect);
    const { code, state } = await authorizeThroughGithub(oauth, id, redirect, pkce(verifier));
    expect(state).toBe('client-xyz');

    const tok = oauth.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: `${BASE}/mcp`,
    });
    expect(tok.status).toBe(200);
    const accessToken = jsonBody(tok)['access_token'] as string;
    expect(jsonBody(tok)['token_type']).toBe('Bearer');

    // The issued token is the agent-credential bearer secret: it
    // resolves through the same seam every authenticator uses.
    const caller = server.authenticator.authenticate(accessToken);
    expect(caller.identity_id).toBeTruthy();
    expect(caller.agent_credential_id).toBeTruthy();
  });

  it('reuses one identity across two signins by the same GitHub account', async () => {
    const { server, oauth } = setup();
    const redirect = 'https://client.test/callback';
    const id = registerClient(oauth, redirect);
    const v1 = 'a'.repeat(50);
    const t1 = await authorizeThroughGithub(oauth, id, redirect, pkce(v1));
    const tok1 = oauth.token({
      grant_type: 'authorization_code',
      code: t1.code,
      code_verifier: v1,
      redirect_uri: redirect,
      resource: `${BASE}/mcp`,
    });
    const v2 = 'b'.repeat(50);
    const t2 = await authorizeThroughGithub(oauth, id, redirect, pkce(v2));
    const tok2 = oauth.token({
      grant_type: 'authorization_code',
      code: t2.code,
      code_verifier: v2,
      redirect_uri: redirect,
      resource: `${BASE}/mcp`,
    });
    const c1 = server.authenticator.authenticate(jsonBody(tok1)['access_token'] as string);
    const c2 = server.authenticator.authenticate(jsonBody(tok2)['access_token'] as string);
    expect(c1.identity_id).toBe(c2.identity_id);
    // Distinct agent credentials so multiple clients don't share a token.
    expect(c1.agent_credential_id).not.toBe(c2.agent_credential_id);
  });
});

describe('OAuthProvider — token failure modes', () => {
  async function freshCode() {
    const ctx = setup();
    const redirect = 'https://client.test/callback';
    const verifier = 'verifier'.repeat(9);
    const id = registerClient(ctx.oauth, redirect);
    const { code } = await authorizeThroughGithub(ctx.oauth, id, redirect, pkce(verifier));
    return { ...ctx, redirect, verifier, code };
  }

  it('rejects a mismatched PKCE verifier', async () => {
    const { oauth, redirect, code } = await freshCode();
    const r = oauth.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier',
      redirect_uri: redirect,
      resource: `${BASE}/mcp`,
    });
    expect(jsonBody(r)['error']).toBe('invalid_grant');
  });

  it('rejects a replayed authorization code', async () => {
    const { oauth, redirect, verifier, code } = await freshCode();
    const ok = oauth.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: `${BASE}/mcp`,
    });
    expect(ok.status).toBe(200);
    const replay = oauth.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: `${BASE}/mcp`,
    });
    expect(jsonBody(replay)['error']).toBe('invalid_grant');
  });

  it('rejects an expired authorization code', async () => {
    const clock = new FakeClock('2026-05-14T00:00:00.000Z', 0);
    const ctx = setup(clock);
    const redirect = 'https://client.test/callback';
    const verifier = 'x'.repeat(64);
    const id = registerClient(ctx.oauth, redirect);
    const { code } = await authorizeThroughGithub(ctx.oauth, id, redirect, pkce(verifier));
    clock.advance(120_000); // > 60s code TTL
    const r = ctx.oauth.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: `${BASE}/mcp`,
    });
    expect(jsonBody(r)['error']).toBe('invalid_grant');
  });

  it('rejects redirect_uri / resource mismatch and wrong grant_type', async () => {
    const { oauth, redirect, verifier, code } = await freshCode();
    expect(
      jsonBody(
        oauth.token({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: 'https://client.test/other',
          resource: `${BASE}/mcp`,
        }),
      )['error'],
    ).toBe('invalid_grant');
    expect(
      jsonBody(
        oauth.token({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: 'https://elsewhere.test/mcp',
        }),
      )['error'],
    ).toBe('invalid_target');
    expect(
      jsonBody(
        oauth.token({
          grant_type: 'client_credentials',
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: `${BASE}/mcp`,
        }),
      )['error'],
    ).toBe('unsupported_grant_type');
  });
});

describe('OAuthProvider — github callback failure modes', () => {
  it('rejects an unknown authorization session', async () => {
    const { oauth } = setup();
    const r = await oauth.githubCallback(
      new URLSearchParams({ state: 'never-issued', code: 'gh_web_code_test' }),
    );
    expect(jsonBody(r)['error']).toBe('invalid_request');
  });

  it('surfaces a GitHub-side error', async () => {
    const { oauth } = setup();
    const r = await oauth.githubCallback(new URLSearchParams({ error: 'access_denied' }));
    expect(jsonBody(r)['error']).toBe('access_denied');
  });
});
