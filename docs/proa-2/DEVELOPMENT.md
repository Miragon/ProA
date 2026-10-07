# ProA 2.0 – Development

How to run, use, build and test ProA 2.0. Spec: [CONCEPT.md](CONCEPT.md); current milestone:
[M1-SKELETON.md](M1-SKELETON.md). The 1.x tree (`backend/`, `frontend/`, Maven) lives next to it,
untouched, until the cut-over PR.

The [Quickstart](#quickstart-docker) and [Troubleshooting](#troubleshooting) were run end to end on
2026-10-07 (macOS, Docker Desktop with Compose v5.5, Node 24.15, pnpm 11.1.3, Claude Code
2.1.292). [Verified end to end](#verified-end-to-end) lists exactly what was run and what was not.

## Status

| Part | State |
|---|---|
| Workspace, TypeScript, ESLint, Prettier, dependency-cruiser, CI (`ci-2.yml`) | working |
| `packages/contracts`: schemas, types, REST route configs, OpenAPI 3.1 | working |
| `packages/client`: hey-api client generated from the contracts | working |
| `packages/bpmn-facts`: `extractFacts` (C7 and C8, CONCEPT §2), `assertSafeXml` (DOCTYPE/ENTITY, UTF-8, 5 MB), 50k-element limit, `factFingerprint`, `factsHash`, `normalizeKey` | working; tested per construct, against hostile XML and on every eval/corpus model |
| `packages/relations`: `runRules` (rule tier + findings), `generateCandidates` (key, lexical, compatible; both directions), `baselineProa1` (the 1.x algorithm), endpoint semantics, DE/EN text similarity | working; unit-tested, gated by `eval:candidates` |
| `apps/server`: full CONCEPT §2 schema, domain use cases with `policy.require`, ingest/import/delete as one transaction (facts, rule tier, assertions, endpoint state, analysis tasks, events) with the real `@proa/bpmn-facts` and `@proa/relations`, every REST route of the contracts, local mode (Host/Origin guard, owner session cookie, owner key for the CLI, agent tokens), MCP `/mcp` with the eight read tools, the built web UI at `/` | working; importing `nordwind-handel` and `stadtwerke-auental` reproduces the rule relations and findings of `eval:candidates` exactly (integration test); MCP contract test with the SDK client |
| `packages/procedures`: procedure Markdown + loader for MCP `get_procedure` | working; only the placeholder `proa-relations@0.0.0` |
| `apps/cli`: `proa seed`, `import`, `token create/list/revoke`, `status`, `health`, and `proa mcp` (stdio bridge for Claude Desktop) | working; unit tests, an e2e test against a real server, and a live check against the running Docker stack |
| `apps/web`: projects (create), per project the tabs Modelle (engine, revision, stage), Relationen (filters, rule vs. key tier, provenance), Befunde, Hochladen (files or a folder via the import endpoint) and Agent verbinden (token, Claude Code/Desktop/generic configurations, revoke); model view with bpmn-js that highlights relation endpoints and switches to the other model; Miragon design system | working; component tests (Testing Library), a Playwright smoke test and the screenshots below; no review actions yet (M2) |
| `eval:candidates` | working; passes on `nordwind-handel` (dev) and `stadtwerke-auental` (holdout); report in `eval/reports/candidates.md` |
| `docker/compose.yaml`, `docker/Dockerfile` | working; `up -d --build --wait` starts PostgreSQL and ProA (migrations at start, owner key in the `proa-state` volume); CI builds it, seeds it and runs the live check against it |

## Quickstart (Docker)

### Prerequisites

- Docker with Compose v2 (Docker Desktop on macOS). That is all ProA itself needs: the image holds
  the server, the web UI and the `proa` CLI.
- Only for the CLI from the checkout, `pnpm dev`, the tests and the "checkout" variant of Claude
  Desktop: Node 24 and pnpm 11.1.3 (`packageManager` in `package.json`), then `pnpm install` at
  the repository root. `.node-version` pins 24.21.0, the version of the image and of CI; any
  Node 24 runs the checkout (`engines`), and a unit test keeps `.node-version`, the image's
  `NODE_IMAGE`, pnpm and the Dockerfile frontend in sync.
- Free ports on 127.0.0.1: 7400 (ProA) and 55432 (PostgreSQL). [Troubleshooting](#troubleshooting)
  shows how to move them.

### Start

```sh
docker compose -p proa2 -f docker/compose.yaml up -d --build --wait   # or: pnpm docker:up
curl -s http://127.0.0.1:7400/health
# {"status":"ok","version":"2.0.0-alpha.0","db":"ok"}
```

This builds the image `proa:local` (the first build takes a few minutes, later ones seconds),
starts PostgreSQL 17 and ProA (compose project `proa2`, containers `proa2-db-1` and
`proa2-proa-1`), runs the migrations and creates the owner key in the volume `proa2_proa-state`.
`--wait` returns once both health checks pass. Both ports are published on 127.0.0.1 only.

### Load the test landscapes

```sh
docker compose -p proa2 -f docker/compose.yaml exec proa proa seed
docker compose -p proa2 -f docker/compose.yaml exec proa proa status
```

`seed` creates `nordwind-handel` (31 models; 9 accepted and 33 proposed relations; 14 findings)
and `stadtwerke-auental` (26 models; 3 accepted, 36 proposed; 17 findings) from `eval/corpus`,
exactly the rule tier that `eval:candidates` computes. Running it again changes nothing.
`proa seed _sample` loads the three-model sample into the project `sample`. Every model starts
at the stage "waiting for agent": the agent pipeline is M2.

### URLs

| What | URL |
|---|---|
| Web UI (you are the owner; local mode has no login) | http://127.0.0.1:7400 (http://localhost:7400 works too) |
| REST API | http://127.0.0.1:7400/api/v1, OpenAPI 3.1 at http://127.0.0.1:7400/api/v1/openapi.json |
| MCP (Streamable HTTP, agent token required) | http://127.0.0.1:7400/mcp |
| Health | http://127.0.0.1:7400/health |
| PostgreSQL | `postgres://proa:proa@127.0.0.1:55432/proa` |

Screenshots with the seeded landscapes (`apps/web/e2e/screenshots.spec.ts`):
[projects](screenshots/01-projects.png), [models](screenshots/02-models.png),
[relations](screenshots/03-relations.png), [model view](screenshots/04-model-view.png),
[findings](screenshots/05-findings.png), [connect an agent](screenshots/06-connect-agent.png),
[Claude Desktop entry](screenshots/07-connect-claude-desktop.png).

![Relations of nordwind-handel: rule acceptances and key-tier proposals](screenshots/03-relations.png)

![Model view: the endpoint of an accepted call highlighted in bpmn-js](screenshots/04-model-view.png)

### Create an agent token

Every MCP client needs an agent token (`proa_at_…`): valid for one project, scopes `proa:read`,
`proa:propose` and `proa:write` (never review), at most 365 days, shown exactly once.

- **Web UI:** open the project → **Agent verbinden** → name, rights, validity → **Token
  erstellen**. The page shows the secret once, ready-to-paste configurations for Claude Code,
  Claude Desktop and other clients, and the token list with **Widerrufen**.
- **CLI in the container** (prints the same configurations; `--json` prints only the token):
  ```sh
  docker compose -p proa2 -f docker/compose.yaml exec proa proa token create \
    --project nordwind-handel --name claude --scopes read,propose --expires 90d
  docker compose -p proa2 -f docker/compose.yaml exec proa proa token list --project nordwind-handel
  docker compose -p proa2 -f docker/compose.yaml exec proa proa token revoke --project nordwind-handel agt_…
  ```

A revoked or expired token is refused with 401 on its next request.

### Connect Claude Code

Claude Code talks to `/mcp` over HTTP with the token as a bearer header:

```sh
export PROA_TOKEN=proa_at_…
claude mcp add --transport http proa http://127.0.0.1:7400/mcp --header "Authorization: Bearer ${PROA_TOKEN}"
claude mcp list
# proa: http://127.0.0.1:7400/mcp (HTTP) - ✔ Connected
```

Without `--scope` this is Claude Code's `local` scope: the server is available in the current
directory only, and the expanded secret is stored in `~/.claude.json`. `--scope user` makes it
available everywhere. To keep the definition in a repository without the secret, use the project
scope with single quotes, so `.mcp.json` holds the literal `${PROA_TOKEN}` and Claude Code reads
it from the environment:

```sh
claude mcp add --scope project --transport http proa http://127.0.0.1:7400/mcp \
  --header 'Authorization: Bearer ${PROA_TOKEN}'
```

```json
{
  "mcpServers": {
    "proa": {
      "type": "http",
      "url": "http://127.0.0.1:7400/mcp",
      "headers": { "Authorization": "Bearer ${PROA_TOKEN}" }
    }
  }
}
```

A project server needs a one-time approval (`claude mcp list` shows `⏸ Pending approval` until
you start `claude` in that directory and approve it). Then ask, for example, "Which processes in
nordwind-handel call the dunning process?"; the tools are listed under [MCP](#mcp). Cursor, VS
Code and Codex use the same URL and header.

### Connect Claude Desktop

Claude Desktop starts local MCP servers over stdio only, so it runs the bridge `proa mcp`, which
relays every message to `/mcp` with `PROA_TOKEN`. Add one entry under `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json` (create the file if it is
missing, keep other entries) and restart Claude Desktop. Claude Desktop does not get your shell's
`PATH` on macOS, so the command must be an absolute path.

**ProA in Docker:** the bridge runs inside the container. `which docker` prints the path; with
Docker Desktop it is `/usr/local/bin/docker`.

```json
{
  "mcpServers": {
    "proa": {
      "command": "/usr/local/bin/docker",
      "args": ["exec", "-i", "-e", "PROA_TOKEN", "proa2-proa-1", "proa", "mcp"],
      "env": { "PROA_TOKEN": "proa_at_…" }
    }
  }
}
```

**Bridge from the checkout** (Node ≥ 24 and `pnpm install` in the checkout; ProA may run in
Docker or with `pnpm dev`). `command` is the absolute path of the Node 24 binary, which
`node -p process.execPath` prints (`which node` may print a version-manager shim that needs your
shell); `args` holds the absolute path of `apps/cli/src/main.ts`:

```json
{
  "mcpServers": {
    "proa": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/<you>/Code/ai-plattform/ProA/apps/cli/src/main.ts", "mcp"],
      "env": { "PROA_URL": "http://127.0.0.1:7400", "PROA_TOKEN": "proa_at_…" }
    }
  }
}
```

The **Agent verbinden** page prints both entries with the real token (enter your Node or Docker
path there). `proa token create` prints the Docker entry when it runs in the container (with
`"command": "docker"` and a reminder to make it absolute) and the checkout entry with its own
absolute Node path when it runs from the checkout. The bridge keeps no state, speaks 2025-11-25
and 2026-07-28, logs to stderr only, and answers every request with a JSON-RPC error naming the
cause if ProA is down or rejects the token.

### Stop and clean up

```sh
docker compose -p proa2 -f docker/compose.yaml stop      # stop; containers and data stay
docker compose -p proa2 -f docker/compose.yaml down      # remove the containers; volumes stay (or: pnpm db:down)
docker compose -p proa2 -f docker/compose.yaml down -v   # also delete proa2_db-data and proa2_proa-state
docker image rm proa:local
```

After `stop` or `down`, `up -d --wait` brings back the projects, the tokens and the owner key.
After `down -v`, start and seed again. Revoke the tokens you handed out (`proa token revoke`),
remove the client entries (`claude mcp remove proa`, plus `-s project` or `-s user` for those
scopes; the entry in `claude_desktop_config.json`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `up` fails: `port is already allocated` or `address already in use` | 7400 or 55432 is taken (`lsof -nP -iTCP:7400 -sTCP:LISTEN`), often by `pnpm dev` (also 7400) or a second ProA. Stop that, or publish other ports: `PROA_HOST_PORT=7500 PROA_DB_PORT=55500 docker compose -p proa2 -f docker/compose.yaml up -d --wait`. The Origin check follows `PROA_HOST_PORT`. Then use `http://127.0.0.1:7500` everywhere (UI, `claude mcp add`, `PROA_URL`); `proa token create` in the container still prints 7400 in its Claude Code command. With another database port, `pnpm dev` needs `DATABASE_URL=postgres://proa:proa@127.0.0.1:55500/proa`. |
| 403 `local mode accepts only localhost Host headers` | ProA was opened by a name or address other than `localhost`, `127.0.0.1` or `[::1]` (a LAN IP, a `.local` name, a proxy). Local mode serves this machine only: use http://127.0.0.1:7400. |
| 403 `local mode accepts only localhost origins on the ProA ports (PROA_ORIGIN_PORTS)` | A browser page on another port called ProA (another app, a dev server on a new port). Allowed are localhost origins on `PROA_ORIGIN_PORTS`: in Docker the published port and 7401, with `pnpm dev` 7400 and 7401. Add a port with `PROA_ORIGIN_PORTS=7400,<port>` on the server. curl, the CLI and MCP clients send no `Origin` and are not affected. |
| 401 `send an agent token (Authorization: Bearer proa_at_…) or open a session` | A REST call without credentials. The web UI opens its session itself; scripts use `POST /api/v1/session` (cookie, see below) or an agent token. |
| 401 on `/mcp`: `MCP needs an agent token …` or `invalid, expired or revoked agent token` | Missing, wrong, revoked or expired token, or the owner key (`proa_ok_…`), which MCP never accepts. Create a new token. Claude Code shows `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401)`; the bridge answers `ProA at … rejected the agent token (401 …); check PROA_TOKEN`. |
| `claude mcp list`: `⏸ Pending approval` | A project server from `.mcp.json` is not approved yet: start `claude` in that directory and approve `proa`. |
| `claude mcp list`: `Missing environment variables: PROA_TOKEN` | `.mcp.json` refers to `${PROA_TOKEN}`: export it in the shell that starts Claude Code. |
| Claude Desktop lists `proa` as failed | Usually a command it cannot find (no shell `PATH`): use absolute paths (`/usr/local/bin/docker`, the output of `node -p process.execPath`). The Docker entry also needs the running container `proa2-proa-1` (`docker ps`). Try the entry by hand: `PROA_TOKEN=… /usr/local/bin/docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp` must wait for input instead of exiting. |
| The server exits at start: `… is accessible by group or others (mode 644); run: chmod 600 …` | The owner key file is readable by others; run the printed `chmod`. Other owner key errors (`belongs to another OS user`, `does not hold an owner key; delete it …`) name their fix too. |
| `proa seed`/`token` on the host: no owner key | The Docker server's key lives in its volume. Run the CLI in the container (`docker compose … exec proa proa …`) or copy the key, see [Local mode](#local-mode-who-is-calling-concept-6). |
| `proa …` on the host: `401 Unauthorized): invalid owner key`, or `proa status`: `does not accept the owner key at …` | The key file on the host belongs to another ProA instance (usually `~/.local/state/proa/owner-key` from an earlier `pnpm dev`), while the Docker server has its own key in its volume. Run the CLI in the container, or copy the container's key and set `PROA_OWNER_KEY_FILE` (see [Local mode](#local-mode-who-is-calling-concept-6)). `proa status` then shows the server only; the other commands fail. |
| The server exits at start: `PROA_HOST=… is not a loopback address` | Local mode has no login, so it listens on 127.0.0.1 only. Unset `PROA_HOST`. In a container (which must listen on 0.0.0.0) publish the port on 127.0.0.1 only and set `PROA_ALLOW_NON_LOOPBACK=1`, as `docker/compose.yaml` does: `docker run -p 127.0.0.1:7400:7400 -e PROA_ALLOW_NON_LOOPBACK=1 -e DATABASE_URL=… proa:local`. |
| UI: "Server nicht erreichbar" or "Datenbank nicht erreichbar" | ProA or PostgreSQL is down or restarting: `docker compose -p proa2 -f docker/compose.yaml ps`, `… logs proa`. |
| Integration or e2e tests cannot start PostgreSQL | Testcontainers needs a running Docker; or set `PROA_TEST_DATABASE_URL` to a PostgreSQL whose user may `CREATEDB`. |

## Development without Docker

```sh
pnpm install
pnpm db:up          # only PostgreSQL of docker/compose.yaml, on 127.0.0.1:55432
pnpm dev            # server on 127.0.0.1:7400 (node --watch) + Vite on http://127.0.0.1:7401
pnpm seed           # second terminal: the eval landscapes, as the owner
pnpm proa status    # models by stage, relations by status, findings per project
```

Vite proxies `/api`, `/mcp` and `/health` to the server. The server runs pending migrations at
startup (`PROA_MIGRATE=off` disables it), creates the owner key on its first start
(`~/.local/state/proa/owner-key`, below) and serves `apps/web/dist` at `/` if it exists, so after
`pnpm build` the UI is also at http://127.0.0.1:7400. `pnpm dev` and the `proa` container both
use port 7400: stop the container first (`docker compose -p proa2 -f docker/compose.yaml stop
proa`). With the checkout CLI against the Docker server, copy the container's owner key (see
[Local mode](#local-mode-who-is-calling-concept-6)).

## Reference

### Layout

```
apps/server/      @proa/server  Hono + @hono/zod-openapi, Drizzle + pg, MCP (src/{domain,db,http,mcp,auth})
apps/cli/         @proa/cli     the `proa` command (commander)
apps/web/         @proa/web     React 19 + Vite + Tailwind v4 + shadcn + TanStack (src/{routes,components,lib,theme}, test/, e2e/)
packages/contracts/  zod schemas, types, REST route configs, buildOpenApiDocument()
packages/client/     hey-api client generated from the contracts (src/generated is generated)
packages/bpmn-facts/ fact extraction (CONCEPT §2)
packages/relations/  rules, candidates, baseline-proa1
packages/procedures/ agent procedures as Markdown with id/version frontmatter (MCP get_procedure)
eval/tools/       @proa/eval-tools: corpus generator/validator (.mjs) + eval:candidates (src/*.ts)
docker/           compose.yaml (project proa2), Dockerfile
docs/proa-2/      CONCEPT.md, M1-SKELETON.md, this file, screenshots/
```

Package dependencies point one way: `contracts` ← `bpmn-facts` ← `relations` ← `server`;
`contracts` ← `client` ← `cli`, `web`. Workspace dependencies use `workspace:0.0.0`.

### Commands (repository root)

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc` in every package |
| `pnpm lint` | ESLint (type-aware) in every package; the server also runs dependency-cruiser |
| `pnpm test` | vitest in every package (server integration and CLI e2e tests need Docker), `node --test` in eval/tools |
| `pnpm format` / `pnpm format:check` | Prettier over the 2.0 workspace (`.prettierignore` keeps 1.x, eval, Markdown, snapshots and generated files out) |
| `pnpm build` | builds the web UI (`apps/web/dist`) |
| `pnpm eval:candidates` | the LLM-free eval gate; writes `eval/reports/candidates.{md,json}`, exit 1 if a gate fails |
| `pnpm --filter @proa/eval-tools check` / `validate:all` / `test` | the corpus: models in sync with their specs, full validation of every landscape, the toolchain tests |
| `pnpm docker:up` | the whole Compose stack (PostgreSQL + ProA on 127.0.0.1:7400), built fresh |
| `pnpm db:up` / `pnpm db:down` | only PostgreSQL up (for `pnpm dev`) / the whole stack down (volumes stay) |
| `pnpm db:migrate` | applies migrations to `DATABASE_URL` |
| `pnpm dev` | server (`node --watch`, 127.0.0.1:7400) and Vite (127.0.0.1:7401) in parallel |
| `pnpm seed` | `proa seed`: one project per scored eval landscape |
| `pnpm proa <command>` | the `proa` CLI from the checkout; relative paths resolve against the directory you run it in |
| `PROA_LIVE_URL=http://127.0.0.1:7400 pnpm --filter @proa/cli test:live` | live check of a running, seeded ProA: tokens, MCP over HTTP, the stdio bridge as Claude Desktop starts it (see [Tests](#tests)) |
| `pnpm --filter @proa/web e2e smoke` | Playwright smoke test against a running ProA (`PROA_E2E_URL`, default http://127.0.0.1:7400); creates its own project `e2e-<time>` |
| `PROA_SCREENSHOTS_DIR=$PWD/docs/proa-2/screenshots pnpm --filter @proa/web e2e screenshots` | retakes the screenshots from a running, seeded ProA |
| `pnpm --filter @proa/client generate` | regenerates `packages/client` after a contracts change |
| `pnpm --filter @proa/server db:generate` | writes the next migration after a schema change |

### Server configuration

| Variable | Default | |
|---|---|---|
| `PROA_PORT` | `7400` | |
| `PROA_HOST` | `127.0.0.1` | local mode refuses to start on a non-loopback address unless `PROA_ALLOW_NON_LOOPBACK=1` |
| `PROA_ALLOW_NON_LOOPBACK` | `0` | `1` lets local mode bind e.g. `0.0.0.0` (with a warning at start): only inside a container whose port is published on 127.0.0.1; compose sets it, the image does not |
| `DATABASE_URL` | `postgres://proa:proa@127.0.0.1:55432/proa` | the compose database |
| `PROA_AUTH` | `local` | the only mode in v1 (CONCEPT §6) |
| `PROA_WEB_DIST` | `apps/web/dist` if built | empty string disables UI serving |
| `PROA_MIGRATE` | `auto` | `off` skips migrations at startup |
| `PROA_ORIGIN_PORTS` | `PROA_PORT,7401` | ports a localhost `Origin` may use; compose sets `PROA_HOST_PORT,7401` |
| `PROA_SESSION_SECRET` | random per process | key of the session cookie (≥ 32 characters); without it a restart ends every session (the UI reopens its session by itself) |
| `PROA_OWNER_KEY_FILE` | `$XDG_STATE_HOME/proa/owner-key`, else `~/.local/state/proa/owner-key` | the CLI's owner key, created on first start; `/var/lib/proa/owner-key` in the image; empty string: no owner key |

`docker/compose.yaml` reads `PROA_HOST_PORT` (default `7400`) and `PROA_DB_PORT` (default
`55432`) for the published ports, and sets `PROA_CONTAINER=proa2-proa-1`, so `proa token create`
in the container prints the `docker exec` entry for Claude Desktop.

Local mode rejects any request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]`, or whose
`Origin` is not one of those hosts on a `PROA_ORIGIN_PORTS` port (403 `forbidden`), on REST, MCP
and the UI alike. The Host check keeps browsers (DNS rebinding) out, not other machines: a
non-browser client sets any `Host`, so the bind address is the boundary, and local mode binds
loopback only (`PROA_ALLOW_NON_LOOPBACK`).

Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy` and `Cross-Origin-Opener-Policy`
`same-origin`, and a CSP: the web UI gets `script-src 'self'` (no inline or foreign scripts) and
`frame-ancestors 'none'`; REST, MCP and `/health` get `default-src 'none'; frame-ancestors
'none'; sandbox`. Uploaded BPMN is stored verbatim and may hold anything (an XHTML `<script>` in
`extensionElements`, for instance); `GET …/revisions/{r}/content` therefore answers with
`Content-Disposition: attachment` under that sandbox CSP, so a browser downloads it instead of
running it on the ProA origin with the owner's session.

### Local mode: who is calling (CONCEPT §6)

Local mode has one human, the **owner**, and any number of **agent tokens**.

- **Owner session.** `POST /api/v1/session` (body optional: `{"client": "proa-web" | "proa-cli"}`)
  sets the cookie `proa_session` (HttpOnly, SameSite=Strict, Path=/, 12 h, no `Secure` because
  local mode is plain http). The value is `v1.<client>.<issued-at>.<nonce>.<HMAC-SHA256>`; it
  names no user, because local mode has exactly one. Requests with a valid cookie act as the
  owner on that interactive client (a human: all scopes, owner of the projects it creates).
  `DELETE /api/v1/session` clears it. The web UI calls `POST /api/v1/session` on start and
  again after a 401 (the Vite dev server shares the cookie, since cookies ignore ports). The
  endpoint is open to any client on localhost — that is the trust model of local mode (CONCEPT
  §6 "Remaining risk: an agent driving the user's browser or CLI"); the Host/Origin guard keeps
  websites and DNS rebinding out.
- **Owner key** (the CLI's bootstrap credential, `Authorization: Bearer proa_ok_…`, REST only).
  On its first start the server creates `PROA_OWNER_KEY_FILE`: directory mode 0700, file created
  exclusively with mode 0600, content `proa_ok_` + 43 base64url characters (256 random bits).
  An existing file is used only if it is a regular file of the server's OS user that group and
  others cannot access (like an ssh key); otherwise the server refuses to start and names the
  `chmod`. The key is never logged (the log names the file), never stored in the database, and
  compared in constant time against its sha256 in memory. The `proa` CLI on the same machine
  reads the same file (same checks) and acts as the owner on the interactive client `proa-cli`:
  `seed`, `import --create` and `token …` need it. MCP never accepts it, and the CLI refuses it
  as `--token`/`PROA_TOKEN`. Rotate it by deleting the file and restarting the server. With
  Docker, run the CLI in the container (`docker compose -p proa2 -f docker/compose.yaml exec proa
  proa …`), or copy the key to the host with a private umask and point the CLI at it:
  ```sh
  mkdir -p ~/.local/state/proa
  (umask 077; docker compose -p proa2 -f docker/compose.yaml exec -T proa cat /var/lib/proa/owner-key \
    > ~/.local/state/proa/docker-owner-key)
  PROA_OWNER_KEY_FILE=~/.local/state/proa/docker-owner-key pnpm seed
  ```
  Why a file and not the open session endpoint: the key binds owner rights to the OS account
  that started the server (other local accounts cannot read it), and it lets the session
  endpoint be closed later without touching the CLI. Until the web UI has a login step, that
  endpoint stays open, so on a shared multi-user machine local mode is not yet a boundary
  between OS accounts; the next step is a one-time login link for the browser (printed by the
  CLI, signed with the owner key) and a switch that closes `POST /api/v1/session` otherwise.
- **Agent tokens** (`Authorization: Bearer proa_at_…`): created by the owner on an interactive
  client (`POST /api/v1/projects/{p}/agent-tokens`, secret shown once), stored as sha256 plus an
  8-character prefix; one project, scopes `proa:read`/`proa:propose`/`proa:write` (never
  review), expiry 1–365 days (default 90), revocation, `last_used_at` (written at most once a
  minute). A token acts as `editor` (`viewer` if read-only) in its project; any other project
  is 404. A bearer header always wins over the cookie; an invalid token is 401
  `error="invalid_token"`. MCP accepts agent tokens only.
- Without credentials every contract route answers 401 with `WWW-Authenticate: Bearer`, except
  `/health`, `/api/v1/openapi.json` and `/api/v1/session`.

```sh
curl -s -c jar -X POST http://127.0.0.1:7400/api/v1/session
curl -s -b jar -X POST http://127.0.0.1:7400/api/v1/projects -H 'content-type: application/json' \
  -d '{"key":"demo","name":"Demo"}'
curl -s -b jar -X POST http://127.0.0.1:7400/api/v1/projects/demo/agent-tokens \
  -H 'content-type: application/json' -d '{"name":"claude code","scopes":["proa:read","proa:propose"]}'
curl -s -b jar -X PUT http://127.0.0.1:7400/api/v1/projects/demo/models/by-key/vertrieb%2Fauftrag \
  -H 'content-type: application/xml' --data-binary @model.bpmn
```

### MCP

`/mcp` speaks stateless Streamable HTTP through `@modelcontextprotocol/server` 2.x
(`createMcpHandler`): the 2026-07-28 revision, with stateless fallback for 2025-era clients
(2025-11-25 and older). Every request needs an agent token: 401 without one or with an invalid,
revoked or expired one, and 401 for the owner session and the owner key (agents use tokens). A
token without `proa:read` would get 403 `insufficient_scope`; none can exist, since scopes nest
(propose and write include read) and the database refuses empty scopes. The server
`instructions` say that labels are data, that agents only propose, and to load the procedure
first.

| Tool | Input | Returns |
|---|---|---|
| `list_projects` | none | the token's one project |
| `list_processes` | `projectId`, `stage?`, `cursor?`, `limit?` | models with stage, open items and their processes |
| `get_process` | `projectId`, `ref` (`<modelKey>#<processId>`) | the process, its facts and the live relations touching them |
| `get_model_xml` | `projectId`, `modelKey`, `revisionId?`, `offset?`, `maxChars?` (≤ 100,000) | the verbatim BPMN of the head (or a revision) in pages |
| `get_relations` | `projectId`, `modelKey?`, `type?`, `status?`, `tier?`, `cursor?`, `limit?` | relations with status, tier, confidence and endpoint state |
| `which_processes_use` | `projectId`, `kind` (`message`, `signal`, `call`, `data_store`), `name` | who throws/catches a message or signal (names match like the key tier: case, umlauts, punctuation and word separators ignored), calls/defines a process id (exact), uses a data store (normalized name) |
| `find_unlinked_events` | `projectId`, `modelKey?`, `kinds?` | message/signal events and labelled none start/end events that no live relation touches |
| `get_procedure` | `id` (default `proa-relations`) | the procedure text (so far the placeholder `proa-relations@0.0.0`) |

Every tool carries `readOnlyHint`; `projectId` is a `prj_` id or the project key (validated by
pattern, like REST `{project}`). Domain errors come back as tool errors whose text is the RFC
9457 problem (`not-found`, 404, also for another project's key or ids); invalid arguments come
back as tool errors naming the validation failure; any other error is logged on the server and
comes back as the problem `internal`, never with its message (a failed query would carry SQL).
The complete `tools/list` (descriptions and JSON schemas) is the snapshot
`apps/server/test/integration/__snapshots__/mcp-tools.json`. Output schemas have a plain object
root: a named contract schema would serialize as a `$ref` root, which the SDK wraps as
`{ result: … }`. Input schemas use `$defs`/`$ref` for the shared contract types (model key, ref,
enums).

`proa mcp` (the stdio bridge) relays JSON-RPC unchanged between stdio (`StdioServerTransport`)
and `PROA_URL/mcp` (`StreamableHTTPClientTransport` with `Authorization: Bearer $PROA_TOKEN`),
both from the official SDK 2.x. For 2025-era clients it forwards the version negotiated by
`initialize` as `MCP-Protocol-Version`. stdout carries only the protocol; it exits when the
client closes stdin.

### The `proa` CLI

`node apps/cli/src/main.ts` (`pnpm proa` from the checkout, `proa` in the container). Global
options: `--url` (`PROA_URL`, default http://127.0.0.1:7400), `--token` (`PROA_TOKEN`, an agent
token), `--owner-key-file` (`PROA_OWNER_KEY_FILE`).

| Command | Credential | |
|---|---|---|
| `proa seed [landscape…] [--corpus dir] [--issue-tokens] [--verbose] [--json]` | owner key | one project per landscape of `eval/corpus` (default: every scored one, i.e. not starting with `_`; `_sample` seeds into `sample`), named after `landscape.yaml`; imports `models/`; safe to repeat (unchanged models stay unchanged) |
| `proa import <dir> --project <key> [--create [--name n]] [--json]` | agent token (`proa:write`) or owner key | every `.bpmn`/`.bpmn2`/`.bpmn20.xml` below `<dir>`, in requests of ≤ 50 files and ≤ 25 MB; the model key is the path below `<dir>`; per-file outcome; exit 1 if a file failed |
| `proa token create --project <key> [--name] [--scopes …] [--expires 90d] [--json]` | owner key | scopes `proa:read`, `proa:propose`, `proa:write` (also `read,propose`); expiry `Nd` or `Nw`, ≤ 365 days |
| `proa token list` / `proa token revoke <id>` (`--project <key>`) | owner key | |
| `proa status [--project <key>] [--json]` | agent token or owner key (optional) | health, caller, per project models by stage, relations by status, accepted relations with changed/missing endpoints, findings |
| `proa health` | none | |
| `proa mcp` | agent token | the stdio bridge above |

### Web UI

`apps/web` is the owner's UI in local mode (CONCEPT §6, M1-SKELETON item 9). In development it
runs under Vite on http://127.0.0.1:7401 (`pnpm dev`, proxying `/api`, `/mcp` and `/health` to
the server); after `pnpm build` the server serves it at http://127.0.0.1:7400.

| Route | Content |
|---|---|
| `/` | projects (name, key, role, `s<seq>`), "Neues Projekt" (key slugified from the name) |
| `/projects/{key}` | **Modelle**: key, name, engine (C7/C8), head revision, stage (CONCEPT §3), open items; stage filter `?stage=` |
| `/projects/{key}/relations` | **Relationen**: quick filters (all, accepted by rule, key-tier proposals, all proposals), filters status/tier/type/model in the URL (`?status=&tier=&type=&model=`); type, from → to with element label, model key and process, tier, status, endpoint state, confidence, provenance, details (refs, version, attributes); "Im Modell" opens the model view. The "Aktion" column is where the M2 review actions go (`renderActions` of `RelationTable`). |
| `/projects/{key}/findings` | **Befunde** grouped by kind, each ref with a link into the model view |
| `/projects/{key}/upload` | **Hochladen**: drag and drop files or a whole folder, or pick them; `POST …/imports` in batches of ≤ 50 files / 25 MB (models > 5 MB and non-BPMN files are skipped and listed); a dropped or picked folder is the import root, so `models/vertrieb/a.bpmn` becomes `vertrieb/a`, like `proa import models`; outcome per file |
| `/projects/{key}/agents` | **Agent verbinden**: create an agent token (scopes, expiry), secret shown once with a copy button, then ready-to-paste configurations: Claude Code (`claude mcp add --transport http …`), Claude Desktop (`proa mcp` from the checkout with Node 24, or `docker exec -i … proa2-proa-1 proa mcp`; the Node or Docker path you enter becomes `command`), any other MCP client (URL + bearer header, `.mcp.json`); list and revoke tokens |
| `/projects/{key}/models/{model-key}` | **Model view**: borderless bpmn-js `NavigatedViewer` (lazy chunk) with floating chrome; the panel lists the model's relations and findings; `?relation=rel_…` highlights its endpoints (marker plus "Von"/"Nach" label) and offers "Zu … wechseln" to the other model; `?element=` highlights one element (from findings or a click on the canvas, which also filters the list) |

How it talks to the server: only through `@proa/client` (generated from the contracts) with
`baseUrl` = the page's origin. `src/lib/api.ts` wraps `fetch`: on a 401 it calls
`POST /api/v1/session` once (parallel 401s share it) and repeats the request, so the UI never
holds a token and survives server restarts. `unwrap()` turns problem+json into `ApiError`.
`src/` imports only *types* from `@proa/contracts` (ESLint enforces it; the zod schemas would
land in the bundle) and mirrors the few constants it needs in `src/lib/limits.ts`, which
`test/limits.test.ts` compares with the contracts. Two things the API does not carry yet are
derived in the UI: the **engine** comes from each head revision's XML (`modeler:executionPlatform`,
else the zeebe/camunda namespace, like `@proa/bpmn-facts`; the content is cached per revision), and
the **provenance** column comes from tier and rule attributes (`proa-rules/1.0.0` for the rule and
key tiers and rule proposals by file stem or process name, agent for lexical/semantic, human for
manual) until the API exposes assertions. Element labels come from the facts of every head
revision (`GET …/revisions/{r}/facts`, cached per revision).

Design: `miragon-brand:modeler-tool-design`. `src/theme/cd-tokens.generated.css` is vendored
unchanged from the skill (re-copy it to update, never edit it); `src/index.css` maps the shadcn
tokens onto it (one light mode, no dark theme, CI radii and shadows, Geist and Geist Mono
self-hosted), `src/theme/tokens.ts` mirrors the palette for code and `test/theme.test.ts` is the
drift test. UI texts are German with "du". The favicon and empty-state mark are the official
Miragon app icon. shadcn components live in `src/components/ui` (added with
`pnpm dlx shadcn@4.21.2 add …`, then adapted: CI radii, blue primary hover, badge radius, toggle
and dialog backdrop); toasts are a small Radix-based `Toaster` (`src/lib/toast.ts`).

## Conventions

**TypeScript runs from source.** Node 24 strips types natively, so the server and the CLI run
`node src/main.ts` without a build step, and workspace packages export `./src/index.ts`. That
requires:

- relative imports with the `.ts` extension (`import { x } from './x.ts'`); the web app, bundled
  by Vite, uses extensionless imports and the `@/` alias like shadcn;
- erasable syntax only (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter
  properties;
- `import type` for types (`verbatimModuleSyntax`).

TypeScript is 6.0.3: TypeScript 7 is published, but typescript-eslint 8.71 supports `<6.1`.

**Dependencies.** Exact versions only; `pnpm add` saves exact versions (`saveExact` in
`pnpm-workspace.yaml`, which is where pnpm 11 reads its settings). pnpm 11 refuses releases younger
than a day, runs no install scripts unless listed under `allowBuilds`, and pins one `vite` via
`overrides`. After editing `pnpm-workspace.yaml` alone, `pnpm install` may report "Already up to
date"; touching `package.json` makes it re-resolve.

**Contracts first.** REST routes are declared once in `packages/contracts/src/api/routes.ts`
(zod-to-openapi route configs). The server implements them with
`app.openapi(createRoute(apiRoutes.x), handler)` inside a `register…Routes(app, deps)` function
called from `src/app.ts`; any contract route without a handler answers 501, so the served
OpenAPI document never points into a 404 (a safety net: `createProaApp` returns these
`placeholders`, and a unit test requires none, plus a real `app.openapi` handler for every
contract operation). Every route with params, query or a body declares 422 (a contracts test
checks it), since the validation hook answers malformed input with `validation-failed`. `GET /api/v1/openapi.json` serves
`buildOpenApiDocument()` from the contracts. After changing contracts, run
`pnpm --filter @proa/client generate`; CI fails if `packages/client` is stale. On schemas with a
`.meta({ id })`, use `orNull(schema)` instead of `.nullable()` (zod-to-openapi drops the `null`
otherwise).

**Server layers** (`apps/server/src`): `domain` (use cases, `DomainError`, no imports from `db`,
`http`, `mcp`, `auth` or from hono/pg/drizzle/MCP packages, enforced by
`.dependency-cruiser.cjs` in `pnpm lint`), `db` (Drizzle, `casing: 'snake_case'`, migrations in
`apps/server/drizzle/`), `http` (routes, problem+json via `problemResponse` and
`DomainError` mapping), `mcp` (tools registered in `createMcpServer`), `auth` (local guard,
session cookie, bearer/cookie → `Actor`). `src/analysis.ts` binds the domain's `AnalysisPort`
to `@proa/bpmn-facts` and `@proa/relations`; tests inject doubles through `createProaApp`.

**Domain** (`apps/server/src/domain`). Ports in `ports.ts` (`Store` with `read` = REPEATABLE READ
read-only snapshot and `write` = one transaction; repositories that only find rows *in a
project*; `AnalysisPort`). Every use case (`use-cases/*`) starts with
`policy.require(tx, actor, permission, projectRef)` (`policy.ts`: the CONCEPT §6 matrix; unknown
and foreign projects are 404). `ingest.ts`: `PUT`, import and seed go through
`ingest(project, files, actor)` — facts are extracted before the transaction; the transaction
locks the project row, stores revisions and facts, runs `recomputeProject` once
(`recompute.ts`: rule tier over the head facts, rule assertions, `recomputeStatus`, endpoint
state, findings) and queues `relations` tasks (a new task only when `facts_hash` differs from
the last `done` task; an open task for other facts is cancelled). Identical bytes are
`unchanged` without revision or event. Rule assertions follow the rules: an unambiguous call is
a rule decision `accept`, everything else a rule proposal, re-asserted when the endpoint
fingerprints change and withdrawn when no longer derived — except an acceptance whose endpoint
is missing (deleted model), which stays accepted with `endpoint_state = missing`, an open item.
A human decision always outranks the rule. Every write appends events with a dense per-project
`seq` (`UPDATE project SET last_seq = last_seq + 1 RETURNING`).

**Schema** (`src/db/schema.ts`, CONCEPT §2): `project`, `principal`, `membership`, `invitation`
(unused in M1), `agent_token`, `model`, `model_revision` (verbatim bytes as `bytea`, processes
and message flows as jsonb), `fact`, `relation` (+ generated `from_model`/`to_model`, anchor
fingerprints), `relation_assertion` (check: agents never decide), `analysis_task` (partial
unique index: one open task per model and kind), `analysis_submission`, `event`, `finding`
(derived, replaced by every ingest), and the view `model_pipeline` (stage and open items).
Child tables use composite foreign keys `(project_id, x_id)`. `event`, `relation_assertion` and
`analysis_submission` are append-only (trigger in `drizzle/0001_append_only.sql`, hand-written).
Migrations: `pnpm --filter @proa/server db:generate` for schema changes,
`pnpm --filter @proa/server exec drizzle-kit generate --custom --name <name>` for SQL drizzle-kit
does not model.

**Facts** (`packages/bpmn-facts`). `extractFacts(xml, {modelKey})` rejects hostile or broken
input with a `BpmnInputError` (`doctype-forbidden`, `entity-forbidden`, `too-large`,
`too-many-elements`, `not-xml`, `not-bpmn`, `invalid-model-key`; the server maps it to 422
`bpmn-invalid`, 413 for `too-large`) and returns non-fatal `warnings` otherwise. It parses with
bpmn-moddle plus the camunda (C7) or the zeebe (C8) extension, chosen from
`modeler:executionPlatform` or the declared namespace (the two extensions cannot be loaded
together). Facts follow CONCEPT §2; `attrs` keys are declared in `FactAttrs` (`@proa/contracts`):
`messageName`/`signalName` only when the key comes from a real message/signal ref (rules never
match labels), `dynamic` for expressions (C7 `${…}`/`#{…}`, C8 `=…`), call binding/version/tenant,
`correlationKey`, `subprocessId`, `readBy`/`writtenBy`, `flowNodeRefs`. Timer, conditional, error,
escalation, link and compensation events produce no facts except none/timer/conditional starts and
none/terminate ends (out of v1). Any change to extraction, normalization or fingerprints needs a
new `FACTS_VERSION`; the corpus snapshots (`test/__snapshots__/*.facts.txt`) make such changes
visible.

**Relations** (`packages/relations`, no LLM). `runRules(projectFacts)` is the rule tier of
CONCEPT §2: a constant `calledElement` that exactly one other process has as id is `accepted`
(tier `rule`, `proa-rules/1.0.0`, binding/version/tenant in `attrs`); two or more processes with
the id give `key`-tier proposals (confidence 1/n) and `duplicate-process-id`; no match gives
`unresolved-call` plus proposals by file stem (`key`, 0.8) or process name (`lexical`, 0.6); an
expression gives `dynamic-call`. Identical message or signal names (`nameKey`: `normalizeKey`
without word separators, so umlaut, case and `_` variants match) of real refs in different
processes are `key`-tier proposals with confidence 1.0, never accepted, unless a message flow in
the file joins them. `dangling-throw`/`unmatched-catch` mark message and signal endpoints without
such a partner and without a message flow; rules see names only, so endpoints that only a
semantic link (other words or language) connects are reported too. Endpoints follow
`endpointRole` and `EVENT_DEF_COMPATIBILITY` (starts/ends in embedded subprocesses and ends in
event subprocesses never; the typed event-subprocess start yes; timer/conditional starts and
terminate ends never; `trigger` = labelled none end → labelled none start). `generateCandidates`
offers per endpoint the rule/key pairs, the top 5 lexical matches (score
`0.6 · concept Jaccard + 0.4 · relative Levenshtein`; camelCase split, DE/EN stopwords, a short
generic DE/EN synonym list with inflection, `ge…` participle and compound-head handling) and up
to 30 further compatible endpoints; calls only while their target is open. With a focus model it
returns that model's perspectives (a subset of the unfocused run). `baselineProa1` reproduces
1.x: search label (lowercase, non-ASCII-alphanumerics → space, words sorted and joined),
Levenshtein ≤ 4 between every end/intermediate throw and every start/intermediate catch
(whatever the event definition, scope or process), call activities by label to process-model
name (file stem, or process/pool name in collaborations). Facts lack timer/conditional/link and
error/escalation events, so the eval passes them in as `extraEvents` from a full parse.

**Errors** are RFC 9457 `application/problem+json` with `type` `urn:proa:problem:<code>` and a
`code` member; codes and statuses are in `PROBLEMS` (`@proa/contracts`).

## Tests

- Unit tests live in each package's `test/`. The server has two vitest projects:
  `pnpm --filter @proa/server test:unit` (no Docker) and `test:integration` (real PostgreSQL).
- Integration tests get one PostgreSQL 17.11 per run from Testcontainers (`test/global-setup.ts`);
  each test file calls `createTestDatabase()` (`test/support/db.ts`) for its own migrated database
  and `drop()`s it afterwards, so files run in parallel. Testcontainers removes its containers
  itself. To use an existing server instead, set
  `PROA_TEST_DATABASE_URL=postgres://user:pass@host:port/db` (the user needs `CREATEDB`).
- Server integration tests (`apps/server/test/integration`): ingest and import (idempotency,
  revisions, facts, rule relations, endpoint state, stages, task queueing), the policy matrix
  over REST (owner session, tokens per scope, foreign project, anonymous), token lifecycle and
  sessions, database constraints (append-only triggers, agents never decide, one open task,
  composite foreign keys), and MCP with the plain SDK client over real HTTP plus a raw
  2025-11-25 JSON-RPC exchange. These use `test/support/fake-analysis.ts` (BPMN-looking
  documents that carry their facts, and a small rule tier) to stay small and precise.
  With the real libraries: `real-libraries.test.ts` ingests `eval/corpus/_sample` against its
  `expected.yaml`; `corpus.test.ts` imports `nordwind-handel` and `stadtwerke-auental` into
  one project each and requires exactly the models, facts, rule relations (type, endpoints,
  status, tier, confidence, attributes) and findings that `eval:candidates` computes
  (`eval/reports/candidates.json`), no change on re-import, a new revision plus recomputed
  relations and findings for a changed model, and `endpoint_state = missing` for accepted calls
  into a deleted model (restored on re-upload). `owner-key.test.ts` covers the CLI credential.
  `hardening.test.ts` (real libraries): control characters in BPMN attributes are stored
  sanitized instead of failing the transaction; an event with a message and a signal
  definition anchors each relation to the fact of its own kind; `which_processes_use` matches
  names like the key tier; malformed MCP/REST input (NUL in a project ref, cursor or name) is
  a validation error and an unexpected error reaches agents only as `internal`; revision
  content is a sandboxed download.
  `test/unit/policy.test.ts` checks the generated matrix permission × role × scopes × principal
  kind.
- `apps/cli`: `pnpm --filter @proa/cli test:unit` (commands against a fake REST API, owner key
  file checks, the MCP bridge against the SDK's in-memory `createMcpHandler`) and `test:e2e`:
  starts `node apps/server/src/main.ts` as a child process on a free port with its own database
  (Testcontainers, or `PROA_TEST_DATABASE_URL`) and owner key, runs `proa seed`, `import`,
  `token`, `status` against it, and spawns `proa mcp` the way Claude Desktop does, talking to it
  with the SDK's `StdioClientTransport` in 2025-11-25 and 2026-07-28 (initialize, tools/list,
  `list_processes`), plus a revoked token.
- `apps/web` (`pnpm --filter @proa/web test`, vitest on jsdom with Testing Library):
  `relation-table.test.tsx` (order, rule acceptances vs. key-tier proposals, labels, quick
  filters, filters, details, action slot, provenance), `connect-agent.test.tsx` (token list and
  states, creation with the request body, secret shown once, exact Claude Code command, Claude
  Desktop node/Docker configurations, generic client, revocation after confirmation, problem
  toast), `upload-panel.test.tsx` (folder paths, batches, per-file outcomes, skipped files),
  `api.test.ts` (session on 401, one session for parallel 401s, problems), `lib.test.ts` (engine
  detection against every corpus spec, upload planning, snippets, slugs, refs, filters),
  `app.test.tsx` (routes rendered on the server), `theme.test.ts` (token drift) and
  `limits.test.ts`. The tests stub `fetch` and talk through the real generated client.
- `apps/web/e2e/smoke.spec.ts` (Playwright, Chromium): creates its own project `e2e-<time>`,
  imports `eval/corpus/_sample` and walks projects → relations (rule acceptance, key-tier quick
  filter) → model view (endpoint highlighted in the caller, switch to the called model), re-imports
  the folder through the upload page (all `unchanged`), checks findings and creates a token. It
  needs a running server with the built UI and skips itself otherwise, so it is not part of
  `pnpm test` or CI:
  ```sh
  pnpm db:up && pnpm build && node apps/server/src/main.ts &   # or: pnpm docker:up
  pnpm --filter @proa/web exec playwright install chromium     # once
  pnpm --filter @proa/web e2e                                  # PROA_E2E_URL=http://127.0.0.1:7400
  ```
- `packages/bpmn-facts/test/hostile.test.ts` also appends NUL, a right-to-left override and SOH
  to every text attribute of every corpus model and requires the same facts as for the clean
  file, with no control or bidi character anywhere in the result.
- `packages/bpmn-facts/test/corpus.test.ts` extracts every model of `eval/corpus` (no warnings
  allowed), checks that every `expected.yaml` endpoint resolves to a fact of a compatible kind
  and that the deterministic findings follow from the facts, and compares a fact summary per
  landscape with `test/__snapshots__/<landscape>.facts.txt`. After an intended extraction change,
  bump `FACTS_VERSION` and run `pnpm --filter @proa/bpmn-facts exec vitest run -u`.
- `packages/relations/test`: endpoint rules, the rule tier, candidates, text similarity and the
  baseline on hand-built facts (`test/support/facts.ts`), plus `_sample` end to end through
  `extractFacts`.
- `pnpm eval:candidates` (`eval/tools/src/candidates.ts`, `landscape.ts`, `score.ts`,
  `report.ts`) scores every landscape in `eval/corpus` not starting with `_`. Gates per
  landscape: rule-tier precision 1.0 (unlisted pairs count as wrong in a closed world), no
  must_not_link accepted, ≥ 98 % of must_link pairs among rules ∪ candidates, findings
  `unresolved-call`/`dynamic-call`/`duplicate-process-id` equal to `expected_findings` (per ref;
  duplicates per group), and every expected `dangling-throw`/`unmatched-catch` found, each extra
  explained by a must_link/may_link of that endpoint. It also reports recall within rules ∪
  key/lexical candidates, per type and tag, and the same pairs for baseline-proa1. The report is
  deterministic; regenerate it after an algorithm change. The holdout landscape is scored but
  must not be tuned against: document a holdout-only miss instead (the report lists must_link
  pairs that only the `compatible` basis reaches). `eval/tools/test/candidates.test.ts` runs the
  gate and unit-tests the scorer.
- `apps/server/test/integration/mcp-contract.test.ts` is the MCP contract test (CONCEPT §8):
  the official SDK client over real HTTP with agent tokens against the real libraries on
  `eval/corpus/_sample`, imported into two projects. `tools/list` is a file snapshot
  (`__snapshots__/mcp-tools.json`, identical in 2025-11-25 and 2026-07-28; after an intended
  tool change run `pnpm --filter @proa/server exec vitest run -u test/integration/mcp-contract.test.ts`).
  Every tool is called with valid input (the client validates `structuredContent` against the
  output schema), invalid input, and the other project's key and id and unknown ids (404). The
  credential matrix: no token, malformed, revoked (also for an open client) and expired tokens,
  the owner key and the owner session (401), every agent scope, a token cannot be created
  without `proa:read` or with `proa:review` (422) nor stored without scopes (check
  constraint), and a scope-less row, with the constraint dropped, gets 403 `insufficient_scope`
  on MCP and REST.
- `apps/cli/test/live/stack.live.test.ts` (`PROA_LIVE_URL=http://127.0.0.1:7400 pnpm --filter
  @proa/cli test:live`) checks a running, seeded ProA as a user runs it: health, UI, OpenAPI
  and a foreign `Host`; agent tokens through `proa token create` in the container
  (`PROA_LIVE_CONTAINER`, default `proa2-proa-1`; empty: the checkout CLI with the local owner
  key); MCP over HTTP in 2025-11-25 and 2026-07-28; `proa mcp` started exactly as both Claude
  Desktop entries say, with the environment of a macOS GUI app (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
  cwd `/`), where a bare `docker` cannot be found; a revoked token refused through the bridge.
  Each path lists the token's project, all models, the accepted rule relations (compared with
  `eval/reports/candidates.json`), a process, XML and the procedure, and gets 404 for the other
  project. Its tokens are revoked at the end (they stay listed as revoked). Without
  `PROA_LIVE_URL` it is skipped, so `pnpm test` never touches a running stack.
- `apps/web/e2e/screenshots.spec.ts` retakes `docs/proa-2/screenshots/*.png` from a running,
  seeded ProA (`PROA_SCREENSHOTS_DIR`, see Commands). It creates a token named "Screenshot",
  blanks every full secret in the page before each screenshot, and revokes the token afterwards.

## CI

`.github/workflows/ci-2.yml` runs on pull requests and on pushes to `develop` and
`claude/proa-2` that touch the workspace. Job `verify`: install with the frozen lockfile, format
check, typecheck, lint, tests (incl. Testcontainers and the MCP contract test), client drift
check, `eval/tools` check and validate, `eval:candidates` (fails on a gate; `eval/reports` must be
up to date), and the web build. Job `docker`: builds the image and starts the Compose stack
(`up -d --build --wait`), checks `/health` and `/`, runs `proa seed` and `proa status` in the
container, then the live check (`test:live`) against it. Actions are pinned to commit SHAs. The
Playwright tests are not in CI.

## Verified end to end

On 2026-10-07, on macOS with Docker Desktop (Compose v5.5.1), Node 24.15.0, pnpm 11.1.3 and
Claude Code 2.1.292, starting from a clean state (`down -v`):

1. `docker compose -p proa2 -f docker/compose.yaml up -d --build --wait`: both containers
   healthy. `proa seed` in the container: the counts in [Load the test landscapes](#load-the-test-landscapes),
   equal to `eval/reports/candidates.json`.
2. curl: `/health` ok; `/` and a deep UI link 200 HTML; OpenAPI 3.1 with 22 operations;
   anonymous API 401; a foreign `Host`, a foreign `Origin` and a localhost `Origin` on another
   port 403; the landscape ETag `"s105"` answered 304; `/mcp` without a token 401; `/.well-known/…` 404.
3. The MCP contract test (28 tests) and the live check (6 tests) above, the latter against the
   Docker stack, including both Claude Desktop entries started as Claude Desktop starts them.
4. Claude Code: `claude mcp add --scope project --transport http proa http://127.0.0.1:7400/mcp
   --header 'Authorization: Bearer ${PROA_TOKEN}'` in a new directory under `/private/tmp` with
   its own `CLAUDE_CONFIG_DIR`, so the user's Claude configuration stayed untouched; the server
   approved there; `claude mcp list` showed `✔ Connected`, with a wrong token the 401 message,
   without `PROA_TOKEN` the missing-variable warning. No prompt was run. The token was revoked.
5. Playwright against the Docker stack: the smoke test (3 tests) and the screenshots.
6. All gates: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm format:check`, `pnpm -r test` (server
   570, cli 50 plus 6 live tests skipped, web 52, bpmn-facts 134, relations 57, contracts 23,
   procedures 6, client 4, eval/tools 27), `pnpm eval:candidates` (pass, report unchanged),
   eval/tools `check` and `validate:all`, `pnpm build`, client generation without drift,
   `docker build -f docker/Dockerfile .` (rerun after the review fixes, also on 2026-10-07).
7. Port override with a second, throwaway compose project (`PROA_HOST_PORT=7402
   PROA_DB_PORT=55433`): health ok, `Origin` on 7402 accepted, on 7400 refused.
8. Review fixes against the rebuilt stack: security headers on UI and API responses; 422 for
   `limit=0`, a malformed model id, `status=bogus` and a NUL project ref, 415 for an import
   with `text/plain`; in headless Chromium, an agent token with `proa:write` uploads BPMN with
   an XHTML `<script>`, the owner opens its content URL, and the browser downloads it instead
   of running it (before the fix the script minted an agent token as the owner); the Playwright
   smoke test with its CSP-violation check; `docker run proa:local` without
   `PROA_ALLOW_NON_LOOPBACK=1` refuses to start (exit 1); `proa status` on the host with a
   stale `~/.local/state/proa/owner-key` reports the server only (exit 0).

Not verified: Claude Desktop itself (no GUI session; the bridge was started exactly as its
configuration says), the `local` and `user` scopes of `claude mcp add` (they write to the user's
Claude configuration; the HTTP exchange is the same as with the project scope), Cursor, VS Code
and Codex, other operating systems, `pnpm dev` in this run (earlier stages verified it), and
`ci-2.yml` on GitHub (only parsed locally).
