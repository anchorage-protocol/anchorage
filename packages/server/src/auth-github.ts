import type { IdentityId } from '@anchorage/contracts';
import { type Authenticator, type Caller, hashBearerSecret, resolveCaller } from './auth.js';
import { ServerError } from './errors.js';
import type { Server } from './server.js';

// `GithubOAuthAuthenticator` is the production-runtime authenticator
// behind the Authenticator seam (PRD §Identity). It is the slice-3c
// concrete that locks GitHub as the v1 IdP per the PRD §Identity
// bullet "specific tech is a Phase 2 implementation choice."
//
// Three responsibilities, in order:
//
//   1. **Token resolution** at the trust boundary
//      (`authenticate(token)`). The token is the opaque bearer
//      secret issued by `completeSignin` at the end of a successful
//      OAuth handshake — same wire-level shape as the secret
//      `bootstrap.bindAgentCredential` issues. Resolved by SHA-256
//      hash against `store.agentCredentialSecrets`, so downstream
//      gates see only a `Caller` and do not branch on which
//      authenticator produced the credential — the sim≡prod
//      invariant in code (CLAUDE.md §Load-bearing design
//      commitments).
//
//   2. **Device-code OAuth flow** for desktop MCP clients
//      (`startSignin` / `completeSignin`). GitHub's device-code
//      flow is the natural fit for MCP clients (Claude Desktop, the
//      Anchorage CLI, custom agents): the user authorizes once in a
//      browser; the client polls for the access token; no client
//      secret needs to live on the user's machine. The
//      authenticator orchestrates the flow against an injected
//      `GithubApi` seam — `GithubApiHttp` for production (real
//      `fetch` against `github.com`), `FakeGithubApi` for tests and
//      the testbed (scripted device codes and user profiles).
//
//   3. **Identity-on-first-signin + attestation mapping**.
//      `completeSignin` resolves the GitHub user id through
//      `store.identityProviderSubjects`; if the (provider, subject)
//      pair is new, a fresh Anchorage identity is minted under it
//      and the attestation_level is computed from the GitHub
//      account signal — 2FA on + verified primary email + account
//      age ≥ `account_age_days_for_level2` (default 30) → level 2,
//      anything weaker → level 1. The mapping is deliberately
//      conservative for v0: GitHub accounts created today carry
//      level 1 even with a verified email; the bar for level 2 is
//      the combined signal a credentialing curator would weigh.
//      Subsequent signins by the same GitHub account reuse the
//      existing identity (one human, one identity per IdP — the
//      bounded-identities-per-real-person invariant), and a fresh
//      agent credential is minted under it so the user can have
//      multiple desktop/agent clients without sharing a token.
//
// The issuance-frequency cap (PRD §Identity bullet 2) lands here on
// `completeSignin` — bucketed per (provider, github_user_id) by
// default — and refuses with `issuance_cap` when the configured
// per-epoch cap is exhausted. The bucket key, the cap, and the
// epoch window are operationally tunable; the *layer* is what
// slice 3c commits to.

// ── GithubApi seam ─────────────────────────────────────────────────

export interface GithubDeviceCode {
  device_code: string;
  user_code: string;
  // URL the user opens in a browser; GitHub returns a static value
  // (`https://github.com/login/device`) but we forward whatever the
  // API gives us so the seam is API-agnostic.
  verification_uri: string;
  // Polling cadence the IdP asks the client to honor (seconds).
  interval_seconds: number;
  // Lifetime of the device_code before the flow expires (seconds).
  expires_in_seconds: number;
}

export type GithubPollStatus =
  | { status: 'pending' }
  | { status: 'slow_down'; interval_seconds: number }
  | { status: 'authorized'; access_token: string }
  | { status: 'expired' }
  | { status: 'denied' };

export interface GithubUser {
  // GitHub's numeric user id (stable across renames). Stringified so
  // the Anchorage `identity_provider_subject` is uniformly string-
  // typed across providers.
  id: string;
  login: string;
  // GitHub exposes 2FA status only when the OAuth scope includes
  // `read:user` and the token belongs to the user themselves.
  // `undefined` means "could not determine" (treated as off for
  // attestation purposes).
  two_factor_authentication?: boolean;
  // ISO-8601 created_at. Used for the account-age threshold in the
  // attestation mapping.
  created_at: string;
}

export interface GithubEmailInfo {
  // Primary email is verified. (`primary_verified` is the only
  // signal the attestation mapping reads; the email value itself is
  // not stored on the Anchorage identity record.)
  primary_verified: boolean;
}

// Minimal seam over the GitHub APIs the authenticator needs. The
// real implementation hits `github.com/login/device/code`,
// `github.com/login/oauth/access_token`, `api.github.com/user`, and
// `api.github.com/user/emails`. The fake implementation (exported
// alongside) drives scripted responses for tests and for the
// testbed's CI-pinned scenarios.
//
// `webAuthorizeUrl` / `exchangeWebCode` are the browser
// authorization-code flow GitHub uses behind the MCP-spec OAuth
// authorization server (`oauth.ts`). Unlike the device flow, the
// web flow's token exchange is client-secret-authenticated — the
// secret lives only in the runtime environment (never on a user
// machine), which is why the web flow is the AS-side bridge and the
// device flow stays the no-secret path for clients that drive it
// directly. Keeping both GitHub-protocol specifics on this seam
// keeps `FakeGithubApi` able to drive the entire web flow in tests
// (sim≡prod: the AS layer never branches on which api backs it).
export interface GithubApi {
  requestDeviceCode(): Promise<GithubDeviceCode>;
  pollDeviceCode(device_code: string): Promise<GithubPollStatus>;
  getUser(access_token: string): Promise<GithubUser>;
  getEmails(access_token: string): Promise<GithubEmailInfo>;
  // Build the GitHub browser-authorization URL the human is sent to
  // (`redirect_uri` is the AS callback; `state` carries the AS
  // session id). Synchronous: it is pure URL construction.
  webAuthorizeUrl(redirect_uri: string, state: string): string;
  // Exchange a GitHub authorization `code` (from the callback) for
  // an access token. The real implementation authenticates with the
  // OAuth App client secret.
  exchangeWebCode(code: string, redirect_uri: string): Promise<{ access_token: string }>;
}

// ── Real (production) GithubApi over fetch ─────────────────────────

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface GithubApiHttpOpts {
  // OAuth App client id (public; appears on every consent screen).
  // Required: a production deployment registers a GitHub OAuth App
  // and passes its client id here.
  client_id: string;
  // OAuth App client secret. Used only by the browser
  // authorization-code flow (`exchangeWebCode`) that backs the
  // MCP-spec authorization server; the device flow never touches
  // it. Lives only in the runtime environment. Optional on the seam
  // so the device-only posture (no web flow) needs no secret; when
  // unset, `exchangeWebCode` refuses rather than calling GitHub with
  // a blank secret.
  client_secret?: string;
  // Fetch implementation. Defaults to `globalThis.fetch`. Tests pass
  // a mock; the production runtime gets the default.
  fetch?: FetchLike;
  // User-Agent for outbound requests. GitHub asks bot traffic to
  // identify itself; sending a stable UA is what their rate-limit
  // ladders read against.
  user_agent?: string;
}

const GITHUB_DEFAULT_USER_AGENT = 'anchorage-protocol/0.1 (+https://anchorage.science)';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_WEB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';
const GITHUB_OAUTH_SCOPES = 'read:user user:email';

export class GithubApiHttp implements GithubApi {
  private readonly fetch: FetchLike;
  private readonly client_id: string;
  private readonly client_secret: string | undefined;
  private readonly user_agent: string;

  constructor(opts: GithubApiHttpOpts) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.client_id = opts.client_id;
    this.client_secret = opts.client_secret;
    this.user_agent = opts.user_agent ?? GITHUB_DEFAULT_USER_AGENT;
  }

  webAuthorizeUrl(redirect_uri: string, state: string): string {
    const u = new URL(GITHUB_WEB_AUTHORIZE_URL);
    u.searchParams.set('client_id', this.client_id);
    u.searchParams.set('redirect_uri', redirect_uri);
    u.searchParams.set('scope', GITHUB_OAUTH_SCOPES);
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeWebCode(code: string, redirect_uri: string): Promise<{ access_token: string }> {
    if (!this.client_secret || this.client_secret.length === 0) {
      // The web flow is unusable without the OAuth App client
      // secret; refuse loudly rather than calling GitHub with a
      // blank secret and getting an opaque 4xx.
      throw new ServerError(
        'invalid_state',
        'github web flow requires a client secret (ANCHORAGE_GITHUB_CLIENT_SECRET)',
      );
    }
    const res = await this.fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.user_agent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.client_id,
        client_secret: this.client_secret,
        code,
        redirect_uri,
      }).toString(),
    });
    if (!res.ok) {
      throw new ServerError('invalid_state', `github token returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      throw new ServerError(
        'unauthorized',
        `github web code exchange failed: ${data.error ?? 'no access_token'}`,
      );
    }
    return { access_token: data.access_token };
  }

  async requestDeviceCode(): Promise<GithubDeviceCode> {
    const res = await this.fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.user_agent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.client_id,
        scope: 'read:user user:email',
      }).toString(),
    });
    if (!res.ok) {
      throw new ServerError('invalid_state', `github device/code returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      interval?: number;
      expires_in?: number;
    };
    if (!data.device_code || !data.user_code || !data.verification_uri) {
      throw new ServerError('invalid_state', 'github device/code response missing fields');
    }
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      interval_seconds: data.interval ?? 5,
      expires_in_seconds: data.expires_in ?? 900,
    };
  }

  async pollDeviceCode(device_code: string): Promise<GithubPollStatus> {
    const res = await this.fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.user_agent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.client_id,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });
    if (!res.ok) {
      throw new ServerError('invalid_state', `github token returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };
    if (data.access_token) {
      return { status: 'authorized', access_token: data.access_token };
    }
    switch (data.error) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down', interval_seconds: data.interval ?? 10 };
      case 'expired_token':
        return { status: 'expired' };
      case 'access_denied':
        return { status: 'denied' };
      default:
        throw new ServerError(
          'invalid_state',
          `github token poll returned unexpected error: ${data.error ?? 'unknown'}`,
        );
    }
  }

  async getUser(access_token: string): Promise<GithubUser> {
    const res = await this.fetch(GITHUB_USER_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${access_token}`,
        'User-Agent': this.user_agent,
      },
    });
    if (!res.ok) {
      throw new ServerError('unauthorized', `github user returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      id?: number | string;
      login?: string;
      two_factor_authentication?: boolean;
      created_at?: string;
    };
    if (data.id === undefined || !data.login || !data.created_at) {
      throw new ServerError('invalid_state', 'github user response missing fields');
    }
    return {
      id: String(data.id),
      login: data.login,
      created_at: data.created_at,
      ...(typeof data.two_factor_authentication === 'boolean'
        ? { two_factor_authentication: data.two_factor_authentication }
        : {}),
    };
  }

  async getEmails(access_token: string): Promise<GithubEmailInfo> {
    const res = await this.fetch(GITHUB_EMAILS_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${access_token}`,
        'User-Agent': this.user_agent,
      },
    });
    if (!res.ok) {
      throw new ServerError('unauthorized', `github emails returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as Array<{
      email?: string;
      primary?: boolean;
      verified?: boolean;
    }>;
    const primary = data.find((e) => e.primary === true);
    return { primary_verified: primary?.verified === true };
  }
}

// ── Fake GithubApi for tests and the testbed ───────────────────────

export interface FakeGithubScenario {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  interval_seconds?: number;
  expires_in_seconds?: number;
  // Sequence of poll responses returned in order; the last entry is
  // sticky (returned for all subsequent polls). Defaults to a
  // single immediate authorization that produces `access_token`.
  poll_responses?: GithubPollStatus[];
  // User profile + email returned when the access_token resolves.
  access_token?: string;
  user?: GithubUser;
  emails?: GithubEmailInfo;
  // Web (browser authorization-code) flow: the authorization `code`
  // GitHub would hand back at the callback. `exchangeWebCode`
  // accepts exactly this value and yields `access_token`.
  web_code?: string;
}

export class FakeGithubApi implements GithubApi {
  private readonly scenario: Required<
    Omit<FakeGithubScenario, 'poll_responses' | 'user' | 'emails'>
  > & {
    poll_responses: GithubPollStatus[];
    user: GithubUser;
    emails: GithubEmailInfo;
  };
  private pollIndex = 0;

  constructor(scenario: FakeGithubScenario = {}) {
    const access_token = scenario.access_token ?? 'fake-access-token';
    this.scenario = {
      device_code: scenario.device_code ?? 'dev_code_test',
      user_code: scenario.user_code ?? 'USER-CODE',
      verification_uri: scenario.verification_uri ?? 'https://github.com/login/device',
      interval_seconds: scenario.interval_seconds ?? 5,
      expires_in_seconds: scenario.expires_in_seconds ?? 900,
      web_code: scenario.web_code ?? 'gh_web_code_test',
      access_token,
      poll_responses: scenario.poll_responses ?? [{ status: 'authorized', access_token }],
      user: scenario.user ?? {
        id: '4242',
        login: 'octocat',
        two_factor_authentication: true,
        created_at: '2020-01-01T00:00:00Z',
      },
      emails: scenario.emails ?? { primary_verified: true },
    };
  }

  async requestDeviceCode(): Promise<GithubDeviceCode> {
    return {
      device_code: this.scenario.device_code,
      user_code: this.scenario.user_code,
      verification_uri: this.scenario.verification_uri,
      interval_seconds: this.scenario.interval_seconds,
      expires_in_seconds: this.scenario.expires_in_seconds,
    };
  }

  async pollDeviceCode(device_code: string): Promise<GithubPollStatus> {
    if (device_code !== this.scenario.device_code) {
      return { status: 'expired' };
    }
    const i = Math.min(this.pollIndex, this.scenario.poll_responses.length - 1);
    this.pollIndex++;
    const response = this.scenario.poll_responses[i];
    if (response === undefined) {
      // Defensive: empty poll_responses arrays would otherwise yield
      // undefined here. Treat as expired so the authenticator's
      // refusal path is consistent.
      return { status: 'expired' };
    }
    return response;
  }

  async getUser(access_token: string): Promise<GithubUser> {
    if (access_token !== this.scenario.access_token) {
      throw new ServerError('unauthorized', 'fake github: unknown access_token');
    }
    return this.scenario.user;
  }

  async getEmails(access_token: string): Promise<GithubEmailInfo> {
    if (access_token !== this.scenario.access_token) {
      throw new ServerError('unauthorized', 'fake github: unknown access_token');
    }
    return this.scenario.emails;
  }

  webAuthorizeUrl(redirect_uri: string, state: string): string {
    const u = new URL('https://github.test/login/oauth/authorize');
    u.searchParams.set('redirect_uri', redirect_uri);
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeWebCode(code: string, _redirect_uri: string): Promise<{ access_token: string }> {
    if (code !== this.scenario.web_code) {
      throw new ServerError('unauthorized', 'fake github: unknown web code');
    }
    return { access_token: this.scenario.access_token };
  }
}

// ── Authenticator ──────────────────────────────────────────────────

export interface GithubOAuthAuthenticatorOpts {
  server: Server;
  githubApi: GithubApi;
  config?: {
    // Account age threshold (days) for attestation level 2. PRD
    // §Identity bullet 1 leaves the IdP free to choose; v0 picks 30
    // days so account-farms minted right before a coordinated push
    // cannot reach level 2 on age alone.
    account_age_days_for_level2?: number;
    // Per-(provider, bucket) issuance cap per epoch. PRD §Identity
    // bullet 2 (issuance-frequency cap). Default Infinity leaves
    // the gate inert — production deployments pick a finite value.
    issuance_cap_per_epoch?: number;
    // Epoch window for issuance accounting, in seconds. Default
    // Infinity is a single never-ending epoch (inert by
    // composition).
    issuance_epoch_seconds?: number;
  };
}

const DEFAULT_ACCOUNT_AGE_DAYS_FOR_LEVEL2 = 30;

// Attestation mapping (PRD §Identity bullet 1). v0 is intentionally
// conservative: level 2 requires *all three* signals — 2FA on,
// verified primary email, account age past the threshold. Anything
// weaker is level 1. Account-only authorization (no verified email,
// no 2FA) is in principle below level 1, but GitHub's device flow
// requires the account to exist and the user to authorize from a
// signed-in session, so we floor at level 1 rather than 0; 0 is
// reserved for the testbed's adversary-budget mints that explicitly
// pay no binding cost.
export function computeGithubAttestationLevel(
  user: GithubUser,
  emails: GithubEmailInfo,
  nowIso: string,
  thresholdDays: number,
): 1 | 2 {
  const twoFactor = user.two_factor_authentication === true;
  const emailVerified = emails.primary_verified === true;
  const createdMs = Date.parse(user.created_at);
  const nowMs = Date.parse(nowIso);
  const ageDays =
    Number.isFinite(createdMs) && Number.isFinite(nowMs) ? (nowMs - createdMs) / 86_400_000 : 0;
  if (twoFactor && emailVerified && ageDays >= thresholdDays) {
    return 2;
  }
  return 1;
}

// Internal state for an in-flight device-code flow. Held in-process
// on the authenticator instance — the lifetime is the device_code's
// expiration window (≤15 minutes by default) and the data is not
// load-bearing across restarts; on server restart the user simply
// retries `startSignin`. Single-instance posture matches the rest
// of the v1 deployment (PRD §What's deliberately not specified
// here, scale-out).
interface DeviceFlowState {
  device_code: string;
  expires_at_ms: number;
  // Once `completeSignin` succeeds, the issued credential's secret
  // is cached here so a retry by the same client returns the same
  // secret instead of minting a duplicate. The cached secret is the
  // plaintext; it is never stored on the Server — and it is retained
  // only for COMPLETED_RETENTION_MS after completion (`completed_at_ms`
  // below): long enough to absorb a dropped network response, short
  // enough that the flow map is not an indefinite plaintext-secret
  // cache any holder of the device_code can replay against.
  completed?: {
    secret: string;
    credential_id: string;
    identity_id: IdentityId;
    completed_at_ms: number;
  };
}

// How long a completed device flow keeps re-returning its secret to
// retries before the entry is dropped. The idempotency window the PRD
// commits ("a client that lost the previous network response gets the
// same (credential_id, secret) back") needs seconds, not process
// lifetime; past it, replaying the device_code returns `expired`.
const COMPLETED_RETENTION_MS = 2 * 60 * 1000;

export interface GithubSigninResult {
  status: 'pending' | 'expired' | 'denied' | 'authorized';
  // Polling cadence hint when status === 'pending'. Forwarded from
  // GitHub's `slow_down` responses so the client backs off the way
  // GitHub asks.
  interval_seconds?: number;
  // Returned exactly once per device_code, when status flips from
  // pending to authorized. Subsequent calls return the cached
  // values (idempotent terminal state) so a client retrying past a
  // dropped network response gets the same credential.
  credential_id?: string;
  identity_id?: IdentityId;
  secret?: string;
  // The GitHub login the identity was bound to, for client-side
  // display ("Signed in as @octocat"). Convenience field; not
  // load-bearing — clients can also derive it from the identity
  // record's `display_name`.
  github_login?: string;
  attestation_level?: 1 | 2;
}

export class GithubOAuthAuthenticator implements Authenticator {
  readonly server: Server;
  readonly api: GithubApi;
  private readonly account_age_days_for_level2: number;
  private readonly issuance_cap_per_epoch: number;
  private readonly issuance_epoch_seconds: number;
  private readonly flows = new Map<string, DeviceFlowState>();

  constructor(opts: GithubOAuthAuthenticatorOpts) {
    this.server = opts.server;
    this.api = opts.githubApi;
    this.account_age_days_for_level2 =
      opts.config?.account_age_days_for_level2 ?? DEFAULT_ACCOUNT_AGE_DAYS_FOR_LEVEL2;
    this.issuance_cap_per_epoch = opts.config?.issuance_cap_per_epoch ?? Number.POSITIVE_INFINITY;
    this.issuance_epoch_seconds = opts.config?.issuance_epoch_seconds ?? Number.POSITIVE_INFINITY;
  }

  // Authenticator surface. Token grammar is the bearer-secret shape
  // — same as `HarnessAuthenticator`'s primary path and the same
  // wire shape every authenticator produces (PRD §Identity,
  // Authenticator seam). No transitional fallback grammars: the
  // production runtime issues exactly one kind of token and
  // refuses everything else with `unauthorized` at the seam.
  authenticate(token: string): Caller {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ServerError('unauthorized', 'missing token');
    }
    const hash = hashBearerSecret(token);
    const credentialId = this.server.store.agentCredentialSecrets.get(hash);
    if (credentialId === undefined) {
      throw new ServerError('unauthorized', 'unknown bearer secret');
    }
    const credential = this.server.store.agentCredentials.get(credentialId);
    if (!credential) {
      throw new ServerError('unauthorized', 'credential record missing for valid secret');
    }
    const caller: Caller = {
      identity_id: credential.identity_id,
      agent_credential_id: credential.id,
    };
    resolveCaller(this.server.store, caller);
    return caller;
  }

  // Step 1 of the device-code flow. Client calls this, shows the
  // returned `user_code` and `verification_uri` to the human, and
  // then polls `completeSignin(device_code)` until the human has
  // authorized in their browser.
  async startSignin(): Promise<GithubDeviceCode> {
    const dc = await this.api.requestDeviceCode();
    const nowMs = Date.parse(this.server.clock.now());
    // Lazy sweep: drop expired flows and completed flows past the
    // retention window, so the map's size tracks live signins rather
    // than process lifetime (abandoned flows previously only fell out
    // when their own device_code was re-polled).
    for (const [k, s] of this.flows) {
      const stale = s.completed
        ? nowMs - s.completed.completed_at_ms > COMPLETED_RETENTION_MS
        : nowMs > s.expires_at_ms;
      if (stale) this.flows.delete(k);
    }
    this.flows.set(dc.device_code, {
      device_code: dc.device_code,
      expires_at_ms: nowMs + dc.expires_in_seconds * 1000,
    });
    return dc;
  }

  // Step 2. Idempotent under repeat polling: pending → authorized
  // is a one-way transition, and once authorized, subsequent calls
  // with the same device_code return the same credential id +
  // secret so a dropped network response doesn't desynchronize the
  // client.
  async completeSignin(device_code: string): Promise<GithubSigninResult> {
    const state = this.flows.get(device_code);
    if (!state) {
      // Unknown device_code — either never minted or expired and
      // garbage-collected. Treat as expired so the client retries
      // `startSignin`.
      return { status: 'expired' };
    }
    if (state.completed) {
      // Idempotent terminal state, bounded: re-return the cached
      // secret so a client that lost the previous response can still
      // pick it up — but only inside the retention window. Past it the
      // entry is dropped (the client has its secret; anyone else
      // replaying the device_code gets nothing).
      const nowMs = Date.parse(this.server.clock.now());
      if (nowMs - state.completed.completed_at_ms > COMPLETED_RETENTION_MS) {
        this.flows.delete(device_code);
        return { status: 'expired' };
      }
      const identity = this.server.store.identities.get(state.completed.identity_id);
      return {
        status: 'authorized',
        credential_id: state.completed.credential_id,
        identity_id: state.completed.identity_id,
        secret: state.completed.secret,
        attestation_level: (identity?.attestation_level === 2 ? 2 : 1) as 1 | 2,
        ...(identity?.display_name ? { github_login: identity.display_name } : {}),
      };
    }
    const nowMs = Date.parse(this.server.clock.now());
    if (nowMs > state.expires_at_ms) {
      this.flows.delete(device_code);
      return { status: 'expired' };
    }
    const poll = await this.api.pollDeviceCode(device_code);
    switch (poll.status) {
      case 'pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'pending', interval_seconds: poll.interval_seconds };
      case 'expired':
        this.flows.delete(device_code);
        return { status: 'expired' };
      case 'denied':
        this.flows.delete(device_code);
        return { status: 'denied' };
      case 'authorized':
        return this.finalizeAuthorization(state, poll.access_token);
    }
  }

  // Browser authorization-code entry point, used by the MCP-spec
  // OAuth authorization server (`oauth.ts`) after it has exchanged
  // the GitHub `code` for an access token via the AS-side bridge.
  // Shares the entire identity-on-first-signin / attestation /
  // issuance-cap / credential-mint tail with the device flow
  // (`mintFromAccessToken`) so the two front doors cannot diverge.
  // There is no in-process flow state here: the AS layer owns the
  // one-time authorization-code record and its idempotency, the way
  // `DeviceFlowState.completed` does for the device flow.
  async completeWebSignin(
    code: string,
    redirect_uri: string,
  ): Promise<{
    secret: string;
    credential_id: string;
    identity_id: IdentityId;
    github_login: string;
    attestation_level: 1 | 2;
  }> {
    const { access_token } = await this.api.exchangeWebCode(code, redirect_uri);
    return this.mintFromAccessToken(access_token);
  }

  private async finalizeAuthorization(
    state: DeviceFlowState,
    access_token: string,
  ): Promise<GithubSigninResult> {
    const minted = await this.mintFromAccessToken(access_token);
    state.completed = {
      secret: minted.secret,
      credential_id: minted.credential_id,
      identity_id: minted.identity_id,
      completed_at_ms: Date.parse(this.server.clock.now()),
    };
    return {
      status: 'authorized',
      credential_id: minted.credential_id,
      identity_id: minted.identity_id,
      secret: minted.secret,
      github_login: minted.github_login,
      attestation_level: minted.attestation_level,
    };
  }

  // The shared post-authorization tail: GitHub access token →
  // profile/email signals → issuance cap → identity-on-first-signin
  // → attestation → fresh agent credential. The returned secret is
  // the bearer token the MCP client presents at the Authenticator
  // seam — same wire-level shape every authenticator produces (PRD
  // §Identity, Agent-credential bearer tokens). Both the device flow
  // and the web flow funnel through here so neither front door can
  // mint an identity the other couldn't.
  private async mintFromAccessToken(access_token: string): Promise<{
    secret: string;
    credential_id: string;
    identity_id: IdentityId;
    github_login: string;
    attestation_level: 1 | 2;
  }> {
    const [user, emails] = await Promise.all([
      this.api.getUser(access_token),
      this.api.getEmails(access_token),
    ]);

    // Issuance-frequency cap (PRD §Identity bullet 2). Bucket key
    // is `github|<github_user_id>` for v0 — per-account
    // throttling. Per-(IP, ASN) bucketing requires request-side
    // metadata that lands at the HTTP transport layer (slice 4)
    // and can compose into the same counter without a schema
    // change. The cap is consumed *before* the identity mint /
    // credential bind so a refused signin burns no graph state.
    this.accountIssuance(`github|${user.id}`);

    const provider = 'github';
    const subject = user.id;
    const subjectKey = `${provider}|${subject}`;
    const existingIdentityId = this.server.store.identityProviderSubjects.get(subjectKey);

    let identityId: IdentityId;
    let attestation: 1 | 2;
    if (existingIdentityId !== undefined) {
      const existing = this.server.store.identities.get(existingIdentityId);
      if (!existing) {
        // Index points at a stale identity — should never happen
        // (`identityProviderSubjects` is only written at mint
        // time and never cleared), but if a future maintenance op
        // breaks this invariant we surface it loudly rather than
        // silently re-minting and forking the identity.
        throw new ServerError(
          'invalid_state',
          `identityProviderSubjects index points at missing identity ${existingIdentityId}`,
        );
      }
      if (existing.status !== 'active') {
        // Revoked identities cannot complete a new signin; the
        // user has to be reinstated curator-side. PRD §Identity
        // bullet "Revocation" — revocation invalidates future
        // participation without rewriting history.
        throw new ServerError('unauthorized', 'identity has been revoked');
      }
      identityId = existing.id;
      attestation = (existing.attestation_level === 2 ? 2 : 1) as 1 | 2;
    } else {
      attestation = computeGithubAttestationLevel(
        user,
        emails,
        this.server.clock.now(),
        this.account_age_days_for_level2,
      );
      const minted = this.server.bootstrap.mintIdentity({
        display_name: user.login,
        attestation_level: attestation,
        identity_provider: provider,
        identity_provider_subject: subject,
      });
      identityId = minted.id;
    }

    // Mint a fresh agent credential under the identity. The
    // returned secret is the bearer token the MCP client presents
    // at the Authenticator seam — same wire-level shape every
    // authenticator produces. PRD §Identity (Agent-credential
    // bearer tokens).
    const { credential, secret } = this.server.bootstrap.bindAgentCredential({
      identity_id: identityId,
      label: `github:${user.login}`,
    });

    const identityRecord = this.server.store.identities.get(identityId);
    return {
      secret,
      credential_id: credential.id,
      identity_id: identityId,
      github_login: user.login,
      attestation_level: identityRecord
        ? ((identityRecord.attestation_level === 2 ? 2 : 1) as 1 | 2)
        : attestation,
    };
  }

  // Issuance-frequency cap accounting (PRD §Identity bullet 2).
  // Same wall-clock-epoch shape as the per-identity rate-limit
  // (Store.rateLimits): lazy advance, single record per bucket,
  // counter resets at epoch boundary. Throws `issuance_cap` when
  // the cap is exhausted for the current epoch.
  private accountIssuance(bucket: string): void {
    if (
      !Number.isFinite(this.issuance_cap_per_epoch) ||
      !Number.isFinite(this.issuance_epoch_seconds)
    ) {
      // Inert configuration (cap = Infinity or epoch = Infinity)
      // — the gate doesn't fire. Counter is still advanced so
      // operators flipping the cap finite later have a baseline.
      // Skipping the write in the inert case avoids a no-value
      // store write per call (issuance is rare; this still
      // matters when the testbed's golden cassettes drive
      // through this path).
      return;
    }
    const nowMs = Date.parse(this.server.clock.now());
    const epoch = Math.floor(nowMs / 1000 / this.issuance_epoch_seconds);
    const existing = this.server.store.idpIssuanceCounters.get(bucket);
    const next =
      existing === undefined || existing.epoch !== epoch
        ? { epoch, count: 1 }
        : { epoch, count: existing.count + 1 };
    if (next.count > this.issuance_cap_per_epoch) {
      throw new ServerError(
        'issuance_cap',
        `issuance-frequency cap exceeded for bucket ${bucket} in epoch ${epoch}`,
      );
    }
    this.server.store.idpIssuanceCounters.set(bucket, next);
  }
}
