# ProA 2.0 – Handoff (status as of 2026-10-09)

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
  guard, the import harness and the CSS check in Playwright).
- **Next:** the **owner's live runs** of `proa-relations@0.2.0` (`docs/proa-2/M3-LIVE-RUNS.md`: 3
  runs per landscape incl. the holdout), then the rest of **M4** (value chain /
  Wertschöpfungskette, slices S4–S6, on `@miragon/value-chain-*` 0.3.0; the owner accepted the
  defaults of M4 §11); S4 (`eval:placements`, `proa seed --value-chains`) is next.

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
| `claude/proa-2` | 2.0 work (see `git log origin/claude/proa-2..` for commits not yet pushed). Commits: `4f1be83` concept · `b29b289` test landscapes · `0c9f55d` M1 · `963d1de` M4 prep · `39e6699` M2 · `df07ea4` handoff · M3: `16c9f4b` claim input · `5340ee2` live tooling · `81f96e4` plugin and setups · `23873a8` procedure 0.1.0 · `37e23fe` clarifications · `d5a784f` large MCP results, image · `bb006cf` gate per model · `f50e550` docs · `f38c45c` review fixes · `0de60dc` docs · `cabdaee` no Agent SDK worker, value chain 0.3.0 · `7126f0b` judge each pair once (procedure 0.2.0) · `3f087c9` docs. |
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
   matching exactly one process id, not the caller). Everything else is a proposal.
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

## 5. What exists (2.0 workspace)

| Path | Content |
|---|---|
| `packages/contracts` | zod schemas, API resources, OpenAPI 3.1 (contracts-first routes) |
| `packages/client` | hey-api client generated from the OpenAPI document (drift test) |
| `packages/bpmn-facts` | C7/C8 fact extraction, hostile-XML protection, `FACTS_VERSION` |
| `packages/relations` | rule tier (unambiguous calls, key-tier proposals, findings), candidates for agents, 1.x baseline, pair assessor, and since M4 S2 `baseline-prefix/1` and the name-stem rule for placements (`placement.ts`) |
| `packages/procedures` | the released procedure `proa-relations@0.2.0` (`relations.md`; judge each pair once), the wrappers for the `work_pipeline` prompt and the Claude Code skill, the skill generator and drift tests |
| `plugins/proa`, `.claude-plugin/marketplace.json` | Claude Code plugin with the generated skill `/proa:relations [project] [max-tasks]`; version = procedure version |
| `examples/agents` | reference setups: Claude Code (interactive and `run-headless.sh`), Claude Desktop (configs + German start prompt), Codex; documentation, not in the image |
| `apps/server` | Hono server: domain (pure, dependency-cruiser enforced), Drizzle/PostgreSQL, REST `/api/v1`, MCP `/mcp` (stateless Streamable HTTP), local mode, agent tokens, pipeline, review; since M4 S1/S2 the value chain and placements (`src/domain/value-chain/`: storage, lifecycle, `prepareRevision`, rule proposals, findings; REST under `/value-chains`, six MCP tools; the web page since S3) |
| `apps/cli` | `proa health / status / import / seed [--project --issue-tokens --token-name] / token create\|list\|revoke / value-chain push\|pull / mcp` (stdio bridge) |
| `apps/web` | projects, models, relations, findings, bpmn-js model view, upload, connect-an-agent, inbox, review screen; since M4 S3 the value chain page (`/projects/{key}/value-chain`: renderer viewer/modeler in a lazy chunk, placement review, save with dry run and conflict, drafts, link editing) and the step view |
| `apps/agent-sim` | LLM-free reference agent that works the pipeline over MCP |
| `eval/corpus` | test landscapes `nordwind-handel` (dev, 31 models, 17 C7/14 C8) and `stadtwerke-auental` (holdout, 26 models, 10 C7/16 C8) + `_sample`; every model deploys on Camunda 7.24.0 and 8.9.22 |
| `eval/tools` | spec format, BPMN generator with DI, validator, deploy check (`engines.compose.yaml`), `eval:candidates`, `eval:replay`, `eval:live` and the live gate |
| `eval/recordings`, `eval/reports` | recorded submissions (today the sim agent under `proa-relations@0.2.0`; the owner's live runs go here too) and generated reports incl. the live gate, pairs judged twice and uncovered pairs |
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
pnpm eval:candidates && pnpm eval:replay
docker compose -p proa2 -f docker/compose.yaml up -d --build --wait     # ProA on http://127.0.0.1:7400
docker compose -p proa2 -f docker/compose.yaml exec proa proa seed      # loads both landscapes
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

### M4 – value chain (after M3)

Follow `docs/proa-2/M4-VALUE-CHAIN.md` (slices S0–S6, ~4 weeks). **S0 is done** (2026-10-08,
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

**Next: S4** (M4 §9 "S4 checklist"): `eval:placements` (reports `baseline-prefix/1`) and
`proa seed --value-chains`, then M4b. After a bump of the renderer, schema-model or zod: rerun the
bundle guard, the import harness and the CSS check (Playwright is not in CI). The owner
accepted the defaults of M4 §11 (2026-10-09): archived copies to `@outside` with the reason, one
home step per process (a second only by a reviewer's decision), a step rename sends accepted
placements to re-confirm, org units as owners of top-level steps (not agent evidence), one chain
per project, kinds by colour until upstream has a category.

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
| Revoking a token | Revoking now withdraws that token's open proposals and no-links (CONCEPT §6) and, since `0.2.0`, queues the models whose pairs it judged again, and, since M4 S2, withdraws its live placement proposals (nothing queued: no placement pipeline before M4b). Confirm. | M2 fix, 0.2.0, M4 S2 |
| Message-name matching | Names match ignoring separators (`Zahlung_Eingegangen` = `ZahlungEingegangen`). Confirm. | M1 relations |
| Local session | `POST /api/v1/session` is open to any local process (fine single-user, not on shared machines). Add a one-time login link later? | M1 integrate |

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
  none of these files (`docker/Dockerfile.dockerignore`).
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
