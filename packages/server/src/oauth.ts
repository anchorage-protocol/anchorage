import { createHash, randomBytes } from 'node:crypto';
import type { GithubOAuthAuthenticator } from './auth-github.js';

// MCP-spec OAuth 2.1 authorization server, co-hosted with the
// resource server (PRD §MCP authorization). The MCP authorization
// profile makes the MCP server an OAuth 2.1 *resource server*: it
// must publish RFC 9728 protected-resource metadata, answer an
// unauthenticated `/mcp` with `401 + WWW-Authenticate:
// resource_metadata=...`, and point at an authorization server. The
// spec allows the AS to be co-hosted; GitHub itself is *not* a
// spec-compliant MCP AS (no RFC 8414 metadata at a discoverable
// URL, no PKCE discovery, no `resource` parameter), so Anchorage
// hosts its own thin AS and bridges to GitHub's browser
// authorization-code flow behind it.
//
// The access token this AS issues *is* the existing agent-credential
// bearer secret (`GithubOAuthAuthenticator.completeWebSignin` →
// `bindAgentCredential`). Nothing downstream of `/mcp` changes: the
// same `extractBearer` → `authenticator.authenticate` → SHA-256
// lookup runs byte-for-byte as before. The OAuth layer is purely a
// standards-compliant *front door* that produces the same artifact
// the manual device flow produced — so the sim≡prod invariant holds
// (the testbed/HarnessAuthenticator path never constructs this
// object; it is wired only when `githubAuth` is, exactly like the
// `/auth/github/*` device routes).
//
// Audience binding (RFC 8707): the token is an opaque secret, not a
// JWT with an `aud` claim. Audience is satisfied *structurally* — a
// single-resource co-hosted AS that only ever mints tokens usable
// at its own `/mcp`, plus the `resource` parameter validated equal
// to the canonical MCP URI at both `/authorize` and `/token`.
//
// Confused-deputy (spec §Confused Deputy): this AS uses a static
// GitHub client id and forwards to GitHub, so it MUST obtain
// per-client user consent before forwarding. The `/authorize`
// consent interstitial is that consent — it names the requesting
// client and its redirect host before the human is sent to GitHub.
//
// State is in-process (registered clients, pending authorize
// sessions, one-time codes) — same single-instance posture and
// justification as `GithubOAuthAuthenticator.flows` (PRD §What's
// deliberately not specified here, scale-out). Codes are
// seconds-lived; a restart at worst makes an in-flight signin retry.

export type OAuthResult =
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'html'; status: number; body: string }
  | { kind: 'redirect'; status: number; location: string };

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name: string;
}

interface AuthSession {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  client_state: string | undefined;
  resource: string;
  created_ms: number;
}

interface AuthCode {
  secret: string;
  code_challenge: string;
  redirect_uri: string;
  resource: string;
  expires_ms: number;
  used: boolean;
}

export interface OAuthProviderOpts {
  gh: GithubOAuthAuthenticator;
  // Public origin the instance is reached at, e.g.
  // `https://mcp.anchorage.science`. No trailing slash. The OAuth
  // issuer and the canonical resource identifier derive from it; it
  // cannot be reconstructed reliably from request headers behind a
  // reverse proxy, so the runtime supplies it explicitly.
  baseUrl: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 60 * 1000;

export class OAuthProvider {
  private readonly gh: GithubOAuthAuthenticator;
  private readonly baseUrl: string;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly codes = new Map<string, AuthCode>();

  constructor(opts: OAuthProviderOpts) {
    this.gh = opts.gh;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.log = opts.log ?? (() => {});
  }

  // Canonical MCP resource identifier (RFC 8707 / RFC 9728). Spec
  // guidance: no trailing slash.
  private get resource(): string {
    return `${this.baseUrl}/mcp`;
  }

  private get callbackUrl(): string {
    return `${this.baseUrl}/auth/github/callback`;
  }

  // Full `WWW-Authenticate` header value for `/mcp` 401s (RFC 9728
  // §5.1). No `scope` parameter: this AS uses no OAuth scopes (the
  // GitHub scope set is fixed server-side).
  wwwAuthenticate(): string {
    return `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource"`;
  }

  // RFC 9728 protected-resource metadata.
  protectedResourceMetadata(): OAuthResult {
    return {
      kind: 'json',
      status: 200,
      body: {
        resource: this.resource,
        authorization_servers: [this.baseUrl],
        bearer_methods_supported: ['header'],
      },
    };
  }

  // RFC 8414 authorization-server metadata. `code_challenge_methods_
  // supported` is load-bearing: MCP clients MUST refuse a server
  // that does not advertise PKCE.
  authorizationServerMetadata(): OAuthResult {
    return {
      kind: 'json',
      status: 200,
      body: {
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        registration_endpoint: `${this.baseUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    };
  }

  // RFC 7591 dynamic client registration. Public clients only
  // (`token_endpoint_auth_method: none`, PKCE-protected) — there is
  // no client secret to issue. This is the registration mechanism
  // current MCP clients (including Claude Code) drive; Client ID
  // Metadata Documents are a documented future addition.
  register(body: unknown): OAuthResult {
    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const redirectUris = obj['redirect_uris'];
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((u) => typeof u === 'string' && isAllowedRedirectUri(u))
    ) {
      return oauthError(
        400,
        'invalid_redirect_uri',
        'redirect_uris must be a non-empty array of https, loopback, or private-use scheme URIs',
      );
    }
    const clientName =
      typeof obj['client_name'] === 'string' && obj['client_name'].length > 0
        ? (obj['client_name'] as string)
        : 'MCP client';
    const client_id = `anc_client_${randomToken()}`;
    const client: RegisteredClient = {
      client_id,
      redirect_uris: redirectUris as string[],
      client_name: clientName,
    };
    this.clients.set(client_id, client);
    this.log('oauth.register', { client_id, redirect_uris: client.redirect_uris.length });
    return {
      kind: 'json',
      status: 201,
      body: {
        client_id,
        client_name: clientName,
        redirect_uris: client.redirect_uris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    };
  }

  // OAuth 2.1 authorization endpoint. Validates the request, then
  // renders the per-client consent interstitial whose only action
  // links to GitHub's browser authorization (state = AS session id).
  authorize(query: URLSearchParams): OAuthResult {
    this.gc();
    const responseType = query.get('response_type');
    const clientId = query.get('client_id');
    const redirectUri = query.get('redirect_uri');
    const codeChallenge = query.get('code_challenge');
    const codeChallengeMethod = query.get('code_challenge_method');
    const resource = query.get('resource');
    const clientState = query.get('state') ?? undefined;

    if (responseType !== 'code') {
      return oauthError(400, 'unsupported_response_type', 'only response_type=code is supported');
    }
    if (!clientId) {
      return oauthError(400, 'invalid_request', 'client_id is required');
    }
    const client = this.clients.get(clientId);
    if (!client) {
      return oauthError(400, 'invalid_client', 'unknown client_id (register first)');
    }
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      // Pre-redirect-trust failure: do NOT redirect (open-redirect
      // guard) — render the error directly.
      return oauthError(400, 'invalid_request', 'redirect_uri does not match a registered URI');
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return oauthError(
        400,
        'invalid_request',
        'PKCE required: code_challenge with code_challenge_method=S256',
      );
    }
    if (!resource || !this.resourceMatches(resource)) {
      return oauthError(
        400,
        'invalid_target',
        `resource must be the canonical MCP URI (${this.resource})`,
      );
    }

    const sid = randomToken();
    this.sessions.set(sid, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      client_state: clientState,
      resource,
      created_ms: this.nowMs(),
    });
    const githubUrl = this.gh.api.webAuthorizeUrl(this.callbackUrl, sid);
    return {
      kind: 'html',
      status: 200,
      body: consentPage(client.client_name, hostOf(redirectUri), githubUrl),
    };
  }

  // GitHub redirect target. Exchanges the GitHub code via the
  // existing mint tail, issues a one-time Anchorage authorization
  // code bound to the session's PKCE challenge, and 302s back to the
  // MCP client.
  async githubCallback(query: URLSearchParams): Promise<OAuthResult> {
    this.gc();
    const sid = query.get('state');
    const ghCode = query.get('code');
    const ghError = query.get('error');
    if (ghError) {
      return oauthError(400, 'access_denied', `github authorization failed: ${ghError}`);
    }
    if (!sid || !ghCode) {
      return oauthError(400, 'invalid_request', 'missing state or code');
    }
    const session = this.sessions.get(sid);
    if (!session) {
      return oauthError(400, 'invalid_request', 'unknown or expired authorization session');
    }
    this.sessions.delete(sid);

    const minted = await this.gh.completeWebSignin(ghCode, this.callbackUrl);

    const code = randomToken();
    this.codes.set(code, {
      secret: minted.secret,
      code_challenge: session.code_challenge,
      redirect_uri: session.redirect_uri,
      resource: session.resource,
      expires_ms: this.nowMs() + AUTH_CODE_TTL_MS,
      used: false,
    });
    this.log('oauth.authorized', {
      identity_id: minted.identity_id,
      github_login: minted.github_login,
    });

    const loc = new URL(session.redirect_uri);
    loc.searchParams.set('code', code);
    if (session.client_state !== undefined) {
      loc.searchParams.set('state', session.client_state);
    }
    return { kind: 'redirect', status: 302, location: loc.toString() };
  }

  // OAuth 2.1 token endpoint. authorization_code grant only;
  // PKCE-S256 verified; one-time code; redirect_uri + resource
  // re-checked. Returns the agent-credential bearer secret as the
  // access token.
  token(params: Record<string, string>): OAuthResult {
    this.gc();
    if (params['grant_type'] !== 'authorization_code') {
      return oauthError(400, 'unsupported_grant_type', 'only authorization_code is supported');
    }
    const code = params['code'];
    const verifier = params['code_verifier'];
    const redirectUri = params['redirect_uri'];
    const resource = params['resource'];
    if (!code || !verifier || !redirectUri) {
      return oauthError(
        400,
        'invalid_request',
        'code, code_verifier and redirect_uri are required',
      );
    }
    const rec = this.codes.get(code);
    if (!rec || rec.used || this.nowMs() > rec.expires_ms) {
      return oauthError(400, 'invalid_grant', 'authorization code is invalid, used, or expired');
    }
    if (rec.redirect_uri !== redirectUri) {
      return oauthError(400, 'invalid_grant', 'redirect_uri mismatch');
    }
    if (!resource || !this.resourceMatches(resource) || !this.resourceMatches(rec.resource)) {
      return oauthError(400, 'invalid_target', 'resource mismatch');
    }
    if (pkceS256(verifier) !== rec.code_challenge) {
      return oauthError(400, 'invalid_grant', 'PKCE verification failed');
    }
    rec.used = true;
    this.codes.delete(code);
    return {
      kind: 'json',
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: { access_token: rec.secret, token_type: 'Bearer' },
    };
  }

  private resourceMatches(candidate: string): boolean {
    return normalizeResource(candidate) === normalizeResource(this.resource);
  }

  private nowMs(): number {
    return Date.parse(this.gh.server.clock.now());
  }

  // Lazy expiry — same shape as the device-flow garbage collection.
  private gc(): void {
    const now = this.nowMs();
    for (const [k, s] of this.sessions) {
      if (now - s.created_ms > AUTH_SESSION_TTL_MS) this.sessions.delete(k);
    }
    for (const [k, c] of this.codes) {
      if (now > c.expires_ms) this.codes.delete(k);
    }
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// Redirect-URI policy for dynamic client registration. OAuth 2.0 for
// Native Apps (RFC 8252) blesses three redirect shapes, and we accept
// all three: https (claimed domains), http to a loopback address, and
// private-use URI schemes (e.g. `cursor://…`, `vscode://…`,
// `com.example.app:/cb`) for installed apps that cannot host a public
// https endpoint. The security weight is carried by mandatory PKCE plus
// the exact-match + open-redirect guard at /authorize — not by the
// scheme. A short denylist keeps schemes a browser could mishandle in a
// 302 Location out of the registry.
const DANGEROUS_REDIRECT_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:']);

function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  }
  // Private-use URI scheme (native-app callback, RFC 8252 §7.1).
  return !DANGEROUS_REDIRECT_SCHEMES.has(u.protocol);
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

// Normalize for RFC 8707 comparison: lowercase scheme+host, drop a
// single trailing slash. Spec says implementations SHOULD accept
// uppercase scheme/host for robustness.
function normalizeResource(r: string): string {
  try {
    const u = new URL(r);
    const path = u.pathname.replace(/\/$/, '');
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
  } catch {
    return r;
  }
}

function oauthError(status: number, error: string, description: string): OAuthResult {
  return {
    kind: 'json',
    status,
    body: { error, error_description: description },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Per-client consent interstitial (confused-deputy mitigation). No
// JavaScript: the only action is the link to GitHub. The redirect
// host is shown verbatim so a user can spot a mismatched client.
function consentPage(clientName: string, redirectHost: string, githubUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize — Anchorage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5;color:#111}
.box{border:1px solid #ddd;border-radius:8px;padding:1.5rem}
.client{font-weight:600}
.host{font-family:ui-monospace,monospace;background:#f4f4f4;padding:.1rem .35rem;border-radius:4px}
a.btn{display:inline-block;margin-top:1.25rem;background:#1f6feb;color:#fff;text-decoration:none;padding:.6rem 1.1rem;border-radius:6px;font-weight:600}
small{color:#666;display:block;margin-top:1rem}
</style></head>
<body>
<h1>Authorize an MCP client</h1>
<div class="box">
<p><span class="client">${escapeHtml(clientName)}</span> is requesting authorization to act for your
Anchorage identity. After you authorize with GitHub, results will be returned to
<span class="host">${escapeHtml(redirectHost)}</span>.</p>
<p>You will sign in with GitHub. Anchorage uses your GitHub account only to establish
your identity and attestation level; it never gains access to your repositories.</p>
<a class="btn" href="${escapeHtml(githubUrl)}">Authorize with GitHub</a>
<small>If you did not initiate this from an MCP client, close this page.</small>
</div>
</body></html>`;
}
