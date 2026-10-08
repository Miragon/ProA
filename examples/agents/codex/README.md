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
   recording agent segment (`codex-1`, …); never reuse a project across runs
   ([DEVELOPMENT.md](../../../docs/proa-2/DEVELOPMENT.md#create-an-agent-token)).
2. `export PROA_TOKEN=proa_at_…` and start Codex in an **empty directory outside the checkout**,
   so its own file and shell tools have no path into `eval/`.
3. Codex gets ProA's server instructions but has no Claude Code skill, and OpenAI's page does not
   mention MCP prompts, so start with a prompt that loads the procedure itself:
   [`../claude-desktop/start-prompt.de.md`](../claude-desktop/start-prompt.de.md) works as is
   (project, the exact model id Codex runs as, batch size).

Not verified: Codex was not run against ProA here. The entry was checked against the
documentation above and parses as TOML (Python `tomllib`).
