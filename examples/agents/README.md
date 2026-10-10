# Agent reference setups

How LLM agents work ProA's analysis pipeline: claim a relations task, judge the candidate pairs
with the procedure `proa-relations` ([`packages/procedures/relations.md`](../../packages/procedures/relations.md)),
submit proposals, and let humans decide in the review screen; or claim the value chain's
placement task and place its processes on steps with the procedure `proa-placements`
([`packages/procedures/placements.md`](../../packages/procedures/placements.md), M4b), decided on
the value chain page. Each run works one kind: `/proa:relations` or `/proa:placements` in Claude
Code (`run-headless.sh --skill placements`), the start prompts
[`start-prompt.de.md`](claude-desktop/start-prompt.de.md) and
[`start-prompt-placements.de.md`](claude-desktop/start-prompt-placements.de.md) in Claude Desktop,
`work_pipeline` with `kind: placement` elsewhere. Drafting a chain is no pipeline task: the MCP
prompt `draft_value_chain` (or [`start-prompt-draft.de.md`](claude-desktop/start-prompt-draft.de.md))
makes an agent write a `.vc.json` that a human imports on the value chain page. ProA itself holds no LLM
credentials and runs no model; these setups are documentation. They are not workspace packages,
nothing imports them, the Docker image does not contain them, and CI runs none of them against a
model.

| Setup | Transport | Auth to ProA | Model access, who runs it | Context per task | Verified |
|---|---|---|---|---|---|
| [Claude Code, interactive](claude-code/README.md#interactive) | HTTP `/mcp` | agent token, `Authorization: Bearer ${PROA_TOKEN}` ([`mcp.json`](claude-code/mcp.json)) | the owner's Claude subscription, in a terminal | one session for many tasks (`/proa:relations <project> <n>`); after compaction the agent reloads the procedure | plugin and marketplace pass `claude plugin validate --strict`; skill drift-tested; no model run |
| [Claude Code, headless](claude-code/README.md#headless-run-headlesssh) | HTTP `/mcp` | as above | the owner's Claude subscription (refuses `ANTHROPIC_API_KEY` unless `--allow-api-billing`), [`run-headless.sh`](claude-code/run-headless.sh) (`--skill placements` for placement tasks) | a fresh `claude -p` per batch of n tasks | `bash -n`, shellcheck, dry run against fakes (`--skill placements`: `bash -n` and a dry run, no shellcheck); no model run |
| [Claude Desktop](claude-desktop/README.md) | stdio bridge `proa mcp` (in the container or from the checkout) → HTTP | agent token in the entry's `env` | the owner's Claude subscription, in the app | one chat per batch, started with [`start-prompt.de.md`](claude-desktop/start-prompt.de.md) | both entries are started as Claude Desktop starts them by CI's live check; the app itself not |
| [Codex](codex/README.md) | HTTP `/mcp` | `bearer_token_env_var = "PROA_TOKEN"` ([`config.toml`](codex/config.toml)) | the user's OpenAI account | one session; the start prompt loads the procedure | checked against OpenAI's documentation, parses as TOML; not run |

## Rules for every run

- **Agents only propose; humans decide.** No setup gets a review scope; tokens carry read +
  propose.
- **One fresh project and one agent token per run.** Seed the project from the corpus, name the
  token after the run (`claude-code-1`, `claude-desktop-2`, …): the token name becomes the agent
  segment of the run's recording. Never reuse a project across runs: a run's judgements stay
  current, so a second run in the same project would skip every pair the first one judged (judge
  each pair once) and measure almost nothing.
- **The agent declares its exact model id** as `llmModel` (the wrappers and the start prompt say
  so), and the procedure id and version the claim names.
- **Start agents outside the checkout**, with ProA's MCP tools only where the client allows it
  (`--tools ""` in Claude Code, no other connectors in Claude Desktop):
  `eval/` holds the ground truth, including the holdout landscape. The directory alone does not
  keep an agent out of `eval/`: Codex has no counterpart to `--tools ""` and its sandbox does not
  restrict reads, so it can read the checkout by absolute path; run it on the holdout only where
  the checkout cannot be read ([Codex](codex/README.md#not-isolated-from-the-checkout)).
- **Long runs:** a fresh context per batch (headless script, a new chat in Claude Desktop) keeps
  the procedure in full view; within one session the agent reloads it with
  `get_procedure` after its context was summarized.

## Where the instructions come from

Each procedure text is written once, in `packages/procedures/relations.md` and
`packages/procedures/placements.md`. `get_procedure` serves it as is; the MCP prompt
`work_pipeline` (`projectId?`, `maxTasks?` 1–100, `kind?` `relations` or `placement`) and the
Claude Code skills `/proa:relations [project] [max-tasks]` and `/proa:placements [project]
[max-tasks]` add only the scope (the placements wrapper claims with `kinds: ["placement"]`), the
model declaration and the reload rule, rendered by one helper in `@proa/procedures`
(`renderPipelineWrapper`); `place_processes` wraps the placements procedure for ad-hoc work
(`renderAdHocWrapper`). The skills
[`plugins/proa/skills/relations/SKILL.md`](../../plugins/proa/skills/relations/SKILL.md) and
[`plugins/proa/skills/placements/SKILL.md`](../../plugins/proa/skills/placements/SKILL.md) are
generated (`pnpm --filter @proa/procedures generate`); a test fails when one lags behind its
procedure, when a released skill changes, or when the skills change without a new plugin version
(plugin 0.3.0 ships both).
