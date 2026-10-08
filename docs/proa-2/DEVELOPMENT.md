# ProA 2.0 – Development

How to run, use, build and test ProA 2.0. Spec: [CONCEPT.md](CONCEPT.md); milestones:
[M1-SKELETON.md](M1-SKELETON.md), [M2-PIPELINE-REVIEW.md](M2-PIPELINE-REVIEW.md) (items 1–9 are
in: the backend of items 1–6, the review web UI of item 7, the simulation agent with
`eval:replay` of item 8 and this document; all of it was run together against the Docker stack,
see [M2 end to end](#m2-end-to-end-2026-10-08), and again after the
[M2 review fixes](#m2-review-fixes-2026-10-08)), and current
[M3-RELATIONS-PROCEDURE.md](M3-RELATIONS-PROCEDURE.md) (code complete, live runs pending: the
released procedure `proa-relations@0.1.0`, the Claude Code plugin, the agent reference setups in
`examples/agents`, `eval:live` and the live gate; the owner's guide to live runs is
[M3-LIVE-RUNS.md](M3-LIVE-RUNS.md)). The 1.x tree (`backend/`, `frontend/`, Maven) lives next to
it, untouched, until the cut-over PR.

The [Quickstart](#quickstart-docker) and [Troubleshooting](#troubleshooting) were run end to end on
2026-10-07 (macOS, Docker Desktop with Compose v5.5, Node 24.15, pnpm 11.1.3, Claude Code
2.1.292), the M2 part of the Quickstart ([Let the simulation agent work the
pipeline](#let-the-simulation-agent-work-the-pipeline)) on 2026-10-08. The M3 setups were checked
without a model on 2026-10-08 ([M3](#m3-2026-10-08)), and the procedure in three LLM dev runs on
the dev landscape (Claude Sonnet 5.5 subagents, not the owner's clients). [Verified
end to end](#verified-end-to-end) lists exactly what was run and what was not.

## Status

| Part | State |
|---|---|
| Workspace, TypeScript, ESLint, Prettier, dependency-cruiser, CI (`ci-2.yml`) | working |
| `packages/contracts`: schemas, types, REST route configs, OpenAPI 3.1 | working |
| `packages/client`: hey-api client generated from the contracts | working |
| `packages/bpmn-facts`: `extractFacts` (C7 and C8, CONCEPT §2), `assertSafeXml` (DOCTYPE/ENTITY, UTF-8, 5 MB), 50k-element limit, `factFingerprint`, `factsHash`, `normalizeKey` | working; tested per construct, against hostile XML and on every eval/corpus model |
| `packages/relations`: `runRules` (rule tier + findings), `generateCandidates` (key, lexical, compatible; both directions), `baselineProa1` (the 1.x algorithm), endpoint semantics, DE/EN text similarity | working; unit-tested, gated by `eval:candidates` |
| `apps/server`: full CONCEPT §2 schema, domain use cases with `policy.require`, ingest/import/delete as one transaction (facts, rule tier, assertions, endpoint state, analysis tasks, events) with the real `@proa/bpmn-facts` and `@proa/relations`, every REST route of the contracts, local mode (Host/Origin guard, owner session cookie, owner key for the CLI, agent tokens), MCP `/mcp` with the eight read tools, the built web UI at `/` | working; importing `nordwind-handel` and `stadtwerke-auental` reproduces the rule relations and findings of `eval:candidates` exactly (integration test); MCP contract test with the SDK client |
| `packages/procedures`: the procedure `proa-relations@0.1.0` (`relations.md`, status `released`, M3), the loader for MCP `get_procedure`, and the wrappers for the MCP prompt `work_pipeline` and the Claude Code skill (`renderPipelineWrapper`, `renderSkill`, `pnpm --filter @proa/procedures generate`) ([below](#the-relations-procedure-m3)) | working; unit tests (frontmatter, wrappers, the guard against skill expansion), the drift test of the generated skill and plugin version, and a server test that keeps the procedure's limits, invalid reasons and tool names in line with the contracts and the MCP tools; three LLM dev runs on `nordwind-handel` (Sonnet 5.5: precision 100 %, recall 78.6 %, 0 must_not_link; [M3](#m3-2026-10-08)) |
| `plugins/proa`: Claude Code plugin `proa` (version = procedure version) with the generated skill `/proa:relations [project] [max-tasks]` and no MCP server; `.claude-plugin/marketplace.json`: the repository as marketplace `proa` (`claude plugin install proa@proa`) | working; `claude plugin validate --strict` passes for both manifests (Claude Code 2.1.294); drift and version tests in `@proa/procedures`; not yet run with a model |
| `examples/agents` (M3): reference setups for Claude Code (interactive, headless `run-headless.sh`), Claude Desktop (both bridge entries, German start prompt), an Agent SDK worker and Codex; documentation, not workspace packages, not in the image | checked without a model ([M3](#m3-2026-10-08)): shellcheck and dry runs of `run-headless.sh` against fakes, `tsc` and `docker build` of the SDK worker, the Codex TOML parses; no setup has run a model yet |
| M2 backend: analysis pipeline (claim/submit/release, lease, long-poll), claim input (with the M3 additions: message-flow ends, partner and process documentation, findings), submissions, ad-hoc proposals, review (accept/reject/hold/correct, bulk, notes, timeline), model engine, relation provenance, answered findings hidden ([below](#analysis-pipeline-and-review-m2)) | working over REST and MCP; real-Postgres integration tests incl. concurrent claims, lease expiry, cancellation, decision memory across re-uploads, the claim-input size and additions on both corpus landscapes; MCP contract test with the SDK client; reviewed in the web UI ([Review in the web UI](#review-in-the-web-ui-m2)); end to end against the Docker stack with the simulation agent (HTTP and the bridge in the container) and in the browser (`e2e/pipeline.spec.ts`: review, re-upload, `suppressed` vs. `reopened`) |
| `apps/cli`: `proa seed` (M3: `--project`, `--token-name`), `import`, `token create/list/revoke`, `status`, `health`, and `proa mcp` (stdio bridge for Claude Desktop) | working; unit tests, an e2e test against a real server, and a live check against the running Docker stack |
| `apps/agent-sim`: `proa-agent-sim`, the LLM-free simulation agent (M2 item 8): works the pipeline over MCP (HTTP or the `proa mcp` bridge) with the deterministic policy `sim-policy-1` and records claim inputs and submissions in `eval/recordings` ([below](#simulation-agent-and-evalreplay-m2)) | working; unit tests (policy, recorder, CLI, the loop against an in-memory MCP server) and an end-to-end server test on both corpus landscapes (every task done, provenance, nothing decided, the committed recordings reproduced byte for byte) |
| `apps/web`: projects (create), per project the tabs Modelle (engine, revision, stage), Prüfen (M2: inbox by stage, review queue, bulk accept per tier, held list), Relationen (filters, rule vs. key tier, provenance), Befunde, Hochladen (files or a folder via the import endpoint) and Agent verbinden (token, Claude Code/Desktop/generic configurations, revoke); model view with bpmn-js that highlights relation endpoints and switches to the other model; review screen per relation (both models in bpmn-js, rationale, evidence, question, provenance, timeline; accept/reject/hold/correct with A/R/H/C, J/K through the queue); bulk accept that leaves generic or widely shared names, open agent questions and ambiguous call targets unchecked; Miragon design system | working; component tests (Testing Library), Playwright smoke, review and pipeline flows against a running server, the screenshots below |
| `eval:candidates` | working; passes on `nordwind-handel` (dev) and `stadtwerke-auental` (holdout); report in `eval/reports/candidates.md` |
| `eval:replay` | working; scores the recordings in `eval/recordings` against `expected.yaml` (precision, recall and F1 per type and tag, must_not_link hits, questions, no-links); report in `eval/reports/replay.md`, ending with the live gate (it reports the gate, `eval:live` enforces it) |
| `eval:live` (M3): records a live run from its project's stored submissions in `eval/recordings`, scores it and checks the live gate ([below](#live-runs-evallive-and-the-live-gate-m3)) | working; unit tests with fixtures, the server test that rebuilds the simulation agent's recordings from the stored submissions byte for byte (input aside), a smoke test against a seeded server; three LLM dev runs recorded into a scratch directory (not committed); no live run of the owner recorded yet |
| `docker/compose.yaml`, `docker/Dockerfile` | working; `up -d --build --wait` starts PostgreSQL and ProA (migrations at start, owner key in the `proa-state` volume); CI builds it, seeds it and runs the live check against it; an M1 stack upgrades in place (migrations 0002/0003 on its data, the engine backfill equal to `@proa/bpmn-facts` on all 57 corpus models) |

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
at the stage "waiting for agent": an agent with `proa:propose` works the pipeline
([Analysis pipeline and review](#analysis-pipeline-and-review-m2)). A live run with an LLM agent
gets a fresh project of its own (`proa seed nordwind-handel --project <key> --issue-tokens
--token-name <run>`, see [Live runs](#live-runs-evallive-and-the-live-gate-m3)).

### Let the simulation agent work the pipeline

The LLM-free simulation agent fills the review inbox without a model (an LLM agent works the same
pipeline with the `relations` procedure: [Connect Claude Code](#connect-claude-code), [Connect
Claude Desktop](#connect-claude-desktop)). It runs from the checkout (`pnpm install`; it is not
in the image) and talks to the stack over MCP with an agent token, one per project:

```sh
docker compose -p proa2 -f docker/compose.yaml exec proa proa token create \
  --project nordwind-handel --name agent-sim --scopes read,propose --expires 7d --json   # the secret
PROA_TOKEN=proa_at_… pnpm agent-sim                       # over HTTP, like Claude Code
PROA_TOKEN=proa_at_… pnpm agent-sim \
  --stdio-command "/usr/local/bin/docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp"   # like Claude Desktop
docker compose -p proa2 -f docker/compose.yaml exec proa proa status
```

It claims and submits until nothing is left (31 tasks in `nordwind-handel`, 26 in
`stadtwerke-auental`). Afterwards `nordwind-handel` has 48 proposed relations (33 of them in the
key tier), 28 models "waiting for review" and 3 "incorporated"; `stadtwerke-auental` has 52
proposed, 20 and 6. Every proposal names the token's principal (`agent:agent-sim`), its client
id, the declared procedure `proa-relations@0.1.0` (the one the claim names; the simulation agent
follows its own policy, not the procedure's rules) and the model `sim-policy-1`; borderline pairs
carry a question. Review them at http://127.0.0.1:7400/projects/nordwind-handel/review. Running
the agent again changes nothing (every task is done); after a re-upload with other facts it works
only the changed model. Options and the policy: [Simulation agent](#simulation-agent-and-evalreplay-m2).

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
[Claude Desktop entry](screenshots/07-connect-claude-desktop.png). The review (M2,
`apps/web/e2e/review.spec.ts`, a project of its own with agent proposals made over REST):
[inbox](screenshots/m2-01-inbox.png), [review screen](screenshots/m2-02-review.png),
[bulk accept](screenshots/m2-03-bulk.png), [held list](screenshots/m2-04-held.png),
[correction](screenshots/m2-05-correct.png), [timeline](screenshots/m2-06-timeline.png),
[version conflict](screenshots/m2-07-conflict.png). The pipeline end to end (M2,
`apps/web/e2e/pipeline.spec.ts`, a project worked by the simulation agent):
[stages after the agent run](screenshots/m2-08-pipeline-stages.png), [an agent proposal with
its question and provenance](screenshots/m2-09-agent-proposal.png), [bulk accept with agent
questions and an ambiguous call target flagged](screenshots/m2-10-bulk-flags.png), [a rejection
whose endpoint changed after a re-upload](screenshots/m2-11-endpoint-changed.png), [the same
relation reopened by the agent's second run](screenshots/m2-12-reopened.png).

![Relations of nordwind-handel: rule acceptances and key-tier proposals](screenshots/03-relations.png)

![Model view: the endpoint of an accepted call highlighted in bpmn-js](screenshots/04-model-view.png)

![Review screen: both endpoint models side by side, the agent's rationale, evidence, question and provenance, the decision with keyboard shortcuts](screenshots/m2-02-review.png)

![Bulk accept of the key tier: every pair listed, generic and widely shared names flagged and left unchecked](screenshots/m2-03-bulk.png)

![Decision memory: the rejection, then the simulation agent's new proposal after the endpoint was renamed](screenshots/m2-12-reopened.png)

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

A revoked or expired token is refused with 401 on its next request. Revoking also withdraws the
token's open proposals and hands its claimed tasks back (CONCEPT §6); an expired token's proposals
stay for review.

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
nordwind-handel call the dunning process?"; the tools are listed under [MCP](#mcp). Cursor and VS
Code use the same URL and header; Codex reads the token from an environment variable
(`examples/agents/codex/config.toml`, `bearer_token_env_var = "PROA_TOKEN"`).

**Work the pipeline.** The plugin `plugins/proa` adds the skill `/proa:relations [project]
[max-tasks]`, generated from the procedure ([The relations procedure](#the-relations-procedure-m3)).
Load it for one session with `claude --plugin-dir <checkout>/plugins/proa`, or install it from
the repository's marketplace:

```sh
claude plugin marketplace add ~/Code/ai-plattform/ProA   # your checkout
claude plugin install proa@proa
```

Then, in a session, `/proa:relations nordwind-handel 5` claims one task at a time and stops
after five tasks or when none is left. The plugin carries no MCP server: the connection above
stays separate, so the tools keep the names `mcp__proa__*`. Without the plugin, the server's MCP
prompt `work_pipeline` gives the same instructions: `/proa:work_pipeline` in the `/` menu
(marked "(MCP)"), or `/mcp__proa__work_pipeline <projectId> <maxTasks>` (positional arguments,
so `maxTasks` needs a project before it). For a run with `--tools ""` (no built-in tools), add
`"alwaysLoad": true` to the server entry, so ProA's tools load at session start instead of
behind tool search. Runs that count as evaluation start Claude Code in an empty directory
outside the checkout (`eval/` holds the ground truth) with a fresh project and its own token:
`examples/agents/claude-code` has the configuration (`mcp.json` with `${PROA_TOKEN}` and
`alwaysLoad`), the interactive command line and `run-headless.sh` (one fresh `claude -p` per
batch until nothing is pending); the owner's step-by-step guide is
[M3-LIVE-RUNS.md](M3-LIVE-RUNS.md).

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

**Work the pipeline.** Claude Desktop has no plugin skill, and whether it offers the MCP prompt
`work_pipeline` is not documented; the procedure is self-contained, so the agent loads it with
`get_procedure` and follows it. `examples/agents/claude-desktop` holds both entries as files and
the German start prompt `start-prompt.de.md` with the placeholders `{{PROJEKT}}`, `{{MODELL_ID}}`
(the exact API model id, which the agent declares as `llmModel`; Claude Desktop shows only a
product name) and `{{ANZAHL}}` (the batch size). A new chat per batch keeps the procedure in full
view; for evaluation runs leave other connectors off. Live runs:
[M3-LIVE-RUNS.md](M3-LIVE-RUNS.md).

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
| `eval:live: project … is not named after a corpus landscape` | A live run's project has a key of its own (`--project` of `proa seed`): name the landscape it was seeded from, e.g. `--landscape nordwind-handel`. |
| `eval:live: warning: project … gives … recording files, …` | The run's submissions declared more than one `llmModel` or procedure version, or the project was worked under more than one token; the live gate would count every file as a run. Do not commit it: start the run again in a fresh project ([M3-LIVE-RUNS.md](M3-LIVE-RUNS.md#3b-claude-desktop)). |
| `eval:live: GET /projects/…/analyses?…: 401 …` | The token is missing, revoked or expired, or belongs to another ProA. Use the run's agent token or the owner key (`PROA_TOKEN`); with ProA in Docker, the checkout needs the container's key (see [Local mode](#local-mode-who-is-calling-concept-6)). |
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
apps/agent-sim/   @proa/agent-sim  `proa-agent-sim`: LLM-free simulation agent over MCP (src/{policy,agent,connect,recorder,program}.ts)
apps/web/         @proa/web     React 19 + Vite + Tailwind v4 + shadcn + TanStack (src/{routes,components,lib,theme}, test/, e2e/)
packages/contracts/  zod schemas, types, REST route configs, buildOpenApiDocument()
packages/client/     hey-api client generated from the contracts (src/generated is generated)
packages/bpmn-facts/ fact extraction (CONCEPT §2)
packages/relations/  rules, candidates, baseline-proa1
packages/procedures/ agent procedures as Markdown with frontmatter (relations.md = proa-relations; MCP get_procedure),
                     src/wrappers.ts (MCP prompt and skill text), scripts/generate.ts (writes the plugin's skill)
plugins/proa/     Claude Code plugin: .claude-plugin/plugin.json, skills/relations/SKILL.md (generated, do not edit)
.claude-plugin/   marketplace.json: this repository as the plugin marketplace `proa`
examples/agents/  reference setups: claude-code/, claude-desktop/, agent-sdk/ (own package.json), codex/; not workspace packages
eval/tools/       @proa/eval-tools: corpus generator/validator (.mjs) + eval:candidates, eval:replay, eval:live (src/*.ts)
eval/recordings/  agent recordings <procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl (eval:replay input)
docker/           compose.yaml (project proa2), Dockerfile
docs/proa-2/      CONCEPT.md, HANDOFF.md, M1-SKELETON.md, M2-PIPELINE-REVIEW.md, M3-RELATIONS-PROCEDURE.md, M3-LIVE-RUNS.md,
                  M4-VALUE-CHAIN.md, this file, screenshots/
```

Package dependencies point one way: `contracts` ← `bpmn-facts` ← `relations` ← `server`;
`contracts` ← `client` ← `cli`, `web`; `contracts` ← `agent-sim` (talks to the server over MCP
only; the server's integration test uses it as a dev dependency); `procedures` (no dependencies)
← `server`, `eval-tools`; `eval-tools` (`contracts`, `bpmn-facts`, `relations`, `procedures`) is
a dev dependency of the server, whose integration test reads a project the way `eval:live` does
(`eval/tools/src/index.ts` exports only the light modules: the REST reader, the mapping, the gate
and the recordings loader, not the corpus toolchain). Workspace dependencies use
`workspace:0.0.0`.

### Commands (repository root)

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc` in every package |
| `pnpm lint` | ESLint (type-aware) in every package; the server also runs dependency-cruiser |
| `pnpm test` | vitest in every package (server integration and CLI e2e tests need Docker; `@proa/procedures` checks that `plugins/proa` is generated from the current procedure), `node --test` in eval/tools |
| `pnpm format` / `pnpm format:check` | Prettier over the 2.0 workspace (`.prettierignore` keeps 1.x, eval, Markdown, snapshots and generated files out) |
| `pnpm build` | builds the web UI (`apps/web/dist`) |
| `pnpm eval:candidates` | the LLM-free eval gate; writes `eval/reports/candidates.{md,json}`, exit 1 if a gate fails |
| `pnpm eval:replay` | scores the recordings in `eval/recordings` against `expected.yaml` and evaluates the live gate; writes `eval/reports/replay.{md,json}`, exit 1 only for an unreadable recording, whatever the gate says ([below](#simulation-agent-and-evalreplay-m2)) |
| `pnpm eval:live --project <key> [--landscape <name>] [--url] [--token] [--agent] [--out] [--corpus] [--no-write] [--json]` | records a live run from the project's stored submissions in `eval/recordings/<procedure>@<version>/<token name>/<llmModel>/<landscape>.jsonl`, scores it and checks the live gate; token: the run's agent token or the owner key (`PROA_TOKEN`); exit 1 when a gate fails or on a runtime error, 2 on a usage error ([below](#live-runs-evallive-and-the-live-gate-m3)) |
| `pnpm agent-sim [options]` | the simulation agent `proa-agent-sim` from the checkout (`PROA_URL`, `PROA_TOKEN`; `--help`) |
| `pnpm --filter @proa/eval-tools check` / `validate:all` / `test` | the corpus: models in sync with their specs, full validation of every landscape, the toolchain tests |
| `pnpm docker:up` | the whole Compose stack (PostgreSQL + ProA on 127.0.0.1:7400), built fresh |
| `pnpm db:up` / `pnpm db:down` | only PostgreSQL up (for `pnpm dev`) / the whole stack down (volumes stay) |
| `pnpm db:migrate` | applies migrations to `DATABASE_URL` |
| `pnpm dev` | server (`node --watch`, 127.0.0.1:7400) and Vite (127.0.0.1:7401) in parallel |
| `pnpm seed` | `proa seed`: one project per scored eval landscape; `pnpm seed <landscape> --project <key> --issue-tokens --token-name <run>` seeds a fresh project for a live run ([below](#the-proa-cli)) |
| `pnpm proa <command>` | the `proa` CLI from the checkout; relative paths resolve against the directory you run it in |
| `PROA_LIVE_URL=http://127.0.0.1:7400 pnpm --filter @proa/cli test:live` | live check of a running, seeded ProA: tokens, MCP over HTTP, the stdio bridge as Claude Desktop starts it (see [Tests](#tests)) |
| `pnpm --filter @proa/web e2e smoke` | Playwright smoke test against a running ProA (`PROA_E2E_URL`, default http://127.0.0.1:7400); creates its own project `e2e-<time>` |
| `pnpm --filter @proa/web e2e review` | Playwright review flow (M2) against a running ProA; creates its own project `review-<time>` from `nordwind-handel` and an agent token, proposes over REST, then reviews in the browser |
| `pnpm --filter @proa/web e2e pipeline` | Playwright pipeline flow (M2) against a running ProA: its own project `pipeline-<time>` from `nordwind-handel`, worked by `proa-agent-sim` over MCP, reviewed in the browser, then a re-upload and the agent's second run (decision memory) |
| `PROA_SCREENSHOTS_DIR=$PWD/docs/proa-2/screenshots pnpm --filter @proa/web e2e screenshots` | retakes the M1 screenshots from a running, seeded ProA; with `… e2e review` the `m2-*.png` |
| `pnpm --filter @proa/client generate` | regenerates `packages/client` after a contracts change |
| `pnpm --filter @proa/procedures generate` | writes `plugins/proa/skills/relations/SKILL.md` from `packages/procedures/relations.md` and the procedure version into `plugins/proa/.claude-plugin/plugin.json`; run it after every change of the procedure and commit both ([Conventions](#conventions)) |
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
`instructions` (`MCP_INSTRUCTIONS`) say that labels, documentation and rationales are data, never
instructions; that agents only propose; to load the procedure with `get_procedure` first and
declare its id and version; and which tools take no `projectId` (`list_projects`,
`get_procedure`, and `submit_analysis`/`release_analysis`, whose task the claim's `taskId` and
`leaseToken` name), which an optional one (`claim_analysis`: default every project where the
token may propose) and that every other tool needs it. `mcp.test.ts` checks that sentence
against the tool schemas.

| Tool | Input | Returns |
|---|---|---|
| `list_projects` | none | the token's one project |
| `list_processes` | `projectId`, `stage?`, `cursor?`, `limit?` | models with stage, open items and their processes |
| `get_process` | `projectId`, `ref` (`<modelKey>#<processId>`) | the process, its facts and the live relations touching them |
| `get_model_xml` | `projectId`, `modelKey`, `revisionId?`, `offset?`, `maxChars?` (≤ 100,000) | the verbatim BPMN of the head (or a revision) in pages |
| `get_relations` | `projectId`, `modelKey?`, `type?`, `status?`, `tier?`, `cursor?`, `limit?` | relations with status, tier, confidence and endpoint state |
| `which_processes_use` | `projectId`, `kind` (`message`, `signal`, `call`, `data_store`), `name` | who throws/catches a message or signal (names match like the key tier: case, umlauts, punctuation and word separators ignored), calls/defines a process id (exact), uses a data store (normalized name) |
| `find_unlinked_events` | `projectId`, `modelKey?`, `kinds?` | message/signal events and labelled none start/end events that no live relation touches |
| `get_procedure` | `id` (default `proa-relations`; the file name `relations` works too) | `id`, `version`, `title`, `status` and the text of the procedure: `proa-relations@0.1.0`, `released` ([below](#the-relations-procedure-m3)) |
| `get_landscape` | `projectId` | models with stage and processes, live relations with provenance, open findings |
| `claim_analysis` | `projectId?`, `modelKey?`, `max` (1–5, default 1) | claimed tasks: lease token, `leaseUntil`, expected procedure, claim input (proa:propose) |
| `submit_analysis` | `taskId`, `leaseToken`, `submissionId` (UUID), `procedure`, `llmModel?`, `relations` (≤ 200), `noLinks?`, `summary?`, `costUsd?` | the result per item (proa:propose) |
| `release_analysis` | `taskId`, `leaseToken`, `reason?` | `{taskId, state: queued}` |
| `propose_relation` | `projectId`, `type` (not `manual`), `from`, `to`, `confidence`, `rationale`, `evidence?`, `question?`, `procedure?`, `llmModel?` | `{result, relation}`; an invalid pair is the problem `validation-failed` with `reason` |
| `withdraw_proposal` | `projectId`, `relationId` | the relation after withdrawing the caller's own live proposal |
| `decide_relation` | `projectId`, `relationId`, `verdict` | never succeeds: `human-decision-required` with `reviewUrl` (agents only propose) |

The read tools carry `readOnlyHint`; the pipeline and proposal tools `readOnlyHint: false`,
`destructiveHint: false`. Every tool declares `_meta` `anthropic/maxResultSizeChars: 500000`
(`MAX_RESULT_SIZE_CHARS`, checked by `mcp-contract.test.ts`): Claude Code otherwise saves a result
above 50,000 characters to a file and shows the model only its path, which an agent without
built-in tools cannot read, and claim inputs reach 80 KB; other clients ignore the key.
`examples/agents/claude-code` also sets `MAX_MCP_OUTPUT_TOKENS=100000` for Claude Code builds that
do not read it. The prompt `work_pipeline` takes `projectId?` and `maxTasks?` (a string, as
prompt arguments are: a whole number from 1 to 100 without a leading zero; anything
else is refused with "must be a whole number from 1 to 100"). Its text is
`renderPipelineWrapper` of `@proa/procedures`, the same as the Claude Code skill's: the scope
(the project, at most `maxTasks` tasks, `claim_analysis({projectId, max: 1})`, when to stop),
the exact model id as `llmModel`, `release_analysis` instead of an expiring lease,
`get_procedure` again after the context was summarized, then the procedure verbatim, which
carries the loop ([The relations procedure](#the-relations-procedure-m3)). `prompts/list` is the
snapshot `__snapshots__/mcp-prompts.json`. `projectId` is a `prj_` id or the project key
(validated by pattern, like REST `{project}`). Domain errors come back as tool errors whose text is the RFC
9457 problem (`not-found`, 404, also for another project's key or ids); invalid arguments come
back as tool errors naming the validation failure; any other error is logged on the server and
comes back as the problem `internal`, never with its message (a failed query would carry SQL).
The complete `tools/list` (descriptions and JSON schemas) is the snapshot
`apps/server/test/integration/__snapshots__/mcp-tools.json`. Output schemas have a plain object
root: a named contract schema would serialize as a `$ref` root, which the SDK wraps as
`{ result: … }`. Input schemas use `$defs`/`$ref` for the shared contract types (model key, ref,
enums), never at the root: `claim_analysis` had a root `$ref` (the named `ClaimAnalysisBody`),
which hid `projectId`, `modelKey` and `max` from clients that read only `properties`; it is a
plain object now, and `mcp.test.ts` forbids a root `$ref` on every input schema. Schemas use
standard JSON Schema only (`pattern`, the formats `date-time` and `uuid`;
the contract test checks it): zod's `.startsWith()` would emit `format: "starts_with"`, which
every SDK client reports on stderr, so the lease token is a `pattern`.

`proa mcp` (the stdio bridge) relays JSON-RPC unchanged between stdio (`StdioServerTransport`)
and `PROA_URL/mcp` (`StreamableHTTPClientTransport` with `Authorization: Bearer $PROA_TOKEN`),
both from the official SDK 2.x. For 2025-era clients it forwards the version negotiated by
`initialize` as `MCP-Protocol-Version`. stdout carries only the protocol; it exits when the
client closes stdin.

### Analysis pipeline and review (M2)

Backend of [M2-PIPELINE-REVIEW.md](M2-PIPELINE-REVIEW.md) items 1–6 (CONCEPT §2, §3, §5). REST
routes are in the contracts (`packages/contracts/src/api/{analyses,review}.ts`, OpenAPI tags
`analyses` and `review`); MCP tools [above](#mcp). Domain: `src/domain/use-cases/{analyses,review}.ts`,
`proposals.ts` (per-item checks and the one write path of submissions and ad-hoc proposals),
`claim-input.ts`, `lease.ts`, `status.ts` (`recomputeStatus`, `classifyProposal`, both pure),
`relation-state.ts`, `findings.ts`.

| Route | |
|---|---|
| `POST /api/v1/analyses/claim` `{projectId?, modelKey?, max ≤ 5}` | claims queued tasks and expired leases with attempts left, oldest first, in the projects where the caller may propose (`proa:propose`, editor or better) |
| `GET /api/v1/analyses/pending?projectId=&wait=0..30` | claimable tasks per project; `wait` long-polls |
| `POST /api/v1/analyses/{a}/submission`, `…/release` | submit (≤ 1 MB) or hand back a claimed task |
| `GET/POST /api/v1/projects/{p}/analyses[/requeue]`, `GET …/analyses/{a}/submission` | tasks newest first; requeue `{modelKeys}` or `{all: true}` (`proa:write`); the stored submission |
| `POST /api/v1/projects/{p}/relations`, `DELETE …/relations/{rel}/proposal` | ad-hoc proposal (or, for humans, an accepted `manual` relation); withdraw the caller's own proposal |
| `POST …/relations/{rel}/decision`, `POST …/decisions`, `POST …/relations/{rel}/notes`, `GET …/relations/{rel}/assertions` | decide (owner on an interactive client), bulk decide, note, timeline |

**Claim and lease.** The claim is one transaction: it locks the projects (writers always lock the
project row first, so claims cannot deadlock with ingest), turns claimed tasks whose lease expired
at attempt 3 into `failed` (`analysis.failed`; nothing runs on a timer, so the pending count and a
requeue do the same, and a model never stays "agent working" with a dead lease once an agent asks
for work or the owner requeues), and claims with one `UPDATE … WHERE id IN (SELECT …
ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT n)`, which sets the 15-minute lease and
`attempts + 1`. Each task then gets a lease token `proa_lt_` + 256 random bits (base64url), shown
once and stored as `sha256(taskId|principalId|token)`. The inputs are rendered afterwards from one
snapshot; if that fails, the tasks are handed back at once. A release queues the task again and
gives the attempt back. Submit and release need the holder's token and principal: another holder,
a release or a wrong token answer 409 `lease-lost`, a new revision with other facts 409
`task-cancelled`; a late submit passes while nobody claimed the task again or cancelled it, also
after it failed, unless a newer task of the model exists or the model changed or was deleted
since the failure (409 `task-cancelled`: the stale analysis would otherwise supersede the newer
one). A requeue queues a new task for every model without an open one; a claimed task whose lease
expired is not open (cancelled, "lease expired; requeued"). A done task answers its own
`submissionId` with the stored result
(`replayed: true`) and any other with 409 `already-submitted`. Clock: the server clock
(`deps.clock`), so tests advance leases without waiting.

**Claim input** (`proa-claim/1`, schema `ClaimInput` in the contracts): the model (key, name,
revision, engine, processes), its head facts with default fields left out and documentation cut
to 300 characters (`CLAIM_DOC_CHARS`), the candidates of `generateCandidates` around the model as
`[type, from, to, basis, score]` tuples, the partner endpoints they name (keyed by ref), and the
non-obsolete relations touching the model with the human decision (reason, hold note, question,
label), an agent's open question and the notes. M3 added four optional parts, so older inputs
still parse and the format stays `proa-claim/1`:

- `message_flow` facts carry `from` and `to`: the refs of the element or pool (participant) at
  each end inside the file (`attrs.sourceRef`/`targetRef`). Such a pair is never a relation
  (`invalid:message-flow`); it shows which endpoints a collaboration already connects.
- Partner endpoints carry `doc`, their documentation cut to 300 characters.
- `partnerProcesses`: for every process a partner endpoint belongs to, keyed by process ref, its
  `name` (the process name, else the pool name) and `doc` (cut likewise), sorted by ref; left
  out without partners.
- `findings`: the project's findings as `GET …/findings` lists them (`visibleFindings`, so
  answered `dangling-throw`/`unmatched-catch` are hidden) with at least one ref in the model,
  sorted by kind, refs and detail; left out when there are none. The claim loads them once per
  project inside its read snapshot; `renderClaimInput` stays pure.

On the eval corpus the largest input is 80.1 KB on `nordwind-handel` (`vertrieb/order-handling`,
295 candidates, 107 partners) and 74.8 KB on `stadtwerke-auental`, the mean 40.8 KB and 48.6 KB
(before M3: 68.7 KB at most, mean 34–41 KB). `claim-input-size.test.ts` measures every model of
both landscapes, requires < 100 KB, and checks the additions on the whole corpus: message-flow
ends in the model, `partnerProcesses` exactly the partners' processes, findings touching the
model, and every addition present in each landscape.

**Submissions.** At most 1 MB (`MAX_SUBMISSION_BYTES`), on REST (body limit, 413) and on MCP alike
(`submit_analysis` answers `payload-too-large`; the MCP endpoint refuses any request over 1 MB +
16 KB, instead of the SDK's 4 MiB default). The body is checked for shape only (≤ 200 relations,
declared procedure and LLM model without control characters, 422 otherwise); each item is then
checked in this order and answered `invalid:<reason>` if it fails: `type-not-allowed`
(`manual`), `malformed-ref`, `confidence-out-of-range`, `rationale-too-long` (> 1,000),
`question-too-long` (> 500), `too-much-evidence` (> 20), `control-characters` (rationale,
question or evidence with a control character other than tab and line breaks; PostgreSQL cannot
store U+0000), `outside-task-model` (neither end in the
task's model), `unknown-ref` (not a head fact), `type-mismatch` (the ends cannot take those sides,
`endpointRole`), `same-process`, `message-flow`. Valid items are `applied`, `duplicate` (the
caller's identical live proposal, a rule acceptance with the same fingerprints, or an earlier item
of the same submission), `suppressed` (the status rests on a human decision with the same endpoint
fingerprints; nothing is recorded) or `reopened` (recorded, and a rejection becomes `proposed`
because an endpoint changed). The server computes the tier (`createPairAssessor` of
`@proa/relations`: `key`, `lexical`, `semantic`); `source_kind`, principal and client come from the
credential, procedure and LLM model are only declared. Supersession (CONCEPT §2): earlier live
pipeline proposals of any principal touching the task's model that the submission does not
repeat (same type, from and to) are withdrawn under their proposer, with the new submission as
reason; ad-hoc proposals stay, and human
decisions keep the status (a held relation stays held). The submission is stored with the request
as received (REST) or the parsed arguments (MCP), without the lease token and with U+0000 (which
jsonb cannot hold) as U+FFFD, plus its result
(`GET …/analyses/{a}/submission`). The assertion → submission foreign key is checked at commit
(migration 0003), so the submission row can hold the final result.

**Review.** Decisions need the `review` permission (a user on an interactive client: the owner via
the web UI or the CLI); agent tokens get 403 `human-decision-required` with `reviewUrl`
(`<origin>/projects/<key>/review/<relation>`, the review screen of the M2 web UI) on REST and from
the MCP stub `decide_relation`. `accept` (optional note), `reject` (reason), `hold` (note, optional
question and label: status `held`, an open item; a model whose only open items are held is
`waiting_for_clarification`), `correct` (rejects the relation and accepts another pair as a
`manual` relation, both assertions linked through `linkedRelationId`). `version` in the body (409
`conflict`) or `If-Match: "<version>"` (412; `GET …/relations/{rel}` sends the ETag) make a decision
conditional. Bulk decisions send `items: [{id, version}]`, `expectedCount` and optionally `tier`;
any mismatch (count, version, tier, unknown, duplicate or obsolete) answers 409 with `mismatches`
and changes nothing. Notes (`kind = note`, humans only, also a DB check) answer held questions,
never change the status and reach the next claim input. Every relation carries `source` and
`provenance` (the assertion its status rests on: kind, verdict, source, handle, client, declared
procedure and model, tier, confidence, rationale, question, label); `GET …/assertions` is the full
timeline. Decision memory: a rejection stays while proposals repeat the same endpoint fingerprints
(`suppressed`), turns `endpointState: changed` when an endpoint changes, and is reopened by the
next proposal with the new fingerprints. Stances are per principal, but a human's latest decision
stays in force when the same human later proposes the relation (working the pipeline over REST)
or that proposal is withdrawn (`decisionsInForce` in `status.ts`); only another decision replaces
it. An accepted relation whose endpoint changed is an open item; accepting it again anchors the
decision on the current fingerprints. Reasons, notes, questions, labels, rationales and evidence
of decisions, notes and ad-hoc proposals refuse control characters other than tab and line
breaks (422), as does a release reason.

**Revoking an agent token** (CONCEPT §6: "revoking a token or service withdraws its proposals")
withdraws, in the same transaction, every live proposal of the token's principal (pipeline and
ad hoc; recorded under that principal, by the revoking owner, reason "agent token … revoked") and
queues its claimed tasks again without counting the attempt. Decisions stay, and so do other
principals' proposals on the same relations. Let a token expire instead if its proposals should
stay for review.

**Other API changes.** `Model.engine` and `Revision.engine` (`c7`/`c8`/`null`, from
`@proa/bpmn-facts`; migration 0003 backfills older revisions from the `<definitions>` tag);
relations created by any path return the database's `updatedAt` (`relations.insert` returns the
stored row), and a relation's `version` moves with every new assertion, so a bulk decision on a
stale view fails; `dangling-throw`/`unmatched-catch` findings are hidden once a proposed, accepted
or held relation connects that endpoint (`GET …/findings`, the landscape).

**Long-poll.** `GET /analyses/pending?wait=` subscribes before it counts, so no wake-up is lost,
then waits at most `wait` seconds for `NOTIFY proa_analysis` (a trigger fires whenever a task
becomes `queued`) and counts again; expired leases are not announced, the bounded wait covers
them. One dedicated `LISTEN` connection per process (`application_name = proa-listen`, never a
pool connection), opened on first use, re-opened after errors, at most 200 waiters per process and
8 per caller (principal; more answer at once, so one token cannot take every slot), aborted
requests let go at once; `docker`/`pnpm dev` shutdown closes it first so waiting requests answer
immediately.

**Events.** `analysis.queued` (new head or requeue), `claimed`, `released`, `done` (with counts,
`late`), `failed`, `cancelled`; `relation.proposed`, `withdrawn`, `decided`, `noted`,
`endpoint_changed`; each with the acting principal and client and a dense `seq`.

### The relations procedure (M3)

`packages/procedures/relations.md` is `proa-relations@0.1.0`, status `released`; it replaced the
M2 placeholder `0.0.1`, and every claim names it (`app.ts` reads id and version from
`@proa/procedures`). The text is self-contained, so a client that only calls `get_procedure`
(Claude Desktop, Codex) can follow it: ground rules, failure modes to avoid, the loop (one task
per claim, lease and call budget, release, reload after a summary, submission errors), the claim
input, the read tools, valid endpoints, a fixed work order per task, judgement rules (identical
specific and generic names, collaborations, near-misses, translation and transliteration, other
words, twins and modelling gaps, triggers, calls), confidence bands and questions, human
decisions and supersession, the submission format with coded no-link reasons, and a self-check.
Its examples are invented, so the eval landscapes stay unseen.

**Language.** Agents write `rationale`, `question`, the sentence of a no-link `reason`
(`<code>: <sentence>`, codes such as `near-miss`, `generic-name`, `no-evidence`), the `summary`
and release reasons in German, because the review UI is German; refs, element ids, message and
signal names and quoted labels stay verbatim. A per-project language setting is deferred to R1.
The simulation agent is not bound by it: `sim-policy-1` still writes English.

**Supersession.** A submission withdraws the live pipeline proposals of any principal on the
relations touching the task's model that it does not repeat
([Submissions](#analysis-pipeline-and-review-m2)), so the procedure tells agents to repeat every
pair they still support, including proposals that came from the partner model's task, and to
no-link the agent proposals they drop.

**Delivery.** One text, three ways:

| Way | Where | Adds |
|---|---|---|
| MCP tool `get_procedure` | every client; the server instructions say to load it first | nothing |
| MCP prompt `work_pipeline` (`projectId?`, `maxTasks?`) | clients that offer prompts; Claude Code: `/proa:work_pipeline`, `/mcp__proa__work_pipeline <projectId> <maxTasks>` | the wrapper with the given scope |
| Skill `/proa:relations [project] [max-tasks]` (`plugins/proa/skills/relations/SKILL.md`) | Claude Code with the plugin `plugins/proa` | frontmatter (`name`, `description` from the procedure, `argument-hint`), then the wrapper with the scope from `$ARGUMENTS` |

The wrapper (`renderPipelineWrapper`, `packages/procedures/src/wrappers.ts`) adds only the
scope (project, at most n tasks, `claim_analysis({…, max: 1})`, when to stop; in the skill, how
to read its two optional arguments and to stop before claiming if one is invalid), the exact
model id as `llmModel` (never a product name, an alias or a guess) and the procedure the claim
names, `release_analysis` instead of an expiring lease, and
`get_procedure` again after the context was summarized or compacted; then `Procedure
<id>@<version>:` and the text verbatim. Prompt and skill share it, so they cannot drift apart.
The plugin carries no MCP server (the connection is configured separately, so the tools keep the
names `mcp__proa__*`), and its version is the procedure version. `renderSkill` refuses text that
Claude Code would expand in a skill; authoring rules are under [Conventions](#conventions).

### Simulation agent and `eval:replay` (M2)

M2 item 8. `apps/agent-sim` (`@proa/agent-sim`, command `proa-agent-sim`, `pnpm agent-sim` from
the checkout) is an LLM-free agent that works the pipeline the way an MCP client is told to by the
`work_pipeline` prompt: it connects to `/mcp` with an agent token (Streamable HTTP, or `--stdio`
through the `proa mcp` bridge as Claude Desktop does), reads `get_procedure` and the prompt, then
claims one task at a time (`claim_analysis {max: 1}`), decides from the claim input alone and
submits (`submit_analysis` with a fresh UUID, the procedure the claim names and `llmModel:
"sim-policy-1"`) until a claim returns nothing. It uses MCP tools only, never REST, and never
decides: everything it submits is a proposal under its token's principal and client.

```sh
pnpm seed --issue-tokens                # prints a read+propose token per project
export PROA_TOKEN=proa_at_…             # the token of the project to work on
pnpm agent-sim                          # HTTP: $PROA_URL/mcp (default http://127.0.0.1:7400)
pnpm agent-sim --stdio                  # through `node apps/cli/src/main.ts mcp` (this checkout)
pnpm agent-sim --stdio-command "docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp"
pnpm agent-sim --dry-run -n 3 --record /tmp/rec    # decide and record 3 tasks, hand them back
```

Options: `--project`/`--model` narrow the claims, `-n/--max-tasks` stops early, `--dry-run`
claims and decides but submits nothing and releases every task at the end (the attempt does not
count), `--propose-at`/`--ask-at` move the thresholds, `--llm-model` changes the declared model,
`--json` prints the report, `-q` silences the per-task log on stderr. Exit 0 when every task was
submitted, 1 when a submission failed or the run broke off (no pipeline tools, a failing claim), 2
for usage errors. A submission the server refuses as malformed is handed back at the end of the
run; on `lease-lost`, `task-cancelled` or `already-submitted` there is nothing to hand back.

**Policy `sim-policy-1`** (`src/policy.ts`, a pure function of the claim input). Every candidate
`[type, from, to, basis, score]` gets one verdict: pairs whose relation is already accepted,
rejected by a human (unless an endpoint changed since, `endpointState: changed`) or held are
skipped; `score ≥ 0.65` is proposed; `0.5 ≤ score < 0.65` is proposed with a question for the
reviewer (borderline: near-miss labels, a call target defined in two models); `key`, `rule` and
`lexical` candidates below 0.5 go into `noLinks`; `compatible` ones below 0.5 are not judged
(semantic judgement is what an LLM agent adds). The verdict depends on the score, never on the
basis, so a pair is judged alike in the tasks of both its models (the second one answers
`duplicate`, and supersession withdraws nothing). Confidence is the score rounded to two decimals;
the rationale names basis, score and both endpoints (label, kind, process, model); evidence is
both refs. The thresholds were set on the dev landscape only; the holdout was not looked at.

**Recordings** (`--record <dir>`, CONCEPT §7):
`<dir>/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`, one line per task in the
format `proa-recording/1` (`RecordingLine` in `packages/contracts/src/recordings.ts`): landscape
(the project key), model key and revision number, agent, declared procedure and model, the task
ids (`--no-record-ids` leaves them out), the claim input (`--record-input full`, the default, or
`summary`: its counts and size), the submission without lease token and submission id, the outcome
(`submitted`, `dry-run`, `failed` with the problem) and the server's result per item. `input` is
optional in the format: the server does not store claim inputs (it renders them at claim time),
so only the agent that claimed can record one, and lines that `eval:live` builds from stored
submissions have none. A run starts each file it writes afresh. The committed recordings
`eval/recordings/proa-relations@0.1.0/agent-sim/sim-policy-1/{nordwind-handel,stadtwerke-auental}.jsonl`
(147 and 134 KB) are written with `--record-input summary --no-record-ids`, so a re-run against a
fresh seed writes identical files: the server test `agent-sim.test.ts` requires exactly that, and
a run against a separately started server with `proa seed` produced the same bytes. The agent
declares the procedure the claim names, so the recordings moved from `proa-relations@0.0.1` to
`0.1.0` with the release, identical apart from the version (the M3 claim input changed only the
recorded `input.bytes`); the test reads the version from `@proa/procedures`. After an intended
change to the policy, the candidates, the claim input, the procedure version or the corpus,
regenerate them with `pnpm --filter @proa/server exec vitest run
test/integration/agent-sim.test.ts -u`, then run `pnpm eval:replay`. `-u` writes the files at the
current path but never deletes old ones: after a procedure version bump, remove the previous
version's `eval/recordings/proa-relations@<old>/agent-sim/` directory by hand, or `eval:replay`
keeps scoring it.

**`eval:replay`** (`eval/tools/src/replay.ts`, `recordings.ts`, `replay-score.ts`,
`replay-report.ts`) reads every recording below `eval/recordings`, finds the landscape in
`eval/corpus` (by name, or `_<name>`: `_sample` is seeded as `sample`), runs the rule tier on it
and scores each file: the agent's link set is the union of its valid proposals over all
submissions (an item answered `invalid:<reason>` is not a proposal; unsubmitted dry-run items are
checked for type and refs locally), deduplicated by `(from, to)` with the highest confidence and
"asked a question" if any proposal did. Precision counts must_not_link, same-process and, in a
closed world, unlisted pairs as false positives; may_link pairs are neutral. Recall counts
must_link pairs, also "∪ rule-tier acceptances" (the unambiguous calls accepted at ingest, which
agents leave alone). Per relation type and per tag (tags come from `expected.yaml`); must_not_link
hits with their confidence (≥ 0.8 is what the live gate forbids) and question; unlisted
proposals; missed must_link; questions and no-links by class. The report
(`eval/reports/replay.{md,json}`) is deterministic; CI regenerates it and requires no diff. It
ends with the section "Live gate" (`liveGate` in `replay.json`; "_No live runs yet._" while only
`agent-sim` recordings exist), and the console prints one line per gate, but `eval:replay` exits
0 whatever the gate says; `eval:live` enforces it ([below](#live-runs-evallive-and-the-live-gate-m3)).

Current numbers (`eval/reports/replay.md`):

| Recording | tasks | pairs | precision | recall | recall ∪ rule tier | F1 | must_not_link (≥ 0.8) | questions |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `sim-policy-1` on `nordwind-handel` (dev) | 31 | 48 | 73.3 % | 78.6 % | 100 % | 75.9 % | 12 (3) | 12 |
| `sim-policy-1` on `stadtwerke-auental` (holdout) | 26 | 52 | 64.0 % | 80.0 % | 87.5 % | 71.1 % | 11 (2) | 15 |

Identical names carry the policy; the near-miss traps come back as proposals with a question (9
of the 12 hits on the dev landscape), reused generic message names (`generic-name`, score 1.0) are
the high-confidence misses, and the semantic links (`de-en` on the holdout, triggers with other
words) are out of its reach. These are the numbers an LLM agent has to beat; the recall column
is also the live gate's baseline for `proa-relations@0.1.0`, for every model, since no earlier
version has live runs. LLM agents with `proa-relations@0.1.0` on the dev landscape (three dev runs with Claude Sonnet 5.5,
[M3](#m3-2026-10-08)): precision 100 %, recall 78.6 %, F1 88.0 %, no must_not_link, in every run.

### Live runs, `eval:live` and the live gate (M3)

A live run is one LLM agent (Claude Desktop or Claude Code on the owner's subscription; ProA holds
no LLM credentials) working a **fresh project** seeded from the corpus under its **own agent
token**, whose name becomes the agent segment of the run's recording (`claude-desktop-1`,
`claude-code-2`, …). Never reuse a project across runs: a submission withdraws other principals'
pipeline proposals it does not repeat, and earlier proposals bias the claim input. The owner's
step-by-step guide is [M3-LIVE-RUNS.md](M3-LIVE-RUNS.md); the client setups are in
`examples/agents` ([Connect Claude Code](#connect-claude-code), [Connect Claude
Desktop](#connect-claude-desktop)).

```sh
docker compose -p proa2 -f docker/compose.yaml exec proa proa seed nordwind-handel \
  --project nordwind-handel-cd-1 --issue-tokens --token-name claude-desktop-1   # prints the token once
# connect the client with that token and let it work the project
PROA_TOKEN=proa_at_… pnpm eval:live --project nordwind-handel-cd-1 --landscape nordwind-handel
pnpm eval:replay                        # reports with the run; commit them with the recording
```

`proa seed <landscape> --project <key>` seeds exactly one landscape into a project of that key,
named `<landscape name> (<key>)`, and warns on stderr when the project already existed;
`--token-name` names the read+propose token of `--issue-tokens` (default `seed`, 90 days), whose
handle is `agent:<name>`. Keep the token until the run is recorded: a revoked token gets 401
(the owner key still reads the project), and revoking withdraws its proposals from the review.

**`eval:live`** (`eval/tools/src/live.ts`, `live-recordings.ts`) reads the project over REST with
the run's agent token or the owner key (`--token`/`PROA_TOKEN`; `--url`/`PROA_URL`, default
http://127.0.0.1:7400): every `done` analysis (`GET …/analyses?state=done`, all pages), its stored
submission (`GET …/analyses/{a}/submission`) and, once per model, its revisions (revision id →
number). Each submission becomes one `proa-recording/1` line: outcome `submitted`; the payload
parsed like a submission without lease token, so a raw REST body gets the defaults an MCP call
gets, in the recorder's key order; the result without task, submission and relation ids; no task
ids and no claim input. Lines are sorted by model key, then submission time, and grouped into
`<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl` below `--out` (default
`eval/recordings`), each written afresh; the agent is the token name from the handle (`--agent`
overrides it), procedure and model are what the submissions declared, so a run whose tasks
declare different models or versions, or a project worked under several tokens, gives several
files, each of which the gate counts as a run; eval:live then warns and names them
(`warning: project … gives 2 recording files, …`). The path names no project: a second run
under the same token name, model and landscape overwrites the first one's file, so give every
run a new token name. When a file exists with other content, eval:live prints
`replacing <file> (n lines before, m now)` on stderr and writes it all the same: recording a run
again after it went on is legitimate. `--landscape` names the corpus landscape the project was
seeded from (default: the project key, if it is one; otherwise a usage error). Relative `--out` and `--corpus` resolve against `INIT_CWD`, the directory pnpm was
started in, never `eval/tools`. A declared procedure version other than the checkout's draws a
warning. The new files are scored with the `eval:replay` scorer together with every recording of
the same procedure id and landscape already in `--out`; the command prints one line per run and
the live gates the new files count in, as a run or as the baseline (a new `agent-sim` recording
is the baseline of every model's gate of its version). `--no-write` scores without writing;
`--json` prints numbers only, never pair lists, so a holdout run shows no ground truth. Exit 0
when every gate shown passes or is incomplete; 1 when one fails or on a runtime error (server
unreachable, 401, 404, no done analyses, invalid data); 2 on a usage error (unknown option, no
`--project` or token, a landscape not in the corpus), as `proa-agent-sim` and `run-headless.sh`
have it. Then run `pnpm eval:replay` and commit the recording with the regenerated reports: CI
requires them to match.

**Live gate** (`eval/tools/src/live-gate.ts`, a pure function; CONCEPT §7). The live runs are the
recordings of every agent but `agent-sim`, one file per run. They are grouped by procedure
`<id>@<version>`, landscape and declared `llmModel` (the `<llmModel>` path segment), so the gate
is per pinned model: runs with another model form a gate of their own, while runs of different
clients with the same model count together. A group

- **fails** if any run proposes a must_not_link pair with confidence ≥ 0.8, or if the mean
  `overall.recall` of its runs (the proposals, without the rule tier's acceptances) is more than
  5 points below the baseline's (exactly 5 points below still passes);
- else is **incomplete** with fewer than 3 runs or without a baseline;
- else **passes**.

Failing is checked first, so a single run can fail a group. The baseline is the mean recall of
the live runs of the highest earlier `x.y.z` version of the same procedure on that landscape with
the same `llmModel`, else of the `agent-sim` recordings of the same version on that landscape,
whatever their model (several are averaged); versions not of the form `x.y.z` are never a
baseline. Means skip null values, so on a landscape without must_link pairs the recall rule does
not apply. Each gate reports procedure, landscape and `llmModel`, the runs, the mean precision,
recall and F1, the must_not_link pairs at ≥ 0.8, the baseline (source, procedure, files,
recall), the recall delta and every reason that applies. `eval:live` exits 1 on `fail`;
`eval:replay` writes the same gates into the report (one row per procedure / landscape /
`llmModel`) and never fails on them.

### The `proa` CLI

`node apps/cli/src/main.ts` (`pnpm proa` from the checkout, `proa` in the container). Global
options: `--url` (`PROA_URL`, default http://127.0.0.1:7400), `--token` (`PROA_TOKEN`, an agent
token), `--owner-key-file` (`PROA_OWNER_KEY_FILE`).

| Command | Credential | |
|---|---|---|
| `proa seed [landscape…] [--corpus dir] [-p\|--project <key>] [--issue-tokens [--token-name <name>]] [--verbose] [--json]` | owner key | one project per landscape of `eval/corpus` (default: every scored one, i.e. not starting with `_`; `_sample` seeds into `sample`), named after `landscape.yaml`; imports `models/`; safe to repeat (unchanged models stay unchanged). `--project` seeds exactly one named landscape into a project of that key, named `<landscape name> (<key>)` (a fresh project per live run; a warning if it already existed); `--issue-tokens` creates a read+propose token per project (90 days), named `--token-name` (default `seed`; the name is the agent segment of `eval:live` recordings). Misuse (`--project` without exactly one landscape or with an invalid key, `--token-name` without `--issue-tokens`) is refused before any request. The JSON result names the `landscape` of each project |
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
| `/projects/{key}/review` | **Prüfen** (M2, the tab counts open proposals): models per pipeline stage (a stage filters; for "Agent arbeitet" the holder and lease, for "Agent gescheitert" the error and "Erneut einplanen"), then **Vorschläge** (the review queue) and **Vorgemerkt** (`?view=held`); filters `?stage=&tier=&model=` stay in the URL and travel to the review screen ([below](#review-in-the-web-ui-m2)) |
| `/projects/{key}/review/{relation}` | **Review screen** of one relation, also the relation detail and the `reviewUrl` of `human-decision-required` ([below](#review-in-the-web-ui-m2)) |
| `/projects/{key}/relations` | **Relationen**: quick filters (all, accepted by rule, key-tier proposals, all proposals), filters status/tier/type/model in the URL (`?status=&tier=&type=&model=`); type, from → to with element label, model key and process, tier, status, endpoint state, confidence, provenance (from `Relation.provenance`), details (refs, version, attributes); "Prüfen" opens the review screen, the crosshair the model view. |
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
`test/limits.test.ts` compares with the contracts. The **engine** is `Model.engine` and the
**provenance** is `Relation.provenance` (M2 API): the rule tier shows `proa-rules/1.0.0` and what
matched, agent proposals the principal handle plus the declared procedure (`id@version`) and LLM
model, human decisions the handle and the verdict; only a relation without provenance falls back
to what tier and attributes say. Element labels come from the facts of every head revision
(`GET …/revisions/{r}/facts`, cached per revision).

#### Review in the web UI (M2)

M2-PIPELINE-REVIEW item 7 on the REST routes of [Analysis pipeline and review](#analysis-pipeline-and-review-m2);
`src/lib/review.ts` (queue, held list, stage counts, evidence, conflicts, all pure),
`src/lib/review-actions.ts` (mutations), `src/components/review/*`, `src/routes/project-review.tsx`
and `src/routes/review.tsx`.

- **Inbox** (`/projects/{key}/review`). The stage bar counts models per pipeline stage ("Phase"
  in the UI; "Stufe" is only the tier) in pipeline order (Wartet auf Agent → Agent arbeitet →
  Agent gescheitert → Wartet auf Prüfung → Klärung offen → Eingearbeitet). Selecting a phase lists
  its models; a lease that expired while nobody claimed since still says "Agent arbeitet" and is
  marked "Lease abgelaufen" with "Erneut einplanen", like a failed task; "Vorgemerkte zeigen" on
  a model waiting for clarification opens its held items. The queue holds the open proposals and
  the accepted relations whose endpoint changed or is missing ("Angenommen, Endpunkt geändert";
  the same `review_items` that keep a model in "Wartet auf Prüfung", and the count of the
  "Prüfen" tab), highest confidence first, then those whose decision finishes a model (its last
  open item, "schließt 1 Modell ab"); an agent's question shows as "Frage". "Prüfen" opens the
  review screen with the same filters.
- **Review screen** (`/projects/{key}/review/{relation}`, full viewport like the model view): both
  endpoint models in bpmn-js side by side (from 1280 px; below that, and with the toggle, one at a
  time: "Von" / "Nach"; one canvas when both ends lie in one file), endpoints marked and labelled
  "Von"/"Nach", each pane with model key, engine, stage and "Im Modell"; a pane whose model was
  deleted says so ("Modell „…“ gibt es nicht mehr") instead of loading. The panel shows type,
  status, tier, endpoint state, confidence, both endpoints, the version, the agent's question,
  rationale and evidence (refs into the two endpoint models are buttons that centre and mark the
  element as "Beleg", switching to its pane when only the other one is shown; refs into other
  project models link to the model view at that element; anything else stays text; a cited
  element belongs to its relation, so another relation, reached by link or history, starts
  without it), the provenance ("Vorgeschlagen von"/"Entschieden von", client, declared procedure
  and LLM model, tier, confidence, time) and the **timeline** (`GET …/assertions`, oldest
  first: proposals, withdrawals, decisions, notes with their texts, the assertion the status rests
  on marked "maßgeblich", links between a correction and the corrected proposal).
- **Decisions** at the panel's foot: **Annehmen** (A; "Erneut annehmen" for an accepted relation
  whose endpoint changed, which anchors the decision on the current endpoints; a missing endpoint
  can only be rejected or corrected), **Ablehnen** (R, reason required; agents see it),
  **Vormerken** (H, note required, question and label optional), **Korrigieren** (C: choose
  which end is wrong, pick an element from the compatible endpoints of the landscape, say why;
  sent as `verdict: correct`, so the server accepts a `manual` relation and rejects the proposal;
  the candidates are one radio group, a single tab stop with the arrow keys moving the choice).
  The correction candidates mirror `endpointRole` of `@proa/relations` (`src/lib/endpoints.ts`,
  same role as the replaced end, any endpoint for a `manual` relation, never in the process of the
  end that stays), ranked by shared words with either end. J/→ and K/← walk the queue (opened
  from the held list, `?view=held`, they walk the held list, and "Vorgemerkt" leads back to it);
  after a decision the screen moves on to the next item (back to the list at its end). Shortcuts
  never fire while typing, with a modifier, or while a dialog is open; Cmd/Ctrl+Enter submits a
  form (reject, hold, correction, the answer in the held list), Escape cancels it, and a
  cancelled correction starts afresh.
- **Versions.** Every decision sends the `version` the reviewer saw. A 409 (another decision, a
  new proposal, a re-upload meanwhile) shows "Die Relation wurde inzwischen geändert" with both
  versions, saves nothing and reloads the new state; the shortcuts pause until "Neuen Stand
  prüfen".
- **Bulk accept per tier** ("Schlüssel: 33 annehmen…", one button per tier in the queue): the
  dialog lists every pair with both labels and model keys and flags (`src/lib/generic-names.ts`)
  a message or signal name or end label made of generic words only ("Antwort", "Antwort erhalten",
  "Daten aktualisiert"; DE/EN list, camelCase split, umlauts folded), a name more than two
  processes use (with how many send and receive), a proposal whose agent asks the reviewer a
  question ("Der Agent fragt nach: …", the review screen shows it in full) and a call whose
  process id several models define (`duplicate-process-id`: accepting every target is rarely
  right). Flagged pairs start unchecked; a deliberate check holds for the version the reviewer
  saw, so after a 409 reload a pair that changed or is flagged now is unchecked again (and one the
  reviewer unchecked stays unchecked); the "Alle" box shows a dash while only some are selected.
  The request carries ids, versions, the tier and `expectedCount`; a 409 keeps the dialog open
  with "Die Liste hat sich geändert … Es wurde nichts entschieden". Accepted relations whose
  endpoint changed are never in a bulk list; they are confirmed one by one.
- **Held list** (`?view=held`): per held relation the hold note, question and label, the answers so
  far (notes after the hold) and an answer field (`POST …/notes`), plus "Prüfen" to decide once the
  answer is known.
- **Plain text.** Rationales, questions, notes, labels, evidence and task errors render through
  `PlainText` (React text, `white-space: pre-wrap`): no HTML, no Markdown; the review flow checks
  that an `<img onerror>` rationale stays text under the CSP.

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
M2: `model_revision.engine`; `relation_assertion.question`, `label`, `linked_relation_id` and the
kind `note` (check: notes only from humans); `analysis_submission.client_id`
(`0002_pipeline_review.sql`, generated); the `proa_analysis` NOTIFY trigger, the engine backfill
and the deferred assertion → submission foreign key (`0003_pipeline_notify.sql`, hand-written).
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

**Procedures** (`packages/procedures`). One Markdown file per procedure in the package root:
frontmatter of `key: value` lines with `id`, `version` (`x.y.z`), `title`, `status`
(`placeholder` or `released`) and optionally `description` (one line; it becomes the skill's
description, else the title does; other keys are ignored), then the text. `listProcedures` parses
every `*.md` in the package root except `README.md`, so drafts, templates and generators stay out
of the root. The text pins no version (no `x.y.z`; agents declare the one the claim names) and
holds no `---` (`procedures.test.ts`), and it must not contain what Claude Code expands in a
skill: `$ARGUMENTS`, `$` followed by a digit (`$1.00` too), `${CLAUDE_`, `` !` `` at the start or
after whitespace, and ```` ```! ````; `renderSkill` throws on them, so `generate` fails. After
every change of the procedure run `pnpm --filter @proa/procedures generate` and commit
`plugins/proa/skills/relations/SKILL.md` and `plugins/proa/.claude-plugin/plugin.json` (its
`version` is the procedure version); `test/plugin.test.ts` fails until both match. Never edit the
skill by hand. `apps/server/test/unit/procedure-text.test.ts` keeps the prose in line with the
code: the procedure is `released`, states the contract limits (lease minutes, the third attempt,
relations and no-links per submission, evidence entries, rationale, question, summary and no-link
reason lengths, the documentation cut, the 1 MiB body), names every `invalid:<reason>` of the contracts,
and names only MCP tools that the tools snapshot lists. A new version also moves the simulation
agent's recordings ([Recordings](#simulation-agent-and-evalreplay-m2)).

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
- M2 pipeline and review (real PostgreSQL; fake analysis unless noted):
  `pipeline.test.ts` (claim and its hashed, bound lease token, the claim input, per-item results
  for every invalid reason, provenance, verbatim storage, replay and 409 `already-submitted`,
  release, lease expiry with re-claim and `lease-lost`, failure after the third lost lease in the
  claim transaction, late submits, cancellation by a new revision, supersession, requeue, scopes,
  a claim whose input cannot be built; after the review: a third expired lease failed by the
  pending count or a requeue without anybody claiming, a requeue cancelling an expired lease with
  attempts left, a late submit after the failure refused once a newer task ran or the model
  changed, the 413 for a body over 1 MB, items with control characters `invalid` while the others
  apply and NUL stored as U+FFFD, control characters in the declared model and a release reason
  refused, a revoked token's proposals withdrawn and its task handed back with decisions and other
  agents' proposals kept); `pipeline-concurrency.test.ts` (over real HTTP: two
  projects, six agent tokens and the owner claim at once, every task exactly once, again after the
  leases expired; a row locked by another transaction is skipped, not waited for; the long-poll
  wakes on NOTIFY, is bounded, shares one LISTEN connection, lets go of aborted requests, ignores
  other projects and bounds the waits per caller); `review.test.ts` (accept, reject, hold, correct, notes, If-Match and versions,
  bulk with count/version/tier/duplicate mismatches, decision memory across re-uploads, held items
  and `waiting_for_clarification`, the claim input with decisions and notes, findings answered by a
  relation, ad-hoc proposals and withdrawal, manual relations, agents never decide, events, a
  human's acceptance kept when the same human proposes the pair again and that proposal is
  superseded, control characters refused in every decision, note and ad-hoc proposal);
  `claim-input-size.test.ts` (real libraries, every model of both scored landscapes, < 100 KB);
  `policy.test.ts` (claim, pending, requeue, ad-hoc proposals, decisions, bulk and notes per
  credential); `db-constraints.test.ts` (notes by humans only, agents never decide even through the
  store, the deferred submission reference, the engine backfill); `mcp-contract.test.ts` (the pipeline
  tools, `decide_relation`, `propose_relation`/`withdraw_proposal`, `get_landscape` and the prompt in
  both protocol versions; a submission just over 1 MB refused as `payload-too-large`, a request
  over the MCP limit as HTTP 413). Unit: `status.test.ts` (with 2,000 random histories as property tests:
  order independence, notes ignored, obsolete exactly without live stances, latest decision wins
  unless a changed proposal reopens a rejection, `classifyProposal` never drops a proposal that would
  change the status; a human decision in force across the same human's later proposal and its
  withdrawal), `pipeline.test.ts` (lease tokens, item checks incl. control characters, the stored
  payload's NUL replacement, findings filter, claim-input rendering, If-Match, notifier fallbacks
  incl. the per-caller limit); `packages/relations/test/assess.test.ts`.
- M2 simulation agent and `eval:replay`: `apps/agent-sim/test/unit` (`pnpm --filter
  @proa/agent-sim test`, no Docker): `policy.test.ts` (one verdict per candidate incl. skips for
  accepted, rejected, held and reopened pairs, rationale and question texts, no-links, thresholds,
  verdict by score whatever the basis, the submission limits on 900 seeded random candidates),
  `recorder.test.ts` (recording lines with and without ids, input summary, layout, files started
  afresh per run), `agent.test.ts` (the loop over the real SDK client against an in-memory MCP
  server: procedure and prompt read, one claim per task, scope and `maxTasks`, dry run, refused
  submissions handed back at the end, no loop on a repeated task, missing tools, wrong token) and
  `program.test.ts` (the command line: token checks, options, exit codes, recording paths). The
  end-to-end run is the server test `agent-sim.test.ts` (real PostgreSQL and libraries): both
  scored landscapes imported, `nordwind-handel` worked over Streamable HTTP and
  `stadtwerke-auental` through `proa-agent-sim --stdio` (the `proa mcp` bridge as a child
  process); every task `done` with attempt 1 and its stored submission (handle, client, declared
  procedure and model, no lease token, nothing invalid), every agent-sourced relation `proposed`
  with the token's principal, client, procedure and model (also checked row by row in
  `relation_assertion`), no decision but the rule tier's, no `relation.decided` event by the
  agent, the recordings equal to `eval/recordings` (file snapshots), and a dry run that leaves
  every task queued with no attempt counted. `eval/tools/test/replay.test.ts`: a fixture recording
  of `_sample` with every case (server-invalid and locally invalid items, a pair proposed twice,
  must_not_link at high confidence, unlisted, no-links incl. one on a must_link, questions) scored
  to exact numbers; the report is deterministic and the committed `replay.md` up to date (with
  its "Live gate" section); unreadable recordings are refused with file and line.
- M3 procedure and plugin: `packages/procedures/test` (`pnpm --filter @proa/procedures test`, no
  Docker): `procedures.test.ts` (the released procedure, its `description`, no version and no
  `---` in the text, frontmatter parsing), `wrappers.test.ts` (the wrapper for a fixed scope, no
  scope and the skill's arguments; the skill's frontmatter, the title fallback, the expansion
  guard and a `$` it lets through) and `plugin.test.ts` (the committed `SKILL.md` equals
  `renderSkill`, `plugin.json` has the name `proa` and the procedure version, the marketplace
  lists `./plugins/proa`, the plugin declares no `mcpServers` and has no `.mcp.json`).
  `apps/server/test/unit/procedure-text.test.ts`: the procedure text against the contracts and
  the MCP tools snapshot ([Conventions](#conventions)). `mcp-contract.test.ts`: the
  `work_pipeline` text equals `renderPipelineWrapper` and ends with the procedure; `maxTasks`
  `7` and `100` (also without a project) limit the loop, and `0`, `101`, `07`, `1.5`, `-3`, `abc`
  and the empty string are refused. `mcp.test.ts`: no input schema has a root `$ref`, and the
  instructions name exactly the tools without a required `projectId` (`test/unit/mcp.test.ts`
  checks the wording).
- M3 claim input: the contracts (an input without the additions still parses, the additions
  parse, malformed ones are refused), unit `pipeline.test.ts` (message-flow ends, partner
  documentation, `partnerProcesses` with the documentation cut, findings filtered to the model
  and sorted, both fields left out when there is nothing), integration `pipeline.test.ts`
  (`partnerProcesses` exactly the partners' processes, each input with the findings touching its
  model) and `claim-input-size.test.ts` ([above](#analysis-pipeline-and-review-m2)).
- M3 live runs: `eval/tools/test/live-gate.test.ts` (pass, fail, incomplete; one gate per
  procedure version, landscape and `llmModel`, whose runs, means and 0.8 rule do not mix; the
  baseline from the highest earlier version's live runs with the same `llmModel` or from
  `agent-sim` of any model, `0.1.10` after `0.1.9`; the 5-point boundary with float noise; 0.79999
  vs. 0.8; null recall) and `live.test.ts` (raw REST and MCP payloads from `test/fixtures/live`,
  U+FFFD, the agent from the handle or `--agent`, sorting and grouping, refused payloads and
  landscapes, the REST reader against a fake server: pages, revision numbers, 401, 404, an
  unreachable server; the command on `_sample`: incomplete, a pass with three runs and the
  `agent-sim` baseline, a second model as a gate of its own, a fail at exactly 0.8 with
  `--no-write`, the warnings for several files and for a replaced file, the procedure warning,
  usage errors with exit 2 before any request, runtime errors with exit 1). The server's `agent-sim.test.ts` runs `eval:live`'s
  reader with each project's agent token after the simulation agent and requires the recorder's
  lines, input aside, byte for byte. `apps/cli`: unit tests for `seed --project`/`--token-name`
  (the warning for an existing project, misuse refused before any request, `--help`) and an e2e
  test that seeds `_sample` into `sample-run-1` with the token `claude-code-1`, whose handle is
  `agent:claude-code-1`.
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
  `api.test.ts` (session on 401, one session for parallel 401s, problems), `lib.test.ts` (upload
  planning, snippets, slugs, refs, filters, provenance fallback), `app.test.tsx` (routes rendered
  on the server, incl. the inbox and the review screen), `theme.test.ts` (token drift) and
  `limits.test.ts` (constants and label maps against the contracts). Review (M2):
  `decision-panel.test.tsx` (accept with the seen version, A/R/H/C shortcuts, required reason and
  note, question and label only when given, shortcuts ignored while typing, Escape, the correction
  dialog with compatible candidates, search and the exact `correct` body, the 409 conflict message
  with both versions and paused shortcuts, other errors as toasts, obsolete and accepted
  relations, "Erneut annehmen" for a changed endpoint and none for a missing one, the correction
  candidates as one radio group with arrow keys, Cmd/Ctrl+Enter and a fresh start after
  "Abbrechen"), `bulk-accept-dialog.test.tsx` (every pair listed, generic and shared names, agent
  questions and ambiguous call targets flagged and unchecked, the exact body with ids, versions,
  tier and `expectedCount`, select all/none with a dash for "some", 409 keeps the dialog open,
  after the reload a pair flagged now or changed since a deliberate check is unchecked),
  `held-list.test.tsx` (hold note, question, label, only answers after the hold, saving an answer
  as a note, also with Cmd/Ctrl+Enter, empty list), `review-screen.test.tsx` (the real router with
  a stand-in canvas: evidence switches the pane, refs into other models link to the model view,
  another relation by link or history starts without the previous one's evidence, a deleted
  endpoint model is named instead of loading), `review-inbox.test.tsx` (accepted relations with a
  changed endpoint in the queue and the tab count but not in bulk, held items of a model waiting
  for clarification, requeue of an expired lease), `review-details.test.tsx` (hostile rationale as
  plain text, endpoints, question, provenance, clickable evidence refs vs. text, timeline order with
  the deciding entry and correction link) and `review-lib.test.ts` (queue order and filters, held
  order, stage counts, neighbours, evidence parsing, conflicts, generic names, endpoint roles and
  correction candidates, provenance from the API). The tests stub `fetch` and talk through the real
  generated client; components with links render in a throwaway router (`renderWithRouter`).
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
- `apps/web/e2e/review.spec.ts` (Playwright, M2 review flow, same prerequisites): creates its own
  project from `eval/corpus/nordwind-handel` and an agent token, then as the agent over REST
  claims ten tasks, submits proposals for eight (built from the claim input's lexical candidates,
  with rationale, evidence, one question and one rationale carrying HTML), releases one and keeps
  one claimed. In the browser: the stage counts (22 waiting, 1 working) and the holder of the
  claimed task; the review screen with both models imported and endpoints marked, rationale,
  provenance, an evidence ref marked "Beleg", J/K; A, R (reason, Ctrl+Enter) and H (note, question,
  label) with the stored status checked over REST; the held list with a saved answer; a correction
  and the linked timelines of both relations; the HTML rationale rendered as text (no element, no
  dialog) and a 409 conflict after a decision made meanwhile over REST; the bulk accept of the key
  tier with flagged pairs left open. Every page is checked for CSP violations.
- `apps/web/e2e/pipeline.spec.ts` (Playwright, M2 end to end, same prerequisites plus the
  checkout's `apps/agent-sim`): creates its own project from `eval/corpus/nordwind-handel` and an
  agent token (read, propose), then runs `proa-agent-sim` as a child process over MCP until no task
  is left (every task submitted at attempt 1, nothing invalid; the five pairs the flow decides are
  proposed with the token's principal and client, `proa-relations` and `sim-policy-1`). In the
  browser: the stage bar equals the models' stages (none waiting for the agent, some waiting for
  review, some incorporated), questions in the queue, the agent's provenance in the relations
  table; the review screen with the agent's rationale, question and provenance; A, R twice, H with
  a question and its answer in the held list; a correction of the dynamic call
  `Call_RechnungAusgeben` to `finanzen/briefversand` (a `manual` relation accepted, the proposal
  rejected); the bulk accept of the key tier with "Antwort" (generic) and both targets of the
  duplicate process id (agent question, ambiguous target) left open. Then decision memory: the
  modeler renames the start event of `finanzen/zahlungslauf` and uploads it again; the rejection
  touching it stays rejected with "Endpunkt geändert" and the model waits for the agent; the other
  rejected pair, proposed again over MCP (`propose_relation`), answers `suppressed` without a new
  version; `decide_relation` over MCP answers `human-decision-required` with a `reviewUrl` that
  opens the review screen; the agent's second run works only that model and reopens the changed
  pair (`reopened`, status `proposed`, timeline proposal → rejection → proposal), while the
  accepted and held relations of that model keep their status; the reviewer accepts it.
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
  tool change run `pnpm --filter @proa/server exec vitest run test/integration/mcp-contract.test.ts -u`;
  `-u` takes an optional value, so a path right after it is not a file filter and every file runs).
  Every tool is called with valid input (the client validates `structuredContent` against the
  output schema), invalid input, and the other project's key and id and unknown ids (404). The
  credential matrix: no token, malformed, revoked (also for an open client) and expired tokens,
  the owner key and the owner session (401), every agent scope, a token cannot be created
  without `proa:read` or with `proa:review` (422) nor stored without scopes (check
  constraint), and a scope-less row, with the constraint dropped, gets 403 `insufficient_scope`
  on MCP and REST. `tools/list` uses no JSON Schema format but `date-time` and `uuid`.
- `apps/cli/test/live/stack.live.test.ts` (`PROA_LIVE_URL=http://127.0.0.1:7400 pnpm --filter
  @proa/cli test:live`) checks a running, seeded ProA as a user runs it: health, UI, OpenAPI
  and a foreign `Host`; agent tokens through `proa token create` in the container
  (`PROA_LIVE_CONTAINER`, default `proa2-proa-1`; empty: the checkout CLI with the local owner
  key); MCP over HTTP in 2025-11-25 and 2026-07-28; `proa mcp` started exactly as both Claude
  Desktop entries say, with the environment of a macOS GUI app (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
  cwd `/`), where a bare `docker` cannot be found; a revoked token refused through the bridge.
  Each path lists the token's project, all models, the accepted rule relations (compared with
  `eval/reports/candidates.json`), a process, XML and the procedure, and gets 404 for the other
  project. M2: the pipeline tools are listed, and deciding a proposed relation as an agent
  (`decide_relation` for accept, reject and hold, and REST `POST …/decision`) answers 403
  `human-decision-required` with `reviewUrl` = `<PROA_LIVE_URL>/projects/<key>/review/<rel>`,
  changes nothing and that URL serves the UI. Its tokens are revoked at the end (they stay
  listed as revoked). Without
  `PROA_LIVE_URL` it is skipped, so `pnpm test` never touches a running stack.
- `apps/web/e2e/screenshots.spec.ts` retakes `docs/proa-2/screenshots/0*.png` from a running,
  seeded ProA (`PROA_SCREENSHOTS_DIR`, see Commands). It creates a token named "Screenshot",
  blanks every full secret in the page before each screenshot, and revokes the token afterwards.
  `review.spec.ts` writes `m2-01` … `m2-07`, `pipeline.spec.ts` `m2-08` … `m2-12` into the same
  directory when `PROA_SCREENSHOTS_DIR` is set.

## CI

`.github/workflows/ci-2.yml` runs on pull requests and on pushes to `develop` and
`claude/proa-2` that touch the workspace: `apps/`, `packages/`, `eval/`, `docker/`, and since M3
`plugins/`, `examples/` and `.claude-plugin/`, plus the root configuration files and the workflow
itself (the same path filter for both triggers). Job `verify`: install with the frozen lockfile,
format check, typecheck, lint, tests (incl. Testcontainers, the MCP contract test, and the plugin
drift check of `@proa/procedures`), client drift check, `eval/tools` check and validate,
`eval:candidates` (fails on a gate; `eval/reports` must be up to date), `eval:replay`
(`eval/reports` and `eval/recordings` must be up to date, the live gate section included; the
gate itself fails nothing), and the web build. Job `docker`: builds the image and starts the
Compose stack (`up -d --build --wait`), checks `/health` and `/`, runs `proa seed` and
`proa status` in the container, then the live check (`test:live`) against it. Actions are pinned
to commit SHAs. The Playwright tests are not in CI. `examples/agents` is outside the workspace:
CI only runs Prettier over its TypeScript and JSON files; the Agent SDK worker (its own
`package.json`, never installed in CI) is neither typechecked nor linted, `run-headless.sh` is
not shellchecked, and no setup runs against a model. `eval:live` needs a live project and is not
in CI either.

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

M2 simulation agent, on 2026-10-08 (same machine, Node 24.15): PostgreSQL in a throwaway compose
project (`PROA_DB_PORT=55441 docker compose -p proa2-sim -f docker/compose.yaml up -d --wait db`),
the server from the checkout on port 7441 with its own owner key, `proa seed --issue-tokens`, then
`pnpm agent-sim --record rec --record-input summary --no-record-ids` with the `nordwind-handel`
token over HTTP (31 tasks submitted) and `node apps/agent-sim/src/main.ts --stdio …` with the
`stadtwerke-auental` token through the bridge (26 tasks); both recordings byte-identical to
`eval/recordings`, `eval:replay --recordings rec` gave the committed numbers, `proa status` showed
no model waiting for an agent and only the rule tier's acceptances. A requeue of all models, a dry
run of two tasks (both queued again, attempts 0) and a second full run (all 96 proposals
`duplicate`, nothing withdrawn) followed; then `down -v`. The owner's `proa2` stack was not
touched.

M2 review UI, on 2026-10-08 (same machine): PostgreSQL in a throwaway compose project
(`PROA_DB_PORT=55471 docker compose -p proa2-m2web -f docker/compose.yaml up -d --wait db`), the
server from the checkout on port 7431 with its own owner key and the freshly built UI, `proa seed`;
Playwright in Chromium with `PROA_E2E_URL=http://127.0.0.1:7431`: the review flow (7 tests), the
smoke test (3) and the screenshots (M1 retaken, since the relations table and the model view now
link to the review screen, plus `m2-*.png`), no CSP violation. Then the gates: `pnpm format:check`,
`pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` (web 98, server 723, cli 50 plus 6 live tests
skipped, agent-sim 36, relations 61, bpmn-facts 134, contracts 32, procedures 6, client 4,
eval/tools 32), `pnpm eval:candidates` (pass, report unchanged) and `pnpm build`; then `down -v`.
Not run for the UI: the Docker image and the CI docker job, other browsers than Chromium, screen
readers.

### M2 end to end (2026-10-08)

Everything of M2 together, on the owner's `proa2` stack (until then the M1 image with the M1
seed; a `pg_dump` was taken first) and a second compose project from the same image:

1. **Upgrade in place.** `docker compose -p proa2 -f docker/compose.yaml up -d --build --wait`
   applied migrations 0002 and 0003 to the M1 database; the engine backfill gave every one of the
   57 models the engine `@proa/bpmn-facts` detects (27 `c7`, 30 `c8`). `proa seed`: all files
   `unchanged`.
2. **Pipeline.** One read+propose token per project (`proa token create` in the container).
   `proa-agent-sim` over HTTP on `nordwind-handel` (31 tasks, 96 proposals: 48 applied, 48
   duplicate; 256 no-links) and through the bridge in the container (`--stdio-command
   "/usr/local/bin/docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp"`, Claude Desktop's Docker
   entry) on `stadtwerke-auental` (26 tasks, 104 proposals: 52 applied, 52 duplicate). The
   recordings (`--record-input summary --no-record-ids`) are byte-identical to `eval/recordings`,
   also on this upgraded database. Stages moved from 31 and 26 "waiting for agent" to 28 "waiting
   for review" + 3 "incorporated" and 20 + 6; every proposed relation's provenance names the
   token's principal and client, `proa-relations@0.0.1` and `sim-policy-1`; findings that a
   proposal answers are hidden (14 → 8 and 17 → 16). The inbox in Chromium shows the same counts.
3. **Agents cannot decide.** The live check (7 tests, incl. `decide_relation` for every verdict
   and REST `POST …/decision` with an agent token: 403 `human-decision-required` with the stack's
   `reviewUrl`, nothing changed) passed against the stack before and after the final rebuild.
4. **Review in the browser** (`e2e/pipeline.spec.ts`, see [Tests](#tests)) against the second
   project `PROA_HOST_PORT=7460 PROA_DB_PORT=55460 docker compose -p proa2-e2e -f
   docker/compose.yaml up -d --build --wait`, so the owner's queue stays undecided: accept, two
   rejections with reasons, a hold with a question and its answer, a correction, the key-tier bulk
   accept with the generic "Antwort" pair and both targets of the duplicate process id left open;
   then the re-upload of `finanzen/zahlungslauf`, `suppressed` for the unchanged rejected pair
   over MCP, `reopened` for the changed one by the agent's second run, accepted and held relations
   unchanged. With the review (7) and smoke (3) specs: 16 passed, no CSP violation; screenshots
   `m2-01` … `m2-12`. Then `down -v`.
5. **Gates:** `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` (server
   723, web 101, cli 50 plus 7 live tests skipped, agent-sim 36, relations 61, bpmn-facts 134,
   contracts 32, procedures 6, client 4, eval/tools 32), `pnpm eval:candidates` (pass, report
   unchanged), `pnpm eval:replay` (reports byte-identical), eval/tools `check` and `validate:all`,
   client generation without drift, `drizzle-kit generate` without schema changes, `pnpm build`,
   and the image build (`up --build`).
6. **Fixed on the way:** the lease token's schema was zod `.startsWith()`, so `claim_analysis`
   declared `format: "starts_with"` and every SDK client printed a warning (now a `pattern`; the
   contract test allows only standard formats); the bulk accept took the agent's key-tier
   proposals that ask the reviewer a question, and both targets of a duplicate process id, without
   a look (now flagged and unchecked); its "Alle" box showed a tick while only some were selected
   (now a dash); the e2e helpers counted the diagrams before they were mounted.

Found and left open (decisions for the owner):

- An agent that leaves out decided pairs, as `sim-policy-1` does, has its earlier proposals on
  accepted and held relations of that model withdrawn by its next submission (supersession). The
  status stays, but the relation's `version` moves, so a reviewer who has it open gets the 409
  "inzwischen geändert" screen after an agent run.
- `correct` towards a pair that already has a typed proposal (e.g. the key-tier message) creates a
  second, `manual` relation next to it; the typed proposal stays open.
- Revoking an agent token did not withdraw its proposals (CONCEPT §6 lists it as a mitigation);
  fixed below, [M2 review fixes](#m2-review-fixes-2026-10-08).
- Through the bridge in the container, `reviewUrl` carries the container's port 7400, which is
  wrong when `PROA_HOST_PORT` moves the published port.
- The simulation agent writes English rationales and questions into a German UI; the real
  procedure (M3) decides the language. Decided in M3: German
  ([The relations procedure](#the-relations-procedure-m3)); `sim-policy-1` stays English.

State left behind: the `proa2` stack runs the final image with both landscapes seeded and worked
by the simulation agent, nothing decided but the rule tier (`nordwind-handel`: 48 proposed, 28
models waiting for review; `stadtwerke-auental`: 52 and 20). The two simulation tokens
(`agent-sim-http`, `agent-sim-bridge`) and the live check's tokens are revoked; their proposals
stay (they were revoked before a revocation withdrew proposals).

Not verified: Claude Desktop itself (no GUI session; the bridge was started exactly as its
configuration says), the `local` and `user` scopes of `claude mcp add` (they write to the user's
Claude configuration; the HTTP exchange is the same as with the project scope), Cursor, VS Code
and Codex, other operating systems, `pnpm dev` in this run (earlier stages verified it), and
`ci-2.yml` on GitHub (only parsed locally).

### M2 review fixes (2026-10-08)

A review of the M2 state (pipeline, security, UX) found 15 issues; all were verified and fixed,
none rejected. Each fix has a test that fails without it (checked by disabling the fix for 1–7, 9
and 10):

1. A late submit on a `failed` task passed after a newer task of the model had run, and its
   supersession withdrew the newer proposals. Now 409 `task-cancelled` when a newer task exists or
   the model changed or was deleted after the failure.
2. A task whose third lease expired stayed `claimed` ("Agent arbeitet") until somebody claimed in
   the project; pending did not count it, and requeue answered `open`. Now the pending count and a
   requeue fail it too (requeue then queues a new task; an expired lease with attempts left is
   cancelled and requeued), and the inbox marks an expired lease with "Erneut einplanen".
3. A human's later proposal replaced that human's own decision (per-principal stance), so an
   accepted relation turned `proposed` and, after supersession, `obsolete`. Now a human's latest
   decision stays in force until the same human decides again (`decisionsInForce`); the property
   tests' oracle follows.
4. MCP `submit_analysis` took up to the SDK default of 4 MiB and stored it. Now the MCP endpoint
   refuses requests over 1 MB + 16 KB (HTTP 413), and the use case refuses a stored payload over
   1 MB (`payload-too-large`) for REST and MCP alike.
5. U+0000 in agent or human text gave a 500 and lost the whole submission. Now submission items
   answer `invalid:control-characters` (a new reason in the contracts, OpenAPI, client and MCP
   snapshot), other free text (decisions, bulk decisions, notes, ad-hoc proposals, release reason)
   is refused with 422, declared procedure and LLM model are names, and the stored payload keeps
   U+0000 as U+FFFD.
6. One token could take all 200 long-poll slots. Now at most 8 waits per caller (principal).
7. Revoking a token now withdraws its live proposals and hands its claimed tasks back (CONCEPT
   §6); the revoke dialog says so.
8. Accepted relations whose endpoint changed kept models in "Wartet auf Prüfung" but were in no
   list, and "Annehmen" was disabled. Now they are in the queue and the tab count ("Angenommen,
   Endpunkt geändert") and can be accepted again ("Erneut annehmen").
9. The bulk dialog kept a pair checked after a 409 reload although it was flagged now. Deliberate
   checks now hold for the version seen.
10. The review screen kept the previous relation's "Beleg" after navigating by link or history.
    Cited elements now belong to their relation; evidence switches to the hidden pane, and refs
    into other models link to the model view.
11. A pane for a deleted endpoint model spun forever; it now names the missing model.
12. "Stufe" meant both the pipeline stage and the tier on the inbox; the pipeline stage is now
    "Phase" (models table, filter, stage list), and the provenance says "Vorgeschlagen
    von"/"Entschieden von" and "LLM-Modell".
13. "Vorschläge zeigen" on a model waiting for clarification opened an empty list; it now opens
    its held items, and the review screen walks and returns to the held list (`view=held`).
14. The correction candidates were up to 60 tab stops without arrow keys, and Cmd/Ctrl+Enter did
    nothing there or in the held list's answer. Now one Radix radio group, Cmd/Ctrl+Enter in both
    forms, and "Abbrechen" starts afresh.
15. `agent-sim.test.ts` told maintainers `vitest run -u <file>` (updates every snapshot); now
    `vitest run <file> -u`.

Verified afterwards, on the same machine:

- Gates: `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint` (no dependency violations),
  `pnpm -r test` (server 738, web 112, cli 50 plus 7 live tests skipped, agent-sim 36, relations
  61, bpmn-facts 134, contracts 33, procedures 6, client 4, eval/tools 32), `pnpm eval:candidates`
  and `pnpm eval:replay` (reports and recordings byte-identical), eval/tools `check` and
  `validate:all`, client generation without drift, `drizzle-kit generate` without schema changes,
  `pnpm --filter @proa/web build`.
- E2E step 1: a `pg_dump` of the owner's database, then `docker compose -p proa2 -f
  docker/compose.yaml up -d --build --wait` with the final code (the image build); `proa seed`
  all `unchanged`; `proa status` identical before and after (48 and 52 proposed, 28 and 20 models
  waiting for review).
- Step 3: the live check (7 tests) against the owner's stack; nothing changed there but two
  created and revoked tokens.
- Steps 2 and 4 on a throwaway project from the same image (`PROA_HOST_PORT=7460
  PROA_DB_PORT=55460 docker compose -p proa2-e2e …`, removed with `down -v` afterwards), so the
  owner's queue stays undecided: `proa seed`, the M1 screenshots retaken from that fresh seed
  (the models table now says "Phase"), one token per project, `proa-agent-sim` over HTTP on
  `nordwind-handel` (31 tasks, 48 applied, 48 duplicate) and through the bridge in the container
  on `stadtwerke-auental` (26 tasks, 52 and 52), both recordings byte-identical to
  `eval/recordings`, the same stages, findings and provenance as before; revoking the
  `nordwind-handel` token withdrew its 48 proposals (33 rule-tier key proposals stayed); then
  `pipeline.spec`, `review.spec` and `smoke.spec` in Chromium (16 passed) with the `m2-*`
  screenshots retaken.

State left behind: the `proa2` stack runs the image with these fixes, its data as before (both
landscapes seeded and worked by the simulation agent, nothing decided but the rule tier). The
`pg_dump` taken before the rebuild stays in the session's scratchpad.

### M3 (2026-10-08)

The M3 commits (`16c9f4b` claim input and MCP instructions, `5340ee2` live-run tooling, `81f96e4`
wrappers, plugin and reference setups, `23873a8` the release of `proa-relations@0.1.0`), same
machine, Claude Code 2.1.294. Verified without a model:

1. **Plugin.** `claude plugin validate --strict plugins/proa` and `claude plugin validate --strict
   .` (the marketplace) pass, rerun on the final tree with plugin version 0.1.0. The validator
   checks the manifests only, neither the skill nor a `.mcp.json` (shown with a deliberately
   broken scratch copy); the skill's frontmatter was parsed once with the workspace's `yaml`
   2.9.1. A deliberate drift of the skill was caught by `plugin.test.ts` and repaired by
   `generate`.
2. **`run-headless.sh`.** `bash -n`; shellcheck 0.10.0 (`--severity=style`, in a throwaway
   container) without findings; dry runs with a fake pending endpoint and a fake `claude` on
   `PATH`: 7 pending tasks in batches of 3 gave three batches and exit 0 with the temporary
   directory removed and the `claude -p` flags as documented; a pending count that did not go
   down stopped with "no progress" (exit 1); a rejected token, bad arguments, a missing
   `PROA_TOKEN` and a set `ANTHROPIC_API_KEY` without `--allow-api-billing` exit 2.
3. **Agent SDK worker.** In an isolated `npm install` of a scratch copy, `tsc --noEmit` against
   `@anthropic-ai/claude-agent-sdk` 0.3.293 passes; `--help`, a missing key, an alias as model and
   `--once` (nothing pending, and a 401) behave as documented without starting a `query()`.
   `docker build` of its Dockerfile succeeds; the image prints `--help` and refuses to start
   without `ANTHROPIC_API_KEY`. Nothing of it is committed; the image was removed.
4. **Codex.** `config.toml` parses (Python 3.12 `tomllib`); its keys follow OpenAI's
   documentation. Not run.
5. **Claim input.** `claim-input-size.test.ts` on both landscapes: at most 80.1 KB and 74.8 KB,
   mean 40.8 KB and 48.6 KB, every addition present; the regenerated simulation recordings
   changed only in `input.bytes`, and `eval:replay` gave the same numbers.
6. **`eval:live` smoke test** (before the release, so the claims still named
   `proa-relations@0.0.1`): PostgreSQL in a throwaway compose project `proa2-m3blive`, the server
   from the checkout on port 7452, `proa seed nordwind-handel --project nordwind-live-1
   --issue-tokens --token-name claude-code-1`, and `proa-agent-sim` with that token through all
   31 tasks. `eval:live` wrote `proa-relations@0.0.1/claude-code-1/sim-policy-1/nordwind-handel.jsonl`,
   byte-identical to the committed simulation recording once `input` is removed and the agent
   renamed. Scored with `--no-write` against `eval/recordings`, the gate took the `agent-sim`
   baseline (recall 78.6 %) and failed with exit 1 on 3 must_not_link pairs at ≥ 0.8, the
   simulation agent's known high-confidence hits. Then the server was stopped and the project
   removed with `down -v`; the owner's `proa2` stack was not touched.
7. **Gates** on the final tree: `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint` (no
   dependency violations, 85 modules, 299 dependencies), `pnpm -r test` (server 750, web 112, cli
   55 plus 7 live tests skipped, agent-sim 36, relations 61, bpmn-facts 134, contracts 36,
   procedures 21, client 4, eval/tools 49), `pnpm eval:candidates` (pass, report unchanged) and
   `pnpm eval:replay` (reports and recordings unchanged).

LLM dev runs: three dev runs on 2026-10-08, each on a fresh `nordwind-handel` project of a scratch stack, every task worked by its own Claude Sonnet 5.5 subagent of the implementing Claude Code session through the real MCP tools (called with a command-line MCP client instead of a native connection). Projects `nordwind-dev-1` to `-3` on a server started from the
checkout (port 7410, its own compose database `proa2-m3`), seeded with `proa seed nordwind-handel
--project nordwind-dev-<n> --issue-tokens --token-name claude-sonnet-dev-<n>`; each subagent got
the `work_pipeline` prompt (`maxTasks` 1) and worked one task. All three runs: 31 of 31 tasks
submitted, 0 invalid items, precision 100.0 %, recall 78.6 % (all 33 non-call must_link pairs;
∪ rule tier 100 %), F1 88.0 %, 0 must_not_link, 6 questions (all on `may_link` pairs: the
ambiguous and dynamic calls, one conditional trigger); `pnpm eval:live` recorded and scored each
run (into a scratch directory) and reported the gate `pass` after the third. Run 1 used a draft
that the released text refines in five places. Per task 1–3 minutes and about 75,000 tokens in
that harness (instructions, claim input, tool results), which at Sonnet 5.5 API prices is roughly
$0.15–0.20. The subagents' tool calls were audited: none read outside its work directory. The
recordings are not committed and do not count for the gate.

Not verified: any run with a model besides the dev run above: `/proa:relations` and
`/proa:work_pipeline` in Claude Code, interactively or through `run-headless.sh` (that
`claude -p "/proa:relations …"` expands the skill and that `--tools ""` with `alwaysLoad` leaves
the agent ProA's tools follows Claude Code's documentation, not a test, as does that Claude Code
honours `anthropic/maxResultSizeChars`), the Claude Desktop start
prompt, the Agent SDK worker with an API key, Codex; whether Claude Desktop offers the
`work_pipeline` prompt; installing the plugin from the marketplace (`claude plugin install
proa@proa`); the image with the M3 code (`up --build`, `proa seed --project` in the container)
and `ci-2.yml` on GitHub.
