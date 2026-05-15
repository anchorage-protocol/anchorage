import type { Identity, IdentityId } from '@anchorage/contracts';
import { ServerError } from './errors.js';
import { Server } from './server.js';
import { SqliteStore } from './sqlite-store.js';

// Slice 4b — `anchorage-admin` CLI. The operator's bootstrap path for
// curator seating: a long-running production server's SQLite file is
// the source of truth; this CLI is the offline surface the operator
// uses to mint the initial curator identity and credential (and
// later, to list / revoke). It does *not* talk to a running server
// — it opens the SQLite file directly. The operator is the only one
// with shell access to the production box; that's the trust boundary.
//
// Subcommands:
//
//   - `mint-curator --db=<path> --display-name=<name> [--label=<label>]`
//     Mints a `'harness'`-provider curator identity and binds a fresh
//     agent credential under it. Prints `{ identity_id, credential_id,
//     secret }` as a single-line JSON object to stdout — the bearer
//     secret is the one-shot reveal the operator stashes in a secrets
//     manager and hands to the curator. The secret is never
//     recoverable after this call (the server keeps only its SHA-256
//     hash, per slice 3b).
//
//   - `mint-reader --db=<path> --display-name=<name>`
//     Mints a `'harness'`-provider *contributor*-role identity bound
//     to no human — the slice 5b "service caller for anonymous
//     browse" shape (PRD §Anonymous-browse surface). The web tier
//     runs in-process with the MCP server (`run-prod.ts` mounts the
//     web handler alongside `/mcp`) and constructs its `Caller`
//     directly from this identity's id; no bearer secret is minted
//     because there is no transport boundary to authenticate
//     across. The CLI prints `{ identity_id, display_name }` —
//     the operator copies `identity_id` into
//     `ANCHORAGE_WEB_READER_IDENTITY`. The identity is freely
//     revocable via `revoke-identity`, which deactivates the web
//     reader without disturbing curator or contributor identities.
//
//   - `list-curators --db=<path>`
//     Prints a JSON array of curator identities, one per line as a
//     header `{ count }` followed by the records. Each record has
//     `id`, `display_name`, `status`, `created_at` — enough for the
//     operator to see who is seated and whether any are revoked.
//
//   - `revoke-identity --db=<path> --identity-id=<id>`
//     Flips the named identity (curator, contributor, or web
//     reader) to `status: 'revoked'`. Revocation invalidates future
//     participation without rewriting graph history (PRD §Identity,
//     Revocation). The identity can no longer sign actions; its
//     past contributions remain in the graph with the revocation
//     flagged.
//
// The CLI is exposed as `runAdminCli` (factor for testing — inject
// stdout / stderr sinks, server factory) and as a `main()` block at
// the bottom that the package's `bin` script invokes.

export interface AdminCliDeps {
  // Output sinks. Tests capture; the production main() block wires
  // `console.log` / `console.error`.
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  // Server factory keyed by SQLite path. Tests inject a deterministic
  // `Server` (`FakeClock` + `SeededIdGen`); production opens a
  // `SqliteStore` over the path and constructs a default `Server`.
  makeServer: (dbPath: string) => { server: Server; close: () => void };
}

export interface AdminCliResult {
  exit_code: number;
}

// Dispatch. Returns an exit code; the caller (test or main()) is
// responsible for translating it to `process.exitCode`.
export async function runAdminCli(argv: string[], deps: AdminCliDeps): Promise<AdminCliResult> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === 'help' || subcommand === '--help') {
    deps.stdout(USAGE);
    return { exit_code: subcommand === undefined ? 1 : 0 };
  }
  const flags = parseFlags(rest);
  try {
    switch (subcommand) {
      case 'mint-curator':
        return await runMintCurator(flags, deps);
      case 'mint-reader':
        return await runMintReader(flags, deps);
      case 'list-curators':
        return await runListCurators(flags, deps);
      case 'revoke-identity':
        return await runRevokeIdentity(flags, deps);
      default:
        deps.stderr(`unknown subcommand: ${subcommand}`);
        deps.stderr(USAGE);
        return { exit_code: 1 };
    }
  } catch (err) {
    if (err instanceof ServerError) {
      deps.stderr(`error: ${err.code}: ${err.message}`);
      return { exit_code: 2 };
    }
    deps.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return { exit_code: 2 };
  }
}

async function runMintCurator(
  flags: Map<string, string>,
  deps: AdminCliDeps,
): Promise<AdminCliResult> {
  const dbPath = requireFlag(flags, 'db');
  const displayName = requireFlag(flags, 'display-name');
  const label = flags.get('label') ?? `curator:${displayName}`;
  const { server, close } = deps.makeServer(dbPath);
  try {
    const identity = server.bootstrap.mintIdentity({
      display_name: displayName,
      role: 'curator',
    });
    const { credential, secret } = server.bootstrap.bindAgentCredential({
      identity_id: identity.id,
      label,
    });
    // Single-line JSON so callers can pipe straight to `jq` or
    // pattern-match. The `secret` field is the one-shot reveal —
    // captured here, never recoverable from the store afterward.
    deps.stdout(
      JSON.stringify({
        identity_id: identity.id,
        credential_id: credential.id,
        display_name: identity.display_name,
        secret,
      }),
    );
    return { exit_code: 0 };
  } finally {
    close();
  }
}

async function runMintReader(
  flags: Map<string, string>,
  deps: AdminCliDeps,
): Promise<AdminCliResult> {
  const dbPath = requireFlag(flags, 'db');
  const displayName = requireFlag(flags, 'display-name');
  const { server, close } = deps.makeServer(dbPath);
  try {
    // Contributor role (the default) — the web reader has no curator
    // powers by construction; the constraint that the web tier never
    // calls write-path tools is enforced by code, not by role, but
    // limiting the role here keeps the operator's mental model
    // unambiguous: a reader identity is a contributor identity that
    // happens to be operator-owned.
    const identity = server.bootstrap.mintIdentity({ display_name: displayName });
    deps.stdout(
      JSON.stringify({
        identity_id: identity.id,
        display_name: identity.display_name,
      }),
    );
    return { exit_code: 0 };
  } finally {
    close();
  }
}

async function runListCurators(
  flags: Map<string, string>,
  deps: AdminCliDeps,
): Promise<AdminCliResult> {
  const dbPath = requireFlag(flags, 'db');
  const { server, close } = deps.makeServer(dbPath);
  try {
    const curators: Array<Pick<Identity, 'id' | 'display_name' | 'status' | 'created_at'>> = [];
    for (const identity of server.store.identities.values()) {
      if (identity.role === 'curator') {
        curators.push({
          id: identity.id,
          display_name: identity.display_name,
          status: identity.status,
          created_at: identity.created_at,
        });
      }
    }
    deps.stdout(JSON.stringify({ count: curators.length, curators }));
    return { exit_code: 0 };
  } finally {
    close();
  }
}

async function runRevokeIdentity(
  flags: Map<string, string>,
  deps: AdminCliDeps,
): Promise<AdminCliResult> {
  const dbPath = requireFlag(flags, 'db');
  const rawId = requireFlag(flags, 'identity-id');
  const { server, close } = deps.makeServer(dbPath);
  try {
    const identity = server.store.identities.get(rawId as IdentityId);
    if (!identity) {
      throw new ServerError('not_found', `identity not found: ${rawId}`);
    }
    if (identity.status === 'revoked') {
      // Idempotent: re-revoking is a no-op rather than an error.
      // The operator running this twice (e.g. from a runbook) should
      // not be surprised.
      deps.stdout(JSON.stringify({ identity_id: identity.id, status: 'revoked', changed: false }));
      return { exit_code: 0 };
    }
    server.store.identities.set(identity.id, { ...identity, status: 'revoked' });
    deps.stdout(JSON.stringify({ identity_id: identity.id, status: 'revoked', changed: true }));
    return { exit_code: 0 };
  } finally {
    close();
  }
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(arg.slice(2), next);
        i++;
      } else {
        flags.set(arg.slice(2), '');
      }
    }
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const v = flags.get(name);
  if (v === undefined || v.length === 0) {
    throw new ServerError('invalid_input', `missing required flag --${name}`);
  }
  return v;
}

const USAGE = [
  'anchorage-admin — operator bootstrap CLI (slice 4b + 5b)',
  '',
  'Usage:',
  '  anchorage-admin mint-curator    --db=<path> --display-name=<name> [--label=<label>]',
  '  anchorage-admin mint-reader     --db=<path> --display-name=<name>',
  '  anchorage-admin list-curators   --db=<path>',
  '  anchorage-admin revoke-identity --db=<path> --identity-id=<id>',
  '',
  'mint-curator prints `{ identity_id, credential_id, display_name, secret }` to stdout.',
  'The secret is the one-shot bearer credential — stash it in a secrets manager;',
  'it is not recoverable from the SQLite store after this call.',
  '',
  'mint-reader prints `{ identity_id, display_name }` — copy `identity_id` into',
  'ANCHORAGE_WEB_READER_IDENTITY. The web tier runs in-process with the MCP server',
  'and constructs its Caller directly from this identity; no bearer secret is minted.',
].join('\n');

// Production entrypoint. The `bin/anchorage-admin` script (added via
// `package.json` `bin`) invokes this module via `tsx` / `node`; the
// guard pattern is the same as `run-live.ts`.
export function makeProductionServer(dbPath: string): { server: Server; close: () => void } {
  const store = new SqliteStore({ path: dbPath });
  const server = new Server({ store });
  return {
    server,
    close: () => store.close(),
  };
}

// `import.meta.url`-driven main guard so this file can be imported by
// tests (which inject their own deps) without firing the CLI body.
if (import.meta.url === `file://${process.argv[1]}`) {
  void runAdminCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    makeServer: makeProductionServer,
  }).then((result) => {
    process.exitCode = result.exit_code;
  });
}
