# Claude Code

Claude Code reaches ProA over HTTP (`/mcp`, agent token as bearer header) and gets the
relations procedure from the plugin [`plugins/proa`](../../../plugins/proa): the skill
`/proa:relations [project] [max-tasks]`, generated from
[`packages/procedures/relations.md`](../../../packages/procedures/relations.md). The plugin
carries no MCP server; [`mcp.json`](mcp.json) configures the connection, so the tools keep the
names `mcp__proa__*`. Without the plugin, the server's MCP prompt `work_pipeline` gives the same
instructions: `/proa:work_pipeline` in the `/` menu (marked `(MCP)`), or
`/mcp__proa__work_pipeline <projectId> <maxTasks>` (arguments space-separated, in this order).

| File | |
|---|---|
| [`mcp.json`](mcp.json) | the `proa` server: `${PROA_URL:-http://127.0.0.1:7400}/mcp` with `Authorization: Bearer ${PROA_TOKEN}`; Claude Code expands both from the environment, so the file holds no secret. `PROA_URL` is the origin without a trailing slash: `/mcp` is appended as is, and `//mcp` is a 404 (`run-headless.sh` strips it). `alwaysLoad` loads ProA's tools at session start instead of deferring them behind tool search, so runs with `--tools ""` (no built-in tools) do not depend on tool search |
| [`run-headless.sh`](run-headless.sh) | `claude -p` in batches, a fresh context per batch, until nothing is pending |

Both ways below start Claude Code in an **empty directory outside the checkout**: it then loads
no `CLAUDE.md`, `.mcp.json` or project settings from the repository and has no path into
`eval/` (the ground truth, including the holdout landscape). `--tools ""` removes the built-in
tools (files, shell, web), so the agent has ProA's MCP tools only.

Each run gets a **fresh project** and its **own agent token** (read + propose), whose name
becomes the agent segment of the run's recording (`claude-code-1`, `claude-code-2`, …); never
reuse a project across runs, and never use the projects the Quickstart seeded (`nordwind-handel`,
…), which hold the simulation agent's proposals. Create both with `proa seed <landscape> --project
<key> --issue-tokens --token-name <name>` (in the container: `docker compose -p proa2 -f
docker/compose.yaml exec proa proa seed …`); step by step in
[M3-LIVE-RUNS.md](../../../docs/proa-2/M3-LIVE-RUNS.md). The examples below use the run project
`nordwind-handel-cc-1` of its step 2.

## Interactive

```sh
export PROA_TOKEN=proa_at_…                # the run's agent token
export PROA_URL=http://127.0.0.1:7400      # optional, this is the default (no trailing slash)
PROA_CHECKOUT=~/Code/ai-plattform/ProA      # your checkout

mkdir -p /tmp/proa-run && cd /tmp/proa-run
MAX_MCP_OUTPUT_TOKENS=100000 claude \
  --strict-mcp-config --mcp-config "$PROA_CHECKOUT/examples/agents/claude-code/mcp.json" \
  --plugin-dir "$PROA_CHECKOUT/plugins/proa" \
  --tools "" --allowedTools "mcp__proa__*" \
  --model claude-opus-5-5
```

Then, in the session:

```text
/proa:relations nordwind-handel-cc-1 5
```

`--allowedTools "mcp__proa__*"` approves ProA's tools for this session (otherwise Claude Code
asks before every call). `MAX_MCP_OUTPUT_TOKENS` raises Claude Code's MCP output limit for builds
that do not read the `anthropic/maxResultSizeChars` ProA's tools declare: claim inputs reach
about 90 KB, and a result moved to a file is out of reach with `--tools ""`. Claude Code's system prompt names the exact model id, which the agent
declares as `llmModel`. When the conversation gets long, Claude Code compacts it; the skill tells
the agent to load the procedure again with `get_procedure` afterwards. For a clean context per
task, use `/clear` between batches or the headless script.

**Installing the plugin** instead of `--plugin-dir`: the repository is a plugin marketplace
([`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json)):

```sh
claude plugin marketplace add ~/Code/ai-plattform/ProA   # or from GitHub: Miragon/ProA#claude/proa-2
claude plugin install proa@proa
```

The plugin version equals the procedure version (a test in `@proa/procedures` enforces it, and
another keeps a released version's skill from changing). Only an install from the GitHub
marketplace is a cached copy pinned to that version: it stays until a new procedure version is
released, then `claude plugin marketplace update proa && claude plugin update proa@proa` and a
new session. `--plugin-dir` and a marketplace added from your checkout load the checkout's
current files at every session start. Only users start `/proa:relations`
(`disable-model-invocation: true`); the model cannot invoke it on its own.

## Headless: `run-headless.sh`

```sh
export PROA_TOKEN=proa_at_…
examples/agents/claude-code/run-headless.sh nordwind-handel-cc-1 claude-opus-5-5 5 20
#                                            run project          model           batch max-batches
```

Each batch is one `claude -p "/proa:relations <project> <batch>"` in the run's temporary directory
outside the checkout with `--output-format json --strict-mcp-config --mcp-config mcp.json
--plugin-dir plugins/proa --allowedTools "mcp__proa__*" --tools "" --permission-mode dontAsk
--no-session-persistence --model <model>` and `MAX_MCP_OUTPUT_TOKENS=100000` (unless set), so
every batch starts with a fresh context. Before and
after each batch the script asks `GET /api/v1/analyses/pending?projectId=<project>` (with the
token; `curl`, and `node` to read the JSON) and stops when nothing is pending (exit 0), after
`max-batches` (exit 0), when a batch failed (`claude` exited non-zero, or its JSON result is
missing, not a `success`, or has `is_error`; exit 1), or when a batch made no progress (pending
did not go down; exit 1). The JSON result of every batch (`result`, `num_turns`, `total_cost_usd`, …) lands in
`PROA_LOG_DIR` (default: a new directory under `$TMPDIR`; the script refuses a directory that
already holds `batch-*.json` from an earlier run); the script prints one line per batch and the
estimated total.

Tasks under a live lease (15 minutes) do not count as pending, so a failed batch can lower the
count too: a batch that died after claiming leaves its task leased until the lease expires, and
that attempt counts (a task fails after three expired leases). The script therefore stops after
the first failed batch; check the run before you start it again.

**Billing.** `claude -p` uses `ANTHROPIC_API_KEY` whenever it is set, ahead of your Claude
subscription login. The script refuses to start with the variable set unless you pass
`--allow-api-billing` first. `PROA_MAX_BUDGET_USD` caps each batch (`--max-budget-usd`).

Without `--bare`, `claude -p` loads what an interactive session would from `~/.claude` (user
settings, hooks, `CLAUDE.md`); the empty working directory only keeps the repository's out.
`--bare` would skip `~/.claude` too, but it never uses the subscription login (it needs an API
key), so the script does not pass it.

## What was verified

- `claude plugin validate plugins/proa` and `claude plugin validate .` (the marketplace) pass,
  also with `--strict` (Claude Code 2.1.294); the validator checks the manifests, not the skill.
- The skill frontmatter parses as YAML; `@proa/procedures` tests compare the committed skill with
  the render of `relations.md` and the plugin version with the procedure version.
- `run-headless.sh`: `bash -n`, shellcheck 0.10.0 without findings, and dry runs (bash 3.2) against
  a fake pending endpoint and a fake `claude`: arguments, temporary directory, a run to the end, a
  failed batch (non-zero exit, `is_error`), no progress, a reused `PROA_LOG_DIR`, and a `PROA_URL`
  with a trailing slash.
- Not verified: a run with a model. That `claude -p "/proa:relations …"` expands the skill
  follows the [headless documentation](https://code.claude.com/docs/en/headless) ("User-invoked
  skills and custom commands work. Include `/skill-name` in the prompt string and Claude Code
  expands it before running."), not a test.
