# Deploying the Anchorage MCP server

Operational guide for standing `mcp.anchorage.science` (or any other public Anchorage instance) up. This is the operator-facing companion to slice 4 of [Phase 2](../ROADMAP.md#phase-2--single-cause-public-instance-opened-2026-05-14): slice 4a wired the HTTP transport, slice 4b wired the curator-bootstrap CLI, slice 4c (this doc) wires the deployment posture. Slice 5b extends the same runtime with an in-process read-only web tier (`anchorage.science`); the wiring is opt-in via the `ANCHORAGE_WEB_READER_IDENTITY` env var documented below.

The runtime composes five already-tested components — `SqliteStore` (persistence, slice 2), `LiveFetchVerifier` (verifier, slice 1), `GithubOAuthAuthenticator` over `GithubApiHttp` (authenticator, slice 3c), the HTTP transport (slice 4a), and — when wired — the read-only web tier (slice 5b: `buildWebHandler` + `InProcessReader`) — into a single bootable process. Everything below is operational: what to set, what to mount, what to back up, what to monitor.

## What the instance needs

Three things, in order:

1. **A registered GitHub OAuth App** to receive the device-code flow. App settings:
   - **Application name**: anything readable to your contributors (the consent screen shows it).
   - **Homepage URL**: your public Anchorage URL (e.g. `https://anchorage.science`).
   - **Authorization callback URL**: required by the form but unused by the device-code flow — any value parses.
   - **Enable Device Flow**: on. This is the load-bearing setting.

   Once registered, the **Client ID** (`Iv1.xxx`) is what the runtime reads. The device-code flow does not use a client secret, so there is nothing else to store.

2. **A sticky disk** for the SQLite store. Single-instance v1 deployment — every request reads and writes the same `anchorage.db` file. Lose the disk, lose every minted identity, credential, and graph node. Backup cadence: see below.

3. **A TLS-terminating edge** in front of the runtime. The Anchorage process binds plain HTTP on `0.0.0.0:8080` by default; the edge (Caddy, nginx, Cloudflare Tunnel, Fly's edge, Render's edge, etc.) terminates TLS, routes `mcp.anchorage.science` to the container, and passes the request through. The runtime is deliberately edge-agnostic.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANCHORAGE_DB_PATH` | yes | — | Path to the SQLite file. Container default: `/data/anchorage.db`. |
| `ANCHORAGE_HOST` | no | `127.0.0.1` (container override: `0.0.0.0`) | Bind address. |
| `ANCHORAGE_PORT` | no | `8080` | Bind port. The edge points here. |
| `ANCHORAGE_GITHUB_CLIENT_ID` | no | — | GitHub OAuth App client id. When unset, `/auth/github/*` routes 404 and the runtime stays on the default `HarnessAuthenticator` (local-dev / testbed posture only — never expose this configuration to the public internet). |
| `ANCHORAGE_ISSUANCE_CAP_PER_EPOCH` | no | `Infinity` (gate inert) | Per-(provider, github-user) per-epoch identity issuance cap. PRD §Identity bullet 2. Tunable without restart — a positive integer fires `issuance_cap` refusals; missing keeps the gate inert. |
| `ANCHORAGE_ISSUANCE_EPOCH_SECONDS` | no | `Infinity` (gate inert) | Epoch window for the issuance cap, in seconds. Pair with the cap above. |
| `ANCHORAGE_ATTESTATION_AGE_DAYS_FOR_LEVEL2` | no | `30` | GitHub account age threshold for attestation level 2 (PRD §Identity bullet 1). Override only with a specific reason. |
| `ANCHORAGE_WEB_READER_IDENTITY` | no | — | Identity id of the operator-minted "web reader" (an `anchorage-admin mint-reader` mint, see *Bootstrap* below). When set, the runtime mounts the read-only web tier on the same HTTP listener: `/` renders the home page (cause list), `/sub-topic/{id}` renders a sub-topic detail page. When unset, the web routes do not exist and the listener serves only `/mcp`, `/auth/github/*`, and `/healthz` — the MCP-only deployment posture. |

The runtime refuses to start on any malformed value — bad ports, negative tunables, missing `ANCHORAGE_DB_PATH`. This is loud-failure on purpose; silent fallbacks would mask a misconfigured production launch.

## Standing it up — Docker

The repo ships a `Dockerfile` that builds the runtime on `node:24-alpine`.

```bash
docker build -t anchorage-mcp .

docker run -d \
  --name anchorage \
  -p 8080:8080 \
  -v anchorage-data:/data \
  -e ANCHORAGE_DB_PATH=/data/anchorage.db \
  -e ANCHORAGE_GITHUB_CLIENT_ID=Iv1.YOUR_CLIENT_ID \
  -e ANCHORAGE_ISSUANCE_CAP_PER_EPOCH=10 \
  -e ANCHORAGE_ISSUANCE_EPOCH_SECONDS=3600 \
  anchorage-mcp
```

Point your TLS edge at `127.0.0.1:8080` (or wherever the container exposed) and route `mcp.anchorage.science` through.

## Standing it up — bare metal

```bash
pnpm install --frozen-lockfile
pnpm -r build

ANCHORAGE_DB_PATH=/var/lib/anchorage/anchorage.db \
ANCHORAGE_HOST=127.0.0.1 \
ANCHORAGE_PORT=8080 \
ANCHORAGE_GITHUB_CLIENT_ID=Iv1.YOUR_CLIENT_ID \
pnpm --filter @anchorage/server run prod
```

A `systemd` unit, a `supervisord` process, or whatever your host runs is the natural way to keep it up. The process responds to `SIGINT` and `SIGTERM` with a graceful shutdown (closes the HTTP server, then the SQLite store).

## Bootstrap: seating the first curator

The `anchorage-admin` CLI (slice 4b) is the offline path. It writes directly to the on-disk SQLite store — no running server is required (or wanted: take the server down before running it, to avoid concurrent writes against the same database file).

```bash
# Inside the container:
docker exec -it anchorage \
  pnpm --filter @anchorage/server run admin mint-curator \
    --db=/data/anchorage.db \
    --display-name="Anchorage Curator"

# Or bare-metal:
pnpm --filter @anchorage/server run admin mint-curator \
  --db=/var/lib/anchorage/anchorage.db \
  --display-name="Anchorage Curator"
```

Output is a single JSON line:

```json
{"identity_id":"idn_...","credential_id":"agt_...","display_name":"Anchorage Curator","secret":"<bearer secret>"}
```

The `secret` field is the bearer credential the curator presents at the Authenticator seam (`Authorization: Bearer <secret>` on `/mcp`). It is the one-shot reveal — the store keeps only its SHA-256 hash (slice 3b), so this is the *only* moment the plain value is available. Stash it in a secrets manager and hand it to the curator. If lost: mint a fresh credential, revoke the old one.

Other admin subcommands:

```bash
# Roster
pnpm admin list-curators --db=/data/anchorage.db

# Revoke (curator, contributor, or web reader)
pnpm admin revoke-identity --db=/data/anchorage.db --identity-id=idn_xxx
```

The curator-only MCP tool surface — the wire-level path through which a curator actually fires `acceptProposal` / `rejectProposal` — lands in [Phase 2 slice 7](../ROADMAP.md#phase-2--single-cause-public-instance-opened-2026-05-14). Slice 4 stops at the data model and the bootstrap.

## Bootstrap: enabling the read-only web tier (slice 5b)

The web tier is opt-in: omit `ANCHORAGE_WEB_READER_IDENTITY` and the deployment stays MCP-only. Enable it in two steps.

1. Mint a *web reader* identity. This is a contributor-role harness identity bound to no human — an operator-owned service caller for anonymous browse traffic. No bearer secret is minted; the web tier runs in-process with the MCP server and constructs its `Caller` directly from the identity id, so there is no transport boundary to authenticate across.

   ```bash
   docker exec -it anchorage \
     pnpm --filter @anchorage/server run admin mint-reader \
       --db=/data/anchorage.db \
       --display-name="anchorage.science web tier"
   ```

   Output is a single JSON line:

   ```json
   {"identity_id":"idn_...","display_name":"anchorage.science web tier"}
   ```

2. Set `ANCHORAGE_WEB_READER_IDENTITY` to that `identity_id` and restart the runtime. On boot, the runtime validates the identity exists and is active (a stale or revoked value refuses loudly here, not on the first browse request) and mounts the web handler on the existing HTTP listener. Anonymous browse traffic to `/` and `/sub-topic/{id}` now serves HTML.

   With your edge routing `anchorage.science` (the apex) and `mcp.anchorage.science` (the subdomain) at the same upstream, the two surfaces share a single process: MCP requests land on `/mcp`, browse requests land on `/` and `/sub-topic/*`, both authenticated through the same `Server` instance. The web tier reads through the MCP `server.resources.*` surface (slice 5a — `cause://`, `sub-topic://{id}`, `subgraph://{sub-topic-id}`) plus `query_frontier`; read-path reads do not consume the per-identity rate-limit budget (PRD §Read-path tools and resources), so the single web-reader identity scales to all anonymous traffic without IdP-side pressure.

   The web reader is freely revocable through `anchorage-admin revoke-identity`; revocation observed mid-flight is honored on the next browse request (the `Server` re-resolves the caller through the store on every call, PRD §Identity, Authenticator seam). On revocation, the web handler starts returning HTML 500s until the operator mints a fresh reader and updates the env.

## Backups

The SQLite file is the source of truth. Loss of the file is loss of the instance. Two reasonable approaches:

- **Snapshot the volume**. Most hosts (Fly volumes, AWS EBS, GCP persistent disks) offer scheduled snapshots. Snapshot cadence is operator's choice; the v1 single-cause-instance posture admits hourly snapshots without strain.
- **`sqlite3 .backup`**. SQLite ships an online backup API: a snapshot of a live database can be taken without quiescing writes. Schedule a cron job that runs `sqlite3 /data/anchorage.db ".backup /backups/anchorage-$(date -u +%Y%m%dT%H%M%SZ).db"` and rotates the backup directory.

The SQLite file is small enough through the single-cause phase that either approach is fine. The choice between them is operational; the contract is "the file is on a sticky disk and you have a recent snapshot."

## Observability

The runtime emits structured logs via the injected log sink. The default sink is `console.log` (line-per-event with a fields object). Production deployments should pipe stdout into whatever the host's log pipeline expects (Fly's log shipper, journald, Loki, etc.) and parse on the event names:

- `anchorage.server.started` — emitted once per boot, with `url`, `db_path`, `github_oauth: boolean`, `web_tier: boolean`.
- `web.page.home` / `web.page.sub_topic` — emitted on every served web page (slice 5b). Carries the cause count or sub-topic id respectively. No PII; the web reader is shared across all anonymous traffic.
- `anchorage.server.stopped` — emitted once per graceful shutdown.
- `auth.github.start` / `auth.github.complete` — one per device-code flow attempt (metadata only: `user_code`, `status` — never the secret).
- `http error <method> <path>` — emitted on uncaught throws inside the HTTP handler.

`GET /healthz` is the load-balancer liveness probe. Reads `{ ok: true }` on every reachable boot. The Dockerfile's `HEALTHCHECK` uses this.

## Sim ≡ prod

The runtime is the production-shaped composition of the same `Server` class the testbed drives. Every `Caller` resolution, every `Verifier` call, every `Store` write goes through the same code path the testbed exercises end-to-end. The only differences are: which `Verifier` (the live one, against NCBI / Crossref), which `Authenticator` (`GithubOAuthAuthenticator` against a real OAuth App), and which `Store` backend (`SqliteStore` against a real disk). No `if (sim) ...` branching anywhere — by construction (PRD §Identity, Authenticator seam; CLAUDE.md §Load-bearing design commitments).

This is what lets testbed results transfer to production: the production deployment is not running different code, it is running the same code with different concretes plugged into the same seams.
