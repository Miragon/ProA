# ProA 2.0 – Milestone M1 "Skeleton"

Status: in progress · Branch: `claude/proa-2` · Spec: [CONCEPT.md](CONCEPT.md), [ADR-0004](../adr/0004-proa-2-headless-landscape-store.md)

M1 is the first runnable slice of ProA 2.0: start it locally, load a test landscape, see the
facts and rule-based relations, and connect Claude Code or Claude Desktop over MCP to ask
questions about the landscape. The 1.x tree (`backend/`, `frontend/`, Maven) stays untouched
next to it until the cut-over PR (CONCEPT §9).

## In scope

1. **Workspace.** pnpm workspace at the repo root (`apps/*`, `packages/*`, `eval/tools`),
   Node 24, strict TypeScript, ESM, exact dependency versions, vitest, ESLint flat config,
   Prettier, dependency-cruiser (domain imports none of db/http/mcp/auth),
   `docker/compose.yaml` (PostgreSQL 17 + ProA), a 2.0 CI workflow that does not touch the
   1.x workflows.
2. **`packages/contracts`.** zod schemas shared by server, client and web: refs, fact kinds,
   relation types, tiers, statuses, API resources; OpenAPI 3.1 generated from them.
3. **`packages/bpmn-facts`.** Fact extraction per CONCEPT §2 for Camunda 7 and 8 BPMN
   (bpmn-moddle + camunda/zeebe moddle), `key_norm`, `fingerprint`, `scope`, `event_def`,
   `FACTS_VERSION`, hostile-XML rejection and limits.
4. **`packages/relations`.** Rule tier (unambiguous call → accepted by `proa-rules/1.0.0`;
   identical message/signal names → `key`-tier proposals; findings `unresolved-call`,
   `dynamic-call`, `duplicate-process-id`, `dangling-throw`, `unmatched-catch`), candidate
   generation for agents (normalization with transliteration, token Jaccard + relative
   Levenshtein, DE/EN stopwords, event-definition compatibility, subprocess scoping), and
   `baseline-proa1` (the 1.x algorithm) for comparison.
5. **Eval gate `eval:candidates`** (no LLM) over `eval/corpus/*`: rule-tier precision 1.0,
   ≥ 98 % of `must_link` pairs among candidates, findings match, report vs `baseline-proa1`.
6. **`apps/server`.** Hono + `@hono/zod-openapi`, Drizzle + PostgreSQL, the full CONCEPT §2
   schema (tables for later milestones may stay unused), domain use cases with
   `policy.require(actor, permission, projectId)`, ingest as one transaction (facts, rules,
   relation assertions, `endpoint_state`, analysis task queued, events), REST
   `/api/v1` read + ingest/import endpoints, MCP `/mcp` (stateless Streamable HTTP) with the
   read tools `list_projects`, `list_processes`, `get_process`, `get_model_xml`,
   `get_relations`, `which_processes_use`, `find_unlinked_events`, `get_procedure` (stub).
7. **Local mode** (`PROA_AUTH=local`): bind 127.0.0.1, Host/Origin checks, the web UI acts as
   the owner, MCP and REST bearer calls use agent tokens (`proa_at_…`, hashed, one project,
   scopes, expiry, revocation).
8. **`proa` CLI** (`apps/cli`): `proa import <dir> --project <key>`, `proa token create`,
   `proa mcp` (stdio bridge for Claude Desktop), `proa seed` (loads the eval landscapes).
9. **`apps/web`.** React 19 + Vite + Tailwind v4 + shadcn: projects, models with stage,
   relations table with tier/status/provenance, findings, a bpmn-js viewer that highlights
   relation endpoints, and a "connect an agent" page that creates a token and prints
   configurations for Claude Code and Claude Desktop.
10. **Docs.** `docs/proa-2/DEVELOPMENT.md`: start, seed, connect Claude Code/Desktop, test.

## Out of scope for M1 (next milestones)

M2: analysis pipeline (claim/submit/release), agent proposals, review verdicts
(accept/reject/hold/correct), decision memory UI. M3: `relations` procedure, reference
agents, live eval runs with several agents, `eval:replay`. M4: value chain
(Wertschöpfungskette, [M4-VALUE-CHAIN.md](M4-VALUE-CHAIN.md)). The inbox and review screen moved
into M2; the process network map and server mode (OIDC) follow in R1.

## Defaults assumed (owner may override)

- Auto-accept only unambiguous calls (CONCEPT §2).
- "Vormerken" = note + optional question/label, no assignee (M2).
- `LICENSE` unchanged, all packages `private: true`, nothing published to npm.
- Local mode only; no IdP in M1.
