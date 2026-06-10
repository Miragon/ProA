# ProA Architecture

This document describes the current architecture, the target architecture, and the
roadmap between the two. It was created as part of a comprehensive platform review
(June 2026); see `docs/IMPROVEMENTS.md` for what was changed in that review.

## System overview

```
┌────────────────────────┐      /api (REST, JWT)      ┌─────────────────────────────┐
│  Frontend (Vue 3)      │ ─────────────────────────► │  Backend (Quarkus)          │
│  Vite · Pinia · i18n   │                            │  REST → Usecases → Repos    │
│  bpmn-js · JointJS     │                            │  Hibernate ORM              │
└────────────────────────┘                            └────────────┬────────────────┘
                                                                   │
                              PostgreSQL (prod, fuzzystrmatch) / H2 (dev, tests)
```

Two runtime modes (`app.mode`):
- **web** — multi-user, JWT authentication, role + project-membership authorization.
- **desktop** — single user, no authentication.

## Backend layering (de.envite.proa)

```
rest/          JAX-RS resources (transport only)
usecases/      application services + port interfaces (e.g. ProjectRepository,
               ProcessOperations) — MUST NOT import repository.tables.*
repository/    port implementations, DAOs (EntityManager), JPA entities (tables/)
entities/      transport/domain objects (currently double as REST DTOs)
bpmn/          BPMN parsing; implements the usecases.ProcessOperations port
camundacloud/  Camunda Cloud import (REST clients + import usecase)
security/      @RolesAllowedIfWebVersion interceptor (no-ops in desktop mode)
authservice/   JWT issuing (TokenService)
startup/       admin user provisioning
```

The ports-and-adapters skeleton is genuinely in place: usecases define interfaces,
repository implements them, dependency direction is almost entirely correct.

### Known deviations from the target (roadmap items)

| # | Deviation | Why it matters | Suggested move |
|---|-----------|----------------|----------------|
| 1 | Business logic (login lockout, owner checks, replace-semantics) lives in repository impls; usecases are mostly pass-throughs | Logic is invisible at the usecase level and hard to test without a DB | Move rule-like logic into usecases step by step whenever a feature is touched; repositories shrink to persistence |
| 2 | `app.mode` web/desktop branching is duplicated through every layer (doubled method stacks) | Every feature costs twice; easy to forget the web-mode auth variant (this caused the IDOR bug) | Introduce a `CurrentUser` abstraction (web: from JWT; desktop: a fixed local user). One code path; authorization becomes data, not control flow |
| 3 | Tenancy key ambiguity: `projectId` means `ProjectTable` id on `/project` endpoints but `ProjectVersionTable` id almost everywhere else | Repeated source of confusion and bugs | Rename path params and Java parameters to `projectVersionId` where that is what they are (transport-compatible: URL shape can stay) |
| 4 | Transport objects in `entities/` double as REST DTOs and as domain objects | API shape is coupled to domain evolution | Acceptable at current size; introduce dedicated request/response records only where the API needs to diverge |
| 5 | Manual mapping scattered across static mappers and private methods | Inconsistent, repetitive | Consolidate per feature into one mapper class; consider MapStruct only if the team wants the dependency |
| 6 | `quarkus-hibernate-orm-panache` is declared but unused (hand-written DAOs) | Misleading dependency | Either adopt Panache repositories or drop the dependency |
| 7 | EAGER `@ManyToOne` on connection tables + per-row recursive lookups on the process-map path | N+1 queries on the hottest read path | Switch to LAZY + fetch joins in the map queries; measure with Hibernate statistics in dev |
| 8 | Schema managed by `hibernate-orm.database.generation=update` in prod | Unreviewed, irreversible DDL at deploy time | Introduce Flyway with a baseline migration; switch generation to `validate` |

## Frontend structure (frontend/src)

```
views/ + router/   thin route shells with auth guards
components/        feature components (ProcessMap, ProcessList, Home, Auth, ...)
services/          API access (axios) — being consolidated into a typed client layer
store/             Pinia (persisted to sessionStorage)
locales/ + i18n.ts en/de translations
plugins/           Vuetify, Pinia, fonts
```

### Known deviations from the target (roadmap items)

| # | Deviation | Suggested move |
|---|-----------|----------------|
| 1 | The Pinia store is a persisted god-object (it even stores serialized JointJS graphs per project) | Split into `auth`, `ui`, `processMap` stores; persist only what must survive a reload |
| 2 | Types/services exported from `.vue` files (e.g. `ProjectOverview.vue` exports types) create circular imports | Move shared types to `src/types/`, shared logic to composables |
| 3 | Gemini (`@google/generative-ai`) is called directly from the browser with an API key fetched from the backend | Proxy the call through the backend; the key must never reach the client. Until then, treat the feature as trusted-environment-only |
| 4 | UI framework: Vuetify (default theme) | Target: shadcn-vue (Reka UI + Tailwind v4). Strangler-fig migration; see `docs/UI-MIGRATION.md` |

## Build & deployment

- `mvn clean package` at the root builds the frontend (frontend-maven-plugin pins
  Node/Yarn), copies the Vite output into the Quarkus uber jar, and produces a
  single deployable artifact.
- GitHub Actions: PR checks (backend tests, frontend lint/type/build) and a
  deploy workflow that builds a Docker image and deploys to Azure Web Apps.
- Local development: `make setup`, then `make backend` (H2) or
  `make db-up && make backend-pg` (PostgreSQL incl. `fuzzystrmatch`), plus
  `make frontend`. See README.
