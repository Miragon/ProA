# Agent reference setups

How LLM agents work ProA's analysis pipeline: claim a relations task, judge the candidate pairs
with the procedure `proa-relations` ([`packages/procedures/relations.md`](../../packages/procedures/relations.md)),
submit proposals, and let humans decide in the review screen. ProA itself holds no LLM
credentials and runs no model; these setups are documentation. They are not workspace packages,
nothing imports them, the Docker image does not contain them, and CI runs none of them against a
model.

| Setup | Transport | Auth to ProA | Model access, who runs it | Context per task | Verified |
|---|---|---|---|---|---|
| [Claude Code, interactive](claude-code/README.md#interactive) | HTTP `/mcp` | agent token, `Authorization: Bearer ${PROA_TOKEN}` ([`mcp.json`](claude-code/mcp.json)) | the owner's Claude subscription, in a terminal | one session for many tasks (`/proa:relations <project> <n>`); after compaction the agent reloads the procedure | plugin and marketplace pass `claude plugin validate --strict`; skill drift-tested; no model run |
| [Claude Code, headless](claude-code/README.md#headless-run-headlesssh) | HTTP `/mcp` | as above | the owner's Claude subscription (refuses `ANTHROPIC_API_KEY` unless `--allow-api-billing`), [`run-headless.sh`](claude-code/run-headless.sh) | a fresh `claude -p` per batch of n tasks | `bash -n`, shellcheck, dry run against fakes; no model run |
| [Claude Desktop](claude-desktop/README.md) | stdio bridge `proa mcp` (in the container or from the checkout) → HTTP | agent token in the entry's `env` | the owner's Claude subscription, in the app | one chat per batch, started with [`start-prompt.de.md`](claude-desktop/start-prompt.de.md) | both entries are started as Claude Desktop starts them by CI's live check; the app itself not |
| [Agent SDK worker](agent-sdk/README.md) | HTTP `/mcp` | agent token from `PROA_TOKEN` | an Anthropic **API key** (Anthropic's terms), whoever deploys the worker | a fresh `query()` per task | `tsc` against the pinned SDK, `docker build`, dry run; no model run |
| [Codex](codex/README.md) | HTTP `/mcp` | `bearer_token_env_var = "PROA_TOKEN"` ([`config.toml`](codex/config.toml)) | the user's OpenAI account | one session; the start prompt loads the procedure | checked against OpenAI's documentation, parses as TOML; not run |

## Rules for every run

- **Agents only propose; humans decide.** No setup gets a review scope; tokens carry read +
  propose.
- **One fresh project and one agent token per run.** Seed the project from the corpus, name the
  token after the run (`claude-code-1`, `claude-desktop-2`, …): the token name becomes the agent
  segment of the run's recording. Never reuse a project across runs: a submission withdraws other
  principals' pipeline proposals it does not repeat, and earlier proposals bias the claim input.
- **The agent declares its exact model id** as `llmModel` (the wrappers and the start prompt say
  so), and the procedure id and version the claim names.
- **Start agents outside the checkout**, with ProA's MCP tools only where the client allows it
  (`--tools ""` in Claude Code, `tools: []` in the SDK, no other connectors in Claude Desktop):
  `eval/` holds the ground truth, including the holdout landscape.
- **Long runs:** a fresh context per batch (headless script, SDK worker, a new chat in Claude
  Desktop) keeps the procedure in full view; within one session the agent reloads it with
  `get_procedure` after its context was summarized.

## Where the instructions come from

The procedure text is written once, in `packages/procedures/relations.md`. `get_procedure`
serves it as is; the MCP prompt `work_pipeline` (`projectId?`, `maxTasks?` 1–100) and the Claude
Code skill `/proa:relations [project] [max-tasks]` add only the scope, the model declaration and
the reload rule, rendered by one helper in `@proa/procedures` (`renderPipelineWrapper`). The
skill [`plugins/proa/skills/relations/SKILL.md`](../../plugins/proa/skills/relations/SKILL.md)
is generated (`pnpm --filter @proa/procedures generate`); a test fails when it, or the plugin
version, lags behind the procedure.
