# ProA 2.0 – Handoff (status as of 2026-10-08)

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
  review, simulation agent, `eval:replay`), **M4 preparation** (value chain concept + golden data).
- **Next:** **M3** (the real `relations` procedure, Claude Code plugin, reference agents, live
  runs that the owner performs personally), then **M4** (value chain / Wertschöpfungskette with
  `@miragon/value-chain-*`, decided 0.2.0, 0.3.0 now exists – see §8).

## 2. Read in this order

| # | Document | What it holds |
|---|---|---|
| 1 | `docs/adr/0004-proa-2-headless-landscape-store.md` | The architecture decision (status: proposed) |
| 2 | `docs/proa-2/CONCEPT.md` | The full 2.0 spec: domain, pipeline, review workflow, store vs Git/OKF, interfaces, auth (local mode v1, server mode R1), agents/procedures, eval, stack, repository transition, roadmap, open questions |
| 3 | `docs/proa-2/DEVELOPMENT.md` | How to run, test and extend the 2.0 workspace (the operational source of truth) |
| 4 | `docs/proa-2/M1-SKELETON.md`, `M2-PIPELINE-REVIEW.md` | Scope of the finished milestones |
| 5 | `docs/proa-2/M4-VALUE-CHAIN.md` | Prepared concept for the value chain milestone (incl. its open questions) |
| 6 | `eval/README.md`, `eval/tools/SPEC.md`, `eval/value-chains/README.md` | Test landscapes, trap catalog, generator/validator, golden value chains |

## 3. Repository and branch state

| Item | State |
|---|---|
| `develop` | 1.x platform overhaul (squash `eb3539b`). Protected by ruleset "main": PRs only, **squash merges only**, linear history, **signed commits**, no bypass actors, no required checks yet. |
| `claude/proa-2` | 2.0 work, pushed. Commits: `4f1be83` concept · `b29b289` test landscapes · `0c9f55d` M1 · `963d1de` M4 prep · `39e6699` M2. |
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
    `@miragon/value-chain-schema-model` and `@miragon/value-chain-renderer` **0.2.0** (released
    2026-10-08 from `Miragon/value-chain-modeler`, MIT; deps zod 4.6.5 and diagram-js 15.28.0 match
    ProA exactly). Do not copy the modeler into ProA. **Note:** 0.3.0 of both packages followed
    the same day (12:51 UTC), a pure version sync: neither package's source changed between 0.1.0
    and 0.3.0, the dependencies are the same. Which version to pin is open (§8).
15. **Order:** M2 → **M3** → **M4** (value chain). The process network map follows later (R1).

## 5. What exists (2.0 workspace)

| Path | Content |
|---|---|
| `packages/contracts` | zod schemas, API resources, OpenAPI 3.1 (contracts-first routes) |
| `packages/client` | hey-api client generated from the OpenAPI document (drift test) |
| `packages/bpmn-facts` | C7/C8 fact extraction, hostile-XML protection, `FACTS_VERSION` |
| `packages/relations` | rule tier (unambiguous calls, key-tier proposals, findings), candidates for agents, 1.x baseline, pair assessor |
| `packages/procedures` | procedure texts (currently placeholder `proa-relations@0.0.1`) |
| `apps/server` | Hono server: domain (pure, dependency-cruiser enforced), Drizzle/PostgreSQL, REST `/api/v1`, MCP `/mcp` (stateless Streamable HTTP), local mode, agent tokens, pipeline, review |
| `apps/cli` | `proa health / status / import / seed / token create\|list\|revoke / mcp` (stdio bridge) |
| `apps/web` | projects, models, relations, findings, bpmn-js model view, upload, connect-an-agent, inbox, review screen |
| `apps/agent-sim` | LLM-free reference agent that works the pipeline over MCP |
| `eval/corpus` | test landscapes `nordwind-handel` (dev, 31 models, 17 C7/14 C8) and `stadtwerke-auental` (holdout, 26 models, 10 C7/16 C8) + `_sample`; every model deploys on Camunda 7.24.0 and 8.9.22 |
| `eval/tools` | spec format, BPMN generator with DI, validator, deploy check (`engines.compose.yaml`), `eval:candidates`, `eval:replay` |
| `eval/recordings`, `eval/reports` | recorded sim-agent submissions and generated reports |
| `eval/value-chains` | golden value chains + expected placements for both landscapes (M4) |
| `docker/` | `compose.yaml` (project `proa2`: PostgreSQL 17 on 127.0.0.1:55432, ProA on 127.0.0.1:7400) and `Dockerfile` |
| `.github/workflows/ci-2.yml` | 2.0 CI (path-filtered; 1.x workflows untouched) |

**Key metrics (eval, no LLM):**

| Landscape | Rule-tier precision | must_link among rules ∪ candidates | 1.x baseline recall / precision | Sim agent (proposals) P / R / F1 |
|---|---|---|---|---|
| nordwind-handel (dev) | 100 % (9/9) | 100 % (42/42) | 33.3 % / 66.7 % | 73.3 % / 78.6 % / 75.9 % |
| stadtwerke-auental (holdout) | 100 % (3/3) | 100 % (40/40) | 42.5 % / 65.4 % | 64.0 % / 80.0 % / 71.1 % |

The sim agent is the **baseline the M3 LLM procedure has to beat** (especially precision: it
links generic reused message names and cannot find semantic DE/EN links).

## 6. Run and verify

```sh
pnpm install
pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test   # server tests use Testcontainers (Docker)
pnpm eval:candidates && pnpm eval:replay
docker compose -p proa2 -f docker/compose.yaml up -d --build --wait     # ProA on http://127.0.0.1:7400
docker compose -p proa2 -f docker/compose.yaml exec proa proa seed      # loads both landscapes
docker compose -p proa2 -f docker/compose.yaml exec proa proa status
```

Details (tokens, Claude Code/Desktop configuration, simulation agent, troubleshooting) are in
`docs/proa-2/DEVELOPMENT.md`. Optional Camunda engines for the test landscapes:
`cd eval/tools && pnpm engines:up && node deploy-check.mjs ../corpus/nordwind-handel --keep`
(Cockpit http://localhost:18080/camunda, Operate http://localhost:18088/operate, demo/demo).

**Machine state at handoff (owner's Mac):** the `proa2` stack is running, both landscapes are
seeded and processed by the sim agent (nordwind: 9 accepted, 48 proposed, 28 of 31 models waiting
for review; stadtwerke: 3 accepted, 52 proposed, 20 of 26 models waiting for review) and wait for
the owner's review. The eval engines (`proa-eval-engines-c7-1`, `-c8-1`)
are running with nordwind deployed. An owner key from a source-run dev server exists in
`~/.local/state/proa/owner-key`; the container's owner key lives in volume `proa2_proa-state`.

## 7. Next steps

### M3 – `relations` procedure and live agents (next)

1. Write the real procedure (`packages/procedures`, `proa-relations@0.1.0`): how to read the claim
   input, judge candidates (event-definition compatibility, subprocess scope, DE/EN semantics,
   transliteration, generic names), when to ask a question instead of proposing, rationale and
   evidence format, **language of rationales/questions** (the UI is German; decide and document),
   no-link reasons, submission size. Delivered via MCP prompt `work_pipeline`, `get_procedure`,
   server instructions; the Claude Code plugin skill (`plugins/proa/skills/relations/SKILL.md`)
   is generated from the same text with a CI drift check (CONCEPT §7).
2. Reference setups in `examples/agents/`: interactive Claude Code, Claude Desktop config,
   headless `claude -p` with `--strict-mcp-config --tools ""`, an Agent SDK worker (documented,
   not shipped in the image).
3. A **step-by-step guide for the owner** (~30 minutes): create a token, connect Claude Desktop
   and/or Claude Code, run `work_pipeline` on `nordwind-handel`, review the proposals; how the
   recordings are captured for `eval:replay`; then the same on `stadtwerke-auental` (holdout).
4. `eval:live` scoring of the owner's runs (stored submissions →
   `eval/recordings/<procedure>@<version>/<agent>/<model>/<landscape>.jsonl`), compared with the
   sim baseline. Live gate (CONCEPT §7): no `must_not_link` at confidence ≥ 0.8. CONCEPT §7 plans
   the live runs with an `agent-sdk` worker on a pinned model; decision 13 replaces that with the
   owner's own Claude Desktop/Code runs, so update §7 accordingly.

### M4 – value chain (after M3)

Follow `docs/proa-2/M4-VALUE-CHAIN.md` (slices S0–S6, ~4 weeks): S0 switches
`eval/value-chains/validate-value-chains.mjs` from the local sibling checkout to the npm package
(add the pinned version to `VERIFIED_SCHEMA_MODEL`, today only `0.1.0`; the schema-model source is
identical in 0.1.0, 0.2.0 and 0.3.0), then storage, **placements** (ProA's term for a process in a
step; `assignment` is the modeler's org-unit connection), the `placement` pipeline kind, MCP
tools, UI with the embedded modeler, `eval:placements`. Ask the owner the open questions of that
document (§11) first.

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
| Supersession scope | An agent submission withdraws its earlier live proposals for that model that it does not repeat (decisions stay, versions move). Keep? | M2 backend/e2e |
| `correct` on a typed pair | Correcting towards a pair that already has a key-tier proposal creates a second, manual relation. Offer "accept the existing proposal instead"? | M2 e2e |
| Revoking a token | Revoking now withdraws that token's open proposals (CONCEPT §6). Confirm. | M2 fix |
| Message-name matching | Names match ignoring separators (`Zahlung_Eingegangen` = `ZahlungEingegangen`). Confirm. | M1 relations |
| Local session | `POST /api/v1/session` is open to any local process (fine single-user, not on shared machines). Add a one-time login link later? | M1 integrate |
| Value chain version | Pin `@miragon/value-chain-*` at 0.2.0 (decision 14) or at 0.3.0 (same code, released later the same day)? | npm, 2026-10-08 |
| Value chain | Six questions with defaults: archived copies (`@outside` vs. superseded flag), one home step per process, step renames send placements to re-confirm, org units as owners vs. performers, one vs. several chains per project, kinds by colour until a step category exists. | M4-VALUE-CHAIN.md §11 |

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
