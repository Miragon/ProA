# ADR-0001: Keycloak (OIDC) replaces the homegrown authentication in web mode

- Status: **accepted** (2026-06-11)
- Deciders: Dominik Horn
- Related: `docs/IMPROVEMENTS.md` (June 2026 review), ADR-0002

## Context

ProA web mode currently ships a self-built identity stack: password storage and
bcrypt verification, login lockout, login/register rate limiting (bucket4j), JWT
issuing (`TokenService` + smallrye-jwt with self-managed RSA keys via
`generate-keys.sh`), and a hand-rolled `ManageUsers` UI.

The June 2026 security review demonstrated the cost of owning this layer:

- the JWT audience was **never verified** (config key typo `mp.jwt.verify.audience`
  vs `audiences`) — found only by an adversarial review;
- the auth toggle defaulted to **fail-open** (`app.mode` default `desktop` = auth off);
- lockout policy lived in a repository class; default `admin`/`admin` credentials;
- a private signing key had been committed to the repository.

Independent of bugs, the stack is feature-incomplete with no realistic path to
parity: no password reset, no e-mail verification, no MFA, no SSO, and 24h
access tokens without refresh.

Desktop mode is single-user and intentionally unauthenticated; it is out of scope.

## Decision

Use **Keycloak** as the identity provider for web mode, integrated via standard
OIDC:

1. **Backend**: `quarkus-oidc` (bearer-only / `service` application type)
   verifies Keycloak-issued tokens. Realm roles `User`/`Admin` map to the
   existing `@RolesAllowed` / `@RolesAllowedIfWebVersion` checks
   (`realm_access/roles` claim). The entire issuing side is **deleted**:
   `TokenService`, `AuthenticationResource` (login/register), lockout logic,
   login/register rate limiting, `AdminInitializer`, RSA key management.
2. **Local user provisioning**: a request-scoped `CurrentUserService` resolves
   the authenticated identity (e-mail/subject claim) to a `UserTable` row,
   creating it on first login and syncing the role from the token. Application
   code consumes `CurrentUserService.getUserId()` instead of parsing a custom
   `userId` claim. This is also the first step toward the `CurrentUser`
   abstraction from the architecture roadmap.
3. **Authorization stays in the application.** Keycloak authenticates and
   provides coarse roles; project membership (OWNER/COLLABORATEUR,
   `ProjectAccessService`) remains domain logic and is unchanged.
4. **Frontend**: Authorization Code Flow + PKCE via `oidc-client-ts`
   (public client `proa-frontend`). Sign-in/registration/password
   management move to Keycloak (login page, registration flow, account
   console). The custom SignIn/CreateAccount/ChangePassword UI is removed.
5. **Local development**: Keycloak runs via docker-compose
   (`make auth-up`, port 8181) with an imported `proa` realm
   (`scripts/keycloak/proa-realm.json`) including dev users. Backend dev in
   web mode therefore requires Docker; desktop mode keeps working without it.
6. **Tests** stay hermetic and container-free: the test profile verifies
   tokens against the checked-in test public key (`quarkus.oidc.public-key`),
   with tokens signed by the existing test private key.

## Consequences

Positive:
- Brute-force protection, refresh tokens, password reset, e-mail verification,
  MFA and SSO become configuration instead of code.
- Significant net code deletion (issuing, lockout, rate limiting, key
  generation, admin seeding) and removal of an entire bug class.
- `ManageUsers` shrinks to local profile data; user/credential administration
  happens in the Keycloak admin console.

Costs / risks:
- One more service to operate (dev: compose; prod: hosting decision required —
  Azure Container Apps or a managed offering. Until provisioned, the
  `claude/keycloak-auth` branch must not be deployed).
- Production rollout prerequisites: Keycloak instance + realm, Web App env
  config (`QUARKUS_OIDC_AUTH_SERVER_URL`), redirect URIs for the deployed
  origins. Existing users are not migrated automatically (current production
  user base is effectively the seeded admin; if real users exist, use
  Keycloak's user import).
- E-mail becomes Keycloak-owned (read-only in the app's profile dialogs).
- Deleting a user in `ManageUsers` removes only the local row; Keycloak account
  deletion happens in the console (follow-up: Keycloak Admin API integration).

## Alternatives considered

- **Keep the homegrown stack**: rejected — the review found exploitable defects
  in exactly this layer, and parity (reset/MFA/SSO/refresh) is months of work.
- **Microsoft Entra External ID**: least ops on Azure, but vendor lock-in and
  weaker fit for an open-source tool that others self-host. Keycloak is the
  de-facto standard in the Camunda ecosystem ProA lives in.
- **Auth0/SaaS**: pricing and data-residency concerns for consulting clients.
