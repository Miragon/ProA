# ProA

ProA is a tool that lets you manage your processes and their connections smoothly. It detects relations among the
processes and shows them in a diagram.

## Quickstart (local development)

Prerequisites: JDK 21+, Node 22 + Yarn 1.x, Docker (only for PostgreSQL parity), `openssl`.

```bash
make setup       # one-time: git hooks, JWT keys, frontend dependencies
make backend     # terminal 1: Quarkus dev mode on :8080 (H2 in-memory)
make frontend    # terminal 2: Vite dev server on :3000 (proxies /api to :8080)
```

Open http://localhost:3000 — in web mode the default user is `admin` / `admin`.

Run `make help` for all targets (tests, lint, db management, full build).

### PostgreSQL parity (optional)

Production uses PostgreSQL with the `fuzzystrmatch` extension (levenshtein-based fuzzy
matching of BPMN labels). H2 dev mode falls back to exact matching. To develop against
the real thing:

```bash
make db-up       # PostgreSQL 17 on localhost:5433 with fuzzystrmatch enabled
make backend-pg  # Quarkus dev mode against that database
```

`make db-reset` wipes the data volume.

## Web or desktop mode

ProA runs in one of two modes:

- **web** — multi-user with JWT authentication (default).
- **desktop** — single user, no authentication.

Switch the mode for development with `cd frontend && yarn mode [web|desktop]`.
This sets `VITE_APP_MODE` in `frontend/.env` and `app.mode` in
`backend/src/main/resources/application-dev.properties` (both are tracked-file
edits for the backend side — don't commit them accidentally). The production
profile always stays `app.mode=web`; released desktop jars get their mode from
the `desktop` profile instead.

For a released jar, use the dedicated desktop artifact (`pro-a-*-desktop.jar` from the
release page — the database kind is fixed at build time in Quarkus, so the regular web
jar cannot be switched to H2 at runtime):

```bash
java -Dquarkus.profile=desktop -jar pro-a-*-desktop.jar    # data stored in ~/.proa
```

### JWT keys (web mode only)

`make setup` generates them. Manually: `./backend/generate-keys.sh` (requires openssl).
Keys are gitignored; never commit them.

## Building the entire application

```bash
mvn clean package
```

builds the frontend (Node/Yarn are pinned and downloaded by the build), copies it into
the Quarkus app, and produces an uber jar under `backend/target/`. Run it with
`java -jar backend/target/pro-a-*.jar`.

## Quality gates

| Gate | What runs |
|------|-----------|
| pre-commit hook | ESLint + Prettier on staged frontend files (fast) |
| pre-push hook | backend `mvnw verify` and/or frontend lint + type-checked build, depending on what changed |
| CI (PRs) | `Backend Tests` and `Frontend Checks` workflows |

Hooks live in `.githooks/` and are activated by `make setup`
(`git config core.hooksPath .githooks/`).

Frontend commands (in `frontend/`): `yarn lint` (fix), `yarn lint:check`, `yarn format`,
`yarn format:check`, `yarn type-check`, `yarn build`.
Backend coverage: `cd backend && ./mvnw verify` → report under `backend/target/jacoco-report/`.

## Architecture & docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system overview, layering, roadmap
- [docs/UI-MIGRATION.md](docs/UI-MIGRATION.md) — Vuetify → shadcn-vue migration status and rules
- [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) — June 2026 platform review: what changed and what's still open

The UI is migrating to [shadcn-vue](https://www.shadcn-vue.com/) (Tailwind v4 + Reka UI).
New UI goes shadcn-first; see the migration doc for the ground rules.

## Configuring settings

Settings can be configured by clicking the settings icon in the top right corner of the app.

`Gemini API Key` is used to generate process model descriptions with AI.

Camunda Modeler `Client ID` and `Client Secret` are used to retrieve process models from the Camunda Web Modeler.

Camunda Operate `Client ID`, `Client Secret`, `Region ID` and `Cluster ID` are used to fetch active process instances.

## Backend details (Quarkus)

Dev UI in dev mode: http://localhost:8080/q/dev/.

### Native executable

H2 is not supported in native mode; configure an external DB
(https://github.com/quarkusio/quarkus/issues/27021).

```bash
./mvnw package -Dnative                                        # with GraalVM installed
./mvnw package -Dnative -Dquarkus.native.container-build=true  # via container
```

More: https://quarkus.io/guides/maven-tooling
