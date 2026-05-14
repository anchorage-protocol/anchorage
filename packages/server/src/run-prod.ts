import { type GithubApi, GithubApiHttp, GithubOAuthAuthenticator } from './auth-github.js';
import { ServerError } from './errors.js';
import { type AnchorageHttpServer, startHttpServer } from './http.js';
import { LiveFetchVerifier } from './live-fetch-verifier.js';
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
}

export interface GithubConfig {
  client_id: string;
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
  if (client_id && client_id.length > 0) {
    github = { client_id };
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

  return github === undefined ? { db_path, host, port } : { db_path, host, port, github };
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
      deps.githubApi ?? new GithubApiHttp({ client_id: deps.config.github.client_id });
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

  const http = await startHttpServer({
    server,
    ...(githubAuth ? { githubAuth } : {}),
    host: deps.config.host,
    port: deps.config.port,
    log,
  });

  log('anchorage.server.started', {
    url: http.url,
    db_path: deps.config.db_path,
    github_oauth: deps.config.github !== undefined,
  });

  let closed = false;
  return {
    http,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
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
