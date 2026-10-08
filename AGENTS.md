# Agent instructions for this repository

This repository is in transition from **ProA 1.x** (Quarkus `backend/`, Vue `frontend/`, Maven) to
**ProA 2.0** (TypeScript pnpm workspace in `apps/`, `packages/`, `eval/`, `docker/`). The 2.0
work happens on branch `claude/proa-2` (draft PR #2).

**Start here:** read `docs/proa-2/HANDOFF.md` (current status, owner decisions, open questions,
next steps), then `docs/proa-2/CONCEPT.md` and `docs/proa-2/DEVELOPMENT.md`.

Rules that always apply:

- Talk to the owner in German; write code and repository docs in English.
- Do not modify the 1.x tree (`backend/`, `frontend/`, `pom.xml`, `mvnw*`, `.mvn/`, `Dockerfile`,
  `eclipse-formatter.xml`, `Makefile`, `scripts/`, `docker-compose.yml`, `.githooks/`, the 1.x
  workflows) until the cut-over PR described in CONCEPT §9.
- Never use `pkill`, `killall` or `kill` by pattern; stop only processes you started. Never stop or
  change Docker containers outside the compose projects `proa2*` (the owner runs other containers
  on this machine).
- Exact dependency versions only (pnpm 11, Node 24). Follow the conventions in DEVELOPMENT.md
  (contracts-first routes, pure domain layer enforced by dependency-cruiser, `policy.require` in
  every use case).
- Agents never decide relations; humans do. ProA holds no LLM credentials.
- Run all gates before claiming something works: `pnpm format:check`, `pnpm -r typecheck`,
  `pnpm -r lint`, `pnpm -r test`, `pnpm eval:candidates`, `pnpm eval:replay`.
- Commit and push to `claude/proa-2` are allowed; merging into `develop` needs the owner's
  explicit OK.
