# ProA 2.0 – Handoff (status as of 2026-10-10)

This file lets another person or AI agent continue the ProA 2.0 rebuild without the original
conversation. It records **where we stand, what the owner decided, what is open and what comes
next**. Specs live in the linked documents; this file does not repeat them.

Owner: Dominik Horn (Miragon). Communication with the owner is in **German**; repository docs
and code are in English.

---

## 1. TL;DR

- ProA is being **rebuilt in place** as **ProA 2.0**: a headless TypeScript store for BPMN process
  landscapes. Agents (any MCP client the operator chooses) analyse models and **propose**
  relations; **humans decide**. ProA itself holds **no LLM credentials**.
- 1.x (Quarkus + Vue) is merged into `develop` (squash commit `eb3539b`, PR #1) and stays
  untouched until the cut-over.
- 2.0 is built on branch **`claude/proa-2`**, draft PR **#2**
  (https://github.com/Miragon/ProA/pull/2), CI `ci-2.yml` green.
- **Done:** concept (ADR-0004), test landscapes + eval toolchain, **M1** (skeleton: facts, rules,
  server, REST, MCP, local mode, CLI, web), **M2** (analysis pipeline, agent proposals, human
  review, simulation agent, `eval:replay`), **M4 preparation** (value chain concept + golden data),
  **M3 code** (the released procedure, claim input additions, the Claude Code plugin
  `plugins/proa`, reference setups in `examples/agents`, `proa seed --project`, `eval:live` and
  the live gate; dev-landscape validation of `0.1.0` with Sonnet: 3 runs, precision 100 %, no
  must_not_link), and **judge each pair once** (procedure `proa-relations@0.2.0`, the owner's
  requirement that no work happens twice: each pair is judged in one task, no-links are stored and
  shown to reviewers), and **M4 S0** (the value chain packages `@miragon/value-chain-*` 0.3.0
  consumed from npm: exact dependencies, the golden-chain validator on the npm schema-model,
  the dependency specifier guard with one locked version of each value chain package,
  `diagram-js` and zod v4, and the schema-model round trip in Node), and **M4 S1** (2026-10-09:
  the value chain tables with migrations 0006/0007, `recomputeStatus` generalised over the
  subject with relation behaviour pinned by a golden digest, step generations, the revision
  write path and the placement lifecycle as domain functions), and **M4 S2** (2026-10-09: the
  value chain and placements over REST, MCP and `proa value-chain push|pull`, the rule tier's key
  proposals, placements that follow model ingest and deletion, findings, server tiers with
  `baseline-prefix/1` in `@proa/relations`), and **M4 S3** (2026-10-09: the value chain page in
  the web UI: viewer and modeler in a lazy chunk, collision-free ids, overlays, placement review
  in the side panel, save with dry run, conflict and drafts, link editing, drill-down; the bundle
  guard, the import harness and the CSS check in Playwright), and **M4 S4** (2026-10-09:
  `eval:placements` with its committed report, `proa seed --value-chains`, German texts for the
  rule tier; with it **M4a is done**, `eval:placements` green in CI since the push of S4), and
  **M4 S5** (2026-10-09: the `placement` pipeline kind with judge each process once,
  the procedure `proa-placements@0.1.0` and the skill `/proa:placements` (plugin 0.3.0), the
  prompts `place_processes` and `draft_value_chain`, Import of a `.vc.json` on the chain page, the
  simulation agent's placement policy, placement recordings scored by `eval:replay`, the placement
  live gate; M4b's code is done, its owner actions are open), and **auto-accept rules** (owner
  decision 19, 2026-10-10: project rules the owner maintains in the new tab
  „Regeln“ or with `proa rules …` accept agent proposals of relations and placements up to a
  chosen confidence, recorded as the owner's decision with rule and revision; agents never see
  rules; off by default, never retroactive (apply with a dry run), conservative safeguards, a
  preview with the project's empirical precision, marks and filters in the review views for
  every reviewer, bulk, per-agent and single revoke; `eval:replay` gained the „Auto-accept
  what-if“ at 0.8/0.9/0.95; a review round's fixes are in, see §7).
- **Next:** the **owner's live runs** of `proa-relations@0.2.0` and `proa-placements@0.1.0`
  (`docs/proa-2/M3-LIVE-RUNS.md`, steps 1–6 and 6a: 3 runs per landscape and model incl. the
  holdout), a chain drafted in Claude Desktop and rated, the holdout import check; **S6** (the OKF
  extension) waits for the R1 OKF export. After the live runs the owner chooses auto-accept
  thresholds from the what-if (§7 "Auto-accept rules"). A public demo on Fly.io is tracked in issue
  [#3](https://github.com/Miragon/ProA/issues/3) (its open questions are listed there).

## 2. Read in this order

| # | Document | What it holds |
|---|---|---|
| 1 | `docs/adr/0004-proa-2-headless-landscape-store.md` | The architecture decision (status: proposed) |
| 2 | `docs/proa-2/CONCEPT.md` | The full 2.0 spec: domain, pipeline, review workflow, store vs Git/OKF, interfaces, auth (local mode v1, server mode R1), agents/procedures, eval, stack, repository transition, roadmap, open questions |
| 3 | `docs/proa-2/DEVELOPMENT.md` | How to run, test and extend the 2.0 workspace (the operational source of truth) |
| 4 | `docs/proa-2/M1-SKELETON.md`, `M2-PIPELINE-REVIEW.md`, `M3-RELATIONS-PROCEDURE.md` | Scope and status of the milestones |
| 4a | `docs/proa-2/M3-LIVE-RUNS.md` | The owner's step-by-step guide for the live LLM runs |
| 5 | `docs/proa-2/M4-VALUE-CHAIN.md` | Prepared concept for the value chain milestone (incl. its open questions) |
| 6 | `eval/README.md`, `eval/tools/SPEC.md`, `eval/value-chains/README.md` | Test landscapes, trap catalog, generator/validator, golden value chains |

## 3. Repository and branch state

| Item | State |
|---|---|
| `develop` | 1.x platform overhaul (squash `eb3539b`). Protected by ruleset "main": PRs only, **squash merges only**, linear history, **signed commits**, no bypass actors, no required checks yet. |
| `claude/proa-2` | 2.0 work (see `git log origin/claude/proa-2..` for commits not yet pushed). Commits: `4f1be83` concept · `b29b289` test landscapes · `0c9f55d` M1 · `963d1de` M4 prep · `39e6699` M2 · `df07ea4` handoff · M3: `16c9f4b` claim input · `5340ee2` live tooling · `81f96e4` plugin and setups · `23873a8` procedure 0.1.0 · `37e23fe` clarifications · `d5a784f` large MCP results, image · `bb006cf` gate per model · `f50e550` docs · `f38c45c` review fixes · `0de60dc` docs · `cabdaee` no Agent SDK worker, value chain 0.3.0 · `7126f0b` judge each pair once (procedure 0.2.0) · `3f087c9` docs · `ada3fdc` judge-once review fixes · `01cd1cf` docs · `d21401f` token test fix · M4: `be4308f` S0 · `b9481b7` S1 · `e90fbba` S2 · `e4890ef` S3 · `bef64e0` S4 · S5 with its review fixes (`53e7acf`) · decision 19 (auto-accept rules) in the commit after `53e7acf`. |
| PR #2 | Draft, base `develop`, CI (`ci-2.yml`: typecheck/lint/test, docker image + compose live check) green. **Merge only with the owner's explicit OK.** |
| 1.x tree | `backend/`, `frontend/`, `pom.xml`, `mvnw*`, `.mvn/`, `Dockerfile`, `eclipse-formatter.xml`, `Makefile`, `scripts/`, `docker-compose.yml`, `.githooks/` and the 1.x workflows (`backend-tests.yml`, `frontend-checks.yml`, `deploy.yml`, `release.yml`) are still present and **must not be modified** on this branch. The cut-over PR removes them (CONCEPT §9). |
| Tags/releases | None in ProA yet. Plan: tag `v1.3.0` on `eb3539b` + branch `maintenance/1.x` + 1.x image **right before the cut-over merge** (owner decision), not now. |

## 4. Owner decisions (binding)

1. **Greenfield 2.0 in the same repository** (`Miragon/ProA`), version line 2.0.0. No data
   migration, no 1.x API compatibility.
2. **TypeScript end to end** (pnpm workspace, Node 24, Hono, PostgreSQL/Drizzle, React 19 +
   Vite + Tailwind v4 + shadcn, bpmn-js/diagram-js).
3. **Headless first:** every capability is a domain use case reachable via REST and, where agents
   need it, MCP; the UI is just one client.
4. **Intelligence in agents/skills, not in ProA.** No LLM key in ProA. Facts are computed by code;
   agents judge; humans decide.
5. **Agent freely chosen** (local Claude subscription via Claude Code/Desktop, deployed agents,
   other vendors) – everything over MCP from outside.
6. **v1 runs locally** (`PROA_AUTH=local`: 127.0.0.1, Host/Origin checks, UI = owner, MCP via
   agent tokens; Claude Desktop through the `proa mcp` stdio bridge). **Generic OIDC** (Keycloak
   or WorkOS) comes with **server mode in R1**.
7. **PostgreSQL is the system of record**; OKF (Open Knowledge Format) only as export; Git/bpmiq.yml
   only as import source.
8. **Pipeline** of models: not yet analysed → agent working → waiting for review / waiting for
   clarification → incorporated (owner's idea, CONCEPT §3).
9. **Auto-accept only unambiguous calls** (static `calledElement` / `zeebe:calledElement`
   matching exactly one process id, not the caller). Everything else is a proposal. Extended by
   decision 19: the owner may add rules that accept further proposals.
10. **"Vormerken" (hold)** = note + optional question/label, no assignee in v1.
11. **LICENSE unchanged** (CC BY-NC-SA 4.0, much 1.x code by envite authors); all packages
    `private: true`, nothing published to npm until the license is decided (prerequisite for
    `v2.0.0`).
12. **Commits/pushes** on `claude/proa-2` and the draft PR are allowed; **merging needs explicit OK**.
13. **Live LLM runs (M3) are done by the owner personally** with Claude Desktop/Code on the
    owner's subscription; no API key is provided. Prepare everything so the owner only has to
    follow a guide.
14. **Value chain** (the owner's meaning of "Prozesslandkarte") via the npm packages
    `@miragon/value-chain-schema-model` and `@miragon/value-chain-renderer`, pinned at **0.3.0**
    (released 2026-10-08 from `Miragon/value-chain-modeler`, MIT; deps zod 4.6.5 and diagram-js
    15.28.0 match ProA exactly). Do not copy the modeler into ProA. 0.2.0 was decided first; 0.3.0
    followed the same day as a pure version sync (neither package's source changed between 0.1.0
    and 0.3.0), so the owner left the choice to the agent, which pinned the newest (2026-10-08).
15. **Order:** M2 → **M3** → **M4** (value chain). The process network map follows later (R1).
16. **No Agent SDK for now** (2026-10-08): models are evaluated through MCP with local agents
    (Claude Code, Claude Desktop, Codex); the reference worker was removed (git history keeps it).
17. **No work twice** (2026-10-08): no pair may be judged twice, also with several agents. Done
    as "judge each pair once" in `proa-relations@0.2.0` (`M3-RELATIONS-PROCEDURE.md`, CONCEPT §3),
    released before any live run, so the owner's runs use `0.2.0`.
18. **Value chain defaults** (2026-10-09): the defaults of `M4-VALUE-CHAIN.md` §11 hold:
    archived copies go to `@outside` with the current version in the reason; one home step per
    process, a second only by a reviewer's decision; a step rename sends accepted placements to
    re-confirm; org units are owners of top-level steps, not agent evidence; one chain per project
    in M4; step kinds by colour until upstream has a category.
19. **Auto-accept rules** (2026-10-10): the owner maintains rules that accept agent proposals
    without a click: "up to x % confidence the agent may link by itself". Scope: **auto-accept
    only** (no glossary or fixed mappings), for **relations and placements**. Design the owner
    agreed to: a rule names the kind, the tier and a minimum confidence, optionally an agent or a
    model; the acceptance is recorded as decided **by the owner's rule** (agents still only
    propose, the check "agents never decide" stays); never for a pair or process with an open
    agent question, an objection or no-link of another agent, or a human decision; off by
    default; a preview shows what a rule would have accepted so far; accepted items are marked
    and can be revoked in bulk. **Delivered 2026-10-10**: CONCEPT §2
    "Auto-accept marker", §3 review workflow step 5, DEVELOPMENT.md "Auto-accept rules (owner
    decision 19)".

**Taken during M3 by the implementing agent (the owner may overrule; details in
`M3-RELATIONS-PROCEDURE.md`):** agents write rationales, questions, no-link reasons and summaries
in **German** (the review UI is German; a per-project language setting is deferred); the claim
input gains message-flow ends, partner documentation, partner processes and findings (optional
fields within `proa-claim/1`); every live run uses a **fresh project and its own token** (token
name = recording agent); the live gate is evaluated **per procedure version, landscape and
declared model** (3 runs each), against the previous version's live runs on that model or else
the simulation agent; every MCP tool declares `anthropic/maxResultSizeChars` so Claude Code
passes large claim inputs inline; the plugin carries no MCP server. For decision 17: an agent
judgement (pipeline proposal or stored no-link) carries a basis (both models' `facts_hash` at the
claim plus the procedure) and is current while it holds; the claim assigns each unjudged `rule`,
`key` or `lexical` candidate pair and each open relation (whatever its basis) to exactly one task
and lists current judgements (`judged`) and partner-assigned pairs (`skip`) instead of repeating
them as candidates (that kept the input below 100 KB); other `compatible` candidates stay the
search space; an agent's confirmation of a held pair is recorded as its judgement (the hold stays
in force); a submission withdraws only
judgements made on another version of its model; judgements of different principals or origins
coexist, so disagreements reach the reviewer; recordings keep the `uncovered` count, not the pairs.
This answers the former open questions "Supersession scope" and "No-links in review".

**Taken during M4 S5 by the implementing agents (the owner may overrule; details in
`M4-VALUE-CHAIN.md` §3.2 "As delivered in S5" and §9 "S5 as delivered"):** decision 17 (no work
twice) holds for placements as **judge each process once**: a process is judged again only when
its input hash changes (its model's facts, the chain's structure and step generations, its
neighbours through accepted relations with their accepted steps, the last human or rule-tier
assertion on it; never agent activity); at most one placement task per chain is open (no parallel
placement agents per project), follow-ups are queued only at submit; unsure and skipped processes
are remembered until their input changes; ad-hoc agent proposals count as the agent's verdict
(`judged`); a submission withdraws stale pipeline proposals of anyone and the caller's own
unrepeated ones, other agents' current proposals stay. `facts_hash` keeps its name and chain tasks
get `input_hash` (instead of the rename M4 §8 planned). `work_pipeline` works one kind per run
(`kind`, default relations with the released text). The plugin has its own version (0.3.0) with
a release table. New pipeline withdrawal reasons for placements are German; the relation ones stay
English. The placement live gate's bar is the higher recall@1 of `baseline-prefix/1` with and
without votes plus 20 points. The simulation agent's placement policy extends `sim-policy-1`.

**Taken during decision 19 by the implementing agents (the owner may overrule; details in
DEVELOPMENT.md "Auto-accept rules (owner decision 19)"):** the deciding principal is the author of
the rule revision in force (whoever created, edited or enabled it), pinned by a database foreign
key; the event principal is the causer (the agent, or the owner applying the rule); every edit,
enable and disable is an immutable revision, rules are never deleted, names are unique per project;
one kind, one tier and an inclusive minimum confidence of at least 0.5 per rule, optionally one
relation type, one agent and one exact declared model; **ad-hoc proposals only when the rule says
so** (default: pipeline proposals with a claim basis); the first matching rule in creation order is
recorded and its author must still be an owner; rules evaluate only proposals newly recorded by a
write and are **never retroactive** (apply: dry run, head revision, `expectedCount`);
**submission and ad-hoc results report the status before rules ran** (recordings and replays stay
independent of a project's rules, agents get no per-item feedback); the safeguards block also on
any human note or human proposal and on an earlier auto-acceptance or its revocation, so a revoked
item is never auto-accepted again and **a rule never re-confirms** after an endpoint change;
competing calls from one element and competing steps of one process block; revoking returns an
item to `proposed` while a live proposal remains (its judgement stays current, nothing is judged
twice), else it becomes `obsolete` and counts as a lost judgement; a human decision taken since is
never touched; **token revocation keeps auto-acceptances** (they are owner decisions) and the agents
page offers to revoke them with the token (and the tab „Regeln“ per agent); decision 9 stays
built in and shows as the read-only system rule „Eindeutige Aufrufe“; no MCP tool and no rule data
for agents (the revocation text names no rule); **the marks are every reviewer's** (editors read
the ledger of acceptances, permission `review`; the rules, apply and revoke stay the owners'); a
revocation ends exactly the acceptance (a later proposal of the rule's author stays); **saving a
rule whose author is no longer an owner takes it over**, also without a change; an agent's ad-hoc
placement proposal never replaces another agent's current `unsure` verdict (the doubt keeps
blocking); the preview counts only unmarked human decisions as ground truth, replays what the
rule's own earlier firing would have blocked, and counts an item as corrected when a human
accepted a competitor of it; the `eval:replay` what-if is report-only and replays a run in
recording order (an acceptance stays, later competitors are blocked), the holdout as `all` rows
without the tier split and with rows hidden when a difference between thresholds would reveal fewer
than 5 items, relations per tier (offline pair assessor), placements
overall, the holdout aggregate only with „< 5“ and a secondary suppression of the tier split.

## 5. What exists (2.0 workspace)

| Path | Content |
|---|---|
| `packages/contracts` | zod schemas, API resources, OpenAPI 3.1 (contracts-first routes) |
| `packages/client` | hey-api client generated from the OpenAPI document (drift test) |
| `packages/bpmn-facts` | C7/C8 fact extraction, hostile-XML protection, `FACTS_VERSION` |
| `packages/relations` | rule tier (unambiguous calls, key-tier proposals, findings), candidates for agents, 1.x baseline, pair assessor, and since M4 S2 `baseline-prefix/1` and the name-stem rule for placements (`placement.ts`) |
| `packages/procedures` | the released procedures `proa-relations@0.2.0` (`relations.md`; judge each pair once) and `proa-placements@0.1.0` (`placements.md`, `kind: placement`, M4 S5; judge each process once), the wrappers for the `work_pipeline` and `place_processes` prompts and the Claude Code skills, the `draft_value_chain` prompt text (`prompts/`), the skill generator and drift tests |
| `plugins/proa`, `.claude-plugin/marketplace.json` | Claude Code plugin 0.3.0 with the generated skills `/proa:relations` and `/proa:placements [project] [max-tasks]`; its own version since two skills ship (a test pins every skill's sha256 per plugin release) |
| `examples/agents` | reference setups: Claude Code (interactive and `run-headless.sh [--skill placements]`), Claude Desktop (configs + German start prompts for relations, placements and drafting a chain), Codex; documentation, not in the image |
| `apps/server` | Hono server: domain (pure, dependency-cruiser enforced), Drizzle/PostgreSQL, REST `/api/v1`, MCP `/mcp` (stateless Streamable HTTP), local mode, agent tokens, pipeline, review; since M4 S1/S2 the value chain and placements (`src/domain/value-chain/`: storage, lifecycle, `prepareRevision`, rule proposals, findings; REST under `/value-chains`, six MCP tools; the web page since S3); since decision 19 the owner's auto-accept rules (`src/domain/auto-accept/`, seven owner-only routes and the ledger for every reviewer, no MCP) |
| `apps/cli` | `proa health / status / import / seed [--project --issue-tokens --token-name --value-chains] / token create\|list\|revoke / value-chain push\|pull / rules list\|show\|add\|edit\|enable\|disable\|preview\|apply\|revoke / mcp` (stdio bridge) |
| `apps/web` | projects, models, relations, findings, bpmn-js model view, upload, connect-an-agent, inbox, review screen; since M4 S3 the value chain page (`/projects/{key}/value-chain`: renderer viewer/modeler in a lazy chunk, placement review, save with dry run and conflict, drafts, link editing) and the step view; since decision 19 the tab „Regeln“ (auto-accept rules with live preview, apply, revoke) and the marks and filters of auto-accepted items in the review views |
| `apps/agent-sim` | LLM-free reference agent that works the pipeline over MCP, both task kinds since M4 S5 |
| `eval/corpus` | test landscapes `nordwind-handel` (dev, 31 models, 17 C7/14 C8) and `stadtwerke-auental` (holdout, 26 models, 10 C7/16 C8) + `_sample`; every model deploys on Camunda 7.24.0 and 8.9.22 |
| `eval/tools` | spec format, BPMN generator with DI, validator, deploy check (`engines.compose.yaml`), `eval:candidates`, `eval:replay`, `eval:live` and the live gate, `eval:placements` (M4 S4: the golden value chains, the rule tier and `baseline-prefix/1`), the „Auto-accept what-if“ of `eval:replay` (decision 19) |
| `eval/recordings`, `eval/reports` | recorded submissions (today the sim agent under `proa-relations@0.2.0` and `proa-placements@0.1.0`; the owner's live runs go here too) and generated reports incl. both live gates, pairs judged twice and uncovered pairs |
| `eval/value-chains` | golden value chains + expected placements for both landscapes (M4); `validate-value-chains.mjs` checks them with `@miragon/value-chain-schema-model` 0.3.0 from npm (pinned in `eval/tools`) and its built-in cross-check, run by `pnpm test` |
| `docker/` | `compose.yaml` (project `proa2`: PostgreSQL 17 on 127.0.0.1:55432, ProA on 127.0.0.1:7400) and `Dockerfile` |
| `.github/workflows/ci-2.yml` | 2.0 CI (path-filtered; 1.x workflows untouched) |

**Key metrics (eval, no LLM):**

| Landscape | Rule-tier precision | must_link among rules ∪ candidates | 1.x baseline recall / precision | Sim agent (proposals) P / R / F1 |
|---|---|---|---|---|
| nordwind-handel (dev) | 100 % (9/9) | 100 % (42/42) | 33.3 % / 66.7 % | 73.3 % / 78.6 % / 75.9 % |
| stadtwerke-auental (holdout) | 100 % (3/3) | 100 % (40/40) | 42.5 % / 65.4 % | 64.0 % / 80.0 % / 71.1 % |

**LLM dev validation of `proa-relations@0.1.0` (2026-10-08, dev landscape only):** three runs on
fresh projects of a scratch stack, each task worked by its own Claude Sonnet 5.5 subagent of the
implementing session through the real MCP tools (a CLI helper instead of a native MCP client):
every run precision **100 %**, recall **78.6 %** (= all 33 non-call must_link pairs; the 9 unique
calls are rule-accepted, so recall ∪ rule tier is 100 %), F1 **88.0 %**, **0** must_not_link, 6
questions, all on may_link pairs, 0 invalid items. The sim agent (73.3 % / 78.6 % / 75.9 %, 3
must_not_link at ≥ 0.8) is beaten on precision at equal recall. These runs are **not** committed
as recordings and do not count for the live gate: the holdout and the owner's clients are untested.
`0.2.0` keeps the sim agent's scores and judges no pair twice (under `0.1.0` it judged 154 and 121
pairs twice). Three LLM dev runs of `0.2.0` (Sonnet 5.5, concurrent claims) kept precision
100 %, recall 78.6 % and 0 must_not_link, and judged 8–10 pairs twice instead of about 150, with
40 instead of 78 proposal items (`M3-RELATIONS-PROCEDURE.md`, dev-run numbers).

## 6. Run and verify

```sh
pnpm install
pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test   # server tests use Testcontainers (Docker)
pnpm eval:candidates && pnpm eval:replay && pnpm eval:placements
docker compose -p proa2 -f docker/compose.yaml up -d --build --wait     # ProA on http://127.0.0.1:7400
docker compose -p proa2 -f docker/compose.yaml exec proa proa seed      # loads both landscapes
docker compose -p proa2 -f docker/compose.yaml exec proa proa seed --value-chains   # and their golden value chains
docker compose -p proa2 -f docker/compose.yaml exec proa proa status
PROA_TOKEN=… pnpm eval:live --project <run project> --landscape nordwind-handel   # after a live run
```

Details (tokens, Claude Code/Desktop configuration, simulation agent, troubleshooting) are in
`docs/proa-2/DEVELOPMENT.md`. Optional Camunda engines for the test landscapes:
`cd eval/tools && pnpm engines:up && node deploy-check.mjs ../corpus/nordwind-handel --keep`
(Cockpit http://localhost:18080/camunda, Operate http://localhost:18088/operate, demo/demo).

**Machine state at handoff (owner's Mac):** the `proa2` stack is running, both landscapes are
seeded and processed by the sim agent (nordwind: 9 accepted, 48 proposed, 28 of 31 models waiting
for review; stadtwerke: 3 accepted, 52 proposed, 20 of 26 models waiting for review) and wait for
the owner's review. That container still runs the **M2 image** (`proa-relations@0.0.1`): rebuild
it before the first live run (`M3-LIVE-RUNS.md` step 1); the sim projects are not used for live
runs. The eval engines (`proa-eval-engines-c7-1`, `-c8-1`)
are running with nordwind deployed. An owner key from a source-run dev server exists in
`~/.local/state/proa/owner-key`; the container's owner key lives in volume `proa2_proa-state`.

## 7. Next steps

### M3 – the owner's live runs (next)

The code, procedure (`proa-relations@0.2.0`, judge each pair once), plugin, reference setups and
tooling are done (`M3-RELATIONS-PROCEDURE.md`). What remains needs the owner's Claude subscription:

1. Follow `docs/proa-2/M3-LIVE-RUNS.md`: rebuild the stack (it applies migrations 0004/0005 of
   `0.2.0` to the existing data), seed a fresh project per run
   (`proa seed nordwind-handel --project … --issue-tokens --token-name …`), run Claude Code
   (`examples/agents/claude-code/run-headless.sh`) or Claude Desktop (start prompt), then
   `pnpm eval:live` and commit the recording. Three runs per landscape and model, then the holdout
   `stadtwerke-auental`. Never tune the procedure on holdout results.
2. Things only such a run can confirm (listed as "not verified" in the docs): `/proa:relations`
   in `claude -p` with `--tools ""`, Claude Code honouring `anthropic/maxResultSizeChars`, MCP
   prompts in Claude Desktop, the Desktop start prompt, Codex.
3. Afterwards: decide the M3 open questions (§8), mark the procedure's live gate in
   `M3-RELATIONS-PROCEDURE.md`, and only then change the procedure as `0.2.1`/`0.3.0` (a released
   version's skill never changes; regenerate it with `pnpm --filter @proa/procedures generate` and
   add its hash to `RELEASED`, §9). Judge each pair once leaves some double work by design
   (`compatible` pairs two concurrent partner searches both examine, re-claims after a lease
   expired, candidate-cap drift; DEVELOPMENT.md "Judge each pair once"): revisit it if the live runs'
   "judged twice" or `uncovered` numbers are not near 0.

### M4 – value chain (M4a done; M4b's code done, its owner actions open; S6 blocked)

Follow `docs/proa-2/M4-VALUE-CHAIN.md` (slices S0–S6, ~4 weeks; S0–S5 done, S6 waits for the R1
OKF export). **S0 is done** (2026-10-08,
§9 "S0 as delivered"): schema-model 0.3.0 in `apps/server`, `apps/web` and `eval/tools`, the
renderer 0.3.0 in `apps/web`, exact and without overrides (the published packages pin the
diagram-js, diagram-js-direct-editing and zod versions ProA already uses; only a type-only `didi`
12.0.0 is a second copy); `minimumReleaseAgeExclude` lists both 0.3.0 versions (pnpm 11 holds
back releases younger than a day); the validator imports the npm package (the sibling-checkout
mode is gone, `VERIFIED_SCHEMA_MODEL` = `0.1.0`, `0.3.0`); `runtime-pins.test.ts` rejects
`link:`, `file:`, `portal:`, tarball, Git and non-exact specifiers in every `package.json` and the
lockfile, and requires one locked version of each value chain package, `diagram-js`,
`diagram-js-direct-editing` and zod v4 that every `@miragon/value-chain-*` pin names (bump the
pins in `apps/server`, `apps/web` and `eval/tools` together). The bundle guard and the Playwright
import check moved to S3, the first slice that imports the renderer; Dependabot for the pnpm
workspace comes with the cut-over, until then bumps are manual.

**S1 is done** (2026-10-09, M4 §9 "S1 as delivered"): the tables `value_chain`,
`value_chain_revision` (append-only), `value_chain_step` (generations, tombstone-only, incl. the
pseudo-step `@outside`), `placement` and `placement_assertion` (append-only, with the M4b basis
columns already in place) in migrations 0006 (generated) and 0007 (triggers, deferred submission
reference); typed ids `vch_`, `vcr_`, `plc_`, `pas_`; `status.ts` generalised over a subject
descriptor, with the relation functions unchanged as instances and a golden digest over 2,000
random relation histories computed before the change; the domain functions in
`apps/server/src/domain/value-chain/` (create, save with the `unchanged` no-op, delete and revive
a chain with step generations and placement endpoint refresh; a save or deletion withdraws the
live proposals on the generations it tombstones; propose, also as the rule tier, withdraw,
accept, reject, hold, correct, manual placement, note). Since S2 the use cases, ingest and model
deletion call them with `prepareRevision`'s output (the seam `PreparedRevision`).

**S2 is done** (2026-10-09, M4 §9 "S2 as delivered"): `prepareRevision` (canonical bytes, ProA
rules with per-element violations, kinds, ranks, step fingerprints, `structure_hash`), 19 REST
routes under `/value-chains` (`If-Match: "r<rev>"` required, 428/412 `revision-conflict`,
`If-None-Match: *` to create, `?dryRun=true` with the impact, decisions incl. bulk, unplaced
processes, findings), six MCP tools (`get_value_chain`, `get_value_chain_document`,
`list_unplaced_processes`, `propose_placement`, `withdraw_placement_proposal`, the stub
`decide_placement`), `proa value-chain push|pull`, the rule tier's key proposals (step link or
equal name, recorded under `proa-rules`, re-derived on every save and model change), placements
that follow model ingest and deletion (`changed`, `missing`, `ok` again), findings, token
revocation of placement proposals, server tiers. `baseline-prefix/1` moved from S4 into S2 and
lives in `@proa/relations` (`placement.ts`), next to the normalization it builds on and reachable
from both the server and `eval/tools` without a sixth package; S4 shrinks to about 1 d. Taken by
the implementing agents (M4 §9 lists all deviations): the top-level ranks group by kind band; the
dry run runs in a snapshot, not under the project lock (the save re-checks and returns its own
impact); "unplaced" and "pending" go by placement status, so a rejected placement homes nothing.
From the S2 review: a ProA rule bounds coordinates and sizes (`geometry-out-of-range`; a finite
coordinate near `Number.MAX_VALUE` was stored as `null` and broke every later read of the
project's chain), the canonical form is loaded again as reads load it before it is stored, the
size and count limits are checked first (an 8,000-step hierarchy blocked the event loop for
43 s), `rev` is capped at 999,999,999, the rule tier runs before the endpoint refresh in saves
too (no `endpoint_changed` there and back on a rename), and `proa value-chain push` needs
`--base` (the revision pulled) or `--force` for an existing chain, so a pull, edit, push round
trip cannot silently revert a save made in between.

**S3 is done** (2026-10-09, M4 §9 "S3 as delivered"): the page `/projects/{key}/value-chain` (tab
"Wertschöpfungskette" with the open placement count; the `reviewUrl` of refused agent writes,
`?placement=` selects the card) and the step view `…/value-chain/steps/{id}`. The renderer's
NavigatedViewer and Modeler live in a lazy chunk (`src/components/value-chain/canvas/`, the only
place allowed to import renderer, schema-model, diagram-js or zod: ESLint plus
`apps/web/test/bundle.test.ts`, chain-only code 36.0 KB gzip of a 40 KB budget beyond the shared
diagram-js chunk); `diagram-js` 15.28.0 became a direct web dependency, no `didi` override was
needed, and `src/lib/zod-csp.ts` sets zod's `jitless` so the CSP sees no `new Function` probe.
ProA's element factory names new elements `shape_<ULID>`, so a re-added step never takes a deleted
step's id. Placements are reviewed in the side panel (A/R/H/C on the active card, J/K, bulk
re-confirm, manual placements, `@outside` and removed steps); saves run the dry run with `If-Match`
(`If-None-Match: *` creates the chain on its first save), ask before stranding or sending to
re-confirm, show the save's own impact, offer "Neuere Revision laden" on 412 (the local copy
downloads first) and keep unsaved edits as drafts in `localStorage`. Link editing writes
`proa:process/<ref>` (a key-tier proposal) and clears with one undoable command. The server texts
for a missing chain and `get_value_chain` name the page. Playwright: the import harness (golden dev
chain and synthetic chains, 0 warnings, waypoints equal `layouter.layoutConnection`, ids never
repeat) and the value chain flow (15 tests, incl. the CSS check of the bpmn-js review screen around
the chain page, which found no difference). A review of the uncommitted work made 20 findings (two
on the same impact-dialog flaw), all fixed with tests before the commit (M4 §9 "S3 review fixes",
DEVELOPMENT.md "M4 S3 review fixes"): drafts that an import deleted or marked clean, edits lost to
the 300 ms change debounce or made during a save, the impact dialog on every save, a re-checked bulk
row, the unfitted first view under StrictMode, the chain routes in the entry chunk (now route
chunks; the bundle guard also bounds the entry), and keyboard, focus and wording issues (link
picker, draft dialog focus, "Zur Übersicht"/Escape, the tree's single tab stop, "nichts angenommen"
instead of "ohne Prozess", "offen" counted alike everywhere). Taken by the implementing agent: the
import check runs on the dev chain plus synthetic chains, never on the holdout chain (the owner can
run it with `PROA_E2E_VC_EXTRA=<path>`, counts only); the confirm rule also counts withdrawn
proposals; the renderer's copy-paste copies nothing in 0.3.0 (no `element.copy` rule), and its
palette and context pad are English (new upstream asks in M4 §12).

**S4 is done** (2026-10-09, M4 §9 "S4 as delivered"; with it **M4a is done**, see M4 §9 "M4a
done criteria status"): `pnpm eval:placements` (`eval/tools/src/placements*.ts`, report
`eval/reports/placements.{md,json}`, a CI step with the drift check) gates each scored landscape
on the validator, on the golden placements naming exactly the process facts and on every
key-tier rule proposal of the golden chain being a must or may, and scores the rule tier and
`baseline-prefix/1` with and without votes (dev: 4 rule proposals, all hits; baseline recall@1
43.8 %, precision@1 53.8 %, recall@3 65.6 %, area recall@1 59.4 %; without votes 46.9 %,
57.7 %, 62.5 %, 56.3 %; the holdout passes, as aggregate numbers only, none over fewer than 5
processes). The rule derivation moved into
`@proa/relations` (`derivePlacementRules`), so the gate checks what the server runs. `proa seed
--value-chains` creates each golden chain after the import (created, revived, unchanged, or
differs and left unchanged); the image ships the chain files only, guarded in CI. The rule
tier's texts are German (placement rationale and withdrawal, value chain finding details, chain
withdrawal reasons, the relation rule tier's finding details), so the agent-sim recordings were
re-recorded (only `input.bytes` changed). A new MCP integration case closes the M4a criterion
"proposed ad hoc over MCP … survive re-ingest and a layout-only re-save". Taken by the
implementing agent (M4 §9 lists all deviations): the ProA rules check of the golden chains is a
server unit test (`value-chain-golden.test.ts`), not part of eval:placements, because eval/tools
must not import from an app; no numeric baseline gate (the committed report pins the numbers);
the report and console show numbers only for the holdout, unlike `candidates.md` and
`replay.md`; neighbours for the votes are the `must_link` relations of `expected.yaml`, known
steps the golden musts (leave-one-out), plus a row without votes; the image ships
`eval/value-chains/*/value-chain.vc.json` (no ground truth: the document an agent reads over MCP)
so the container quickstart and M4b live runs can seed; seed never overwrites an edited chain
and revives a deleted one (it says so); the German finding details land before the M3 live runs
without a procedure version bump (the claim format and the skill are unchanged).

**Follow-ups and owner actions from S4:**
- Run the holdout import check once (counts only):
  `PROA_E2E_VC_EXTRA=eval/value-chains/stadtwerke-auental/value-chain.vc.json pnpm --filter @proa/web e2e value-chain-import`.
- Review the German server texts (M4 §9 "S4 as delivered"). Still English: the pipeline and token
  reasons ("superseded by submission …", "superseded by a newer analysis task …", "agent token …
  revoked"), API error messages, MCP tool descriptions and CLI output; translate them in one
  slice if wanted. A database from before S4 keeps English relation finding details until the
  next ingest or deletion. Undecided rule placement proposals are re-asserted in German at the
  next chain save that stores a revision or at the next model change; rule proposals a human
  already accepted, rejected or held keep their English rationale in the history until a step or
  process fingerprint changes (no migration; add a one-off rewrite if the owner wants a full
  switch).
- The M3 live runs (above); seed their projects with `--value-chains` only when the run also
  covers placements (M4b).
- "`eval:placements` is green in CI": confirmed (CI 2.0 run 37942115182 on `bef64e0`, the S4
  push).

**S5 is done** (2026-10-09, M4 §9 "S5 as delivered"; M4b's code is done): analysis tasks have two
kinds, `relations` and `placement` (subject: the value chain; migration 0008, `facts_hash` kept
and `input_hash` added for chain tasks). **Judge each process once:** a per-process input hash
decides when a process is due again, `placement_input` remembers the last agent verdict
(`proposed`, `unsure` with the reason, `skipped`), one placement task per chain is open at a time,
its claim (`proa-claim-placement/1`, ≤ 50 processes, ≤ 96 KB) is rendered under the project lock,
follow-ups are queued at submit (truncation with progress, or a trigger during the lease), saves
never cancel a claimed task. `claim_analysis` and `GET /analyses/pending` take `kinds` (default
relations, so M2 clients see nothing new), `submit_analysis` takes `placements` and `unsure`
(`wrong-task-kind` for the other kind), `get_value_chain` returns the stage and the unsure list,
`list_unplaced_processes` marks `judged` and `inTask` processes. The procedure `proa-placements@0.1.0`
(released; English text with invented examples, German output; a server drift test keeps it in
line with the code), the skill `/proa:placements` (plugin 0.3.0; the relations skill unchanged),
the prompts `work_pipeline` with `kind`, `place_processes` and `draft_value_chain`. The chain page
imports a `.vc.json` (edit mode and the empty state; re-laid out by the layouter; unsaved until
saved) and shows the agent's stage and „Agent unsicher“. The simulation agent works both kinds
(`decidePlacements`: rule-tier proposals at 0.95, else `baseline-prefix/1` hints with fixed bands);
its placement recordings are committed (the holdout's compared by digest only) and scored by
`eval:replay` (dev: recall@1 46.9 %, as the baseline without votes; precision 57.7 %, 6 traps at ≥
0.8: a floor, not a bar); the placement live gate needs recall@1 ≥ the better baseline row + 20
points (dev 66.9 %) and no must_not at ≥ 0.8. Relations behave byte for byte as before (their
recordings, report sections and released skill unchanged). Examples: `run-headless.sh --skill
placements`, German start prompts for placements and drafting.

**S5 review fixes** (2026-10-10, M4 §9 "Review fixes", committed with S5): the input
hash covers only what a claim shows (human notes on an open proposal now appear on it in the
claim; org units, layout, a sibling process or a task label re-offer nothing; the basis of
pipeline proposals follows the same digests); `list_unplaced_processes` marks the processes of a
claimed placement task `inTask` and procedure section 13 skips them (the remaining double work is
listed in CONCEPT §3 and M4 §3.2); the server start queues the first placement task of chains
that never had one (M4a chains after migration 0008), and reviewers queue it by hand on the chain
page („Aufgabe einplanen“, „Erneut einplanen“) or with `proa value-chain requeue`; procedure
sections 4 and 11 describe what a claim really carries (skill regenerated, the placements 0.1.0
hash updated while nothing is committed); `eval:live` accepts a REST relations payload without
`relations`; the simulation agent's rationale no longer claims a name match (recordings
regenerated, scores unchanged); `run-headless.sh --skill placements` counts a moved task or a
falling due count as progress; marketplace and README name both skills; the draft prompt has a
drift test; an import on the empty state asks before it replaces a stored new-chain draft.

**Owner actions from S5:**
- Three placement live runs per landscape and model (dev first, then the holdout):
  `M3-LIVE-RUNS.md` step 6a (`proa seed <landscape> --project <key> --value-chains --issue-tokens
  --token-name <run>`, `/proa:placements` or `work_pipeline` with kind `placement`, `pnpm
  eval:live`, then commit the recording with `pnpm eval:replay`'s reports). Never edit a run
  project's chain.
- Draft a chain in Claude Desktop (`examples/agents/claude-desktop/start-prompt-draft.de.md` or
  the MCP prompt `draft_value_chain`), import it on the chain page, edit, save and rate it (the
  open M4b criterion).
- The holdout import check (from S3/S4, counts only):
  `PROA_E2E_VC_EXTRA=eval/value-chains/stadtwerke-auental/value-chain.vc.json pnpm --filter @proa/web e2e value-chain-import`.

**Next: S6** (M4 §9 "S6 checklist"): the OKF extension, **blocked** until the R1 OKF export
exists. After a bump of the renderer, schema-model or zod: rerun the bundle guard (chain-only
37.0 of 40 KB used since S5), the import harness and the CSS check (Playwright is not in CI). The
owner accepted the defaults of M4 §11 (2026-10-09): archived copies to `@outside` with the reason,
one home step per process (a second only by a reviewer's decision), a step rename sends accepted
placements to re-confirm, org units as owners of top-level steps (not agent evidence), one chain
per project, kinds by colour until upstream has a category.

### Auto-accept rules (owner decision 19, delivered 2026-10-10)

Done on `claude/proa-2` in the commit after S5 (core: storage with migrations 0009/0010, the
evaluator in all four agent write paths, revocation, preview, ledger, REST; edge: the tab
„Regeln“, marks and filters in the relation table, review screen, timeline, queue, chain page and
step view, the token revoke offer, `proa rules …`, the `eval:replay` what-if, these docs, German
screenshots `docs/proa-2/screenshots/d19-*.png`). A review round (2026-10-10) fixed: the rule
dialog's „Neuere Revision laden“ now loads the newer revision into the form and lists what changed;
the marks and filters for editors; thresholds with every decimal (no silent rounding on save);
revoking leaves a later proposal of the rule's author; another agent's `unsure` survives an ad-hoc
proposal, so preview, apply and the write path agree; the preview's and the what-if's
counterfactual (an acceptance blocks later competitors); the holdout differencing across
thresholds; taking over a rule whose author lost the owner role; `proa rules apply` on a rule that
is off; outcome-aware revocation texts and a per-agent revoke in the tab; the rules table's
numbers; „Durch Systemregel angenommen“; „Inhaber“; the documented 422 reasons; the eval README on
comparability. Every gate passes (DEVELOPMENT.md "Verified end to end"). No project has a rule
until the owner creates one.

**Owner actions:**
- After the live runs (M3 and placements): read the „Auto-accept what-if“ sections of
  `eval/reports/replay.md` and choose a threshold per tier from the dev runs of the model in use
  (no traps, precision at the target), then check the holdout aggregate; the simulation agent's
  rows are only a smoke test (its key-tier relation proposals hold 3 traps at every threshold).
- In a working project (never a live-run project): create the first rule off, read its preview
  (the project's empirical precision on decisions you already made), enable it, and apply it to the
  open proposals only after reading the dry run list.
- Decide the new open questions in §8.

### Later (R1 and beyond)

Process network map (diagram-js + elkjs, saved views, impact analysis, end-to-end paths), lint
workflow, descriptions/glossary by agents, OKF export, server mode (OIDC, users, invitations,
public URL for claude.ai/ChatGPT/Routines), runtime overlays from Camunda 7/8, Web Modeler and
Git/bpmiq.yml import, MCP App widget.

### Cut-over (when the owner says so)

CONCEPT §9: freeze 1.x (tag `v1.3.0`, `maintenance/1.x`, 1.x image), then one squash PR that
removes the 1.x tree and all current workflows, rewrites README, adds `ci.yml` (successor of
`ci-2.yml`, without path filters) and `release.yml`, and makes `ci.yml` the required check.

## 8. Open questions for the owner

| Topic | Question | Source |
|---|---|---|
| License | Which license for 2.0 code? Prerequisite for `v2.0.0` and any npm publishing. | CONCEPT §12 |
| 1.x | How long does `maintenance/1.x` get fixes? Were 1.x versions snapshots or as-is/to-be variants? | CONCEPT §12 |
| First users | UI upload or Git/bpmiq.yml repos? Decides whether folder/bpmiq.yml import moves earlier. | CONCEPT §12 |
| Shared-name flag | The bulk dialog flags 20–22 of 33 key-tier pairs (names used by >2 processes), incl. legitimate broadcasts. Keep, or flag only names with several senders? | M2 web stage |
| `correct` on a typed pair | Correcting towards a pair that already has a key-tier proposal creates a second, manual relation. Offer "accept the existing proposal instead"? | M2 e2e |
| Revoking a token | Revoking now withdraws that token's open proposals and no-links (CONCEPT §6) and, since `0.2.0`, queues the models whose pairs it judged again, and, since M4 S2, withdraws its live placement proposals; since M4 S5 the chain's placement task is queued again for the processes it judged. Confirm. | M2 fix, 0.2.0, M4 S2, M4 S5 |
| Ad-hoc verdicts | Since M4 S5 an agent's ad-hoc placement proposals count as its verdict (the pipeline does not judge those processes again); ad-hoc relation proposals do not. Keep the asymmetry? | M4 S5 |
| Message-name matching | Names match ignoring separators (`Zahlung_Eingegangen` = `ZahlungEingegangen`). Confirm. | M1 relations |
| Local session | `POST /api/v1/session` is open to any local process (fine single-user, not on shared machines). Add a one-time login link later? | M1 integrate |
| Auto-accept: token revocation | Revoking an agent token keeps the auto-acceptances its proposals triggered (they are your decisions); the agents page offers to revoke them in the same step. Keep, or revoke them automatically? | Decision 19 |
| Auto-accept: ad hoc | Rules accept only pipeline proposals unless „Auch Ad-hoc-Vorschläge“ is set (ad-hoc proposals have no claim basis). Keep the default off? | Decision 19 |
| Auto-accept: 0.5 floor | No rule may accept below 0.5 confidence (contract and database check). Keep the floor, or raise it (e.g. 0.8)? | Decision 19 |
| Auto-accept: notes block | Any human note on a pair or process blocks a rule, like a decision or a hold (a note is often an answer to a question). Keep, or let a plain note through? | Decision 19 |
| Auto-accept: no re-confirm | After an endpoint change an accepted item waits for a human, also when a rule accepted it; a rule never re-confirms. Keep? | Decision 19 |
| Auto-accept: unique names | Rule names are unique per project ignoring case, so marks and filters are unambiguous. Keep? | Decision 19 |
| Auto-accept: results | Submission and ad-hoc results report the status before rules ran (an agent's `proposed` may already be accepted; `get_relations` shows the truth). Keeps recordings comparable and agents uninformed. Keep? | Decision 19 |
| Auto-accept: marks for editors | Editors see which acceptances a rule made (the ledger names rule, revision, agent and confidence, never the criteria); only owners see the rules, apply and revoke. Keep, or show the marks to viewers too? | Decision 19 review |
| Auto-accept: take-over | A rule whose author lost the owner role matches nothing until an owner saves it; saving it, also unchanged, makes that owner its author (its later acceptances are recorded under them). Keep, or add an explicit „Übernehmen“ action? | Decision 19 review |

## 9. Working agreements and pitfalls

- **Process safety (hard rule):** never use `pkill`, `killall` or `kill` by pattern. A subagent
  once killed the owner's apps (Docker Desktop, Teams, …) with a mis-ordered BSD `pkill`. Stop
  only PIDs you started; stop containers only via `docker compose -p <own project>`.
- **Shared Docker:** the owner runs other containers on this machine (`cibseven`,
  `cibflow-training-*`, `wattsapp`, `proa-eval-engines-*`). Never stop or modify them. ProA 2.0 uses compose projects
  `proa2` / `proa2-test*` and ports 7400, 7401 (Vite), 55432; the eval engines use 18080/18088.
- **Do not touch the 1.x tree** on `claude/proa-2` until the cut-over.
- **Exact dependency versions** everywhere (no `^`/`~`). Note: `.claude/rules/package-json-fixed-versions.md`
  was copied from another repo and mentions npm/`.npmrc`/`@miragon/wardley-*`; the intent (exact
  pins) applies, the details are for pnpm 11 (see DEVELOPMENT.md).
- **Domain purity:** `apps/server/src/domain` imports nothing from db/http/mcp/auth
  (dependency-cruiser, part of lint). Contracts first for every route. Authorization via
  `policy.require(actor, permission, projectId)` in every use case; foreign ids → 404.
- **Agents never decide** – keep that invariant in policy, DB check and MCP.
- **Holdout hygiene:** `stadtwerke-auental` is the holdout. Whoever writes or tunes a procedure
  never reads `eval/corpus/stadtwerke-auental/{expected.yaml,README.md,spec/}` (ground truth and
  traps), `eval/recordings/**/stadtwerke-auental.jsonl`, `eval/value-chains/stadtwerke-auental/`,
  or the stadtwerke sections of `eval/reports/*` (they list missed and wrong pairs). Live agents
  start outside the checkout with MCP tools only (Claude Code `--tools ""`; Codex keeps its shell
  and its sandbox allows reads, so a working directory alone does not isolate it: on the holdout
  it runs only in an environment without read access to the checkout); the Docker image ships
  none of these files (`docker/Dockerfile.dockerignore`) except, since M4 S4, the golden chain
  files `eval/value-chains/*/value-chain.vc.json` for `proa seed --value-chains`: steps without
  links, the document an agent reads over MCP in a seeded project anyway; the expected
  placements stay out (CI checks it). The placement report `eval/reports/placements.*` shows
  the holdout as aggregate numbers only, none over fewer than 5 processes (no rule tier split,
  no per-tag numbers of small tags).
- **Procedure releases are immutable:** recordings are keyed by `<id>@<version>`, and Git-hosted
  plugin installs stay at their version. A change to `relations.md`, to the wrapper
  (`packages/procedures/src/wrappers.ts`) or to the skill frontmatter needs a new version: bump it,
  run `pnpm --filter @proa/procedures generate` (skill + plugin version), add the new version's
  sha256 to `RELEASED` in `packages/procedures/test/plugin.test.ts` (its failing test prints it)
  and regenerate the sim recordings (`vitest … agent-sim.test.ts -u` writes the new folder but
  never deletes the old one: remove it by hand). The `0.1.0` hash is the skill after the review
  fixes (version rule, `disable-model-invocation`), which changed it before any live run without
  a new version; a Git-hosted install made before them keeps the older 0.1.0 skill (the owner's
  runs use `--plugin-dir`, which loads the current files). `0.2.0` (judge each pair once) is the
  current release, with its own hash; its sim recordings replaced the `0.1.0` folder.
- **Large MCP results:** Claude Code saves tool results above 50,000 characters to a file unless
  the tool declares `anthropic/maxResultSizeChars` (ProA's tools do); with `--tools ""` an agent
  could not read that file. Keep the declaration on new tools.
- **Parallel worktree agents** (Claude Code workflows) were created from the repository's default
  branch `develop`, not from `claude/proa-2`: such agents must `git reset --hard claude/proa-2` in
  their own worktree before working.
- **Verify before claiming:** every milestone so far ran all gates (format, typecheck, lint, tests
  against real PostgreSQL, eval gates, docker build) plus adversarial reviews; keep that standard.
- **Commits** end with the attribution line used in this repo's history; `develop` requires signed
  commits, which GitHub's squash merge satisfies.
- **`Miragon/value-chain-modeler`** is a separate product (VS Code extension, web app). Consume it
  from npm; changes to it go through its own repo.
- The 1.x review: the critical 1.x issues (version IDOR, silent version delete, replace data
  loss, Keycloak Dev Services in tests) were fixed and merged with PR #1. Further security
  findings of that review are deliberately not listed in this public repository; check their
  status with the owner before planning `maintenance/1.x` fixes. 1.x is otherwise frozen.
