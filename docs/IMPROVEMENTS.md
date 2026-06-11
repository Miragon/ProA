# Platform review, June 2026 — what changed and what's still open

Everything below happened on the branch `claude/platform-improvements` (autonomous
overnight session, 2026-06-10/11). Nothing was pushed. Suggested reading order:
this file → `git log develop..HEAD` → `docs/ARCHITECTURE.md` → `docs/UI-MIGRATION.md`.

## TL;DR

| Area | Before | After |
|------|--------|-------|
| Backend toolchain | Quarkus 3.8.3 (3/2024), did not compile on local JDK 25 | Quarkus 3.27.4 LTS, Lombok 1.18.46, JaCoCo 0.8.15; 358 tests green |
| Frontend toolchain | Vue 3.3, Vite 4, ESLint 8 (weakest rule set), axios with CVEs, version ranges | Vue 3.5, Vite 7, TS 5.9, ESLint 9 flat (`vue3-recommended`), all versions pinned |
| Guardrails | Hooks never ran and never failed; no frontend CI | Working pre-commit/pre-push hooks, frontend CI, Dependabot |
| Local setup | 6+ manual steps, hand-installed Postgres + extension | `make setup` + `make backend` + `make frontend`; dockerized PG 17 with fuzzystrmatch |
| Security | IDOR on all process endpoints, XSS, committed private key, fail-open auth default, no XML hardening | Fixed (details below) |
| Architecture | Non-atomic multi-step flows, JPA leak into usecases, per-endpoint try/catch | Transactions, port decoupling, exception mappers; roadmap in ARCHITECTURE.md |
| UI | Vuetify, default theme | shadcn-vue foundation + first migrated wave (sign-in, auth dialogs, user management), verified in the running app |

## Security fixes (verified by tests)

1. **IDOR**: process-model/process-map/Camunda-import endpoints never checked project
   membership — any authenticated user could read/delete/import into foreign projects
   by guessing ids. Now enforced via `ProjectAccessService` (+ 59 tests incl. 403/404
   cross-user cases).
2. **XSS**: delete-confirmation dialog rendered user-controlled project/version names
   via `v-html`. Now escaped via `<i18n-t>` slots.
3. **Fail-open auth**: `app.mode` defaulted to `desktop` (= auth off) when the property
   was missing. Defaults flipped to `web` (fail closed); web-mode 401/403 paths now have
   real test coverage (they previously had none — all tests ran in desktop mode).
4. **JWT**: tokens were signed without the `aud` claim the verifier requires.
5. **XXE**: BPMN XML parsing hardened (no DTDs/external entities); uploads containing
   DOCTYPE are rejected with a clear 400.
6. **Committed private key**: `backend/src/main/resources/rsaPrivateKey.pem` removed
   from the index and ignored.
7. Bean Validation on registration; loud startup warning when default admin
   credentials are active in web mode; sensitive `.env` files are deny-listed for
   tooling; SQL logging off in prod.

## ⚠️ Action required (couldn't be fixed from here)

1. **Rotate the JWT keypair.** `rsaPrivateKey.pem` is still in git *history* (and in
   every previously built jar). If this pair was ever used in production, treat it as
   compromised: regenerate keys, redeploy, consider a history rewrite (`git filter-repo`).
2. **Gemini API key reaches the browser.** `@google/generative-ai` runs client-side
   with a key fetched in plaintext from `/api/settings` (and `VITE_*` fallbacks get
   baked into the bundle). Real fix: proxy the Gemini call through the backend.
   Until then, treat the feature as trusted-environments-only.
3. **Dev and prod share one Azure Postgres server/login**, separated only by the
   `STAGE` schema — the dev app can read/write prod data with the same `proaadmin`
   account. Split databases/logins; move the JDBC URL into per-environment Web App
   config (`QUARKUS_DATASOURCE_JDBC_URL`).
4. **Default admin credentials** (`admin`/`admin`) are seeded in web mode. Change them
   in any real deployment (the app now warns loudly at startup).
5. Settings secrets (Gemini/Camunda) are stored **in plaintext** in the database.

## Known trade-offs / deliberate decisions

- **Vuetify and shadcn-vue coexist** (strangler fig). Tailwind's preflight is off and
  its utilities are deliberately *unlayered* (Vuetify ships an unlayered CSS reset that
  would otherwise beat every utility — see commit 3395a68). Both quirks resolve
  themselves when Vuetify is removed.
- **No Flyway yet**: prod schema is still `hibernate generation=update`. After the big
  ORM jump (6.4 → 6.6+), watch the first deploy closely. Introducing Flyway with a
  baseline is the top roadmap item (ARCHITECTURE.md #8).
- `vue-i18n` runs in deprecated legacy mode (`$t` options API). Migration to
  composition mode is mechanical but touches 21 files — roadmap.
- The `yarn mode web|desktop` script still rewrites backend properties files (wart;
  roadmap: `CurrentUser` abstraction removes the mode duplication entirely).
- Audit findings that remain open are tracked in `docs/ARCHITECTURE.md` roadmap tables
  (anemic usecases, N+1 on the process map, tenancy-key naming, god-store split, …).

## Verification status

- Backend: `./mvnw verify` — 358 tests green (baseline at branch start: suite didn't
  even compile locally; after compile fix: 265 green / 64 skipped equivalents).
- Frontend: `yarn lint:check` (0 problems), `yarn format:check`, `yarn build`
  (vue-tsc + Vite) — green.
- Full `mvn clean package` (uber jar incl. frontend) — green.
- Manual E2E (Playwright, against `quarkus:dev` + `yarn dev`): login (`admin`/`admin`
  in dev), project overview, ManageUsers table, profile + change-password dialogs —
  all functional in the migrated shadcn UI; unauthenticated API access returns 403.
- A multi-agent adversarial review of the full branch diff ran at the end of the
  session; confirmed findings were fixed (see final commits).
