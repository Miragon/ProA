# ProA 2.0 – M3 live runs

Status: prepared; validated with LLM subagents on the dev landscape, not yet run by the owner ·
Branch: `claude/proa-2` (up to date with `origin/claude/proa-2`) ·
Spec: [CONCEPT.md](CONCEPT.md) §7 · Setups: [examples/agents](../../examples/agents/README.md) ·
Reference: [DEVELOPMENT.md](DEVELOPMENT.md)

The owner's guide to the live runs of the relations procedure `proa-relations@0.2.0`
(and, since M4 S5, of the placements procedure `proa-placements@0.1.0`: [step 6a](#6a-placements-m4b-proa-placements010))
([`packages/procedures/relations.md`](../../packages/procedures/relations.md)): an LLM agent
(Claude Code or Claude Desktop on your Claude subscription) works a fresh project seeded from the
eval corpus, `pnpm eval:live` records what it submitted and scores it, and the live gate decides
over three runs per landscape and model. ProA holds no API key and runs no model; every run is yours.

**What `0.2.0` changes for you** (it replaced `0.1.0`, which never had a live run;
[judge each pair once](M3-RELATIONS-PROCEDURE.md#procedure-020-judge-each-pair-once)): each pair is
judged in one task only. Agents no longer repeat what a partner task proposed: a claim lists the
current judgements on its model's pairs in `judged` and the pairs a partner task judges in `skip`,
and neither appears among its candidates, so later tasks of a run are cheaper. Every submission
result reports `uncovered`, the assigned pairs the agent left without a verdict (it should be 0;
nothing is queued for them). Agents' no-links are typed and visible in the review: as "Einwand" in
the queue, in the review screen and as a flag in the bulk dialog
([step 7](#7-review-the-proposals-optional)). The run itself works as before.

The first run takes about 30 minutes of your time (steps 1, 2, 3a and 5); the agent's working time
on the 31 tasks comes on top (in the dev runs 1–3 minutes per task; with batches of 5 in one
`claude -p` context expect about an hour for a landscape). Commands run in a terminal at the checkout root
(`~/Code/ai-plattform/ProA`) unless a step says otherwise, against the Docker stack `proa2` on
http://127.0.0.1:7400 ([Quickstart](DEVELOPMENT.md#quickstart-docker)).

## What is verified

| Part | Verified | Not verified |
|---|---|---|
| Stack rebuild (step 1) | CI builds the image, seeds the stack and runs the live check (`ci-2.yml`), so far on the M2 commits | the image with the M3 commits (CI has not run on them yet); your `proa2` stack with them (agents do not touch it) |
| `proa seed --project --token-name` (step 2) | CLI unit tests; an e2e test against a real server (`_sample` into `sample-run-1` with token `claude-code-1`, handle `agent:claude-code-1`), and a second seed into that key refused with exit 1 and nothing changed; `nordwind-handel` seeded into a fresh project (`nordwind-live-1`) on a server started from the checkout (2026-10-08) | inside the container |
| Claude Code, headless and interactive (step 3a) | plugin and marketplace pass `claude plugin validate --strict` (Claude Code 2.1.294); a test compares the committed skill with the procedure; `run-headless.sh`: `bash -n`, shellcheck, dry runs against a fake server and a fake `claude` (a run to the end, failed batches, no progress, a reused `PROA_LOG_DIR`, a vanished temporary directory, `PROA_URL` with a trailing slash) | a run with a model, including that `claude -p "/proa:relations …"` expands the skill and that the agent has ProA's tools with `--tools ""` |
| Claude Desktop (step 3b) | CI's live check starts the Docker entry the way Claude Desktop does (absolute command, launchd-like environment) | the app, the start prompt, a run with a model |
| `eval:live` and the live gate (step 5) | unit tests (REST and MCP payloads, one gate per declared model, the 0.8 rule, the 5-point boundary, the baseline choice, the warnings for several tokens, several files and a replaced file, the refusal of analyses of models outside the landscape, the exit codes); the server test `agent-sim.test.ts` rebuilds the simulation agent's recording byte for byte (input aside) from the stored submissions; a seeded `nordwind-handel` project worked by the simulation agent and read by `eval:live` gave the committed recording again (input aside, agent renamed) and `FAIL` (3 must_not_link at ≥ 0.8, as the simulation agent has; 2026-10-08) | a recording of an LLM run |
| Judge each pair once (`0.2.0`) | integration tests against real PostgreSQL (assignment at the claim, `judged` and `skip`, supersession, no-link outcomes, `uncovered`, losses); the simulation agent's runs judge no pair twice with unchanged scores; the review e2e with a no-link in queue, bulk dialog and review screen | a run with a model |
| The procedure against a model (dev run) | three dev runs of `0.1.0` on `nordwind-handel` with Claude Sonnet 5.5 subagents of the implementing session, through the real MCP tools: precision 100 %, recall 78.6 % (∪ rule tier 100 %), 0 must_not_link, 0 invalid items in every run ([M3-RELATIONS-PROCEDURE](M3-RELATIONS-PROCEDURE.md#dev-run-numbers)) | Claude Desktop and Claude Code as clients, other models, the holdout |

## 0. Before you start

### What one run is

- **One fresh project**, seeded from one corpus landscape: `nordwind-handel` (dev, 31 models) or
  `stadtwerke-auental` (holdout, 26 models).
- **One agent token** for it (read + propose), named after the run: `claude-code-1`,
  `claude-desktop-2`, … The name becomes the handle `agent:<name>` and the agent segment of the
  recording.
- **One client with one model** works every task of the project until nothing is left.
- **One recording**, `eval/recordings/proa-relations@0.2.0/<token name>/<llmModel>/<landscape>.jsonl`,
  written by `pnpm eval:live` from the submissions the project stored.

Never reuse a project across runs:

1. Each pair is judged once: the claims list the first agent's current judgements in `judged` and
   leave those pairs out of the candidates, so a second agent would judge almost nothing.
2. The claim input contains the relations touching the model with their proposals and decisions:
   earlier proposals bias the next agent.
3. A worked project has nothing left to claim, and `eval:live` reads every done analysis of the
   project.

**Never create auto-accept rules in a run project** (owner decision 19, tab „Regeln“, `proa rules
…`). A seeded project has none, and it should stay so: a rule would accept proposals while the
agent works, and accepted relations and placements change the next claims (settled pairs, homed
processes, neighbours' steps). The submission results, and so the recording, would not change
(they report the state before rules ran), but the run would no longer measure the agent alone.
After the runs, read the „Auto-accept what-if“ sections of `eval/reports/replay.md` (written by
`pnpm eval:replay`, step 5): what a rule at 0.8, 0.9 or 0.95 would have accepted in each run,
right and wrong, per tier; choose a threshold from the dev runs of the model you use, and check the
holdout only as its aggregate rows.

Never reuse a token name for another run on the same landscape: `eval:live` writes each recording
file afresh, so a second `claude-code-1` run with the same model on `nordwind-handel` overwrites the
first one's file (`eval:live: replacing <file> (n lines before, m now)` on stderr). Number the runs
per landscape and client:

| Run | Project key | Token name |
|---|---|---|
| Claude Code, run n on the dev landscape | `nordwind-handel-cc-<n>` | `claude-code-<n>` |
| Claude Desktop, run n on the dev landscape | `nordwind-handel-cd-<n>` | `claude-desktop-<n>` |
| the same on the holdout (step 6) | `stadtwerke-auental-cc-<n>`, `stadtwerke-auental-cd-<n>` | `claude-code-<n>`, `claude-desktop-<n>` |

Project keys are lowercase slugs of at most 64 characters (`ProjectKey`); token names 1–100
characters.

### Prerequisites

- The Docker stack `proa2` ([Quickstart](DEVELOPMENT.md#quickstart-docker)); step 1 rebuilds it.
- The checkout on `claude/proa-2`, up to date with `origin/claude/proa-2` and with
  `pnpm install` done (Node 24, pnpm 11.1.3): `eval:live`, `eval:replay`, the plugin and the
  headless script come from it, and step 1 builds the image from it.
- Claude Code logged in with your Claude subscription (step 3a) and/or Claude Desktop (step 3b).
- `ANTHROPIC_API_KEY` unset in the shells you start agents from: `claude -p` uses it ahead of the
  subscription login whenever it is set.
- `node` and `curl` on the `PATH` (the headless script uses both).

```sh
cd ~/Code/ai-plattform/ProA
git switch claude/proa-2 && git pull --ff-only && pnpm install
grep -c maxResultSizeChars apps/server/src/mcp/server.ts # 1 or more: the M3 server
grep -m1 '^version:' packages/procedures/relations.md   # version: 0.2.0
echo "${ANTHROPIC_API_KEY:+ANTHROPIC_API_KEY is set}"    # prints an empty line
```

## 1. Rebuild the stack

```sh
docker compose -p proa2 -f docker/compose.yaml up -d --build --wait   # or: pnpm docker:up
curl -s http://127.0.0.1:7400/health
# {"status":"ok","version":"2.0.0-alpha.0","db":"ok"}
docker compose -p proa2 -f docker/compose.yaml exec proa grep -m1 '^version:' /app/packages/procedures/relations.md
# version: 0.2.0
docker compose -p proa2 -f docker/compose.yaml exec proa grep -c maxResultSizeChars /app/apps/server/src/mcp/server.ts
# 1 or more: the image has the M3 server
```

The image carries the procedure: `get_procedure` serves it, the claim names it as the expected
procedure, `work_pipeline` embeds it. Until the rebuild, the container serves the procedure of the
commit it was built from. In a connected client, `get_procedure` answers `version: "0.2.0"`,
`status: "released"`, and its tool description lists `proa-relations@0.2.0`. The rebuild also
applies the database migrations of `0.2.0` (no-links, the judgement basis) to the existing
projects. The rebuilt MCP server also declares `anthropic/maxResultSizeChars` on its tools: Claude
Code otherwise saves a tool result above 50,000 characters to a file and shows the model only its
path, which an agent without built-in tools cannot read, and claim inputs reach about 90 KB.

The volumes stay: projects, tokens and the owner key survive the rebuild. The projects seeded
earlier (`nordwind-handel`, `stadtwerke-auental`, `sample`, the e2e projects) keep the simulation
agent's proposals; they are not used for live runs.

## 2. Seed a run project

Set the run's names, in every terminal you use for this run:

```sh
cd ~/Code/ai-plattform/ProA
LANDSCAPE=nordwind-handel          # the holdout stadtwerke-auental only in step 6
RUN_AGENT=claude-code-1            # token name = agent segment of the recording
RUN_PROJECT=nordwind-handel-cc-1   # a key never used before
RUN_FILE=$HOME/.local/state/proa/runs/$RUN_PROJECT.json
```

Seed the project and keep the result, which holds the token secret (shown only now), in a file only
you can read:

```sh
mkdir -p "$HOME/.local/state/proa/runs" && chmod 700 "$HOME/.local/state/proa/runs"
if [ -s "$RUN_FILE" ]; then echo "$RUN_FILE exists: RUN_PROJECT was used before; pick another key"
else (umask 077; docker compose -p proa2 -f docker/compose.yaml exec -T proa proa seed "$LANDSCAPE" \
  --project "$RUN_PROJECT" --issue-tokens --token-name "$RUN_AGENT" --json > "$RUN_FILE"); fi
node -p 'const [r] = require(process.argv[1]); `${r.project} (${r.landscape}, created ${r.created}): ${r.models} models; token ${r.token.name} ${r.token.id}`' "$RUN_FILE"
# nordwind-handel-cc-1 (nordwind-handel, created true): 31 models; token claude-code-1 agt_…
export PROA_TOKEN=$(node -p 'require(process.argv[1])[0].token.secret' "$RUN_FILE")
```

`--project` seeds exactly one landscape into a project of that key, named "<landscape name>
(<key>)" (here "Nordwind Handel GmbH (nordwind-handel-cc-1)"), with the rule tier that
`eval:candidates` computes (`nordwind-handel`: 9 accepted and 33 proposed relations, 14 findings);
every model starts at "waiting for agent". `--issue-tokens --token-name` creates a read+propose
token for that project, valid for 90 days. Without `--json` the command prints the secret and
ready-made Claude Code and Claude Desktop entries instead.

The `if` keeps an earlier run's file: the redirect would empty it before `proa` runs, and its
token secret exists nowhere else (a seed that failed leaves an empty file, which the next try
overwrites). If it prints `… exists`, or stderr says `proa: project … already exists; a live run
needs a fresh project: pick another key (nothing was imported, no token was issued)` (exit 1), the
key was used before and nothing changed: set another `RUN_PROJECT` (and `RUN_FILE` after it) and
seed again; do not go on with the lines after the seed, which read the old or an empty file.

## 3a. Claude Code (recommended first)

Both ways below start Claude Code in an empty directory outside the checkout, with ProA's MCP
server as its only tools (`--strict-mcp-config --mcp-config examples/agents/claude-code/mcp.json
--tools "" --allowedTools "mcp__proa__*"`) and the plugin from the checkout (`--plugin-dir
plugins/proa`: the skill `/proa:relations [project] [max-tasks]`, generated from the procedure;
`--plugin-dir` loads the checkout's current files at every start). The skill runs only when you
type it (`disable-model-invocation: true`; a `/proa:relations` in the `claude -p` prompt counts),
never on the model's own initiative.
Details: [examples/agents/claude-code](../../examples/agents/claude-code/README.md).

**Model.** `claude-sonnet-5-5`, the Sonnet class CONCEPT §7 suggests for `relations`;
`claude-opus-5-5` works the same way. Give the exact id, not an alias such as `sonnet`: Claude
Code's system prompt names it, and the agent declares it as `llmModel`, which becomes a path
segment of the recording. Keep one model for the whole run, and for the three runs the gate
averages ([step 5](#5-record-and-score)).

### Headless: `run-headless.sh` (recommended)

One fresh `claude -p "/proa:relations <project> <batch-size>"` per batch, until nothing is
pending:

```sh
examples/agents/claude-code/run-headless.sh "$RUN_PROJECT" claude-sonnet-5-5 5 20
#                                            project        model             batch-size max-batches
```

- Arguments: the project key, the model id, the batch size (tasks per `claude -p`, 1–100,
  default 5) and the maximum number of batches (default 20). `nordwind-handel` has 31 tasks:
  7 batches of 5. A smaller batch keeps each context smaller.
- It needs `PROA_TOKEN` ([step 2](#2-seed-a-run-project)) and refuses to start while
  `ANTHROPIC_API_KEY` is set (`run-headless: ANTHROPIC_API_KEY is set, so claude -p would bill
  the API instead of your Claude subscription; …`, exit 2): `unset ANTHROPIC_API_KEY`.
  `--allow-api-billing` as the first argument overrides the guard; not for these runs.
  `PROA_MAX_BUDGET_USD` caps each batch (`--max-budget-usd`).
- The batches run in one new temporary directory under `$TMPDIR` (removed at the end), each with
  `--output-format json --model <model> --strict-mcp-config --mcp-config mcp.json --plugin-dir
  plugins/proa --allowedTools 'mcp__proa__*' --tools '' --permission-mode dontAsk
  --no-session-persistence`, and `MAX_MCP_OUTPUT_TOKENS=100000` unless you set it (the MCP
  output limit, for Claude Code builds that do not read `anthropic/maxResultSizeChars`). Without
  `--bare`, your `~/.claude` (user settings, hooks, `CLAUDE.md`) still applies: make sure nothing
  there steers how the agent judges.

```text
project nordwind-handel-cc-1: 31 pending; batches of 5 with claude-sonnet-5-5; logs in …/proa-headless-nordwind-handel-cc-1-…
batch 1: /proa:relations nordwind-handel-cc-1 5
  success, … turns, ~… USD
  pending: 31 -> 26
…
done: no task pending in nordwind-handel-cc-1 after 7 batches
estimated cost of all batches: … USD; results in …
```

Exit 0 when nothing is pending, or after `max-batches` with tasks still pending (run it again).
Exit 1 when a batch failed (`stopped: batch … failed`: `claude` exited non-zero, or its JSON
result is missing, not a `success`, or has `is_error`; a task it claimed stays leased for up to
15 minutes and that attempt counts, so check the run before you start the script again) or made
no progress (`stopped: batch … made no progress`). Exit 2 for usage errors, the API-key guard, a
pending count that cannot be read with the token, a `PROA_LOG_DIR` that already holds
`batch-*.json` from an earlier run, or a temporary directory that disappeared mid-run. The JSON
result of every batch (`result`, `num_turns`, `total_cost_usd`, an estimate) stays in the log
directory: `PROA_LOG_DIR`, which must be new or empty, by default a new
`proa-headless-<project>-<time>-XXXXXX` directory under `$TMPDIR` (`mktemp`). Tasks under a live
lease do not count as pending: check [step 4](#4-watch-progress) before you record.

Time and estimated cost per batch: the dev runs needed 1–3 minutes and about 75,000 tokens per
task with a fresh context each; a batch of 5 in one context needs somewhat more, so expect about
10 minutes and, at Sonnet 5.5 API prices, about $1 per batch (`total_cost_usd` in the log is the
estimate). On a subscription the tokens count against your usage limit instead.

### Interactive

```sh
PROA_CHECKOUT=~/Code/ai-plattform/ProA
mkdir -p /tmp/proa-run && cd /tmp/proa-run
MAX_MCP_OUTPUT_TOKENS=100000 claude \
  --strict-mcp-config --mcp-config "$PROA_CHECKOUT/examples/agents/claude-code/mcp.json" \
  --plugin-dir "$PROA_CHECKOUT/plugins/proa" \
  --tools "" --allowedTools "mcp__proa__*" \
  --model claude-sonnet-5-5
```

Start it from the shell where step 2 exported `PROA_TOKEN` (`mcp.json` reads `${PROA_TOKEN}` and
`${PROA_URL:-http://127.0.0.1:7400}` from the environment). `MAX_MCP_OUTPUT_TOKENS` is what the
headless script sets too. In the session:

```text
/proa:relations nordwind-handel-cc-1 5
```

The agent claims, judges and submits one task at a time and reports after 5 tasks, or earlier
when `claim_analysis` returns no items. Then `/clear` (a fresh context) and the same command
again, until it reports that nothing is left. `/mcp` shows whether `proa` is connected. Do not
switch the model during the run (`/model`): another declared model makes another recording file.

## 3b. Claude Desktop

Claude Desktop starts the stdio bridge `proa mcp` in the container, which relays to `/mcp` with
the token. It has no plugin skill; the start prompt makes the agent load the procedure with
`get_procedure`. Details: [examples/agents/claude-desktop](../../examples/agents/claude-desktop/README.md).
Use `claude-desktop-<n>` and `<landscape>-cd-<n>` in [step 2](#2-seed-a-run-project).

1. **Entry.** Merge into `~/Library/Application Support/Claude/claude_desktop_config.json` (create
   the file if it is missing, keep other entries), with the run's token in `env`
   ([`docker-bridge.json`](../../examples/agents/claude-desktop/docker-bridge.json)):

   ```json
   {
     "mcpServers": {
       "proa": {
         "command": "/usr/local/bin/docker",
         "args": ["exec", "-i", "-e", "PROA_TOKEN", "proa2-proa-1", "proa", "mcp"],
         "env": { "PROA_TOKEN": "proa_at_…" }
       }
     }
   }
   ```

   `command` must be an absolute path, since Claude Desktop does not get your shell's `PATH`:
   `which docker` prints it (Docker Desktop: `/usr/local/bin/docker`). Copy the token to the
   clipboard with `node -e 'process.stdout.write(require(process.argv[1])[0].token.secret)' "$RUN_FILE" | pbcopy`
   (no trailing newline, so the JSON string stays on one line).
   Every run has its own token: replace it for each run.
2. **Restart.** Quit Claude Desktop (Cmd+Q) and start it again. `proa` appears under the
   connectors of a new chat. Leave other connectors (file system, web) off in these chats, so the
   agent works from ProA's tools only.
3. **Start prompt.** Fill in [`start-prompt.de.md`](../../examples/agents/claude-desktop/start-prompt.de.md)
   and copy it:

   ```sh
   sed -e "s/{{PROJEKT}}/$RUN_PROJECT/g" -e 's/{{MODELL_ID}}/claude-sonnet-5-5/g' -e 's/{{ANZAHL}}/5/g' \
     examples/agents/claude-desktop/start-prompt.de.md | pbcopy
   ```

   `{{MODELL_ID}}` is the exact API id of the model you pick in the chat: Claude Desktop shows a
   product name, the agent declares this id as `llmModel` (Sonnet 5.5 is `claude-sonnet-5-5`).
   `{{ANZAHL}}` is the batch size.
4. **First batch.** Open a new chat, pick the model, paste the prompt and send it. The agent loads
   the procedure with `get_procedure({id: "proa-relations"})`, claims one task at a time with
   `claim_analysis({projectId: "<project>", max: 1})`, declares the model id and stops after
   `{{ANZAHL}}` tasks or when `claim_analysis` returns no items. Claude Desktop asks before each
   tool call: allow the ProA tools for the chat (or always) at the first call. A claimed task's
   lease lasts 15 minutes without renewal, and time spent waiting for approvals counts against
   it.
5. **Next batches.** A new chat per batch, same model, same prompt, until the agent reports that
   `claim_analysis` returned no items. Then [step 4](#4-watch-progress).

**Check the declared model after the first batch** (from the checkout, `PROA_TOKEN` set as in step
2):

```sh
pnpm eval:live --project "$RUN_PROJECT" --landscape "$LANDSCAPE" --no-write
# proa-relations@0.2.0/claude-desktop-1/claude-sonnet-5-5/nordwind-handel.jsonl (not written): 5 tasks from project nordwind-handel-cd-1
```

The third path segment is the declared `llmModel` (`none` if the agent declared none); the review
screen shows it too (provenance: declared procedure and LLM model). Ignore the scores of a partial
run. `eval:live` cannot rewrite the model, and `eval:replay` refuses a file whose lines name
another model than its path. If it is missing or wrong (a product name such as "Claude Sonnet
5.5", an alias, a guess): stop the run, revoke its token ([step 8](#8-clean-up)), seed a fresh
project with the next run number and repeat the id more prominently in the prompt (for example as
its last line). A run whose tasks declared different ids becomes several files, one per id, which
the gate counts as partial runs of each model's gate; `eval:live` warns
(`eval:live: warning: project … gives 2 recording files, …`) and names them: do not commit it.

## 4. Watch progress

```sh
docker compose -p proa2 -f docker/compose.yaml exec proa proa status --project "$RUN_PROJECT"
#   models     31 (2 agent working, 14 waiting for agent, 15 waiting for review)
```

The claimable count, as the headless script reads it (the token goes to curl on stdin):

```sh
printf 'Authorization: Bearer %s\n' "$PROA_TOKEN" |
  curl -s -H @- "http://127.0.0.1:7400/api/v1/analyses/pending?projectId=$RUN_PROJECT"
# {"total":14,"items":[{"projectId":"prj_…","projectKey":"nordwind-handel-cc-1","pending":14}]}
```

In the web UI, the project's **Prüfen** tab (http://127.0.0.1:7400/projects/nordwind-handel-cc-1/review)
counts models per stage: Wartet auf Agent → Agent arbeitet → Agent gescheitert → Wartet auf
Prüfung → Klärung offen → Eingearbeitet; "Agent arbeitet" names the holder (`agent:claude-code-1`),
the attempt and the lease end.

The run is complete when no model is left "waiting for agent", "agent working" or "agent failed"
(only "waiting for review", "waiting for clarification" and "incorporated"). Decide nothing in the
run project before that: human decisions go into the claim input of the tasks still to come.

**Stuck tasks.** A claim holds a task for 15 minutes (no renewal, at most 3 attempts):

| Inbox | Meaning | What to do |
|---|---|---|
| Agent arbeitet, "Lease bis …" | a session holds the task | wait: the agent submits, or hands the task back with `release_analysis` (queued again, the attempt does not count) |
| Agent arbeitet, "Lease abgelaufen am …" | the session ended without submitting or releasing | nothing: the next claim takes the task again (the attempt counts); or **Erneut einplanen** |
| Agent gescheitert, "Nach 3 Versuchen gescheitert" | three leases expired | **Erneut einplanen** (a new task), then one more batch |

- Only the holder can release a task: the lease token goes to the agent once. While a lease runs,
  claims skip the task, so a batch can end with nothing pending while a model is still "agent
  working". Run one more batch after the lease end.
- **Erneut einplanen** (the requeue) is in the web UI: the requeue route needs `proa:write` or
  the owner, run tokens lack it, and the CLI has no requeue command. It cancels a task whose
  lease expired and queues a new one.
- Do not revoke the run's token to free its tasks: revoking withdraws every proposal and no-link
  of the run and queues their models again, and going on needs a new token, that is another agent
  name and another recording.

## 5. Record and score

From the checkout, with the run's token (or the owner key):

```sh
cd ~/Code/ai-plattform/ProA
PROA_TOKEN=$(node -p 'require(process.argv[1])[0].token.secret' "$RUN_FILE") \
  pnpm eval:live --project "$RUN_PROJECT" --landscape "$LANDSCAPE"
```

`--landscape` is needed because the run's key is no landscape name. `eval:live` reads the
project's done analyses and their stored submissions over REST (`--url`/`PROA_URL`, default
http://127.0.0.1:7400), writes
`eval/recordings/proa-relations@0.2.0/<token name>/<llmModel>/<landscape>.jsonl` afresh (one line
per task: declared procedure and model, the submission, the server's result per item and per
no-link with the `uncovered` count; no claim input, which the server does not keep), scores it with
the `eval:replay` scorer together with the other recordings of the procedure on that landscape, and
prints the live gate of the run's model. `--no-write` scores without writing, `--json` prints the
numbers as JSON, `--agent <name>` overrides the agent segment.

```text
eval/recordings/proa-relations@0.2.0/claude-code-1/claude-sonnet-5-5/nordwind-handel.jsonl: 31 tasks from project nordwind-handel-cc-1
proa-relations@0.2.0/claude-code-1/claude-sonnet-5-5/nordwind-handel.jsonl: 31 tasks, … pairs; precision … %, recall … % (∪ rules … %), F1 … %; must_not_link … (… at ≥ 0.8); … questions; … judged twice, … uncovered
live gate proa-relations@0.2.0 / nordwind-handel / claude-sonnet-5-5 (dev): INCOMPLETE; 1 run, precision … %, recall … % (baseline 78.6 % from agent-sim proa-relations@0.2.0), F1 … %; must_not_link at ≥ 0.8: 0
  - 1 of 3 runs
```

1. The file written and its tasks: 31 on `nordwind-handel`, 26 on `stadtwerke-auental`; fewer
   means the run is not complete ([step 4](#4-watch-progress)).
2. The run: precision, recall and F1 of the agent's valid proposals against `expected.yaml` (an
   item answered `invalid:<reason>` is no proposal), recall with the rule tier's acceptances
   (∪ rules), must_not_link proposals and how many of them at confidence ≥ 0.8, proposals with a
   question for the reviewer; then the double work: pairs judged (proposed or no-linked) in the
   tasks of more than one model, which judge each pair once keeps near 0 (concurrent partner
   searches can still meet on a pair), and `uncovered`, the assigned pairs the agent left without a
   verdict (0 when it judged everything it was given).
3. The live gate of the procedure version on that landscape for the declared model, over every
   live run in `eval/recordings` with that `llmModel` (every agent but `agent-sim`, one file per
   run, whatever the client); a run with another model has a gate of its own:

| Status | When | Exit |
|---|---|---|
| `FAIL` | a run proposes a must_not_link pair at confidence ≥ 0.8, or the mean recall of the runs is more than 5 points below the baseline; checked first, so one run can fail the gate | 1 |
| `INCOMPLETE` | fewer than 3 runs, or no baseline | 0 |
| `pass` | at least 3 runs, a baseline, no failure | 0 |

The baseline is the mean recall of the live runs of the highest earlier version of the procedure
on that landscape with the same `llmModel`, else the `agent-sim` recording of the same version
(whatever its model). No earlier version of the procedure has live runs (`0.1.0` never had one),
so the baseline of every model is the simulation agent's 78.6 % on `nordwind-handel`: the mean
recall of a model's live runs must stay at 73.6 % or above. Recall and precision are those of the
proposals, without the rule tier. Exit 1 also for a runtime error (ProA unreachable, 401, 404, no
done analyses, invalid data); exit 2 for a usage error (unknown option, no `--project` or token, a
landscape not in the corpus, analyses of models the landscape does not have), which prints the usage
and writes nothing.

A warning `eval:live: warning: the run declared proa-relations@…; the current procedure is
proa-relations@0.2.0` means the container served another procedure than the checkout: rebuild
([step 1](#1-rebuild-the-stack)) and do not commit that recording.

Numbers of the dev runs of `0.1.0` (Sonnet 5.5 subagents, `nordwind-handel`): `31 tasks, 39 pairs;
precision 100.0 %, recall 78.6 % (∪ rules 100.0 %), F1 88.0 %; must_not_link 0 (0 at ≥ 0.8); 6
questions` in each of three runs. The dev runs of `0.2.0` gave the same scores, and additionally
`8–10 judged twice, 0–2 uncovered` (under `0.1.0`: about 150 judged twice). A run of yours that
ends far below this on the dev landscape points to a setup problem (tools, truncated claim inputs, a
summarized procedure) rather than the procedure.

**Commit** the recording together with the regenerated reports (CI regenerates
`eval/reports/replay.{md,json}` and fails on a diff):

```sh
pnpm eval:replay
git add "eval/recordings/proa-relations@0.2.0/$RUN_AGENT" eval/reports/replay.md eval/reports/replay.json
git commit -m "Live run $RUN_AGENT on $LANDSCAPE (proa-relations@0.2.0)"
```

`eval:replay` rescores every recording and writes the "Live gate" section of `replay.md` (and
`liveGate` in `replay.json`); it gates nothing and exits 1 only for an unreadable recording.
Commit every complete run, also a failing one: dropping runs with poor numbers biases the gate. Do
not commit an aborted run, a run with a missing, wrong or changing `llmModel`, or a recording of
another procedure version.

## 6. Repeat: three runs per landscape, then the holdout

1. **Dev landscape.** Runs 2 and 3 on `nordwind-handel`: steps 2–5 with `RUN_AGENT=claude-code-2`,
   `RUN_PROJECT=nordwind-handel-cc-2`, and so on. After the third run with the same model,
   `eval:live` and `eval:replay` report `pass` or `FAIL`. The gate is per declared model: a run
   with another model starts a gate of its own and does not count towards the three, while runs
   of another client with the same model id (Claude Desktop and Claude Code) enter the same
   gate's means. Run the three gate runs with one client and one model.
2. **Holdout.** Then three runs on `stadtwerke-auental` (26 tasks): `LANDSCAPE=stadtwerke-auental`,
   `RUN_PROJECT=stadtwerke-auental-cc-1`, `RUN_AGENT=claude-code-1`, … The landscape is part of the
   recording path, so token names may repeat across landscapes.

Runs on different projects may run at the same time, each with its own token; never two agents on
one project.

Holdout rules:

- **Measure, do not tune.** Run the holdout with the procedure version the dev runs measured, and
  do not change the procedure because of holdout results: the holdout measures how the procedure
  generalizes, and tuning on it destroys that. A changed procedure is a new version (frontmatter
  `version` in `relations.md`, then `pnpm --filter @proa/procedures generate`), worked out on the
  dev landscape, with its own runs on both landscapes.
- **Agents start outside the checkout**, so they cannot read `eval/` (the ground truth, the
  holdout's included): the headless script runs `claude` in a temporary directory outside the
  checkout, the interactive way starts in `/tmp/proa-run` with `--tools ""`, and Claude Desktop
  runs without file-system connectors. Codex (not part of this guide) is not isolated that way: it
  keeps its shell, and its sandbox does not restrict reads, so it runs on the holdout only in an
  environment without read access to the checkout (a container or VM that does not mount it,
  another OS user, another machine; [Codex](../../examples/agents/codex/README.md#not-isolated-from-the-checkout)).
- **Keep holdout details out of procedure work.** Model and element names, pairs, rationales and
  per-pair results of `stadtwerke-auental` never go into a conversation used for procedure work.
  The holdout runs' own chats and sessions are full of them: do not continue procedure work there.
  If your Claude settings let chats draw on earlier chats (memory, chat search), keep holdout chats
  out of their reach.
- `eval:live` and the `eval:replay` console print aggregate numbers only. `eval/reports/replay.md`
  lists pairs per recording, the holdout's included: leave its `stadtwerke-auental` sections out
  of procedure work.

## 6a. Placements (M4b): `proa-placements@0.1.0`

The value chain's placement pipeline (M4 S5, [M4-VALUE-CHAIN.md](M4-VALUE-CHAIN.md) §3.2) has
its own procedure, skill and live gate; a placement run is a run of its own, in its own fresh
project, under its own token. The stack must run an image with S5 (rebuild as in
[step 1](#1-rebuild-the-stack)); `get_procedure({id: "proa-placements"})` then answers.

```sh
LANDSCAPE=nordwind-handel RUN_PROJECT=nordwind-handel-cc-p1 RUN_AGENT=claude-code-p1
docker compose -p proa2 -f docker/compose.yaml exec proa proa seed "$LANDSCAPE" \
  --project "$RUN_PROJECT" --value-chains --issue-tokens --token-name "$RUN_AGENT"
# prints "value chain: created r1" and the token (once)
export PROA_TOKEN=proa_at_…
examples/agents/claude-code/run-headless.sh --skill placements "$RUN_PROJECT" claude-opus-5-5 1 5
# or Claude Desktop with examples/agents/claude-desktop/start-prompt-placements.de.md,
# or any client with the MCP prompt work_pipeline and kind "placement"
PROA_TOKEN=proa_at_… pnpm eval:live --project "$RUN_PROJECT" --landscape "$LANDSCAPE"
pnpm eval:replay                        # commit the recording with the reports
```

- `--value-chains` creates the landscape's golden chain without placements (the rule tier's key
  proposals appear, as after any save) and queues the chain's placement task. One task covers up
  to 50 processes, so a run is usually a single task (the dev chain has 32, the holdout 27);
  `/proa:placements <project> 1` is enough. Should a claim be truncated (more than 50 due
  processes or the 96,000-byte budget), its submission queues the follow-up at once, so the
  pending count stays at 1: `run-headless.sh --skill placements` counts a batch as progress when
  the chain's latest placement task changed or its due count fell (it prints `due: a -> b`), and
  stops only when nothing moved.
- A placement task that failed (three expired leases) shows „Agent fehlgeschlagen“ on the chain
  page with „Erneut einplanen“; `proa value-chain requeue -p "$RUN_PROJECT"` does the same in the
  container. A stack upgraded from M4a queues the first placement task of its existing chains at
  start (`queued the first placement task of n value chain(s)` in the log).
- Work only the placement task in this project (`--skill placements`, `kinds: ["placement"]`):
  the relations tasks the import queued stay queued, and relation proposals of a relations run
  would change the placement claim input (neighbours). The live gate compares the run with
  `baseline-prefix/1` as a fresh project's hints show it.
- **No auto-accept rules** in a run project (see [step 0](#what-one-run-is)); the placement
  what-if of `eval:replay` shows afterwards what a placement rule would have accepted.
- **Never edit the chain** of a run project: a placement recording counts only on the golden
  chain, and `eval:live` refuses a run whose task saw another chain content ("not comparable
  (edited chain)"). Reviewing placements is fine afterwards; it does not change the recording.
- The recording lands at
  `eval/recordings/proa-placements@0.1.0/<agent>/<llmModel>/<landscape>.jsonl`; `eval:live`
  prints the placement score line (precision, recall, recall@1 next to `baseline-prefix/1`,
  traps at ≥ 0.8, unsure, skipped) and the **placement live gate**: per procedure, landscape and
  model, **fail** if a run places a process on a must_not step at confidence ≥ 0.8 or the mean
  recall@1 of the runs is below the better `baseline-prefix/1` recall@1 plus 20 points (dev:
  66.9 %), **incomplete** below 3 runs, else **pass**. Three runs per landscape and model, dev
  first, then the holdout, with the holdout rules above.
- **Rating a drafted chain** (no run, no recording): in a project without a chain (for example a
  fresh `proa seed nordwind-handel --project nordwind-handel-draft` without `--value-chains`), let
  Claude Desktop draft one with
  [`start-prompt-draft.de.md`](../../examples/agents/claude-desktop/start-prompt-draft.de.md) (or
  the MCP prompt `draft_value_chain`), save the JSON block as `entwurf.vc.json`, open the project's
  value chain page, choose „Importieren“, check, edit and save it. Rate it against the golden chain
  by eye (steps, kinds, sub-steps); never draft on the holdout in a chat used for procedure work.

## 7. Review the proposals (optional)

Once the run is recorded, its proposals wait in the run project's inbox:
http://127.0.0.1:7400/projects/nordwind-handel-cc-1/review, each with the agent's rationale,
evidence, question and provenance (`agent:claude-code-1`, the declared procedure and model). Where
the agent judged a pair unrelated, typically a key-tier proposal of the rule tier with a generic
name, the queue shows "Einwand", the review screen the callout "Kein Zusammenhang laut Agent" with
its reason, and the bulk dialog flags the pair and leaves it unchecked. Accept,
reject, hold, correct and bulk accept per tier as in
[Review in the web UI](DEVELOPMENT.md#review-in-the-web-ui-m2). Reviewing does not affect the eval:
`eval:live` reads the stored submissions, and the scores compare them with `expected.yaml`, not with
your decisions. Before the run is complete, do not review ([step 4](#4-watch-progress)).

## 8. Clean up

Record ([step 5](#5-record-and-score)) and review ([step 7](#7-review-the-proposals-optional))
first. You need not revoke at all: the token works for its run project only and expires after 90
days. Revoking a token withdraws every open proposal and no-link of the run (decisions stay),
hands its claimed tasks back and queues every model whose pairs the run judged again (they show
"Wartet auf Agent"; the recording is unaffected, since `eval:live` reads done analyses only), and
`eval:live` then needs the owner key instead of the revoked token.

```sh
docker compose -p proa2 -f docker/compose.yaml exec proa proa token list --project "$RUN_PROJECT"
docker compose -p proa2 -f docker/compose.yaml exec proa proa token revoke --project "$RUN_PROJECT" \
  "$(node -p 'require(process.argv[1])[0].token.id' "$RUN_FILE")"
rm "$RUN_FILE"; unset PROA_TOKEN
```

- To keep the proposals reviewable, let the token expire instead (90 days after seeding).
- The run projects stay: ProA has no project deletion (only `down -v` deletes all data, every
  project included).
- Claude Desktop: remove the `proa` entry from `claude_desktop_config.json` (or put the next run's
  token in) and restart it.
- Claude Code: `--mcp-config` and `--plugin-dir` last only for the session; remove
  `/tmp/proa-run`. The headless JSON results stay in the log directory until you delete them.

Owner key for `eval:live` after a revocation:

```sh
PROA_TOKEN=$(docker compose -p proa2 -f docker/compose.yaml exec -T proa cat /var/lib/proa/owner-key) \
  pnpm eval:live --project "$RUN_PROJECT" --landscape "$LANDSCAPE"
```

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| 401: `/mcp` in Claude Code lists `proa` as failed; `run-headless: cannot read the pending tasks from … (is ProA running, is PROA_TOKEN valid for …?)`; the bridge answers `ProA at … rejected the agent token (401 …); check PROA_TOKEN`; `eval:live: GET /projects/…/analyses?…: 401 …` | `PROA_TOKEN` is not the run's token: not exported in this shell, another run's token, revoked or expired, or the owner key (MCP never accepts it). Set it from the run file ([step 2](#2-seed-a-run-project)); for `eval:live` after a revocation use the owner key ([step 8](#8-clean-up)). A token of another project gets 404 `not-found`. More 401 cases: [DEVELOPMENT.md](DEVELOPMENT.md#troubleshooting). |
| `⏸ Pending approval` | Concerns a project server from a `.mcp.json` ([DEVELOPMENT.md](DEVELOPMENT.md#troubleshooting)). With `--strict-mcp-config` Claude Code uses only the server from `--mcp-config`: start in the empty directory as in step 3a, not in the checkout. |
| `/proa:relations` is unknown, or `claude -p` treats it as plain text | The plugin is not loaded: `--plugin-dir` must name `<checkout>/plugins/proa`, the directory with `.claude-plugin/plugin.json` (is `PROA_CHECKOUT` set?). The headless script checks it (`run-headless: plugin not found: …`). Without the plugin, the server's MCP prompt gives the same instructions: `/mcp__proa__work_pipeline <project> <maxTasks>`. |
| The agent has no ProA tools (with `--tools ""` it has nothing else) | `PROA_TOKEN` was not exported in the shell that started Claude Code (`mcp.json` reads it from the environment), ProA is down (`curl -s http://127.0.0.1:7400/health`), or `mcp.json` lost `"alwaysLoad": true`, which loads ProA's tools at session start instead of deferring them behind tool search. `/mcp` shows the server's state. Headless, tools outside `mcp__proa__*` are denied (`--permission-mode dontAsk`). |
| Claude Code: the agent says a tool result was saved to a file, or works without the claim input | Claude Code moved a large result (claim input, model XML) to a file, which an agent with `--tools ""` cannot read. Rebuild the stack ([step 1](#1-rebuild-the-stack)): its tools declare `anthropic/maxResultSizeChars`; and start Claude Code with `MAX_MCP_OUTPUT_TOKENS=100000` as in step 3a. A run with such tasks measures the setup, not the procedure: stop it and start over in a fresh project; do not commit it. |
| Claude Desktop lists `proa` as failed | Usually `command` is not absolute, or the container `proa2-proa-1` is not running (`docker ps`); also check that the config file is valid JSON. Try the entry by hand: `PROA_TOKEN=… /usr/local/bin/docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp` must wait for input instead of exiting. See [Connect Claude Desktop](DEVELOPMENT.md#connect-claude-desktop). |
| Context limit: a Claude Desktop chat ends at its length limit; Claude Code compacts | A claim input is up to about 93 KB (measured: 82.0 KB on `nordwind-handel` and 75.5 KB on `stadtwerke-auental` with every task claimed at once, 92.9 KB with LLM-sized judgements in `judged`), the procedure about 33 KB. Lower the batch size (`{{ANZAHL}}`, the script's batch size, `/proa:relations <project> <n>`). After a compaction the skill and the start prompt make the agent reload the procedure with `get_procedure`. A task claimed in a cut-off chat comes back after its lease ([step 4](#4-watch-progress)). |
| Usage limit of your subscription reached | The client stops mid-batch; the claimed task cannot be released and comes back when its lease expires (the attempt counts; after 3 lost leases: Agent gescheitert → Erneut einplanen). Headless: `claude exited with status …`, then `stopped: batch … failed`, exit 1. When the limit resets, run the same command again or open a new chat; the run continues where it stopped. Do not switch the model to go on. |
| The agent reports items `invalid:<reason>` | The server refused those items (`message-flow`, `same-process`, `unknown-ref`, `outside-task-model`, `type-mismatch`, …; for no-links also `type-required` and `also-proposed`; [Submissions](DEVELOPMENT.md#analysis-pipeline-and-review-m2)) and stored the rest. Invalid items are no proposals for the eval. Let the run go on: correcting the agent mid-run changes what is measured. Note the reasons for procedure work on the dev landscape (`eval:live --json` gives `invalid` per run). A refused submission as a whole (`Input validation error: …`, 422, 413) stored nothing; the procedure has the agent fix and resubmit, or release the task. |
| The agent reports `uncovered` above 0 | It left pairs of its assignment without a verdict (call budget, lease, a skipped candidate). Nothing is queued for them. A partner task claimed later gets such a pair assigned again when it is among the partner's `rule`/`key`/`lexical` candidates or relations, and judges it then; the pair stays unjudged until one of its models changes only when the partner was analysed already or held it under a concurrent claim, when it is a `compatible` candidate for the partner and no relation, or when it is intra-model. Only then is a link among them missing from the run's recall. The `uncovered` sum in `eval:replay` adds up the results' counts, so it also counts pairs a later partner judged. Let the run go on; note it for procedure work on the dev landscape. |
| `stopped: batch … failed; see <log>` | `claude` exited non-zero, or its JSON result is missing, not a `success` (`error_max_turns`, `error_max_budget_usd`, …) or has `is_error`: read `subtype` and `result` in that log. A task the batch claimed stays leased for up to 15 minutes, and that attempt counts (3 expired leases fail a task, [step 4](#4-watch-progress)). Fix the cause (usage limit, budget, connection), check the run, then start the script again; with `PROA_LOG_DIR` set, name a new directory. |
| `stopped: batch … made no progress (pending … -> …)` | The batch succeeded, but the pending count did not go down: read its `result` in the log directory. Usually the agent had no ProA tools (did the proa MCP server connect? `PROA_URL`, `PROA_TOKEN`; see the row on missing tools above) or handed its tasks back. |
| `eval:live: project … is not named after a corpus landscape; …` | Add `--landscape nordwind-handel` (or `stadtwerke-auental`). |
| `eval:live: project … has no done analyses yet` | No task of the project was submitted yet. |
| `eval:live: project … has analyses of N models not in landscape …; name the landscape the project was seeded from with --landscape` (exit 2) | `--landscape` (`$LANDSCAPE`) names another landscape than the one the project was seeded from. Nothing was written: set it right and record again. |
| `eval:live: warning: project … was worked under N tokens (…)` | More than one agent token submitted in the project (also two tokens of one name): that is no run, whatever the files. Do not commit it; `--agent` does not fix it. Start the run again in a fresh project ([step 2](#2-seed-a-run-project)). |
| `eval:live: warning: project … gives 2 recording files, …` (several files for one run) | The tasks declared different `llmModel`s or procedure versions; the gate would count each file as a run: do not commit ([step 3b](#3b-claude-desktop)). (Several tokens give several files too, with the warning above.) |
| The run's token has the wrong name (the recording's agent segment) | Record again with `--agent <name>`, but first delete the file `eval:live` already wrote under the token name (`eval/recordings/proa-relations@0.2.0/<token name>/<llmModel>/<landscape>.jsonl`; if it replaced a committed run's file, `git checkout -- <file>` instead): the gate counts it as another run. |
| `eval:live: replacing <file> (n lines before, m now)` | The recording file existed with other content and was overwritten: fine when you record the same run again after it went on; if another run used the same token name, model and landscape, restore its file (`git checkout -- <file>`, if committed) and record this run again with `--agent <new name>`. |
