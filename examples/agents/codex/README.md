# Codex

The OpenAI Codex CLI connects to ProA's MCP endpoint over Streamable HTTP with the agent token as
bearer header: [`config.toml`](config.toml) is the entry for `~/.codex/config.toml`.

```toml
[mcp_servers.proa]
url = "http://127.0.0.1:7400/mcp"
bearer_token_env_var = "PROA_TOKEN"
```

The syntax follows OpenAI's MCP documentation for Codex
([developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp), which redirects to
[learn.chatgpt.com/docs/extend/mcp](https://learn.chatgpt.com/docs/extend/mcp?surface=cli);
read 2026-10-08):

- servers live under `[mcp_servers.<name>]` in `~/.codex/config.toml`, or in `.codex/config.toml`
  of a project ("trusted projects only");
- for Streamable HTTP servers, `url` is required and `bearer_token_env_var` is the "Environment
  variable name for a bearer token to send in `Authorization`"; `http_headers` and
  `env_http_headers` set other headers;
- `startup_timeout_sec` (default 10) and `tool_timeout_sec` (default 60), `enabled`, `required`,
  `enabled_tools` and `disabled_tools` are optional.

## Run

1. Create a **fresh project** and an **agent token** for the run (read + propose), named after the
   recording agent segment (`codex-1`, …); never reuse a project across runs:
   `proa seed <landscape> --project <key> --issue-tokens --token-name <name>` creates both
   ([M3-LIVE-RUNS.md](../../../docs/proa-2/M3-LIVE-RUNS.md), step 2).
2. `export PROA_TOKEN=proa_at_…` and start Codex in an **empty directory outside the checkout**,
   so it finds no project files there. That directory does **not** keep Codex out of `eval/`
   (see below).
3. Codex gets ProA's server instructions but has no Claude Code skill, and OpenAI's page does not
   mention MCP prompts, so start with a prompt that loads the procedure itself:
   [`../claude-desktop/start-prompt.de.md`](../claude-desktop/start-prompt.de.md) works as is
   (project, the exact model id Codex runs as, batch size).

## Not isolated from the checkout

Codex keeps its own shell and file tools; there is no counterpart to Claude Code's `--tools ""`
in this setup, and `enabled_tools`/`disabled_tools` filter the MCP server's tools only. Its
sandbox modes restrict writes and network access, not reads: with codex-cli 0.159.3, `codex
sandbox` in `read-only` and in `workspace-write`, started from an empty directory, read the
checkout's files (including the listing of `eval/`) by absolute path. An agent that looks for
answers can therefore read `eval/`, the holdout's ground truth included.

- Do not run Codex on the holdout landscape (`stadtwerke-auental`) on a machine whose checkout
  it can read. A holdout run needs an environment without read access to the checkout: a
  container or VM that does not mount it, another OS user that cannot read it, or another machine.
- On the dev landscape, a Codex run on your machine works, but its recording carries the same
  caveat: nothing stopped the agent from reading `expected.yaml`.

Not verified: Codex was not run against ProA here. The entry was checked against the
documentation above and parses as TOML (Python `tomllib`).
