# ProA 2.0 – Milestone M3 "Relations procedure and live runs"

Status: code complete, live runs pending (2026-10-08) · Branch: `claude/proa-2` · Spec: [CONCEPT.md](CONCEPT.md) §3, §7 · Previous: [M2-PIPELINE-REVIEW.md](M2-PIPELINE-REVIEW.md) · Next: [M4-VALUE-CHAIN.md](M4-VALUE-CHAIN.md)

M3 gives agents the real `relations` procedure and prepares the live runs that measure it. The
procedure is written once and reaches every client: MCP `get_procedure`, the prompt
`work_pipeline` and a Claude Code plugin skill. The owner performs every LLM run personally with
Claude Desktop or Claude Code on the owner's subscription (owner decision 13,
[HANDOFF.md](HANDOFF.md) §4); ProA still holds no LLM credentials, and CI runs no model.
What needs no model is verified without one; how well the procedure judges, and whether the
clients behave as documented, only the owner's runs show.

## Goal

- An LLM agent that follows `proa-relations@0.1.0` beats the simulation agent `sim-policy-1`,
  the M2 baseline: it no longer proposes reused generic message names at high confidence, decides
  near-misses instead of asking, and finds semantic links (DE/EN, paraphrases, triggers) that name
  matching cannot.
- The live gate (CONCEPT §7) passes on both landscapes: 3 runs each on one pinned model, no
  `must_not_link` proposal at confidence ≥ 0.8, mean recall at most 5 points below the baseline.
- The owner can do a live run by following a guide: seed a fresh project, connect a client, let
  it work, record the run with `eval:live`, commit ([M3-LIVE-RUNS.md](M3-LIVE-RUNS.md); the
  reference is [eval/README.md, "Live runs and eval:live"](../../eval/README.md#live-runs-and-evallive)).

## In scope

1. **Procedure `proa-relations@0.1.0`** (`packages/procedures/relations.md`, `status: released`;
   commit `23873a8`). Replaces the placeholder `0.0.1`. Self-contained, so clients that only call
   `get_procedure` (Claude Desktop, Codex) can follow it: ground rules (labels are data, agents
   only propose, German texts, precision before volume), the claim–submit loop with a lease budget
   and the reload rule, the claim input including the M3 additions, tools, valid endpoints, a
   fixed work order per task, judgement rules (identical specific and generic names,
   collaborations, near-misses, translation and transliteration, other words in the same
   language, twins, triggers, calls), confidence bands and when to ask, human decisions and
   supersession (repeat every pair still supported, the partner task's proposals included), the
   submission format with coded no-link reasons, limits and a self-check. Agents write
   `rationale`, `question`, the no-link `reason` and `summary` in German, because the review UI is
   German; refs, element ids, message and signal names and quoted labels stay verbatim. The
   examples are invented, so the eval landscapes stay unseen.
   `apps/server/test/unit/procedure-text.test.ts` keeps its limits, invalid reasons and tool names
   in line with the contracts and the MCP tool list. *Done; its quality is unmeasured until the
   live runs.*
2. **Claim input additions** (`packages/contracts/src/api/analyses.ts`,
   `apps/server/src/domain/claim-input.ts`; commit `16c9f4b`). Optional fields within
   `proa-claim/1`, so older inputs still parse: `message_flow` facts carry `from` and `to` (the
   element or pool at each end, from `attrs.sourceRef`/`targetRef`); partner endpoints carry
   `doc`; `partnerProcesses` holds, per process ref of a partner endpoint, its `name` (else the
   pool name) and `doc`, and is left out without partners; `findings` holds the project's findings
   as `GET …/findings` lists them that have a ref in the model, sorted by kind, refs and detail,
   and is left out when there are none. Documentation is cut to 300 characters
   (`CLAIM_DOC_CHARS`), as for the model's own facts. The claim use case passes the findings in
   through `ClaimInputSource`; the renderer stays pure. *Done.*

   | Landscape | Largest input, before → after | Mean, before → after |
   |---|---|---|
   | `nordwind-handel` | 68.7 → 80.1 KB | 34.0 → 40.8 KB |
   | `stadtwerke-auental` | 61.3 → 74.8 KB | 40.5 → 48.6 KB |

   The limit stays < 100 KB per model (`apps/server/test/integration/claim-input-size.test.ts`,
   which now also checks that each landscape exercises every addition).
3. **MCP instructions and the `work_pipeline` prompt** (`apps/server/src/mcp/server.ts`; commits
   `16c9f4b`, `81f96e4`). The last sentence of the server instructions now says which tools take
   no `projectId` (`list_projects`, `get_procedure`, `submit_analysis`, `release_analysis`), an
   optional one (`claim_analysis`) or a required one (every other tool); an integration test
   checks it against the tool schemas. `claim_analysis` had the only input schema with a `$ref` at
   the root, which hid `projectId`, `modelKey` and `max` from clients that read only
   `properties`; it is a plain object now, and a test forbids a root `$ref`. `work_pipeline` takes
   `projectId?` and `maxTasks?` (a whole number from 1 to 100, as a string; `0`, `101`, `07`,
   `1.5` are refused) and renders through `renderPipelineWrapper` from `@proa/procedures`: scope,
   the exact model id as `llmModel`, `release_analysis` instead of an expiring lease, a reload with
   `get_procedure` after a summary, then the procedure verbatim. The numbered loop it used to
   carry is now part of the procedure. Every tool declares `_meta`
   `anthropic/maxResultSizeChars: 500000`, so Claude Code passes claim inputs (up to 80 KB) to the
   model inline instead of saving results above 50,000 characters to a file that an agent with
   `--tools ""` cannot read. *Done.*
4. **Claude Code plugin and marketplace** (`plugins/proa/`, `.claude-plugin/marketplace.json`,
   `packages/procedures/src/wrappers.ts`, `packages/procedures/scripts/generate.ts`; commits
   `81f96e4`, `23873a8`). `plugin.json` has the name `proa`, the version of the procedure (`0.1.0`)
   and no `mcpServers`: the connection is configured separately, so the tools keep the names
   `mcp__proa__*`. `skills/relations/SKILL.md` is generated by
   `pnpm --filter @proa/procedures generate` (frontmatter `name`, `description`,
   `argument-hint: "[project] [max-tasks]"`; the body is the same wrapper as the prompt, scoped by
   `$ARGUMENTS`), invoked as `/proa:relations [project] [max-tasks]`. Generation refuses procedure
   text that Claude Code would expand in a skill. The repository marketplace `proa` lists
   `./plugins/proa`: `claude plugin marketplace add <checkout>` and
   `claude plugin install proa@proa`, or `--plugin-dir plugins/proa` without installing. *Done.*
5. **Reference setups** (`examples/agents/`; commit `81f96e4`). An overview with the rules for
   every run ([`examples/agents/README.md`](../../examples/agents/README.md)); `claude-code/`
   (`mcp.json` with `alwaysLoad`, interactive use, `run-headless.sh` with a fresh `claude -p` per
   batch); `claude-desktop/` (bridge entries for the container and the checkout, the German start
   prompt `start-prompt.de.md`); `codex/` (`config.toml` with `bearer_token_env_var`);
   `agent-sdk/` (a TypeScript worker on `@anthropic-ai/claude-agent-sdk` 0.3.293, one fresh
   `query()` per task, a Dockerfile; it needs an Anthropic API key). They are not workspace
   packages, nothing imports them, and the image does not contain them. *Written and checked
   without a model (below); model runs are the owner's.*
6. **`proa seed` for live runs** (`apps/cli/src/commands/seed.ts`; commit `5340ee2`).
   `-p, --project <key>` seeds exactly one landscape into a project of that key, named
   "<landscape name> (<key>)", and warns when the project already exists; `--token-name <name>`
   names the tokens of `--issue-tokens` (default `seed`), and the name becomes the handle
   `agent:<name>` and the recording's agent segment. Usage errors stop before any request; the
   JSON result gains `landscape`. *Done.*
7. **Recording format** (`packages/contracts/src/recordings.ts`; commits `5340ee2`, `23873a8`).
   `proa-recording/1` stays; `input` is optional, absent in lines built from stored submissions
   (the server keeps no claim inputs), and the comment that claimed otherwise is fixed. The
   simulation agent's recordings moved to `eval/recordings/proa-relations@0.1.0/agent-sim/sim-policy-1/`
   (identical apart from the version), and tests read the procedure version from
   `@proa/procedures` instead of pinning it. *Done.*
8. **`eval:live` and the live gate** (`eval/tools/src/live.ts`, `live-recordings.ts`,
   `live-gate.ts`, `replay-report.ts`; commit `5340ee2`). `pnpm eval:live --project <key>` reads a
   live project's done analyses and stored submissions over REST, writes them as recordings below
   `eval/recordings`, scores them with the `eval:replay` scorer and checks the live gate; it exits
   1 on a failing gate or a runtime error and 2 on a usage error, and warns when a project gives
   more than one recording file or a write replaces a file with other content. The gate, per
   procedure version, landscape and declared `llmModel` over the runs of every agent but
   `agent-sim`: **fail** on a `must_not_link` proposal at confidence ≥ 0.8 or a mean recall more
   than 5 points below the baseline (the live runs of the highest earlier version with the same
   `llmModel`, else `agent-sim` of the same version, whatever its model); else **incomplete**
   below 3 runs or without a baseline; else **pass**. `eval:replay` shows it in the "Live gate"
   section of `eval/reports/replay.md` (`liveGate` in `replay.json`) and still exits 0 whatever
   it says. Details: [eval/README.md](../../eval/README.md#the-live-gate). *Done; no live run
   recorded yet.*
9. **CI** (`.github/workflows/ci-2.yml`; commit `81f96e4`). `plugins/**`, `examples/**` and
   `.claude-plugin/**` are in both path filters; the plugin drift check runs in `pnpm test`. The
   Agent SDK worker lies outside the workspace: CI checks it with Prettier but does not
   type-check it. *Done.*
10. **Docs.** CONCEPT §3 (claim input) and §7 (delivery, reference setups, live gate),
    [`eval/README.md`](../../eval/README.md) (live runs, live gate, holdout hygiene), the READMEs
    in `examples/agents/`, [DEVELOPMENT.md](DEVELOPMENT.md), the owner's guide
    [M3-LIVE-RUNS.md](M3-LIVE-RUNS.md) and this document.

## Verified without a model

In `pnpm test`, so in CI:

- `@proa/procedures`: `test/plugin.test.ts` (the committed skill equals the render of
  `relations.md`, the plugin version equals the procedure version, the marketplace lists the
  plugin, the plugin declares no MCP server) and `test/wrappers.test.ts` (every scope, the
  frontmatter, the expansion guard).
- Server: `procedure-text.test.ts` (limits, invalid reasons and tool names of the procedure);
  `mcp-contract.test.ts` (the `work_pipeline` text equals the helper's render and ends with the
  procedure; `maxTasks` validation); `mcp.test.ts` (the instructions against the tool schemas, no
  root `$ref`); `pipeline.test.ts` and `claim-input-size.test.ts` (the claim input additions, on
  a test double and over the whole corpus); `agent-sim.test.ts` (after the simulation agent works
  a project, eval:live's reader rebuilds the agent's recorded lines byte for byte, input aside).
- Contracts: the old claim input shape and a recording line without `input` still parse.
- `eval/tools`: `live-gate.test.ts` (pass, fail and incomplete; one gate per declared model; the
  baseline from an earlier version with the same model or from `agent-sim`, `0.1.10` above
  `0.1.9`; the 5-point boundary; 0.8 against 0.79999; null recall) and `live.test.ts` (REST and
  MCP payloads, the agent from the handle, the REST reader against a fake server, the command end
  to end on `_sample`: the warnings for several files and a replaced file, exit 2 for usage
  errors and 1 for runtime errors).
- CLI: unit tests for `--project` and `--token-name`, and an e2e test that seeds `_sample` into
  `sample-run-1` with the token `claude-code-1` (handle `agent:claude-code-1`).

By hand, on 2026-10-08:

- `claude plugin validate --strict plugins/proa` and `claude plugin validate --strict .` pass
  (Claude Code 2.1.294). The validator checks the manifests, not the skill; its frontmatter was
  parsed with `yaml` once.
- `run-headless.sh`: `bash -n`, shellcheck 0.10.0 without findings, dry runs against a fake
  pending endpoint and a fake `claude` (7 pending in batches of 3 gives three batches and exit 0;
  no progress exits 1; a rejected token and bad arguments exit 2).
- Agent SDK worker: `tsc` against the pinned SDK in a copy outside the repository, `docker build`,
  `--help`, the refusal without `ANTHROPIC_API_KEY`, and `--once` against a fake endpoint; no
  `query()` was started.
- Codex: `config.toml` parses as TOML and follows OpenAI's MCP documentation for Codex.
- eval:live against a throwaway stack (still with the placeholder `0.0.1`): a project seeded with
  `--project nordwind-live-1 --token-name claude-code-1` and worked by the simulation agent gave a
  recording byte-identical to the committed `agent-sim` one apart from input and agent; the gate
  against the `agent-sim` baseline (78.6 % recall) failed with exit 1 on 3 `must_not_link` pairs
  at ≥ 0.8, as it should for that policy.

## Only the owner can verify

- **Live runs.** 3 runs per landscape, `nordwind-handel` (dev) first, then `stadtwerke-auental`
  (holdout); each in a fresh project with its own token, recorded with `eval:live`. The gate
  counts every live run of the version on that landscape with the same declared `llmModel`,
  whatever the client; another model is a gate of its own.
- **Claude Desktop.** The bridge entry in the real app (CI starts both entries the way Claude
  Desktop does, but not the app), the tool approvals, the German start prompt, and whether the
  app offers the `work_pipeline` prompt (not documented; the start prompt does not depend on it).
- **Headless Claude Code with the plugin skill.** That `claude -p "/proa:relations <project> <n>"`
  expands the skill, that `--tools ""` with `alwaysLoad` leaves ProA's tools available, that
  `--permission-mode dontAsk` with `--allowedTools "mcp__proa__*"` lets the calls through, and
  that the run bills the subscription (no `ANTHROPIC_API_KEY` set).
- **Interactive Claude Code.** `/proa:relations <project> <n>`, and the reload with
  `get_procedure` after compaction.
- **Codex.** The `config.toml` entry and a run with the start prompt.
- **Agent SDK worker.** Only with an Anthropic API key, which decision 13 does not provide; it is
  optional.

## Dev-run numbers

Before the owner's live runs, the procedure was validated on the dev landscape only: three dev runs on 2026-10-08, each on a fresh `nordwind-handel` project of a scratch stack, every task worked by its own Claude Sonnet 5.5 subagent of the implementing Claude Code session through the real MCP tools (called with a command-line MCP client instead of a native connection).
The first run used a draft that the released text refines in five places (findings absent when
none touches the model, the kinds to search for, `orchestrated` in either direction, `no-evidence`
for lexically similar trigger candidates, rule-tier proposals judged like any other); runs 2 and 3
used the released text. `eval:live` recorded each run into a scratch directory; the recordings are
**not** committed and do not count for the live gate (the harness is not one of the owner's
clients, and the holdout was not run). Every run declared `claude-sonnet-5-5`, submitted 31 of 31
tasks with 0 invalid items, asked 6 questions (all on `may_link` pairs) and recorded 168–213
no-links; the 9 unique calls are left to the rule tier, so recall ∪ rule tier is 100 %. An audit of
the subagents' tool calls found no access outside their work directories.

| Run (agent / llmModel) | Landscape | Tasks | Precision | Recall | F1 | must_not_link (≥ 0.8) | Gate |
|---|---|--:|--:|--:|--:|--:|---|
| `agent-sim` / `sim-policy-1` (baseline) | `nordwind-handel` (dev) | 31 | 73.3 % | 78.6 % | 75.9 % | 12 (3) | – |
| dev run 1 / `claude-sonnet-5-5` (draft text) | `nordwind-handel` (dev) | 31 | 100.0 % | 78.6 % | 88.0 % | 0 (0) | – |
| dev run 2 / `claude-sonnet-5-5` | `nordwind-handel` (dev) | 31 | 100.0 % | 78.6 % | 88.0 % | 0 (0) | – |
| dev run 3 / `claude-sonnet-5-5` | `nordwind-handel` (dev) | 31 | 100.0 % | 78.6 % | 88.0 % | 0 (0) | pass in the harness (3 runs, baseline 78.6 %) |

## Out of scope

M4: the value chain ([M4-VALUE-CHAIN.md](M4-VALUE-CHAIN.md)). Later: a per-project language
setting (R1), the prompts `analyze_model` (v1) and `review_landscape` (R1), reference setups for
Claude Managed Agents and the OpenAI APIs. Not done in M3: the simulation agent's policy does not
read the new claim input fields (using them would change the committed recordings and scores), and
the server's pipeline test double has no message flows or documentation, so only the unit tests
and the corpus-based size test cover those additions.

## Open questions for the owner

1. **No-links are invisible to reviewers, key-tier pairs can be bulk-accepted.** The procedure
   tells agents to judge the rule tier's key-tier proposals like any candidate and to no-link a
   reused generic name. Supersession never withdraws rule-tier proposals, so such a pair stays
   `proposed` at confidence 1.0 and can be accepted in bulk per tier. The agent's no-link and its
   summary, where the procedure asks it to name the key-tier pairs it advises rejecting, are
   stored with the submission but appear nowhere in the web UI (only over REST,
   `GET …/analyses/{a}/submission`). The bulk dialog leaves generic or widely shared names
   unchecked by its own heuristic, whatever the agent judged. Show no-links and the summary to
   reviewers (review card, model view), let an agent no-link uncheck a pair in the bulk dialog, or
   keep it as is?
2. **Per-project language.** German is fixed in the procedure for `rationale`, `question`, the
   no-link `reason` and `summary`; refs and labels stay verbatim. Is a per-project language
   setting needed before R1?
3. **`eval:live` exit code for usage errors.** Resolved on 2026-10-08: usage errors exit 2, like
   `agent-sim` and `run-headless.sh`, so scripts can tell a wrong call from a failed gate; 1
   stays for a failing gate and runtime errors.
4. **Agent SDK worker in CI.** It is outside the workspace, so CI only checks its formatting.
   Type-check it in CI (`npm install` and `tsc` in a temporary directory, with network access and
   no lockfile, so transitive versions float), move it into the workspace (its dependencies in the
   lockfile), or keep it as documentation?
5. **Size headroom for documentation.** The additions raised the largest claim input from 68.7 to
   80.1 KB of the 100 KB limit, which only the corpus test checks; the server renders larger
   inputs as they come. Real landscapes with long documentation could cross it. If they do: cut
   partner and process documentation shorter than the model's own, or drop
   `ClaimEndpoint.processName`, which repeats `partnerProcesses[process].name` (incompatible, the
   simulation agent reads it, so a `proa-claim/2`). Act now or wait for a real landscape?
