import type { IdentityId } from '@anchorage/contracts';
import { buildWebHandler } from '@anchorage/web';
import type { Caller } from './auth.js';
import { type GithubApi, GithubApiHttp, GithubOAuthAuthenticator } from './auth-github.js';
import { ServerError } from './errors.js';
import { type AnchorageHttpServer, startHttpServer } from './http.js';
import { LiveFetchVerifier } from './live-fetch-verifier.js';
import { OAuthProvider } from './oauth.js';
import { InProcessCuratorReader, InProcessReader } from './reader.js';
import { Server } from './server.js';
import { SqliteStore } from './sqlite-store.js';
import type { Verifier } from './verifier.js';

// Slice 4c — production runtime entrypoint. Wires the persistence
// layer (SqliteStore against a configurable on-disk path), the live
// verifier (NCBI E-utilities + Crossref), the production
// authenticator (GithubOAuthAuthenticator over GithubApiHttp against
// a registered GitHub OAuth App), and the HTTP transport (slice 4a)
// into a single bootable process. This is the slice where
// `mcp.anchorage.science` actually answers traffic.
//
// The wiring is intentionally thin — every component it composes is
// individually tested, and the entry point's responsibility is
// turning the operator's environment into a running server, not
// re-implementing anything. Two pieces have explicit injection
// seams (`verifier`, `githubApi`) so an end-to-end smoke test can
// drive the production wiring against deterministic fakes without
// hitting NCBI / Crossref / GitHub.

export interface ProdConfig {
  // SQLite database path. The single source of truth for graph
  // state — must be a sticky disk in production (see
  // `docs/deploy.md`).
  db_path: string;
  // Address to bind. Production deployments use `0.0.0.0` behind a
  // TLS-terminating edge; loopback `127.0.0.1` is the safer default
  // for local boots and `pnpm prod` smoke tests.
  host: string;
  // Port to bind. Production: behind the edge, anything works (the
  // docs default to 8080); the Dockerfile wires `EXPOSE 8080`.
  port: number;
  // GitHub OAuth configuration. Optional: a deployment that
  // intentionally omits the IdP (testbed-shaped runs, local boots
  // for development) sets `ANCHORAGE_GITHUB_CLIENT_ID` empty and the
  // `/auth/github/*` HTTP routes 404. PRD §Identity (Authenticator
  // seam) — `Server` falls back to its default `HarnessAuthenticator`
  // in that posture, which is the testbed wiring; valid only because
  // the testbed is the only client of the harness path.
  github?: GithubConfig;
  // Public origin the instance is reached at, e.g.
  // `https://mcp.anchorage.science` (no trailing slash). Required
  // whenever `github` is set: the MCP-spec OAuth authorization
  // server derives its issuer and the canonical resource identifier
  // from it, and it cannot be reconstructed reliably from request
  // headers behind a reverse proxy / TLS-terminating edge. Unset in
  // the harness/testbed posture (no `github`, no OAuth surface).
  public_base_url?: string;
  // Slice 5b — web tier wiring. The identity id of an active,
  // operator-minted reader identity (`anchorage-admin mint-reader`),
  // used by the in-process web handler as the privileged read-only
  // caller for anonymous browse traffic. When omitted, the web
  // routes (`/`, `/sub-topic/*`) are not mounted and the HTTP
  // surface stays MCP-only — the testbed-only and local-only
  // postures land on that branch.
  web_reader_identity_id?: IdentityId;
  // Slice 7b — curator-console wiring. The identity id of an active
  // curator-role identity (`anchorage-admin mint-curator`) the
  // web handler holds as the privileged caller for the
  // `/curator/*` routes. When omitted, those routes are not
  // mounted (404 by absence) — the public anonymous-browse
  // posture stays as 5b's. The operator gates network access to
  // `/curator/*` upstream (reverse-proxy ACL, basic auth, VPN);
  // the in-process role check inside `server.resources.*` re-
  // asserts curator role on every call so a mid-flight revocation
  // (or a misconfigured non-curator id) refuses with
  // `permission_denied` → 403 without a restart. Setting this
  // without `web_reader_identity_id` is a configuration error and
  // refuses at boot — the curator console depends on the public
  // reader for cause-list rendering (the curator index page lists
  // causes for filter links), so the public tier must also be up.
  web_curator_identity_id?: IdentityId;
  // Optional in-band second factor for `/curator/*`
  // (`ANCHORAGE_WEB_CURATOR_TOKEN`). The primary gate stays the
  // reverse-proxy ACL; when set, the console additionally requires
  // HTTP Basic credentials whose password equals this token, so one
  // proxy-config mistake no longer exposes the moderation queue and
  // identity-cluster projections. Only meaningful alongside
  // `web_curator_identity_id`; setting it without the console wired
  // refuses at boot (a token guarding unmounted routes is a config
  // error worth surfacing).
  web_curator_token?: string;
  // Slice 7c part 2 — periodic re-verification scheduler. Three
  // env knobs configure the production tick that drives
  // `server.curator.reverifyDueAnchors` against the live verifier:
  //   - `reverify_interval_ms` is the period between ticks. Setting
  //     this is the opt-in; the other two are required when it is
  //     set, refused at boot when only one is set (no silent default
  //     for a load-bearing-against-NCBI cadence — operator picks).
  //   - `reverify_max_age_ms` is the freshness threshold passed
  //     through to `reverifyDueAnchors`: anchors whose
  //     `last_verified_at` predates `now - max_age_ms` are eligible.
  //   - `reverify_batch_size` caps the per-tick fetch count so a
  //     large backlog (e.g. first tick after a long quiet window)
  //     does not turn into a sudden burst against the upstream
  //     verifier. Backlogs drain across subsequent ticks.
  // When `reverify_interval_ms` is unset, the scheduler is off and
  // the re-verification primitive remains available on-demand via
  // `curator_reverify_anchors` (operators can drive it manually).
  reverify_interval_ms?: number;
  reverify_max_age_ms?: number;
  reverify_batch_size?: number;
}

export interface GithubConfig {
  client_id: string;
  // OAuth App client secret. Required whenever the GitHub IdP is
  // wired: the MCP-spec OAuth authorization server (PRD §Identity,
  // MCP-spec OAuth) bridges to GitHub's browser authorization-code
  // flow, whose token exchange is client-secret-authenticated. The
  // secret lives only here in the runtime environment. See
  // docs/deploy.md for why this replaced the device-flow no-secret
  // posture.
  client_secret: string;
  // PRD §Identity bullet 2 (issuance-frequency cap). Defaults to
  // `Infinity` at the authenticator (gate inert); production
  // deployments pick finite values. `0` here means "use the
  // authenticator default" — i.e. don't pass the knob at all. Any
  // positive integer overrides.
  issuance_cap_per_epoch?: number;
  issuance_epoch_seconds?: number;
  // PRD §Identity bullet 1 (binding cost). The threshold the
  // attestation mapping uses for level 2; default 30 days at the
  // authenticator. Production deployments can tune.
  account_age_days_for_level2?: number;
}

// Env → ProdConfig. Pure function so tests can pin every refusal
// and default branch directly. Production deployments pass
// `process.env`; the entrypoint at the bottom does that.
export function parseProdConfig(env: NodeJS.ProcessEnv): ProdConfig {
  const db_path = env['ANCHORAGE_DB_PATH'];
  if (!db_path || db_path.length === 0) {
    throw new ServerError('invalid_input', 'ANCHORAGE_DB_PATH is required');
  }
  const host = env['ANCHORAGE_HOST'] ?? '127.0.0.1';
  const port = parsePort(env['ANCHORAGE_PORT'] ?? '8080');

  const client_id = env['ANCHORAGE_GITHUB_CLIENT_ID'];
  let github: GithubConfig | undefined;
  let public_base_url: string | undefined;
  if (client_id && client_id.length > 0) {
    const client_secret = env['ANCHORAGE_GITHUB_CLIENT_SECRET'];
    if (!client_secret || client_secret.length === 0) {
      throw new ServerError(
        'invalid_input',
        "ANCHORAGE_GITHUB_CLIENT_SECRET is required when ANCHORAGE_GITHUB_CLIENT_ID is set (the MCP-spec OAuth server bridges GitHub's client-secret-authenticated web flow; see docs/deploy.md)",
      );
    }
    const base_raw = env['ANCHORAGE_PUBLIC_BASE_URL'];
    if (!base_raw || base_raw.length === 0) {
      throw new ServerError(
        'invalid_input',
        'ANCHORAGE_PUBLIC_BASE_URL is required when ANCHORAGE_GITHUB_CLIENT_ID is set (OAuth issuer / canonical resource URI; cannot be derived behind a proxy)',
      );
    }
    let parsedBase: URL;
    try {
      parsedBase = new URL(base_raw);
    } catch {
      throw new ServerError(
        'invalid_input',
        `ANCHORAGE_PUBLIC_BASE_URL must be an absolute URL; got '${base_raw}'`,
      );
    }
    if (
      parsedBase.protocol !== 'https:' &&
      parsedBase.hostname !== 'localhost' &&
      parsedBase.hostname !== '127.0.0.1'
    ) {
      throw new ServerError(
        'invalid_input',
        `ANCHORAGE_PUBLIC_BASE_URL must be https (or http loopback for local boots); got '${base_raw}'`,
      );
    }
    public_base_url = base_raw.replace(/\/+$/, '');
    github = { client_id, client_secret };
    const cap = parseOptionalPositiveInt(
      env['ANCHORAGE_ISSUANCE_CAP_PER_EPOCH'],
      'ANCHORAGE_ISSUANCE_CAP_PER_EPOCH',
    );
    if (cap !== undefined) github.issuance_cap_per_epoch = cap;
    const epoch = parseOptionalPositiveInt(
      env['ANCHORAGE_ISSUANCE_EPOCH_SECONDS'],
      'ANCHORAGE_ISSUANCE_EPOCH_SECONDS',
    );
    if (epoch !== undefined) github.issuance_epoch_seconds = epoch;
    const ageDays = parseOptionalPositiveInt(
      env['ANCHORAGE_ATTESTATION_AGE_DAYS_FOR_LEVEL2'],
      'ANCHORAGE_ATTESTATION_AGE_DAYS_FOR_LEVEL2',
    );
    if (ageDays !== undefined) github.account_age_days_for_level2 = ageDays;
  }

  const web_reader_identity_id_raw = env['ANCHORAGE_WEB_READER_IDENTITY'];
  const web_reader_identity_id =
    web_reader_identity_id_raw && web_reader_identity_id_raw.length > 0
      ? (web_reader_identity_id_raw as IdentityId)
      : undefined;

  const web_curator_identity_id_raw = env['ANCHORAGE_WEB_CURATOR_IDENTITY'];
  const web_curator_identity_id =
    web_curator_identity_id_raw && web_curator_identity_id_raw.length > 0
      ? (web_curator_identity_id_raw as IdentityId)
      : undefined;
  if (web_curator_identity_id !== undefined && web_reader_identity_id === undefined) {
    throw new ServerError(
      'invalid_input',
      'ANCHORAGE_WEB_CURATOR_IDENTITY requires ANCHORAGE_WEB_READER_IDENTITY (curator console depends on the public reader for cause-list rendering)',
    );
  }

  const web_curator_token_raw = env['ANCHORAGE_WEB_CURATOR_TOKEN'];
  const web_curator_token =
    web_curator_token_raw && web_curator_token_raw.length > 0 ? web_curator_token_raw : undefined;
  if (web_curator_token !== undefined && web_curator_identity_id === undefined) {
    throw new ServerError(
      'invalid_input',
      'ANCHORAGE_WEB_CURATOR_TOKEN requires ANCHORAGE_WEB_CURATOR_IDENTITY (a token guarding unmounted routes is a configuration error)',
    );
  }

  // Re-verification scheduler. The three knobs travel together —
  // setting the interval is the opt-in, and the other two are
  // required when it is set. Refusing at boot when only some are
  // set avoids the trap of "set the interval, forget max_age,
  // scheduler runs with an undefined threshold."
  const reverify_interval_ms = parseOptionalPositiveInt(
    env['ANCHORAGE_REVERIFY_INTERVAL_MS'],
    'ANCHORAGE_REVERIFY_INTERVAL_MS',
  );
  const reverify_max_age_ms = parseOptionalPositiveInt(
    env['ANCHORAGE_REVERIFY_MAX_AGE_MS'],
    'ANCHORAGE_REVERIFY_MAX_AGE_MS',
  );
  const reverify_batch_size = parseOptionalPositiveInt(
    env['ANCHORAGE_REVERIFY_BATCH_SIZE'],
    'ANCHORAGE_REVERIFY_BATCH_SIZE',
  );
  if (reverify_interval_ms !== undefined) {
    if (reverify_max_age_ms === undefined) {
      throw new ServerError(
        'invalid_input',
        'ANCHORAGE_REVERIFY_MAX_AGE_MS is required when ANCHORAGE_REVERIFY_INTERVAL_MS is set',
      );
    }
    if (reverify_batch_size === undefined) {
      throw new ServerError(
        'invalid_input',
        'ANCHORAGE_REVERIFY_BATCH_SIZE is required when ANCHORAGE_REVERIFY_INTERVAL_MS is set',
      );
    }
  } else if (reverify_max_age_ms !== undefined || reverify_batch_size !== undefined) {
    throw new ServerError(
      'invalid_input',
      'ANCHORAGE_REVERIFY_MAX_AGE_MS / ANCHORAGE_REVERIFY_BATCH_SIZE require ANCHORAGE_REVERIFY_INTERVAL_MS to enable the scheduler',
    );
  }

  const config: ProdConfig = { db_path, host, port };
  if (github !== undefined) config.github = github;
  if (public_base_url !== undefined) config.public_base_url = public_base_url;
  if (web_reader_identity_id !== undefined) config.web_reader_identity_id = web_reader_identity_id;
  if (web_curator_identity_id !== undefined) {
    config.web_curator_identity_id = web_curator_identity_id;
  }
  if (web_curator_token !== undefined) config.web_curator_token = web_curator_token;
  if (reverify_interval_ms !== undefined) {
    config.reverify_interval_ms = reverify_interval_ms;
    // Both guaranteed defined by the refusal block above.
    config.reverify_max_age_ms = reverify_max_age_ms as number;
    config.reverify_batch_size = reverify_batch_size as number;
  }
  return config;
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ServerError(
      'invalid_input',
      `ANCHORAGE_PORT must be an integer 0..65535; got '${raw}'`,
    );
  }
  return n;
}

function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ServerError('invalid_input', `${name} must be a positive integer; got '${raw}'`);
  }
  return n;
}

export interface ProdServerHandle {
  http: AnchorageHttpServer;
  // Tears down the HTTP server and closes the SQLite store. Safe to
  // call multiple times.
  close: () => Promise<void>;
}

export interface ProdServerDeps {
  config: ProdConfig;
  // Override the verifier. Defaults to `LiveFetchVerifier` (NCBI +
  // Crossref). Tests inject `FakeVerifier` against seeded sources.
  verifier?: Verifier;
  // Override the GitHub API implementation. Defaults to
  // `GithubApiHttp` over `globalThis.fetch`. Tests inject
  // `FakeGithubApi`. Ignored when `config.github` is undefined.
  githubApi?: GithubApi;
  // Structured-log sink. Defaults to `console.log`. Production
  // deployments wire a JSON-line logger here.
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export async function runProdServer(deps: ProdServerDeps): Promise<ProdServerHandle> {
  const log = deps.log ?? defaultLog;
  const store = new SqliteStore({ path: deps.config.db_path });
  const verifier = deps.verifier ?? new LiveFetchVerifier();
  const server = new Server({ store, verifier });

  let githubAuth: GithubOAuthAuthenticator | undefined;
  if (deps.config.github) {
    const githubApi: GithubApi =
      deps.githubApi ??
      new GithubApiHttp({
        client_id: deps.config.github.client_id,
        client_secret: deps.config.github.client_secret,
      });
    const authConfig: NonNullable<
      ConstructorParameters<typeof GithubOAuthAuthenticator>[0]['config']
    > = {};
    if (deps.config.github.issuance_cap_per_epoch !== undefined) {
      authConfig.issuance_cap_per_epoch = deps.config.github.issuance_cap_per_epoch;
    }
    if (deps.config.github.issuance_epoch_seconds !== undefined) {
      authConfig.issuance_epoch_seconds = deps.config.github.issuance_epoch_seconds;
    }
    if (deps.config.github.account_age_days_for_level2 !== undefined) {
      authConfig.account_age_days_for_level2 = deps.config.github.account_age_days_for_level2;
    }
    githubAuth = new GithubOAuthAuthenticator({ server, githubApi, config: authConfig });
    server.setAuthenticator(githubAuth);
  }

  // MCP-spec OAuth authorization server (PRD §Identity, MCP-spec
  // OAuth). Wired iff the GitHub IdP is — `public_base_url` is
  // guaranteed present alongside `github` by `parseProdConfig`'s
  // refusal block. When unwired (harness/testbed), `opts.oauth` is
  // omitted and the discovery/authorize/token routes 404 by
  // absence, exactly like `/auth/github/*`; the sim≡prod posture is
  // byte-for-byte unchanged.
  let oauth: OAuthProvider | undefined;
  if (githubAuth && deps.config.public_base_url !== undefined) {
    oauth = new OAuthProvider({
      gh: githubAuth,
      baseUrl: deps.config.public_base_url,
      log,
    });
  }

  // Slice 5b — web tier. Resolve the configured reader identity
  // through the store at boot so a stale env value fails loudly
  // here, not on the first browser request. The web handler holds a
  // direct `Caller` (no transport boundary, so no Authenticator);
  // `server.resources.*` re-resolves the caller through the store
  // on every call so a mid-flight revocation is honored without a
  // restart.
  let webHandler: ReturnType<typeof buildWebHandler> | undefined;
  if (deps.config.web_reader_identity_id !== undefined) {
    const readerId = deps.config.web_reader_identity_id;
    const identity = server.store.identities.get(readerId);
    if (!identity) {
      throw new ServerError(
        'invalid_input',
        `ANCHORAGE_WEB_READER_IDENTITY does not name an existing identity: ${readerId}`,
      );
    }
    if (identity.status !== 'active') {
      throw new ServerError(
        'invalid_input',
        `ANCHORAGE_WEB_READER_IDENTITY identity is ${identity.status}: ${readerId}`,
      );
    }
    const caller: Caller = { identity_id: identity.id };
    const reader = new InProcessReader({ server, caller });

    // Slice 7b — curator console. Same boot-time validation shape
    // as the public reader plus a role assertion: the curator
    // reader identity must hold `role === 'curator'`, otherwise
    // the deployment would silently mount `/curator/*` against
    // an identity whose `requireCurator` check refuses on every
    // request — load-bearing to fail at boot instead. The
    // operator mints the identity via `anchorage-admin
    // mint-curator` and passes the printed `identity_id`.
    let curatorReader: InProcessCuratorReader | undefined;
    if (deps.config.web_curator_identity_id !== undefined) {
      const curatorId = deps.config.web_curator_identity_id;
      const curatorIdentity = server.store.identities.get(curatorId);
      if (!curatorIdentity) {
        throw new ServerError(
          'invalid_input',
          `ANCHORAGE_WEB_CURATOR_IDENTITY does not name an existing identity: ${curatorId}`,
        );
      }
      if (curatorIdentity.status !== 'active') {
        throw new ServerError(
          'invalid_input',
          `ANCHORAGE_WEB_CURATOR_IDENTITY identity is ${curatorIdentity.status}: ${curatorId}`,
        );
      }
      if (curatorIdentity.role !== 'curator') {
        throw new ServerError(
          'invalid_input',
          `ANCHORAGE_WEB_CURATOR_IDENTITY identity does not hold curator role: ${curatorId} (role=${curatorIdentity.role})`,
        );
      }
      const curatorCaller: Caller = { identity_id: curatorIdentity.id };
      curatorReader = new InProcessCuratorReader({ server, caller: curatorCaller });
    }

    webHandler = buildWebHandler({
      reader,
      ...(curatorReader ? { curatorReader } : {}),
      ...(deps.config.web_curator_token !== undefined
        ? { curatorToken: deps.config.web_curator_token }
        : {}),
      log,
    });
  }

  const http = await startHttpServer({
    server,
    ...(githubAuth ? { githubAuth } : {}),
    ...(oauth ? { oauth } : {}),
    ...(webHandler ? { webHandler } : {}),
    host: deps.config.host,
    port: deps.config.port,
    log,
  });

  // Slice 7c part 2 — periodic re-verification scheduler. Off by
  // default; the operator turns it on by setting
  // `ANCHORAGE_REVERIFY_INTERVAL_MS` alongside the two companion
  // knobs. Each tick fires `server.curator.reverifyDueAnchors` with
  // the configured batch size and freshness threshold; results are
  // logged. Per-tick errors are caught and logged so a transient
  // upstream failure does not kill the scheduler — the next tick
  // will retry naturally. `Timer.unref()` keeps the scheduler from
  // pinning the process alive past HTTP shutdown; the close path
  // explicitly clears the interval anyway, but unref guards the
  // case where the operator closes the underlying handle directly.
  let reverifyTimer: NodeJS.Timeout | undefined;
  if (deps.config.reverify_interval_ms !== undefined) {
    const interval = deps.config.reverify_interval_ms;
    const maxAge = deps.config.reverify_max_age_ms as number;
    const batch = deps.config.reverify_batch_size as number;
    const tick = (): void => {
      void (async () => {
        try {
          const out = await server.curator.reverifyDueAnchors({
            batch_size: batch,
            max_age_ms: maxAge,
          });
          if (out.checked > 0) {
            log('anchorage.reverify.tick', {
              checked: out.checked,
              unchanged: out.unchanged,
              unresolvable: out.unresolvable,
              transient: out.transient,
            });
          }
        } catch (err) {
          log('anchorage.reverify.error', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    };
    reverifyTimer = setInterval(tick, interval);
    reverifyTimer.unref();
    log('anchorage.reverify.started', {
      interval_ms: interval,
      max_age_ms: maxAge,
      batch_size: batch,
    });
  }

  log('anchorage.server.started', {
    url: http.url,
    db_path: deps.config.db_path,
    github_oauth: deps.config.github !== undefined,
    mcp_oauth: oauth !== undefined,
    web_tier: webHandler !== undefined,
    curator_console: deps.config.web_curator_identity_id !== undefined,
    reverify_scheduler: reverifyTimer !== undefined,
  });

  let closed = false;
  return {
    http,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (reverifyTimer !== undefined) clearInterval(reverifyTimer);
      await http.close();
      store.close();
      log('anchorage.server.stopped', {});
    },
  };
}

function defaultLog(message: string, fields?: Record<string, unknown>): void {
  if (fields && Object.keys(fields).length > 0) {
    console.log(message, fields);
  } else {
    console.log(message);
  }
}

// Production entrypoint. Reads env, stands the server up, wires
// SIGINT/SIGTERM to a graceful shutdown so the SQLite store closes
// cleanly (a half-written write-ahead log on hard kill is recoverable,
// but a clean shutdown is the operationally-supported path).
if (import.meta.url === `file://${process.argv[1]}`) {
  const main = async (): Promise<void> => {
    const config = parseProdConfig(process.env);
    const handle = await runProdServer({ config });
    let shutting = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (shutting) return;
      shutting = true;
      console.log(`received ${signal}, shutting down...`);
      handle
        .close()
        .then(() => {
          process.exit(0);
        })
        .catch((err) => {
          console.error('shutdown error:', err);
          process.exit(1);
        });
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  };
  main().catch((err) => {
    if (err instanceof ServerError) {
      console.error(`startup error: ${err.code}: ${err.message}`);
    } else {
      console.error('startup error:', err);
    }
    process.exitCode = 1;
  });
}
