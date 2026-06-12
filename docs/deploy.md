# Deploying the Anchorage MCP server

Operational guide for standing `mcp.anchorage.science` (or any other public Anchorage instance) up. This is the operator-facing companion to slice 4 of [Phase 2](../ROADMAP.md#phase-2--single-cause-public-instance-opened-2026-05-14): slice 4a wired the HTTP transport, slice 4b wired the curator-bootstrap CLI, slice 4c (this doc) wires the deployment posture. Slice 5b extends the same runtime with an in-process read-only web tier (`anchorage.science`); the wiring is opt-in via the `ANCHORAGE_WEB_READER_IDENTITY` env var documented below.

The runtime composes already-tested components — `SqliteStore` (persistence, slice 2), `LiveFetchVerifier` (verifier, slice 1), `GithubOAuthAuthenticator` over `GithubApiHttp` (authenticator, slice 3c), the HTTP transport (slice 4a), the MCP-spec OAuth 2.1 authorization server (`OAuthProvider`, PRD §Identity, MCP-spec OAuth — wired alongside the GitHub IdP so any MCP client self-drives signin), and — when wired — the read-only web tier (slice 5b: `buildWebHandler` + `InProcessReader`) — into a single bootable process. Everything below is operational: what to set, what to mount, what to back up, what to monitor.

## What the instance needs

Three things, in order:

1. **A registered GitHub OAuth App** — *not* a GitHub App. These are different GitHub primitives; a GitHub App is the wrong one and fails opaquely. Register at GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App. Register it under an **organization you control**, not a personal account: the Client ID is baked into every contributor's signin and cannot be moved between owners, so a personal-account registration is a single point of failure if that account lapses. App settings:
   - **Application name**: anything readable to your contributors (the consent screen shows it verbatim).
   - **Homepage URL**: your public Anchorage URL (e.g. `https://anchorage.science`).
   - **Authorization callback URL**: load-bearing — set it to `https://<your-mcp-host>/auth/github/callback` (e.g. `https://mcp.anchorage.science/auth/github/callback`). This is the redirect target of the browser authorization-code flow that backs the MCP-spec OAuth server (PRD §Identity, MCP-spec OAuth). It must match the host clients reach (`ANCHORAGE_PUBLIC_BASE_URL` below) exactly; a mismatch fails the GitHub redirect.
   - **Enable Device Flow**: on. The device routes (`/auth/github/*`) remain as a fallback for clients driving the device flow directly; the primary client path is the OAuth server's browser flow.
   - **Generate a client secret.** The browser authorization-code token exchange is client-secret-authenticated (this is intrinsic to GitHub's web flow — unlike the device flow, it is *not* `client_id`-only). Set it into `ANCHORAGE_GITHUB_CLIENT_SECRET`.

   > **Why this changed.** Earlier deploy guidance said *do not generate a client secret*. That was correct **for the device flow**, whose token exchange sends only `client_id` + `device_code` + `grant_type` — a stored secret would have been zero-upside liability. The MCP-spec OAuth server (so any MCP client self-drives signin instead of a human hand-running the device flow) bridges GitHub's browser authorization-code flow, which *requires* the secret. The no-secret property was a consequence of the flow choice, not a standalone security axiom. The secret is low-severity: a GitHub *OAuth App* secret only completes code-exchanges for this one app, yielding tokens scoped to `read:user user:email` (read-only profile/email) — not account, repo, or org access — and PKCE + exact redirect-URI match + `state` already block code interception. Treat it like the curator bearer: secrets manager / `fly secrets`, never committed, rotatable (regenerate on the app, update the env, redeploy).

   The **Client ID** (older `Iv1.xxx` or newer `Ov23li…` format — the runtime takes either verbatim) goes into `ANCHORAGE_GITHUB_CLIENT_ID`. It is a *public identifier* (it appears on every consent screen), not a secret, but it is still per-deployment config that lives only in the runtime environment and is never committed to this repo.

   Scopes are not configured on the app (OAuth Apps don't pre-declare them); the runtime requests `read:user user:email` at authorization time, and they map directly to the attestation tiering (`computeGithubAttestationLevel`): `read:user` exposes 2FA status and account age, `user:email` exposes primary-email-verified state. Attestation **level 2** requires all of 2FA-on + verified-primary-email + account-age ≥ `ANCHORAGE_ATTESTATION_AGE_DAYS_FOR_LEVEL2` (default 30); anything weaker is level 1. A contributor who declines the email scope still authorizes but lands at level 1 — which only gates writes if the operator raises `min_attestation_level` above the inert default.

2. **A sticky disk** for the SQLite store. Single-instance v1 deployment — every request reads and writes the same `anchorage.db` file. Lose the disk, lose every minted identity, credential, and graph node. Backup cadence: see below.

3. **A TLS-terminating edge** in front of the runtime. The Anchorage process binds plain HTTP on `0.0.0.0:8080` by default; the edge (Caddy, nginx, Cloudflare Tunnel, Fly's edge, Render's edge, etc.) terminates TLS, routes `mcp.anchorage.science` to the container, and passes the request through. The runtime is deliberately edge-agnostic.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANCHORAGE_DB_PATH` | yes | — | Path to the SQLite file. Container default: `/data/anchorage.db`. |
| `ANCHORAGE_HOST` | no | `127.0.0.1` (container override: `0.0.0.0`) | Bind address. |
| `ANCHORAGE_PORT` | no | `8080` | Bind port. The edge points here. |
| `ANCHORAGE_GITHUB_CLIENT_ID` | no | — | GitHub OAuth App client id. When set, `ANCHORAGE_GITHUB_CLIENT_SECRET` and `ANCHORAGE_PUBLIC_BASE_URL` become required (boot refuses otherwise) and the MCP-spec OAuth surface (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/auth/github/callback`, `/token`) plus the device routes are mounted. When unset, all of those 404 and the runtime stays on the default `HarnessAuthenticator` (local-dev / testbed posture only — never expose this configuration to the public internet). |
| `ANCHORAGE_GITHUB_CLIENT_SECRET` | no² | — | GitHub OAuth App client secret. Required whenever `ANCHORAGE_GITHUB_CLIENT_ID` is set — the OAuth server bridges GitHub's client-secret-authenticated browser flow. Secret; set via `fly secrets` / a secrets manager, never committed. Rotatable (regenerate on the app, update env, redeploy). |
| `ANCHORAGE_PUBLIC_BASE_URL` | no² | — | Public origin clients reach the instance at, no trailing slash (e.g. `https://mcp.anchorage.science`). Required whenever `ANCHORAGE_GITHUB_CLIENT_ID` is set: it is the OAuth issuer and the canonical resource identifier, and cannot be reconstructed reliably behind a reverse proxy. Must be `https` (http allowed only for `localhost`/`127.0.0.1` local boots) and must match the GitHub App's Authorization callback URL host. |
| `ANCHORAGE_ISSUANCE_CAP_PER_EPOCH` | no | `Infinity` (gate inert) | Per-(provider, github-user) per-epoch identity issuance cap. PRD §Identity bullet 2. Tunable without restart — a positive integer fires `issuance_cap` refusals; missing keeps the gate inert. |
| `ANCHORAGE_ISSUANCE_EPOCH_SECONDS` | no | `Infinity` (gate inert) | Epoch window for the issuance cap, in seconds. Pair with the cap above. |
| `ANCHORAGE_ATTESTATION_AGE_DAYS_FOR_LEVEL2` | no | `30` | GitHub account age threshold for attestation level 2 (PRD §Identity bullet 1). Override only with a specific reason. |
| `ANCHORAGE_WEB_READER_IDENTITY` | no | — | Identity id of the operator-minted "web reader" (an `anchorage-admin mint-reader` mint, see *Bootstrap* below). When set, the runtime mounts the read-only web tier on the same HTTP listener: `/` renders the home page (cause list), `/sub-topic/{id}` renders a sub-topic detail page. When unset, the web routes do not exist and the listener serves only `/mcp`, the OAuth surface, `/auth/github/*`, and `/healthz` — the MCP-only deployment posture. |
| `ANCHORAGE_WEB_CURATOR_IDENTITY` | no | — | Identity id of an active `curator`-role identity (an `anchorage-admin mint-curator` mint, see *Bootstrap: enabling the curator console* below). When set, the runtime mounts the `/curator/*` console pages — moderation queue, identity-clusters view, unresolvable-anchors view — gated by this in-process curator caller. When unset, every `/curator/*` route 404s by absence. Requires `ANCHORAGE_WEB_READER_IDENTITY` to also be set (the curator index lists active causes via the public reader for filter links); boot refuses otherwise. |
| `ANCHORAGE_WEB_CURATOR_TOKEN` | no | — | Optional in-band second factor for `/curator/*`. When set, the console additionally requires HTTP Basic credentials whose password equals this token (any username) — refusals are `401` with a Basic challenge so a browser prompts. The reverse-proxy ACL stays the primary gate (PRD §Curator console); this guards against a single proxy-config mistake exposing the projections. Requires `ANCHORAGE_WEB_CURATOR_IDENTITY`; boot refuses otherwise. Secret; set via `fly secrets`. |
| `ANCHORAGE_REVERIFY_INTERVAL_MS` | no | — | Period between re-verification scheduler ticks, in milliseconds. Setting this turns the scheduler on; the two companion knobs (max-age, batch-size) are required when this is set, and setting any companion without this refuses at boot. When unset, the scheduler is off and the re-verification primitive remains available on-demand via the `curator_reverify_anchors` MCP tool. PRD §Verification engine (Re-verification). |
| `ANCHORAGE_REVERIFY_MAX_AGE_MS` | no¹ | — | Freshness threshold: anchors whose `last_verified_at` predates `now - max_age_ms` are eligible for re-verification. The scheduler picks the oldest first. Required when the interval is set. |
| `ANCHORAGE_REVERIFY_BATCH_SIZE` | no¹ | — | Per-tick cap on the number of anchors the scheduler re-verifies. Bounds the burst against the upstream verifier (NCBI / Crossref) when a backlog accumulates; backlogs drain across subsequent ticks. Required when the interval is set. |

¹ Required when `ANCHORAGE_REVERIFY_INTERVAL_MS` is set; boot refuses otherwise. The three knobs travel together — there is no default for a load-bearing cadence against NCBI / Crossref; the operator picks.

² Required when `ANCHORAGE_GITHUB_CLIENT_ID` is set; boot refuses otherwise. The GitHub IdP, its client secret, and the public base URL travel together — a half-configured OAuth surface is a misconfigured launch, not a degraded one.

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

**Platform note — single-volume container hosts (Fly Machines, Render, single-VM Docker).** "Take the server down" has no clean realization when the SQLite volume is pinned to the one machine running the server: the volume cannot be mounted by a second machine, and a stopped machine cannot exec the CLI. The supported procedure on these hosts:

- *First bootstrap* (fresh, empty DB, no traffic, re-verification scheduler off — the state right after the first deploy): run the CLI inside the running machine (`fly ssh console`, `docker exec`, etc.) against `ANCHORAGE_DB_PATH`. `SqliteStore` opens the database in WAL mode on a local volume (`packages/server/src/sqlite-store.ts`), and WAL safely serializes multiple processes on the *same host* — its hazard is networked/multi-host filesystems, not same-host multi-process. With an idle server doing no writes (zero traffic, scheduler off), a short CLI invocation is safe in practice; the "server down" rule is the conservative posture for bulk/destructive ops and for hosts where the CLI and server might not share the same local lock domain, not a hard requirement for same-host first-seeding.
- *Later admin ops, under live traffic*: prefer the over-the-wire path — the `curator_*` MCP tools (slice 7a) and `anchorage-admin revoke-identity`'s delegation both route through the running server's single writer rather than opening a second handle. Reserve direct-file CLI for a genuine maintenance window (drain traffic at the edge first), where the conservative "server down" rule still applies as written.

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

The curator-only MCP tool surface — the wire-level path through which a curator actually fires `acceptProposal` / `rejectProposal` — landed in [Phase 2 slice 7a](../ROADMAP.md#phase-2--single-cause-public-instance-opened-2026-05-14); slice 4 stops at the data model and the bootstrap. The read-only curator console (slice 7b) and the re-verification scheduler (slice 7c) are documented as opt-in bootstraps below.

## Bootstrap: seating the cause and starter sub-topics

A fresh instance has no cause and no sub-topics — the home page renders the empty state until one is seated. Causes and the v0 starter sub-topics are *operator-seeded*, not contributor-proposed: there is no write-path MCP tool that creates a cause, by design (a cause is a governance decision per [docs/seed-topic.md](./seed-topic.md), not a contribution), and the v0 starter sub-topics are the hand-seeded set the cause launches with. The `anchorage-admin` CLI is the offline path, same posture as curator seating — server down, write directly to the on-disk SQLite store.

1. Seat the umbrella cause. The v0 public instance's cause is **colon cancer**, locked in [docs/seed-topic.md](./seed-topic.md):

   ```bash
   docker exec -it anchorage \
     pnpm --filter @anchorage/server run admin seed-cause \
       --db=/data/anchorage.db \
       --name="Colon cancer" \
       --description="Cooperative open research on colon cancer: screening, hereditary risk, treatment, and the evidence chains behind contested clinical decisions."
   ```

   Output is a single JSON line:

   ```json
   {"cause_id":"cau_...","name":"Colon cancer"}
   ```

2. Seat each starter sub-topic against that `cause_id` — one `seed-sub-topic` call per sub-topic in the v0 set (the tentative set in [docs/seed-topic.md](./seed-topic.md) is ctDNA-MRD + Lynch surveillance + screening age; the final selection is the operator's at launch). The `--scope-query` is the PubMed-style membership query the sub-topic's scope envelope is defined by (PRD §Multi-scale graph; seed-topic.md's hand-seed criteria target ~200–1500 papers). Example with the strongly-favored ctDNA-MRD candidate:

   ```bash
   docker exec -it anchorage \
     pnpm --filter @anchorage/server run admin seed-sub-topic \
       --db=/data/anchorage.db \
       --cause-id=cau_... \
       --name="ctDNA-guided adjuvant chemo in resected stage II colon cancer" \
       --description="When ctDNA-positivity justifies escalation and ctDNA-negativity justifies de-escalation of adjuvant chemotherapy after resection of stage II colon cancer, traceable to the trial spine (CIRCULATE-Japan, DYNAMIC, GALAXY, BESPOKE-CRC)." \
       --scope-query="(colon cancer) AND (circulating tumor DNA OR ctDNA OR minimal residual disease) AND (adjuvant) AND stage II"
   ```

   Output is a single JSON line:

   ```json
   {"sub_topic_id":"stp_...","cause_id":"cau_...","name":"ctDNA-guided adjuvant chemo in resected stage II colon cancer","status":"active"}
   ```

   `status` is `active` because this is the curator-seeded path — the sub-topic is live the moment it is seeded. This is distinct from the contributor-facing `propose_sub_topic` MCP tool, which stages a sub-topic at `proposed` for curator acceptance (PRD §Sub-topic creation governance); the offline seed path is how the *initial* set lands without a curator round-trip against an empty graph. `seed-sub-topic` refuses with `not_found` if the `--cause-id` is unknown and `invalid_state` if the cause is archived.

The seed step is reversible only forward: there is no `unseed`. To retire a mis-seeded sub-topic before launch, the cleanest path on a not-yet-public instance is to delete the SQLite file and re-run the bootstrap from `mint-curator`. Once the instance is public and has graph state, sub-topic retirement is a curator archival action, not a delete.

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

2. Set `ANCHORAGE_WEB_READER_IDENTITY` to that `identity_id` and restart the runtime. On boot, the runtime validates the identity exists and is active (a stale or revoked value refuses loudly here, not on the first browse request) and mounts the web handler on the existing HTTP listener. Anonymous browse traffic to `/`, `/sub-topic/{id}`, `/node/{id}`, `/contributor/{id}`, and `/manuscript/{sub-topic-id}` now serves HTML — the full public read-only surface as of slice 6b sits behind this single env-var gate.

   With your edge routing `anchorage.science` (the apex) and `mcp.anchorage.science` (the subdomain) at the same upstream, the two surfaces share a single process: MCP requests land on `/mcp`, browse requests land on the public routes enumerated above, both authenticated through the same `Server` instance. The web tier reads through the MCP `server.resources.*` surface (the six resources committed across slices 5a/5c/6a — `cause://`, `sub-topic://{id}`, `subgraph://{sub-topic-id}`, `node://{id}`, `contributor://{id}`, `manuscript://{sub-topic-id}`) plus `query_frontier`; read-path reads do not consume the per-identity rate-limit budget (PRD §Read-path tools and resources), so the single web-reader identity scales to all anonymous traffic without IdP-side pressure.

   The web reader is freely revocable through `anchorage-admin revoke-identity`; revocation observed mid-flight is honored on the next browse request (the `Server` re-resolves the caller through the store on every call, PRD §Identity, Authenticator seam). On revocation, the web handler starts returning HTML 500s until the operator mints a fresh reader and updates the env.

## Bootstrap: enabling the curator console (slice 7b)

The curator console at `/curator/*` is an additional opt-in on top of the public web tier. PRD §Curator console commits the read-only posture: the curator visits the console to see what's queued or flagged and then directs their MCP agent (Claude Desktop, Cursor, custom client) to fire the `curator_*` tools (slice 7a) — there are no action buttons in the web view. Enable in two steps.

1. Mint a *curator* identity for the web tier. This is a curator-role harness identity (only harness-provider mints can hold the curator role, PRD §Identity Roles — the same invariant `mint-curator` already enforces).

   ```bash
   docker exec -it anchorage \
     pnpm --filter @anchorage/server run admin mint-curator \
       --db=/data/anchorage.db \
       --display-name="anchorage.science curator console"
   ```

   Output is a single JSON line carrying both the `identity_id` and a one-shot bearer secret (the secret is for a curator-as-agent who fires the `curator_*` MCP tools; for the web console specifically you only need the `identity_id`). Stash the secret in a secrets manager if the same identity will also drive the curator agent.

2. Set `ANCHORAGE_WEB_CURATOR_IDENTITY` to that `identity_id`, keep `ANCHORAGE_WEB_READER_IDENTITY` set, and restart the runtime. On boot, the runtime validates the identity exists, is active, and holds the curator role — all three are caught at boot rather than per-request. The `/curator/*` routes then mount: `/curator` (index), `/curator/queue` (moderation queue, optional `?cause_id=` filter), `/curator/identity-clusters` (cross-cause vote-coordination fingerprints), `/curator/unresolvable` (anchors flagged by the re-verification scheduler, optional `?cause_id=` filter).

3. **Gate `/curator/*` upstream.** The console contains operationally-private data — cross-cause identity-pair signals, the moderation queue, drift-flagged anchors. The Anchorage runtime does *not* expose a login flow for these routes in v0: the in-process curator caller is the single privileged identity behind the namespace, and (unless you set the optional `ANCHORAGE_WEB_CURATOR_TOKEN` second factor) anyone who can hit `/curator/*` will see the content. The operational posture PRD §Curator console commits is: the operator restricts which network origin reaches `/curator/*` upstream — reverse-proxy ACL (NGINX `allow`/`deny`, Caddy `route` with `@curator`), basic auth at the edge, Cloudflare Access policy, VPN-only egress, or whatever the deployment's network primitives offer. Setting `ANCHORAGE_WEB_CURATOR_TOKEN` adds an in-band HTTP Basic check as defense-in-depth but the network gate remains the primary control. A misconfigured deployment that exposes `/curator/*` to the public internet with no token leaks the projections; gate before mount.

   **Proxy-less PaaS (Fly Machines, Render, bare container behind the platform's own edge).** These deployments have no path-level ACL hook: the platform proxy forwards every path to the one process, and DNS-only fronting (e.g. Cloudflare gray-cloud, chosen so the platform's TLS and the MCP SSE stream are unaffected) puts nothing in front of `/curator/*`. There is no in-runtime way to gate it. The options, in order of operational simplicity:

   - **Don't mount it (recommended v0 default).** Leave `ANCHORAGE_WEB_CURATOR_IDENTITY` unset. The console is a read-only convenience; it is *not* required to curate. A seated curator does all moderation over MCP — point an MCP client at `https://mcp.<domain>/mcp` with the curator's bearer and use the `curator_*` tools (accept/reject, escalate, defer, revoke, archive-stale, identity-clusters, reverify). This is the full curator capability with zero public-exposure surface, and is the posture a proxy-less deployment should ship until a gate exists.
   - **Cloudflare Access on a dedicated curator hostname.** Add `curator.<domain>` as a Fly cert + DNS record, orange-cloud *only that one hostname* (the apex and `mcp.` stay gray so MCP streaming and Fly cert validation are untouched), and put a Cloudflare Access policy (email/SSO allowlist) in front of it. Access enforces auth before the request reaches the origin; the runtime still sees the same in-process curator caller. This is the cleanest "real console, gated" path on Fly.
   - **Private network / Tailscale.** Bind the curator's browser path to a tailnet (`tailscale serve` from a sidecar, or a WireGuard/Tailscale-only listener) so `/curator/*` is reachable only from operator-enrolled devices.

   Whichever is chosen, the rule is unchanged: gate *before* setting `ANCHORAGE_WEB_CURATOR_IDENTITY`, never after.

4. Revocation is freely available — `anchorage-admin revoke-identity` against the curator's `identity_id`, or the curator firing `curator_revoke_identity` against themselves. `server.resources.requireCurator` re-resolves the caller on every call, so the next page load after revocation refuses with `permission_denied` → 403. (A demotion to contributor role surfaces the same way.) To rotate, mint a fresh curator, update the env, restart.

## Bootstrap: enabling the re-verification scheduler (slice 7c)

The re-verification scheduler periodically re-fetches `active` anchors against their stored `content_hash` and flips drift to `unresolvable` (terminal at the anchor level; recovery is via `propose_supersedes` from a contributor proposing a fresh `external_ref`). PRD §Verification engine (Re-verification) commits the contract; the periodic tick in production is opt-in through three companion env vars.

The scheduler is *off* by default. The primitive remains available on-demand whether the scheduler is on or off — a seated curator can fire `curator_reverify_anchors` through their MCP agent to drive a sweep manually, regardless of the env config.

1. Decide a cadence. The two operational tradeoffs are upstream pressure (each tick fetches up to `batch_size` URLs from NCBI / Crossref / the URL host) and freshness latency (the maximum time a drifted source can sit `active` before the scheduler catches it). NCBI's E-utilities are 3 req/sec without an API key, 10 req/sec with; Crossref is broadly polite-pool friendly at hundreds of req/min for a registered user agent. A starting point: `INTERVAL_MS=3600000` (1 hour), `BATCH_SIZE=16`, `MAX_AGE_MS=604800000` (7 days). At that shape each anchor is re-verified roughly weekly, the per-tick burst is bounded at 16 fetches, and drift surfaces in the `/curator/unresolvable` view within a week of when it lands upstream. The numbers are operator's choice; PRD §Verification engine commits that specific cadence is operationally private.

2. Set the three env vars and restart:

   ```bash
   ANCHORAGE_REVERIFY_INTERVAL_MS=3600000 \
   ANCHORAGE_REVERIFY_MAX_AGE_MS=604800000 \
   ANCHORAGE_REVERIFY_BATCH_SIZE=16 \
   pnpm --filter @anchorage/server run prod
   ```

   The runtime refuses at boot if only some of the three are set — there is no silent default for a cadence that drives real fetches against upstream verifiers. Drop the `INTERVAL` to turn it off, or all three to revert to the unset shape.

3. The scheduler's tick fires every `INTERVAL_MS`, picks up to `BATCH_SIZE` `active` anchors whose `last_verified_at` predates `now - MAX_AGE_MS` (oldest first), and re-verifies each in turn. Per-tick errors are caught and surfaced through the structured-log sink (`anchorage.reverify.error`); a transient upstream failure does not kill the scheduler. Outcomes for a non-empty tick are logged as `anchorage.reverify.tick` with `{ checked, unchanged, unresolvable, transient }` — `transient` counts upstream 429/5xx signals, which persist nothing and stop the batch early (the next tick retries for free). The `/curator/unresolvable` view (slice 7c) surfaces flagged anchors to a seated curator, most-recent-drift-first.

## Connecting an MCP client

With the GitHub IdP wired (`ANCHORAGE_GITHUB_CLIENT_ID` + `_SECRET` + `ANCHORAGE_PUBLIC_BASE_URL`), the instance is a spec-compliant OAuth 2.1 resource server and any MCP client self-drives signin. The contributor experience is add-and-go — no hand-run curl, no copied bearer, no header editing:

1. Add the server, e.g. with Claude Code: `claude mcp add --transport http anchorage https://mcp.anchorage.science/mcp` (no auth header).
2. Restart the client. On first use it hits `/mcp` unauthenticated, reads the `WWW-Authenticate` challenge, discovers the authorization server via `/.well-known/oauth-protected-resource` → `/.well-known/oauth-authorization-server`, dynamically registers (RFC 7591), and opens a browser to `/authorize`.
3. The contributor sees the per-client consent page (which client, which redirect host), clicks through to GitHub, authorizes once, and is redirected back. The client exchanges the code (PKCE S256) at `/token` and stores the resulting bearer. Done — subsequent calls are authenticated.

What the operator sees: `anchorage.server.started` logs `mcp_oauth: true`; `oauth.register` / `oauth.authorized` log lines (metadata only — never the secret) mark each registration and successful signin. The issued bearer is an ordinary agent credential — revoke it the same way (`anchorage-admin revoke-identity` for the human, transitively its agents).

The legacy device routes (`/auth/github/start` + `/auth/github/complete`) remain for clients that drive the device flow directly, but no human needs them in the OAuth-server path.

The whole pre-auth surface (`/register`, `/authorize`, `/token`, `/auth/github/*`) is throttled per client IP at the HTTP layer (default 60 requests/minute per address; refusals are `429` `rate_limited`). The throttle keys on `Fly-Client-IP` when present (set by the Fly proxy and not client-forgeable there) and falls back to the socket address — if you front the instance with a different proxy, make sure it either sets `Fly-Client-IP` or terminates close enough that socket addresses are meaningful, or the throttle degrades to bucketing all traffic under the proxy's address. `/mcp` is exempt: it is bearer-gated and the per-identity rate limits own it. The dynamically-registered OAuth client registry is bounded (idle registrations expire after 30 days; at the hard cap the oldest-idle registration is evicted and the affected client transparently re-registers on its next connect).

## Backups

The SQLite file is the source of truth. Loss of the file is loss of the instance. Two reasonable approaches:

- **Snapshot the volume**. Most hosts (Fly volumes, AWS EBS, GCP persistent disks) offer scheduled snapshots. Snapshot cadence is operator's choice; the v1 single-cause-instance posture admits hourly snapshots without strain.
- **`sqlite3 .backup`**. SQLite ships an online backup API: a snapshot of a live database can be taken without quiescing writes. Schedule a cron job that runs `sqlite3 /data/anchorage.db ".backup /backups/anchorage-$(date -u +%Y%m%dT%H%M%SZ).db"` and rotates the backup directory.

The SQLite file is small enough through the single-cause phase that either approach is fine. The choice between them is operational; the contract is "the file is on a sticky disk and you have a recent snapshot."

## Observability

The runtime emits structured logs via the injected log sink. The default sink is `console.log` (line-per-event with a fields object). Production deployments should pipe stdout into whatever the host's log pipeline expects (Fly's log shipper, journald, Loki, etc.) and parse on the event names:

- `anchorage.server.started` — emitted once per boot, with `url`, `db_path`, `github_oauth: boolean`, `web_tier: boolean`, `curator_console: boolean`.
- `web.page.home` / `web.page.sub_topic` — emitted on every served web page (slice 5b). Carries the cause count or sub-topic id respectively. No PII; the web reader is shared across all anonymous traffic.
- `web.page.node` / `web.page.contributor` — emitted on every served node-detail and contributor-profile page (slice 5c). Carries `{ node_id }` and `{ identity_id }` respectively. No PII beyond the public contributor display fields the profile page itself surfaces.
- `web.page.manuscript` — emitted on every served `/manuscript/:sub-topic-id` page (slice 6b). Carries `{ sub_topic_id }`.
- `web.page.curator.index` / `web.page.curator.queue` / `web.page.curator.identity_clusters` — emitted on every served curator-console page (slice 7b). Carries projection-shape counts (cause count, proposal count, pair count) and the cause_id filter where applicable.
- `web.page.curator.unresolvable` — emitted on every served `/curator/unresolvable` page (slice 7c). Carries `{ anchor_count, cause_id }`.
- `anchorage.reverify.started` — emitted once per boot when the re-verification scheduler is configured (slice 7c). Carries `{ interval_ms, max_age_ms, batch_size }`. Absent when the scheduler is disabled.
- `anchorage.reverify.tick` — emitted per non-empty scheduler tick (slice 7c). Carries `{ checked, unchanged, unresolvable, transient }`. Empty ticks are silent to keep the log volume bounded under quiet steady state.
- `anchorage.reverify.error` — emitted per scheduler tick that threw (slice 7c). Carries `{ message }`. The scheduler itself survives the throw and keeps ticking.
- `anchorage.server.stopped` — emitted once per graceful shutdown.
- `auth.github.start` / `auth.github.complete` — one per device-code flow attempt (metadata only: `user_code`, `status` — never the secret).
- `http error <method> <path>` — emitted on uncaught throws inside the HTTP handler.

`GET /healthz` is the load-balancer liveness probe. Reads `{ ok: true }` on every reachable boot. The Dockerfile's `HEALTHCHECK` uses this.

## Sim ≡ prod

The runtime is the production-shaped composition of the same `Server` class the testbed drives. Every `Caller` resolution, every `Verifier` call, every `Store` write goes through the same code path the testbed exercises end-to-end. The only differences are: which `Verifier` (the live one, against NCBI / Crossref), which `Authenticator` (`GithubOAuthAuthenticator` against a real OAuth App), and which `Store` backend (`SqliteStore` against a real disk). No `if (sim) ...` branching anywhere — by construction (PRD §Identity, Authenticator seam; CLAUDE.md §Load-bearing design commitments).

This is what lets testbed results transfer to production: the production deployment is not running different code, it is running the same code with different concretes plugged into the same seams.
