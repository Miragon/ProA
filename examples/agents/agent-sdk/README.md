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
  `Authorization: Bearer $PROA_TOKEN`, `alwaysLoad`), `strictMcpConfig`.
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
`total_cost_usd`, an estimate, `durationMs`, `result`); the worker stops on `--once` when nothing
is pending, after `--max-tasks`, after three tasks in a row without progress (an error, or the
pending count did not go down), or on Ctrl-C.

## Run

Node 24 runs the TypeScript source directly. The directory is not part of the pnpm workspace;
install it on its own (outside the checkout, so nothing lands in the repository):

```sh
cp -R examples/agents/agent-sdk /tmp/proa-agent-sdk && cd /tmp/proa-agent-sdk
npm install
export PROA_TOKEN=proa_at_…  ANTHROPIC_API_KEY=sk-ant-…   # PROA_URL defaults to http://127.0.0.1:7400
node src/worker.ts --project nordwind-handel --model claude-sonnet-5-5 --once
```

`package.json` pins the direct dependencies exactly (the SDK and its peers
`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`); without a lockfile, transitive
versions resolve at install time. The SDK brings the Claude Code binary for the platform as an
optional dependency, so do not install with `--omit=optional`.

**Docker:** [`Dockerfile`](Dockerfile) (`node:24.21.0-trixie-slim`, the same Node as ProA's image):

```sh
docker build -t proa-agent-sdk-worker examples/agents/agent-sdk
docker run --rm --network host -e PROA_TOKEN -e ANTHROPIC_API_KEY \
  proa-agent-sdk-worker --project nordwind-handel --model claude-sonnet-5-5
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
- Not verified: a run with a model (it needs an API key).
