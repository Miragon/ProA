# ProA eval corpus

Test landscapes of BPMN models for Camunda 7 and Camunda 8. They are the eval
corpus for relation detection (precision and recall per relation type and per
trap, CONCEPT §7) and demo data for ProA 2.0. Every model is written as a
compact YAML spec and generated into deployable BPMN with complete diagram
information; ground truth lives next to it in `expected.yaml`.

```
eval/
  README.md                  this file
  .gitignore                 tools/node_modules
  tools/                     workspace package @proa/eval-tools: spec format, generator, validator, eval commands
    SPEC.md                  the spec format, with a complete example
    generate.mjs             spec -> BPMN
    validate.mjs             checks a landscape end to end
    deploy-check.mjs         deploys the models to real Camunda 7 and 8 engines
    engines.compose.yaml     those engines, for Docker
    src/candidates.ts        the eval:candidates gate (TypeScript, uses @proa/bpmn-facts and @proa/relations)
    src/replay.ts            eval:replay: scores recorded agent submissions (both task kinds), reports the live gates
    src/live.ts              eval:live: records a live run from a ProA project, scores it, checks the live gate
    src/live-recordings.ts   eval:live's REST reader and the mapping to recording lines
    src/live-gate.ts         the live gate (eval:live enforces it, eval:replay reports it)
    src/placements*.ts       eval:placements (M4): the golden value chains against the process facts, the rule tier and baseline-prefix/1
    src/placements-replay*.ts  eval:replay's placement part (M4b): placement recordings on the golden chain
    src/placement-live-gate.ts the placement live gate (eval:live enforces it, eval:replay reports it)
    lib/  test/
  recordings/
    <procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl   agent runs: simulation agent and live runs (below)
  reports/
    candidates.md, .json     last eval:candidates report (generated, deterministic)
    replay.md, .json         last eval:replay report (generated, deterministic)
    placements.md, .json     last eval:placements report (generated, deterministic; the holdout as numbers only)
  corpus/
    <landscape>/
      landscape.yaml         metadata (below)
      README.md              the landscape's story and its traps
      spec/<model-key>.yaml  source specs (edit these)
      models/<model-key>.bpmn  generated, never edited by hand
      expected.yaml          ground truth (below)
  value-chains/              golden value chains and expected placements (M4, value-chains/README.md)
    <landscape>/value-chain.vc.json, expected-placements.yaml
```

`_sample` is a three-model landscape that doubles as the toolchain's
regression test; it is not scored. Landscapes whose names start with `_` are
not part of the corpus.

## Working with the tools

Node 24 and pnpm 11. `eval/tools` is part of the repository's pnpm workspace:
install once at the repository root (`pnpm install`); dependencies are pinned to
exact versions (the root `pnpm-workspace.yaml` sets `saveExact`).

```sh
cd eval/tools

pnpm generate ../corpus/<landscape>          # spec/ -> models/ (also: a single spec file)
pnpm validate ../corpus/<landscape>          # full check, exit 1 on any error
pnpm generate:all && pnpm validate:all       # every landscape under corpus/
pnpm check                                   # generate --all --check: fail if models/ is stale
pnpm test                                    # _sample, generator fixtures, negative cases, SPEC.md example, src/
```

From the repository root, `pnpm eval:candidates` runs the LLM-free candidate gate
(CONCEPT §7) over every scored landscape: it extracts the facts, runs the rule tier,
the candidate generation and `baseline-proa1` (the 1.x algorithm) from
`@proa/relations`, and writes `reports/candidates.{md,json}`. It fails (exit 1) unless,
per landscape, the rule tier's accepted relations are all must_link or may_link (an
unlisted pair counts as wrong), no must_not_link is accepted, at least 98 % of the
must_link pairs are among rules ∪ candidates, `unresolved-call`, `dynamic-call` and
`duplicate-process-id` equal `expected_findings`, and every expected `dangling-throw`
and `unmatched-catch` is found (an extra one must be explained by a must_link or
may_link of that endpoint: the rule tier sees names only). The report also gives
recall within the key and lexical candidates and the same numbers for the baseline,
per relation type and per tag. Holdout landscapes are scored but never tuned against;
a miss that only the holdout shows is documented, not special-cased.

`pnpm eval:placements` (M4 §6) is the LLM-free gate of the value chains in
[`value-chains/`](value-chains/README.md): per scored landscape it runs
`validate-value-chains.mjs <landscape>` (exit 0 required; only its summary lines are kept, an
exit 2 makes eval:placements exit 2), requires the golden placements to name exactly the
landscape's `process` facts, and requires every key-tier rule proposal derived from the golden
chain (`derivePlacementRules` in `@proa/relations`, as the server derives it) to be the
process's `must` or a `may`. It scores those rule proposals and `baseline-prefix/1` (top-1 and
top-3, with votes from the must_link neighbours' golden steps, leave-one-out, and without votes)
as hit, may, coarse, trap, wrong or none, with precision, recall@1/@3, level 0, the trap rate
(at level 0 over the processes with a top-level `must_not`) and per tag, and writes
`reports/placements.{md,json}` (the holdout as numbers only, see holdout hygiene below);
`--out <dir>`, `--no-write` and landscape names as for eval:candidates. Exit 1 when a gate fails or golden data cannot be read, 2 on a
usage error. The baselines are a floor, not a gate; CI requires the committed report to match a
fresh run. The ProA rules check of the golden chains runs in `pnpm test`
(`apps/server/test/unit/value-chain-golden.test.ts`).

`generate` owns `models/`: it rewrites changed models and removes `.bpmn` files
without a spec. Output is byte-stable, so a diff in `models/` always means the
spec changed.

`validate` prints one line per section and the problems below it:

| Section | Checks |
|---|---|
| landscape | `landscape.yaml` against its schema, name equals the directory, README.md exists |
| specs | every spec against the zod schema and the semantic rules of SPEC.md |
| sync | every `models/*.bpmn` equals a fresh generation of its spec; no model without spec and vice versa |
| parse | bpmn-moddle with camunda-bpmn-moddle (c7) or zeebe-bpmn-moddle (c8): no warnings, no element or attribute from an unknown namespace, `modeler:executionPlatform` matches the spec's engine |
| lint | `bpmnlint:recommended` plus `bpmnlint-plugin-camunda-compat` for the model's engine and version (`camunda-platform-7-24`, `camunda-cloud-8-9`); errors and warnings fail |
| di | one diagram; DI for every participant, lane, flow node, data store, sequence flow, message flow and data association; valid bounds and waypoints; expanded subprocesses; shapes inside their pool, lane and subprocess; lanes tile their pool; boundary events on their host's border; edges start and end on their source and target |
| expected | refs resolve with the right kinds, findings hold, data store labels exist, closed-world completeness, trap coverage (below) |

**Lint overrides.** A spec may switch off a rule with
`lint.disable: [{rule, reason}]`, only where an intentional trap conflicts with
it, and the reason is mandatory. None are needed so far: every trap in the
catalog is expressible in lint-clean BPMN, because lint looks at one file and
traps live between files.

**Loading landscapes into ProA.** With a ProA server running locally,
`pnpm seed` from the repository root (the `proa seed` CLI; `proa seed` in the
container) creates one project per scored landscape, named after
`landscape.yaml`, and imports its `models/` through the REST API;
`pnpm seed _sample` loads the sample into project `sample`. `--value-chains` also creates
each landscape's golden value chain from `value-chains/<landscape>/value-chain.vc.json`
(only that file is read, never `expected-placements.yaml`; the Docker image ships the chain
files only), without placements; an existing chain is left unchanged (`differs` when it was
edited). `--issue-tokens`
also creates a read+propose agent token per project, named `seed` or
`--token-name <name>`. `--project <key>` seeds exactly one landscape into a
project of that key, named "<landscape name> (<key>)": the fresh project of a
live run (below). Re-running it changes no project and no model
(`--issue-tokens` creates another token each time). The server's integration
test `apps/server/test/integration/corpus.test.ts` checks that an import yields
exactly the rule relations and findings of `reports/candidates.json`. See
`docs/proa-2/DEVELOPMENT.md` for the owner key the CLI needs.

## Recordings and eval:replay

An agent run on a landscape is recorded as
`recordings/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`
(CONCEPT §7), one JSON line per analysed task in the format `proa-recording/1`
(`RecordingLine` in `packages/contracts/src/recordings.ts`): the landscape (the
corpus landscape the project was seeded from, `sample` for `_sample`; the
simulation agent records the project key, so it works projects seeded under the
landscape's name), the model and its revision, agent, declared procedure and LLM model,
optionally the task ids and the claim input (in full or as counts), the
submission as sent (relations with confidence, rationale, evidence and question;
no-links with their type; summary) without its lease token, and the server's
outcome per item; since `proa-relations@0.2.0` also per no-link, with the
withdrawn no-links and the number of `uncovered` pairs (the count, not the
pairs). Two writers produce them:

- the LLM-free simulation agent (`apps/agent-sim`,
  `pnpm agent-sim --record eval/recordings …`, see `docs/proa-2/DEVELOPMENT.md`)
  records as it works, claim input included; the committed ones under
  `proa-relations@0.2.0/agent-sim/sim-policy-1/` are reproduced byte for byte
  by the server test `apps/server/test/integration/agent-sim.test.ts`;
- `pnpm eval:live` (below) builds them afterwards from the submissions a live
  project stored. The server keeps no claim inputs, so these lines have no
  `input`; the same server test checks that eval:live rebuilds the simulation
  agent's lines byte for byte, input aside.

`pnpm eval:replay` (from the repository root) scores every recording against the
landscape's `expected.yaml` and writes `reports/replay.{md,json}`: the union of an
agent's valid proposals over all its submissions, by `(from, to)`, with
precision (must_not_link, same-process and, in a closed world, unlisted pairs are
false positives; may_link is neutral), recall (of the proposals, and of the
proposals ∪ the rule tier's accepted calls, which agents leave alone) and F1,
overall, per relation type and per tag; the must_not_link hits with confidence
and question; unlisted proposals; missed must_link pairs; questions and no-links
per class (a no-link the server answered `invalid:<reason>` is none; results
before `proa-relations@0.2.0` have no no-link outcomes, so all of theirs count);
the double work of judge each pair once: `pairsJudgedTwice`, the distinct
`(from, to)` pairs judged (a valid proposal or no-link) in the lines of more
than one model, and `uncovered`, the sum of the results' `uncovered` counts
(`–` for results before `0.2.0`, which have none), also at the end of each
console line (`; N judged twice, M uncovered`, the latter only when
reported); and the [live gate](#the-live-gate) per procedure version,
landscape and declared model. `--recordings <dir>`, `--corpus <dir>` and
`--out <dir>` (default `eval/recordings`, `eval/corpus`, `eval/reports`) take
other directories, `--no-write` writes nothing; relative paths resolve against
`INIT_CWD`, the repository root for `pnpm eval:replay` wherever in the checkout
it is started, as eval:live's do (below). A `--recordings` directory that does
not exist is a usage error, while an absent `eval/recordings` just has no
recordings. It is deterministic and enforces nothing: it exits 1 only for an
unreadable recording or an unknown landscape, 2 on a usage error. CI regenerates the report and
requires no diff, so new recordings are committed together with the report.

**Placement recordings** (M4b, `placements-replay.ts`): a recording of the procedure
`proa-placements` holds placement lines (`kind: "placement"`, the chain revision
`valueChain {key, rev, contentHash}` instead of a model and revision, the
placements and unsure items as sent, the result with `skipped` as a count); a
file never mixes kinds (eval:replay refuses it). eval:replay scores them against
`value-chains/<landscape>/expected-placements.yaml` with the eval:placements
scorer, after the relations sections (`replay.md`, key `placements` in
`replay.json`; the relations part stays as it was). A recording counts only on
the golden chain: every line's content hash must be the sha256 of
`value-chain.vc.json`, else eval:replay exits 1 ("not comparable (edited
chain)"). The run's placements are the union of its valid items (applied,
duplicate, suppressed, reopened; `@outside` included), one per (process, step)
with its highest confidence, ranked per process by confidence (ties by step
id): precision, recall, recall@1 and @3, area recall@1, F1, trap rate, traps
at ≥ 0.8, unsure, skipped and invalid items, next to `baseline-prefix/1` with
and without votes. The dev landscape adds traps, wrong top-1 and the musts
missed; the holdout shows aggregates only (as `placements.md`). The simulation
agent under `proa-placements@0.1.0` on `nordwind-handel`: 29 placements and 3
unsure for 32 processes, precision 57.7 %, recall (= recall@1) 46.9 %, area
recall@1 56.3 %, F1 51.7 %, trap rate 29.2 %, 6 traps at ≥ 0.8 (the baseline:
43.8 % with votes, 46.9 % without). The placement live gate per procedure,
landscape and `llmModel` over the live runs: **fail** if a run has a trap at
≥ 0.8 or the mean recall@1 is below the higher recall@1 of the two baseline
rows plus 20 points (dev: 66.9 %); **incomplete** below 3 runs; else **pass**.
eval:live records placement tasks too (the chain revision's number and content
hash from the revision listing), refuses a run on an edited chain and exits 1
on a failing placement gate.

**Auto-accept what-if** (owner decision 19, `tools/src/auto-accept-whatif.ts`):
what an owner's auto-accept rule at a minimum confidence of 0.8, 0.9 or 0.95
would have accepted in each recorded run, so the owner can choose the threshold
"x" from data. Report only, no gate; the sections follow the relation
recordings ("Auto-accept what-if (relations)") and the placement recordings
("Auto-accept what-if (placements)") in `replay.md`, `replay.json` has the key
`autoAcceptWhatIf {thresholds, relations, placements}`. The run is replayed in
recording order, as the server evaluates rules: at the end of each submission
(after its own replacements and withdrawals), for the proposals it newly
recorded (`applied` or `reopened`), with the safeguards checked against what is
live at that moment; what the rule accepted stays accepted (a later competing
call or step is blocked, and the agent's later no-link or re-judgement of it
does not undo it), and the agent's later submissions are taken as recorded.
Relations per recording, threshold and tier (`all` = one rule per tier at that
threshold): a pair counts at its first new proposal with confidence ≥ the
threshold and the rule's tier (the server's, recomputed offline with
`createPairAssessor` of `@proa/relations` on the landscape's facts) that passes
the safeguards: no competing call from the same element (a live call proposal
of the run to another target, one the rule already accepted, or a rule-tier
call), no question, no live no-link on the typed pair. What is live follows the
server: a newer proposal on a pair replaces the older; a no-link replaces the
agent's proposal on the pair from an analysis of the same model, a proposal or
no-link replaces its no-link from the same model; a submission for a new
revision of a model withdraws the judgements touching it that rest on an older
one. Columns: would accept, correct (must_link), acceptable (may_link), wrong
(unlisted in a closed world, same-process), traps (must_not_link), precision =
correct / (correct + wrong + traps). Placements per recording and threshold,
overall (a placement's tier depends on the project's neighbour votes at
proposal time, so there is no offline tier split; the in-product preview is per
tier): a process counts at its first new item at the threshold that passes the
safeguards: never `@outside`, no other step accepted, no live proposal on
another step (the run's, after the submission withdrew the agent's proposals of
a process it gave a verdict without repeating them, or the rule tier's key
proposal, decision 18), no question. Correct = the must, acceptable = a may or
coarse step, wrong, traps = a must_not step. Exclusions count, at 0.8, the items
with a qualifying proposal that were never accepted, by the safeguard that held
the first one back. A single-agent recording has no humans, holds or second
agent, so those safeguards cannot fire here. Dev recordings also list their
wrong and trap items at 0.8. **Holdout:** aggregate rows only, relations
without the tier split (the `all` rows), no item lists; a row with fewer than
`HOLDOUT_MIN_GROUP` (5) would-accept items shows „< 5“ (in `replay.json` its
counts are `null` with `redacted: "small"`), and since the rows are cumulative
(≥ the threshold), a row whose difference to the row of the next lower
threshold shown is 1 to 4 items shows „hidden“ (`redacted: "difference"`), so
no two shown rows differ by a small group; the exclusion counts under 5 show
„< 5“. The simulation agent on `nordwind-handel` (dev): relations at every
threshold 33 would accept, 30 correct, 3 traps (precision 90.9 %; all key tier,
which holds the 3 traps: 90.3 %; lexical 2 of 2); placements 19 at 0.8 (12
correct, 3 acceptable, 1 wrong, 3 traps: 75.0 %), 9 at 0.9 (87.5 %), 4 at 0.95
(100 %).

**How the owner's live runs feed it.** `eval:live` records every live run and
`pnpm eval:replay` adds its rows per agent, model and landscape. Submission
results report the status before the owner's rules ran, so a recording's
result field does not depend on rules; the claim inputs the agent saw do (what a
rule accepted is a settled pair, a homed process, a neighbour's step), so a
recording from a project with rules does not measure the agent alone and is
not comparable: live runs use fresh projects without rules
(`docs/proa-2/M3-LIVE-RUNS.md`, step 0). Rule of thumb:
choose x per tier where the dev runs on the model in use have no trap and the
precision meets the target, then check the holdout aggregate (never tune on its
numbers); afterwards the rule's preview in the tab „Regeln“ shows the project's
own empirical precision.

The simulation agent under `proa-relations@0.2.0`: `nordwind-handel` 48 pairs,
precision 73.3 %, recall 78.6 %, F1 75.9 %, must_not_link 12 (3 at ≥ 0.8);
`stadtwerke-auental` 52 pairs, 64.0 %, 80.0 %, 71.1 %, 11 (2); no pair judged
twice and none uncovered. These are the scores of `0.1.0`, under which it judged
154 and 121 pairs twice.

## Live runs and eval:live

A live run is one LLM agent working one fresh ProA project, seeded from a
corpus landscape, with its own agent token. The owner runs them with Claude
Desktop or Claude Code on the owner's subscription (owner decision 13 in
`docs/proa-2/HANDOFF.md`); the setups, including Codex as the non-Claude
client, are in [`examples/agents/`](../examples/agents/README.md). One run, against the Docker
stack, from the repository root:

```sh
# 1. a fresh project and a read+propose token named after the run (the secret is printed once)
docker compose -p proa2 -f docker/compose.yaml exec proa \
  proa seed nordwind-handel --project nordwind-handel-cc-1 --issue-tokens --token-name claude-code-1
# 2. the agent works project nordwind-handel-cc-1 with that token (examples/agents/)
# 3. record the run below eval/recordings, score it, check the live gate
PROA_TOKEN=proa_at_… pnpm eval:live --project nordwind-handel-cc-1 --landscape nordwind-handel
# 4. regenerate the reports; commit the recording and reports/replay.{md,json} together
pnpm eval:replay
```

Against a server started from the checkout, step 1 is
`pnpm seed nordwind-handel --project … --issue-tokens --token-name …`.

- **One fresh project per run.** Each pair is judged once: the claims list an
  earlier run's current judgements in `judged` and leave those pairs out of the
  candidates, so a second agent would judge almost nothing, and earlier
  proposals appear in the next claim input, so a reused project mixes runs and
  biases them.
  `proa seed --project` refuses a project that already exists (exit 1, before
  any import or token request).
- **One token name per run.** The token name becomes the agent segment of the
  recording (`claude-desktop-1`, `claude-code-2`, …). eval:live writes every
  file afresh, so a second run under the same name, procedure version, model and
  landscape replaces the first; when the file held other content, eval:live
  prints `replacing <file> (n lines before, m now)` on stderr (recording a run
  again after it went on is legitimate). A project worked under more than one
  token is no run: eval:live warns
  (`warning: project … was worked under 2 tokens (…)`), also when `--agent`
  would record it as one file.
- **The exact model id.** The agent declares it as `llmModel` (the wrappers and
  the start prompt tell it to); it becomes the `<llmModel>` segment, and the
  live gate is per model. A run whose submissions declare several models or
  procedure versions gives one file each, and the live gate counts each file as
  a run; eval:live warns and names the files
  (`warning: project … gives 2 recording files, …`). One run declares one model
  and one procedure.
- **Finish the run first.** Only `done` tasks are recorded; a queued, leased or
  failed task is missing from the recording and can lower its recall. `--json`
  shows `tasks.models` against `tasks.landscapeModels`.

`pnpm eval:live --project <key>` reads the project over REST with
`--token`/`PROA_TOKEN` (the run's agent token, or the owner key `proa_ok_…`) at
`--url`/`PROA_URL` (default `http://127.0.0.1:7400`): every `done` analysis
(all pages), its stored submission, and once per model the revisions, to map
the revision id to its number. Each line has outcome `submitted`, the server's
result without ids (with the no-link outcomes and the `uncovered` count where
the server answered them), no task ids and no input; the agent is the token
name from the submitter's handle `agent:<name>`, and procedure and model are
what the submissions declared. Lines are sorted by model key, then submission
time, so reading the same project again writes the same bytes. eval:live warns
when the declared procedure is not the one this checkout serves, scores the
new files together with the other recordings of that procedure and landscape in
`--out`, and prints one line per run and the live gates the new files count
in, as a run or as the baseline (procedure version, landscape and model).

| Option | |
|---|---|
| `--project <key>` | the project the run worked on (required) |
| `--landscape <name>` | the corpus landscape the project was seeded from; default: the project key, if it names one |
| `--url <url>`, `--token <token>` | server and token; default `PROA_URL` (else `http://127.0.0.1:7400`) and `PROA_TOKEN` |
| `--agent <name>` | agent segment instead of the token name |
| `--out <dir>`, `--corpus <dir>` | default `eval/recordings` and `eval/corpus`; relative paths resolve against `INIT_CWD`, which pnpm sets to the repository root for `pnpm eval:live` wherever in the checkout it is started (not to the shell's directory), never `eval/tools` |
| `--no-write` | score and check without writing |
| `--json` | per run the counts and metrics, per gate the means, baseline and reasons |

Exit 0 when every gate shown passes or is incomplete; 1 when one fails or on a
runtime error (server unreachable, 401, 404, no done analyses, invalid data);
2 on a usage error (unknown option, no `--project` or token, a landscape not
in the corpus, analyses of models the landscape does not have: name the
landscape the project was seeded from), like `proa-agent-sim` and
`run-headless.sh`; nothing is written then. The REST reader, the mapping and the gate are
exported from `@proa/eval-tools` (`tools/src/index.ts`, without the corpus
toolchain) for the server's `agent-sim.test.ts`.

### The live gate

`tools/src/live-gate.ts` is a pure function that eval:live enforces and
eval:replay reports (section "Live gate" of `reports/replay.md`; today "No live
runs yet"). The live runs are the recordings of every agent but `agent-sim`,
one file per run; it groups them by procedure `<id>@<version>`, landscape and
declared `llmModel` (the `<llmModel>` path segment), so each pinned model has
a gate of its own, while runs of different clients with the same model count
together.

| Status | When |
|---|---|
| fail | a run proposes a must_not_link pair with confidence ≥ 0.8, or the runs' mean recall is more than 5 points below the baseline (exactly 5 points passes) |
| incomplete | not fail, and fewer than 3 runs or no baseline |
| pass | otherwise |

The baseline is the mean recall of the live runs of the highest earlier version
(`x.y.z`) of the same procedure on that landscape with the same `llmModel`;
without such runs, the `agent-sim` recordings of the same version on that
landscape, whatever their model (averaged if there are several); without
either, there is none. Recall is the proposals' `overall.recall`,
without the rule tier; runs without one (no must_link pairs) are left out of the
mean, and without a mean or a baseline recall the recall rule does not apply.
Fail is checked before incomplete, so a single run can fail a version on its
model. Each gate reports its procedure, landscape and `llmModel`, the means of
precision, recall and F1, the run count, the must_not_link pairs at ≥ 0.8, the
baseline with its source and the reasons.

### Holdout hygiene for live runs

`stadtwerke-auental` is the holdout: the procedure is never tuned against it,
and a miss only the holdout shows is documented, not special-cased.

- **Start agents outside the checkout.** `eval/` holds the ground truth
  (`expected.yaml`, the landscape READMEs with their traps, the reports). Start
  Claude Code in an empty directory outside the checkout with
  `--strict-mcp-config` and `--tools ""`, and use Claude Desktop without other
  connectors (file system, web), so the agent works from ProA's MCP tools only
  ([`examples/agents/README.md`](../examples/agents/README.md)).
- **Codex is not isolated by a directory.** It keeps its own shell and file
  tools, and its sandbox does not restrict reads, so from an empty directory it
  can still read the checkout by absolute path. On the holdout, run it only in
  an environment without read access to the checkout: a container or VM that
  does not mount it, another OS user that cannot read it, or another machine
  ([`examples/agents/codex`](../examples/agents/codex/README.md#not-isolated-from-the-checkout)).
- **Read numbers, not pairs.** eval:live prints numbers only: per run the
  counts and metrics, per gate the means, the baseline and the reasons; with
  `--json` likewise, never pair lists, so a holdout run shows no ground truth on
  the console. `reports/replay.md` and `replay.json` do list pairs per recording
  (must_not_link hits, unlisted proposals, missed must_link pairs); whoever
  works on the procedure does not open their holdout sections.
  The placement sections of `reports/replay.md` and `replay.json` (M4b) show
  the holdout's placement recordings as aggregates only, like
  `reports/placements.md` and `placements.json`, which show the holdout as
  aggregate numbers only, none over fewer than 5 processes: no per-item
  lists, the rule tier as its gate and proposal count only (its proposals
  follow from the public chain file and model names, so a class split would
  name their classes), and per-tag numbers only for tags with at least 5
  processes (`HOLDOUT_MIN_GROUP`). eval:placements prints gates and
  whole-landscape numbers only. Whoever works on a procedure may open both
  files; they still carry the holdout's whole-landscape numbers, so tune
  nothing against them.
- **The auto-accept what-if** (owner decision 19) shows the holdout as
  aggregate rows only, relations without the tier split, rows and exclusion
  counts under 5 items as „< 5“, a row as „hidden“ when its difference to the
  next lower threshold shown would reveal fewer than 5 items, and no item
  lists (`auto-accept-whatif.test.ts` checks the redaction).
- **The holdout placement recording** (`recordings/proa-placements@…/agent-sim/…/stadtwerke-auental.jsonl`)
  is compared by the server test by sha256, line and byte counts only (no diff
  is ever printed; `-u` writes it); nobody opens it.
- **Recordings and server texts.** Since M4 S4 the rule tier's finding details
  are German; the claim input carries them, so the committed agent-sim
  recordings were re-recorded (only `input.bytes` changed, checked by a
  count-only comparison, the holdout file included; `reports/replay.*`
  unchanged).

## Engines

| Engine | Version | Lint config | Docker image (used by deploy-check) |
|---|---|---|---|
| Camunda 7 | 7.24.0 | `camunda-platform-7-24` | `camunda/camunda-bpm-platform:run-7.24.0` |
| Camunda 8 | 8.9.0 | `camunda-cloud-8-9` | `camunda/camunda:8.9.22` (single orchestration-cluster image) |

7.24 is the newest Camunda 7 minor with a `run` image. 8.9 is the newest Camunda
8 minor with months of patch releases; it supports everything the spec format
emits, including conditional events (8.9+), signal catch events and Camunda
user tasks. A landscape sets its versions in `landscape.yaml`, and a spec can
override them with `engineVersion` (c7 7.19–7.24, c8 8.6–8.10).

## Deploy check

`validate` proves lint-clean BPMN; `deploy-check.mjs` proves that the engines
accept it. It needs Docker and about 3 GB of memory for both engines.

```sh
cd eval/tools
pnpm engines:up                            # docker compose -f engines.compose.yaml up -d --wait
pnpm deploy-check ../corpus/<landscape>    # one or more landscape directories; --json for a report as JSON
pnpm deploy-check:all                      # every landscape plus the generator fixtures (test/fixtures/stress)
pnpm engines:down                          # docker compose ... down -v: removes containers and volumes
```

`engines.compose.yaml` starts `camunda/camunda-bpm-platform:run-7.24.0` on
`127.0.0.1:18080` (REST `/engine-rest`, Cockpit `/camunda`, demo/demo) and
`camunda/camunda:8.9.22` on `127.0.0.1:18088` (REST `/v2`, Operate `/operate`,
demo/demo; gRPC on 26500), both on in-memory H2 and with unauthenticated APIs,
for local use only. `PROA_C7_PORT`, `PROA_C8_PORT`, `PROA_C8_GRPC_PORT` and
`PROA_C8_MGMT_PORT` move the host ports; deploy-check reads `PROA_C7_URL`
(default `http://127.0.0.1:18080/engine-rest`) and `PROA_C8_URL` (default
`http://127.0.0.1:18088`).

For each landscape and engine (taken from `modeler:executionPlatform`),
deploy-check runs two steps:

1. **Each model on its own.** c7: `POST /engine-rest/deployment/create` with
   the landscape name as tenant id; c8: `POST /v2/deployments`. Each
   deployment is deleted again right after the check (c7 with cascade, c8
   through `/v2/resources/{key}/deletion`), so models never see each other.
2. **All models of the engine in one deployment**, which surfaces conflicts
   between files. Duplicate process ids make both engines reject it. If
   `expected.yaml` lists exactly those models in a `duplicate-process-id`
   finding, that is the `call-ambiguous` trap and counts as expected; the
   bundle is then deployed once per copy (all other models plus that copy).

A deployment passes when the engine accepts it and creates one process
definition per executable process. A directory without `models/` (the
generator fixtures) is generated in memory. Exit code 1 means an unexpected
rejection and 2 an unreachable engine. `--keep` leaves the first passing bundle
per landscape and engine deployed as demo data. c7 keeps landscapes apart by
tenant, but c8 has no tenants here, so on c8 keep one landscape at a time,
because the landscapes reuse process ids. Operate keeps listing deleted
definitions as history.

Deployable does not mean runnable. Call activities have no variable mappings,
and there are no job workers or forms (see the landscape READMEs).

Last run (2026-10-06, run-7.24.0 and 8.9.22), per model on its own and per
engine together:

| Landscape | Camunda 7 | Camunda 8 |
|---|---|---|
| `_sample` | 2/2; together ok | 1/1; together ok |
| `nordwind-handel` | 17/17; together rejected as expected (`Process_Bestellfreigabe` in two models), ok with either copy | 14/14; together ok |
| `stadtwerke-auental` | 10/10; together rejected as expected (`Process_Abschlagsanpassung` in two models), ok with either copy | 16/16; together ok |
| `test/fixtures/stress` | 2/2; together ok | 2/2; together ok |

The runs also showed engine rules that lint does not check: duplicate
subscriptions in one scope, one message start per name, straight-through loops
on c8, and the c8 deployment binding. The generator now rejects these up front
(`tools/SPEC.md`, section "Deploy-time rules").

## landscape.yaml

```yaml
name: billing-de             # equals the directory name
description: >-
  What the landscape is about, who the teams are.
lang: de                     # de | en | mixed
split: dev                   # dev | holdout
closed_world: true           # unlisted cross-process endpoint pairs count as must_not_link
engines:
  c7: 7.24.0
  c8: 8.9.0
traps_not_applicable:        # optional: trap tag -> reason
  call-ambiguous: no outdated copies in this landscape
```

## expected.yaml

```yaml
relations:
  - type: message                       # call | message | signal | trigger
    from: vertrieb/auftragsabwicklung#Event_WareVersandbereit
    to: finanzen/rechnungsstellung#Start_WareVersandbereit
    expect: must_link                   # must_link | must_not_link | may_link
    tags: [cross-engine-message]        # at least one; trap or extra tag
    rationale: Why this is (not) a link.

expected_findings:
  - kind: unresolved-call               # unresolved-call | dynamic-call | duplicate-process-id | dangling-throw | unmatched-catch
    refs: [finanzen/rechnungsstellung#Call_Mahnwesen]
    tags: [call-unresolved]
    rationale: Process_Mahnwesen is defined nowhere.

data_store_groups:
  - name: Kundenstamm
    labels: [Kundenstamm, Kunden-Stammdaten, CRM Kunden]
    tags: [data-store-variants]
    rationale: Same customer master data, three names.
```

**Refs** are `<model_key>#<element_id>` for elements and
`<model_key>#<process_id>` for processes. The model key is the path below
`models/` without `.bpmn`: lowercase slug segments such as
`finanzen/rechnungsstellung`.

**Relation types and endpoints** (CONCEPT §2):

| type | from | to |
|---|---|---|
| `call` | call activity | process |
| `message` | message throw: intermediate throw, message end, send task | message catch: message start (also of an event subprocess), intermediate catch, boundary, receive task |
| `signal` | signal intermediate throw or end | signal start (also of an event subprocess), intermediate catch, boundary |
| `trigger` | labelled none end | labelled none start (agents only, no rule) |

For `must_link` and `may_link` the validator enforces these kinds strictly, and
the endpoints must lie in different processes. Start and end events inside an
embedded subprocess or an event subprocess are never endpoints, except the
typed start of an event subprocess. A message flow inside one collaboration
file is a fact, not a relation; listing such a pair is an error. A `must_link`
call needs a static `calledElement` equal to the target process id; dynamic
calls are at most `may_link`.

`must_not_link` entries are checked loosely: `from` must be an end, throw or
call and `to` a start, catch or process, in any scope and in any process (also
the same one, for `self-link`). `type` names the relation an agent would most
plausibly propose by mistake.

**Findings.** `unresolved-call` (static calledElement matching no process id),
`dynamic-call` (expression) and `duplicate-process-id` (same id in two or more
models, all refs in one finding) are recomputed by the validator and must match
exactly. `dangling-throw` and `unmatched-catch` refs must be message or signal
throws and catches without a `must_link` or `may_link`.

**Closed world.** With `closed_world: true` the validator also requires:

- every key-tier candidate to be listed with some `expect`: a throw and a catch
  with the same message or signal name in different processes (unless an
  internal message flow connects them), and every static calledElement that
  matches a process id;
- every message and signal throw or catch endpoint to have a `must_link` or
  `may_link`, an internal message flow, or a `dangling-throw` /
  `unmatched-catch` finding.

**Trap coverage.** Every trap tag of the catalog must appear in
`expected.yaml` or be listed in `traps_not_applicable` with a reason.

**Extra tags** for entries that are not traps: `exact-key` (plain key-tier
link), `lexical` (similar labels, no identical key), `semantic` (same meaning,
other words, same language), `distractor` (plausible must_not_link not covered
by a catalog trap).

## Trap catalog

Every landscape must embed and tag each applicable trap at least once (tag
names in brackets).

- **[near-miss]** labels within Levenshtein <= 4 but different meaning ("Auftrag eingegangen" vs "Auftrag abgelehnt", "Order received" vs "Order rejected", "Invoice paid" vs "Invoice sent") -> must_not_link.
- **[transliteration]** umlaut/ß variants of the same event ("Antrag prüfen"/"Antrag pruefen", "Gemäß"/"Gemaess") -> must_link.
- **[de-en]** German/English pairs meaning the same ("Rechnung versendet" / "Invoice sent") across teams -> must_link (semantic tier).
- **[event-def-mismatch]** same or similar label but incompatible event definitions (timer end vs message start; none end vs message start) -> must_not_link (or may_link with rationale).
- **[subprocess-scope]** start/end events inside an embedded subprocess or event subprocess that match labels of other processes -> must_not_link.
- **[call-unique]** static calledElement (C7 calledElement="id"; C8 `<zeebe:calledElement processId="id"/>`) matching exactly one process id -> must_link (rule tier).
- **[call-dynamic]** calledElement as expression (C7 "${target}"; C8 processId="=target") -> may_link to plausible candidates + finding dynamic-call.
- **[call-ambiguous]** the same process id defined in two models (e.g. an outdated copy) -> may_link to both + finding duplicate-process-id.
- **[call-unresolved]** calledElement pointing to a process that does not exist -> finding unresolved-call, no link.
- **[cross-engine-message]** identical message name between a C7 and a C8 model (integration via message bus) -> must_link (key tier).
- **[generic-name]** a generic message/label reused with different meanings ("Antwort erhalten", "Daten aktualisiert") -> must_not_link between unrelated pairs.
- **[signal-broadcast]** one signal thrown, caught in several processes -> must_link each.
- **[collaboration]** collaboration file with participants + message flows (internal facts), where one participant process ALSO talks to other files -> cross-file links from the participant elements only.
- **[data-store-variants]** data store label variants of the same store ("Kundenstamm", "Kunden-Stammdaten", "CRM Kunden") -> data_store_groups.
- **[self-link]** a process whose own end/start labels match -> must_not_link.
- **[trigger]** labelled none end -> labelled none start in another process meaning a handover ("Auftrag freigegeben") -> must_link or may_link (agents only).
- **[dangling-throw]/[unmatched-catch]** message thrown with no receiver / catch with no sender -> findings.

BPMN has no timer end events, so the generator rejects them. Build the "timer
vs message" variant of event-def-mismatch from a timer start or a timer catch.

## Adding a landscape

1. Create `corpus/<name>/` with `landscape.yaml`, `README.md` and
   `spec/<model-key>.yaml` per model (format: `tools/SPEC.md`).
2. `pnpm generate ../corpus/<name>`; open a few models in Camunda Modeler.
3. Write `expected.yaml`: every plausible link, every trap entry and every
   finding. Each `must_not_link` needs the reason a matcher would fall for it.
4. `pnpm validate ../corpus/<name>` until it passes.
5. `pnpm engines:up && pnpm deploy-check ../corpus/<name>`; a rejection that is
   not an intentional trap is a spec or generator bug. Commit specs, models
   and expected.yaml together.
