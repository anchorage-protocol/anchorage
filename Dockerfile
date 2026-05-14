# Anchorage MCP server — production image (slice 4c).
#
# Single-stage build on `node:24-alpine`: the runtime needs Node ≥24
# (the engine floor declared in the root `package.json` — `node:sqlite`
# is built-in from Node 22 but the project pins ≥24 across the
# workspace). Build tooling and TypeScript sources stay in the image
# because `tsx` is the launcher; a future split into builder/runtime
# stages can compile to `dist/` and drop the dev deps, but for the v1
# deployment posture the simpler shape is the right call (the image
# is small enough — alpine + node + pnpm + tsx + the workspace —
# that the operational saving is not load-bearing).
#
# Build:  docker build -t anchorage-mcp .
# Run:    docker run -p 8080:8080 -v anchorage-data:/data \
#           -e ANCHORAGE_DB_PATH=/data/anchorage.db \
#           -e ANCHORAGE_GITHUB_CLIENT_ID=Iv1.xxx \
#           anchorage-mcp

FROM node:24-alpine

RUN corepack enable

WORKDIR /app

# Copy the workspace manifest first so the install layer caches on
# unchanged dependency manifests.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/server/package.json packages/server/
COPY packages/testbed/package.json packages/testbed/

RUN pnpm install --frozen-lockfile

# Copy the workspace sources after install so source edits don't
# bust the install layer.
COPY . .

# Catch type errors at image-build time rather than at container
# startup. `pnpm -r build` runs `tsc -b` across the workspace; the
# resulting `dist/` is not strictly required at runtime (tsx loads
# from `src/`) but the typecheck pass is.
RUN pnpm -r build

# Bind on 0.0.0.0 inside the container so the TLS-terminating edge
# (Caddy, nginx, Cloudflare, etc.) can route to it. The container
# itself does not terminate TLS — see `docs/deploy.md`.
ENV ANCHORAGE_HOST=0.0.0.0
ENV ANCHORAGE_PORT=8080

# The on-disk SQLite store lives at `/data/anchorage.db`. The host
# must mount a persistent volume here — a fresh disk on each restart
# loses every minted identity, credential, and graph node. The
# deployment docs cover backup cadence.
VOLUME /data
ENV ANCHORAGE_DB_PATH=/data/anchorage.db

EXPOSE 8080

# Liveness probe — the `GET /healthz` handler the slice-4a HTTP
# transport exposes. Production orchestrators (Kubernetes, Fly.io,
# Render, etc.) typically configure their own probe against the
# same endpoint; this `HEALTHCHECK` is the Docker-native fallback
# for `docker ps` and standalone hosts.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1

# `pnpm prod` runs `tsx src/run-prod.ts`, which reads env, stands
# `runProdServer` up, and wires SIGINT/SIGTERM to a graceful shutdown.
CMD ["pnpm", "--filter", "@anchorage/server", "run", "prod"]
