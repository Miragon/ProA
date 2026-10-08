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

- An LLM agent that follows the released procedure (`proa-relations@0.2.0` since it replaced
  `0.1.0` before any live run, [below](#procedure-020-judge-each-pair-once)) beats the simulation
  agent `sim-policy-1`, the M2 baseline: it no longer proposes reused generic message names at high
  confidence, decides near-misses instead of asking, and finds semantic links (DE/EN, paraphrases,
  triggers) that name matching cannot.
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
   supersession (in `0.1.0`: repeat every pair still supported, the partner task's proposals
   included; `0.2.0` judges each pair once instead, [below](#procedure-020-judge-each-pair-once)),
   the submission format with coded no-link reasons, limits and a self-check. Agents write
   `rationale`, `question`, the no-link `reason` and `summary` in German, because the review UI is
   German; refs, element ids, message and signal names and quoted labels stay verbatim. The
   examples are invented, so the eval landscapes stay unseen.
   `apps/server/test/unit/procedure-text.test.ts` keeps its limits (each as a whole number in its
   own phrase), the documentation and candidate caps, the invalid reasons (as a set) and the tool
   names and arguments in line with the contracts and the MCP tool list; the `llmModel`, procedure
   id and version, and evidence entry limits are not checked yet, because the contracts keep them
   inline ([DEVELOPMENT.md](DEVELOPMENT.md#conventions)). *Done; its quality is unmeasured until
   the live runs.*
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
   the exact model id as `llmModel`, the version rule (if a claim names another procedure or
   version than the embedded `<id>@<version>`, load the claim's with `get_procedure` before that
   task and follow it, still declaring what the claim names), `release_analysis` instead of an
   expiring lease, a reload with `get_procedure` after a summary, then the procedure verbatim.
   The numbered loop it used to carry is now part of the procedure. Every tool declares `_meta`
   `anthropic/maxResultSizeChars: 500000`, so Claude Code passes claim inputs (up to about 90 KB) to
   the model inline instead of saving results above 50,000 characters to a file that an agent with
   `--tools ""` cannot read. *Done.*
4. **Claude Code plugin and marketplace** (`plugins/proa/`, `.claude-plugin/marketplace.json`,
   `packages/procedures/src/wrappers.ts`, `packages/procedures/scripts/generate.ts`; commits
   `81f96e4`, `23873a8`). `plugin.json` has the name `proa`, the version of the procedure (`0.1.0`,
   now `0.2.0`) and no `mcpServers`: the connection is configured separately, so the tools keep the
   names `mcp__proa__*`. `skills/relations/SKILL.md` is generated by
   `pnpm --filter @proa/procedures generate` (frontmatter `name`, `description`,
   `argument-hint: "[project] [max-tasks]"`, `disable-model-invocation: true`; the body is the same
   wrapper as the prompt, scoped by `$ARGUMENTS`), invoked as `/proa:relations [project]
   [max-tasks]`; only users start it (CONCEPT §7), the model cannot. Generation refuses procedure
   text that Claude Code would expand in a skill, and a test pins the sha256 of every released
   version's skill, so a change to the text, the wrapper or the frontmatter needs a new version.
   The repository marketplace `proa` lists `./plugins/proa`: `claude plugin marketplace add
   <checkout>` and `claude plugin install proa@proa`, or `--plugin-dir plugins/proa` without
   installing; both load the checkout's current files, while an install from the Git-hosted
   marketplace stays at its version until a new one (`claude plugin marketplace update proa &&
   claude plugin update proa@proa`). *Done.*
5. **Reference setups** (`examples/agents/`; commit `81f96e4`). An overview with the rules for
   every run ([`examples/agents/README.md`](../../examples/agents/README.md)); `claude-code/`
   (`mcp.json` with `alwaysLoad`, interactive use, `run-headless.sh` with a fresh `claude -p` per
   batch); `claude-desktop/` (bridge entries for the container and the checkout, the German start
   prompt `start-prompt.de.md`); `codex/` (`config.toml` with `bearer_token_env_var`; Codex keeps
   its shell and its sandbox does not restrict reads, so an empty directory does not isolate it
   from the checkout). They are not workspace packages, nothing imports them, and the image does
   not contain them. An Agent SDK worker written in M3 was removed on 2026-10-08: for now, models
   are evaluated through MCP with local agents only (owner decision 16, [HANDOFF.md](HANDOFF.md)
   §4; git history keeps the worker). *Written and checked without a model (below); model runs are
   the owner's.*
6. **`proa seed` for live runs** (`apps/cli/src/commands/seed.ts`; commit `5340ee2`).
   `-p, --project <key>` seeds exactly one landscape into a project of that key, named
   "<landscape name> (<key>)", and refuses an existing project with exit 1 before any import or
   token request; `--token-name <name>`
   names the tokens of `--issue-tokens` (default `seed`), and the name becomes the handle
   `agent:<name>` and the recording's agent segment. Usage errors stop before any request; the
   JSON result gains `landscape`. *Done.*
7. **Recording format** (`packages/contracts/src/recordings.ts`; commits `5340ee2`, `23873a8`).
   `proa-recording/1` stays; `input` is optional, absent in lines built from stored submissions
   (the server keeps no claim inputs), and the comment that claimed otherwise is fixed. The
   simulation agent's recordings moved to `eval/recordings/proa-relations@0.1.0/agent-sim/sim-policy-1/`
   (identical apart from the version; since `0.2.0` they are under `proa-relations@0.2.0/`), and
   tests read the procedure version from `@proa/procedures` instead of pinning it. *Done.*
8. **`eval:live` and the live gate** (`eval/tools/src/live.ts`, `live-recordings.ts`,
   `live-gate.ts`, `replay-report.ts`; commit `5340ee2`). `pnpm eval:live --project <key>` reads a
   live project's done analyses and stored submissions over REST, writes them as recordings below
   `eval/recordings`, scores them with the `eval:replay` scorer and checks the live gate; it exits
   1 on a failing gate or a runtime error and 2 on a usage error (also for analyses of models the
   named landscape does not have, writing nothing), and warns when a project was worked under more
   than one token (also with `--agent`), gives more than one recording file, or a write replaces a
   file with other content. The gate, per procedure version, landscape and declared `llmModel`
   over the runs of every agent but `agent-sim`: **fail** on a `must_not_link` proposal at
   confidence ≥ 0.8 or a mean recall more than 5 points below the baseline (the live runs of the
   highest earlier version with the same `llmModel`, else `agent-sim` of the same version,
   whatever its model); else **incomplete** below 3 runs or without a baseline; else **pass**. `eval:replay` shows it in the "Live gate"
   section of `eval/reports/replay.md` (`liveGate` in `replay.json`) and still exits 0 whatever
   it says. Details: [eval/README.md](../../eval/README.md#the-live-gate). *Done; no live run
   recorded yet.*
9. **CI** (`.github/workflows/ci-2.yml`; commit `81f96e4`). `plugins/**`, `examples/**` and
   `.claude-plugin/**` are in both path filters; the plugin drift check runs in `pnpm test`.
   `examples/agents` lies outside the workspace: CI checks only the formatting of its JSON files.
   *Done.*
10. **Docs.** CONCEPT §3 (claim input) and §7 (delivery, reference setups, live gate),
    [`eval/README.md`](../../eval/README.md) (live runs, live gate, holdout hygiene), the READMEs
    in `examples/agents/`, [DEVELOPMENT.md](DEVELOPMENT.md), the owner's guide
    [M3-LIVE-RUNS.md](M3-LIVE-RUNS.md) and this document.

## Verified without a model

In `pnpm test`, so in CI:

- `@proa/procedures`: `test/plugin.test.ts` (the committed skill equals the render of
  `relations.md`, a released version's skill has the sha256 recorded for it, the plugin version
  equals the procedure version, the marketplace lists the plugin, the plugin declares no MCP
  server) and `test/wrappers.test.ts` (every scope, the version rule, the frontmatter with
  `disable-model-invocation: true`, the expansion guard).
- Server: `procedure-text.test.ts` (limits as whole numbers in their phrases, the documentation
  and candidate caps, invalid reasons, tool names and arguments of the procedure);
  `mcp-contract.test.ts` (the `work_pipeline` text equals the helper's render, ends with the
  procedure and carries the version rule; `maxTasks` validation); `mcp.test.ts` (the
  instructions against the tool schemas, no root `$ref`); `pipeline.test.ts` and
  `claim-input-size.test.ts` (the claim input additions, on a test double and over the whole
  corpus); `agent-sim.test.ts` (after the simulation agent works
  a project, eval:live's reader rebuilds the agent's recorded lines byte for byte, input aside).
- Contracts: the old claim input shape and a recording line without `input` still parse.
- `eval/tools`: `live-gate.test.ts` (pass, fail and incomplete; one gate per declared model; the
  baseline from an earlier version with the same model or from `agent-sim`, `0.1.10` above
  `0.1.9`; the 5-point boundary; 0.8 against 0.79999; null recall) and `live.test.ts` (REST and
  MCP payloads, the agent from the handle, the REST reader against a fake server, the command end
  to end on `_sample`: the warnings for several tokens, several files and a replaced file, exit 2
  for usage errors and for analyses of models outside the named landscape, 1 for runtime errors)
  and `replay.test.ts` (relative paths against the base directory, a missing `--recordings`
  directory and an unknown option exit 2).
- CLI: unit tests for `--project` and `--token-name` (an existing project refused before any
  import or token request), and an e2e test that seeds `_sample` into `sample-run-1` with the
  token `claude-code-1` (handle `agent:claude-code-1`) and refuses a second seed into that key.

By hand, on 2026-10-08:

- `claude plugin validate --strict plugins/proa` and `claude plugin validate --strict .` pass
  (Claude Code 2.1.294). The validator checks the manifests, not the skill; its frontmatter was
  parsed with `yaml` once.
- `run-headless.sh`: `bash -n`, shellcheck 0.10.0 without findings, dry runs against a fake
  pending endpoint and a fake `claude` (7 pending in batches of 3 gives three batches and exit 0;
  no progress exits 1; a rejected token and bad arguments exit 2). After the review fixes also: a
  failed batch (non-zero exit, `is_error`, no JSON) stops with exit 1, a `PROA_LOG_DIR` with
  earlier `batch-*.json` and a vanished temporary directory exit 2, and a trailing slash in
  `PROA_URL` is stripped.
- Agent SDK worker (removed on 2026-10-08: the owner decided against the Agent SDK for now):
  `tsc` against the pinned SDK in a copy outside the repository, `docker build`,
  `--help`, the refusal without `ANTHROPIC_API_KEY`, and `--once` against a fake endpoint; no
  `query()` was started. With a fake Claude Code executable: the token stays off the child's
  command line (`Bearer ${PROA_TOKEN}`, expanded by Claude Code from the environment, as checked
  with Claude Code 2.1.293 and 2.1.294 against a header-logging server), and a task ending in an
  error result keeps its JSON line and its cost.
- Codex: `config.toml` parses as TOML and follows OpenAI's MCP documentation for Codex. Its
  sandbox (codex-cli 0.159.3, `read-only` and `workspace-write`) read the checkout from an empty
  directory, so Codex is not isolated from `eval/` there.
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
- **Codex.** The `config.toml` entry and a run with the start prompt; on the holdout only in an
  environment without read access to the checkout (a container or VM without it, another OS user,
  another machine).

## Dev-run numbers

`proa-relations@0.2.0` (judge each pair once) was validated the same way on 2026-10-08: three
runs on fresh `nordwind-handel` projects (`nordwind-jo-1` to `-3`) of a scratch stack, one Claude
Sonnet 5.5 subagent per task, up to about 14 tasks claimed at the same time, so the assignment
rules ran under concurrent claims. `eval:live` recorded each run into a scratch directory (not
committed); the live gate of that harness reported `pass` after the third run. The subagents' tool
calls were audited: none read outside its work directory and its own tool outputs.

| Run (`claude-sonnet-5-5`, 31 tasks each) | Precision | Recall | F1 | must_not_link (≥ 0.8) | proposal items | no-link items | pairs judged twice | uncovered |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `0.1.0` dev runs 1 / 2 / 3 | 100.0 % | 78.6 % | 88.0 % | 0 (0) | 78 / 78 / 77 | 334 / 282 / 289 | 160 / 153 / 148 | – |
| `0.2.0` dev runs 1 / 2 / 3 | 100.0 % | 78.6 % | 88.0 % | 0 (0) | 40 / 40 / 40 | 205 / 206 / 209 | 10 / 8 / 8 | 0 / 2 / 0 |

The quality is unchanged; the pairs judged in more than one task fall by about 94 %, the proposal
items by half. The remaining 8–10 are the documented rest: `compatible` pairs (mostly triggers, one
dynamic call) that two concurrent partner searches examined at the same time; the server answered a
few of them `duplicate` (same token). The 2 uncovered pairs of run 2 are lexical pairs one subagent
left without a verdict. In this harness the total tokens per run stayed about the same (2.3–2.4
million), because the fixed context of every subagent (instructions, procedure, claim input)
dominates; the judging output and the reviewer's items shrink.


Before the owner's live runs, `proa-relations@0.1.0` was validated on the dev landscape only: three dev runs on 2026-10-08, each on a fresh `nordwind-handel` project of a scratch stack, every task worked by its own Claude Sonnet 5.5 subagent of the implementing Claude Code session through the real MCP tools (called with a command-line MCP client instead of a native connection).
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

## Procedure 0.2.0: judge each pair once

Status: code complete (commit `7126f0b`, 2026-10-08), released before any live run; the owner's
live runs use it ([M3-LIVE-RUNS.md](M3-LIVE-RUNS.md)). Spec: [CONCEPT.md](CONCEPT.md) §3 "Judge
each pair once"; mechanics: [DEVELOPMENT.md](DEVELOPMENT.md#judge-each-pair-once).

The owner's requirement (2026-10-08): models are evaluated through MCP with local agents, and no
work may happen twice, also with several agents. Under `0.1.0` every cross-model pair was judged in
the tasks of both its models, because a submission withdrew every unrepeated pipeline proposal
touching its model: a dev run made 78 proposals on 39 pairs, and the simulation agent judged 154
pairs on `nordwind-handel` and 121 on `stadtwerke-auental` twice.

Scope:

1. **Basis of agent judgements.** Pipeline proposals and, new, stored no-links record the
   `facts_hash` of both endpoint models as the agent saw them at its claim plus the declared
   procedure; a judgement is current while both models and the procedure are unchanged. Migrations
   0004 (generated: basis columns, `analysis_task.claimed_seq`, `assignment`, `requeue_after`, the
   tables `no_link` and `no_link_withdrawal`) and 0005 (append-only triggers, `claimed_seq`
   backfill).
2. **Assignment at the claim.** The input is rendered under the project lock; each unjudged,
   unsettled `rule`, `key` or `lexical` candidate pair goes to exactly one claim (a partner's live
   claim that holds it, else the queued partner whose key sorts first, else this one), stored as the
   task's assignment. The claim input gains `judged` (current judgements, any agent) and `skip`
   (pairs a partner judges), optional within `proa-claim/1`; `candidates` leaves both out, which kept
   the input below 100 KB (82.0 and 75.5 KB with every task claimed at once, 92.9 KB with LLM-sized
   judgements). `compatible` candidates are the search space, never assigned.
3. **Submissions.** Typed no-links with per-item outcomes (`stored`, `duplicate`,
   `invalid:<reason>`, `NO_LINK_INVALID_REASONS`); supersession only of judgements made on another
   version of the model or under another procedure, so current ones stay without repetition; a
   `duplicate` needs the same basis; the same principal and origin replace their own earlier
   judgement on a pair, other judgements coexist; `uncovered` reports assigned pairs left without a
   verdict.
4. **Queueing.** A task is queued when the head's facts differ from the previous head's and on a
   revive; a token revocation or `withdraw_proposal` that loses a pipeline judgement queues both
   endpoint models (or sets `requeue_after` on a claimed task).
5. **Review.** `Relation.noLinks` (current no-links on the pair; storing or withdrawing one moves
   the relation's version), the review screen's callout "Kein Zusammenhang laut Agent", the bulk
   flag `agent-no-link` (the pair starts unchecked) and "Einwand" in the queue. This answers open
   question 1 below.
6. **Procedure text** (`relations.md` `0.2.0`, skill and plugin regenerated, its hash in
   `RELEASED`): ground rule 6 "Judge each pair once"; section 4 documents `judged`, `skip` and "your
   pairs"; the work order judges your pairs, searches `compatible` candidates for endpoints without
   a partner and leaves listed verdicts alone, contradicting one only with concrete evidence; every
   examined pair gets a verdict, a rejected one a typed no-link, and an invalid pair nothing (the
   code `invalid-endpoint` is gone); section 10 has the new supersession and the same-principal rule
   instead of "repeat what you still support"; section 11 the no-link outcomes and `uncovered`.
   `procedure-text.test.ts` also checks the no-link reasons.
7. **Simulation agent and eval.** `sim-policy-1` sends typed no-links; its recordings moved to
   `proa-relations@0.2.0/agent-sim/sim-policy-1/` with identical scores, half the proposals on
   `nordwind-handel` (48 instead of 96; no-links 150 instead of 256), 0 pairs judged twice and 0
   uncovered. Recordings carry the no-link outcomes, `withdrawnNoLinks` and the `uncovered` count;
   `eval:replay` reports `pairsJudgedTwice` and `uncovered` ([eval/README.md](../../eval/README.md#recordings-and-evalreplay)).

Verified without a model ([DEVELOPMENT.md](DEVELOPMENT.md#judge-each-pair-once-proa-relations020-2026-10-08)):
all gates; `judge-once.test.ts` (21 integration tests: sequential and concurrent claims, release,
lease expiry, uploads between claims, disagreements, doc-only change, revert, delete and revive, a
procedure release, revocation, `withdraw_proposal`, no-link outcomes, `uncovered`, old results, a
bulk decision after a no-link) and its unit counterpart; the claim-input size test with every task
claimed at once and with LLM-sized judgements; the web review e2e with a no-link. The dev runs of
`0.2.0`: [Dev-run numbers](#dev-run-numbers). Remaining double work, by design: a `compatible`
pair that two concurrent partner searches both examine, re-claims after a lease expired, and
candidate-cap drift between two claims.

## Out of scope

M4: the value chain ([M4-VALUE-CHAIN.md](M4-VALUE-CHAIN.md)). Later: a per-project language
setting (R1), the prompts `analyze_model` (v1) and `review_landscape` (R1), reference setups for
Claude Managed Agents and the OpenAI APIs. Not done in M3: the simulation agent's policy does not
read the new claim input fields (using them would change the committed recordings and scores), and
the server's pipeline test double has no message flows or documentation, so only the unit tests
and the corpus-based size test cover those additions.

## Open questions for the owner

1. **No-links are invisible to reviewers, key-tier pairs can be bulk-accepted.** Resolved on
   2026-10-08 with `0.2.0`: reviewers see current agent no-links on the relation, in the review
   screen and as an unchecked flag in the bulk dialog, and the queue marks them as "Einwand"; the
   summary stays visible over REST only. The question as asked: the procedure tells agents to
   judge the rule tier's key-tier proposals like any candidate and to no-link a reused generic
   name. Supersession never withdraws rule-tier proposals, so such a pair stays
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
4. **Agent SDK worker in CI.** Resolved on 2026-10-08: removed by the owner's decision. For now
   there is no Agent SDK setup; models are evaluated through MCP with local agents (Claude Code,
   Claude Desktop, Codex; owner decision 16, [HANDOFF.md](HANDOFF.md) §4), and git history keeps
   the worker.
5. **Size headroom for documentation.** The additions raised the largest claim input from 68.7 to
   80.1 KB of the 100 KB limit (with `0.2.0`: 82.0 KB with every task claimed at once, 92.9 KB with
   LLM-sized judgements in `judged`), which only the corpus test checks; the server renders larger
   inputs as they come. Real landscapes with long documentation could cross it. If they do: cut
   partner and process documentation shorter than the model's own, or drop
   `ClaimEndpoint.processName`, which repeats `partnerProcesses[process].name` (incompatible, the
   simulation agent reads it, so a `proa-claim/2`). Act now or wait for a real landscape?
