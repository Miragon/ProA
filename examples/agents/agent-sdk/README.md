# Agent SDK worker

[`src/worker.ts`](src/worker.ts) works ProA's analysis pipeline with the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
(`@anthropic-ai/claude-agent-sdk` 0.3.293, TypeScript): it long-polls
`GET /api/v1/analyses/pending?projectId=<project>&wait=30` and runs **one fresh `query()` per
task**, which claims, analyses and submits exactly one task and starts with an empty context.

**It needs an Anthropic API key and is billed per token.** The Agent SDK authenticates with
`ANTHROPIC_API_KEY`; Anthropic's terms do not allow claude.ai logins or subscription limits for
agents built on the SDK
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): "Unless previously
approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits
for their products, including agents built on the Claude Agent SDK. Use the API key
authentication methods described in the Quickstart instead."; the SDK falls under Anthropic's
Commercial Terms of Service). ProA holds no LLM credentials and
its CI never runs this worker; whoever deploys it brings the key. Live evaluation runs on the
owner's subscription use [Claude Code](../claude-code) or [Claude Desktop](../claude-desktop)
instead.

## What each task gets

- **Connection:** only ProA's MCP server (`mcpServers.proa`: HTTP `PROA_URL/mcp` with
  `Authorization: Bearer ${PROA_TOKEN}`, `alwaysLoad`), `strictMcpConfig`. The SDK hands this
  config to the Claude Code child on its command line (`--mcp-config <JSON>`), which `ps` shows
  to other local users, so the header is the literal placeholder, as in
  [`claude-code/mcp.json`](../claude-code/mcp.json); Claude Code expands it from the `env` the
  worker passes, and the token never appears on a command line.
- **Tools:** no built-in tools (`tools: []`: no files, shell or web), `allowedTools:
  ["mcp__proa__*"]`, `permissionMode: "dontAsk"` (anything else is denied).
- **Settings:** `settingSources: []` (no `~/.claude`, no project `CLAUDE.md` or `.mcp.json`), a
  new empty temporary directory as `cwd`, no session persistence.
- **Instructions:** by default the MCP prompt `work_pipeline` that ProA serves
  (`projectId`, `maxTasks: "1"`), which embeds the current procedure; with `--plugin-dir
  <ProA checkout>/plugins/proa` the skill `/proa:relations <project> 1` instead. The system prompt
  is Claude Code's preset plus the exact model id, which the agent declares as `llmModel`.
- **Limits:** `--max-turns` (default 80) and `--max-budget-usd` per task.

Each finished task prints one JSON line (`subtype`, `isError`, `turns`, `costUsd` =
`total_cost_usd`, an estimate, `durationMs`, `result`), also one that ended in an error result
such as `error_max_turns` or `error_max_budget_usd` (its cost counts towards the estimated total,
and it counts as no progress); the worker stops on `--once` when nothing
is pending, after `--max-tasks`, after three tasks in a row without progress (an error, or the
pending count did not go down), or on Ctrl-C.

## Run

Node 24 runs the TypeScript source directly. The directory is not part of the pnpm workspace;
install it on its own (outside the checkout, so nothing lands in the repository):

```sh
cp -R examples/agents/agent-sdk /tmp/proa-agent-sdk && cd /tmp/proa-agent-sdk
npm install
export PROA_TOKEN=proa_at_…  ANTHROPIC_API_KEY=sk-ant-…   # PROA_URL defaults to http://127.0.0.1:7400
node src/worker.ts --project nordwind-handel-sdk-1 --model claude-sonnet-5-5 --once
```

`--project` names the project of the agent token. As for the other setups, a run whose result is
recorded gets a fresh project and its own token
([rules for every run](../README.md#rules-for-every-run)), for example `proa seed nordwind-handel
--project nordwind-handel-sdk-1 --issue-tokens --token-name agent-sdk-1`; the projects the
Quickstart seeded (`nordwind-handel`, …) already hold the simulation agent's proposals.

`package.json` pins the direct dependencies exactly (the SDK and its peers
`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`); without a lockfile, transitive
versions resolve at install time. The SDK brings the Claude Code binary for the platform as an
optional dependency, so do not install with `--omit=optional`.

**Docker:** [`Dockerfile`](Dockerfile) (`node:24.21.0-trixie-slim`, the same Node as ProA's image):

```sh
docker build -t proa-agent-sdk-worker examples/agents/agent-sdk
docker run --rm --network host -e PROA_TOKEN -e ANTHROPIC_API_KEY \
  proa-agent-sdk-worker --project nordwind-handel-sdk-1 --model claude-sonnet-5-5
```

ProA's local mode accepts only `localhost`, `127.0.0.1` and `[::1]` as `Host` (403 otherwise,
`apps/server/src/auth/local-guard.ts`), so the container must reach ProA as `127.0.0.1`: share
the host's network (`--network host`), or run the worker on the host. `host.docker.internal` is
refused.

## What was verified

- `tsc` (TypeScript 6.0.3, `strict`) passes against the pinned SDK in a copy of this directory
  outside the repository, after `npm install` there.
- `docker build` succeeds; the image prints `--help` and refuses to start without
  `ANTHROPIC_API_KEY`.
- `--once` against a fake pending endpoint with nothing pending stops without starting a query;
  a rejected token stops with the 401.
- With a fake Claude Code executable (`pathToClaudeCodeExecutable`, set in a test copy only): the
  child's `--mcp-config` carries `Bearer ${PROA_TOKEN}`, not the token, and its environment
  carries `PROA_TOKEN`; a task that ends in `error_max_budget_usd` (exit 1 after the result)
  prints its JSON line and its cost counts; three such tasks in a row stop the worker with exit 1.
  That Claude Code expands `${PROA_TOKEN}` in `--mcp-config` JSON was checked with Claude Code
  2.1.293 and 2.1.294 against a local server that logs the header.
- Not verified: a run with a model (it needs an API key).
