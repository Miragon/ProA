# ADR-0003: Project invitations replace in-app user management

- Status: **accepted** (2026-06-11)
- Deciders: Dominik Horn
- Related: ADR-0001 (Keycloak), `docs/ARCHITECTURE.md`

## Context

After ADR-0001, Keycloak owns registration, credentials, password reset and
profile data. What remains in the app is a leftover of the homegrown era:

- A `ManageUsers` view backed by three `@RolesAllowed({"Admin"})` endpoints
  (list/patch/delete local users) — the **only** thing the global `Admin` role
  still gates in the entire application.
- Local editing of first/last name (`EditProfileDialog`, `EditUserDialog`),
  although `CurrentUserService` already syncs identity data from token claims.
- A contributor flow (`addContributor`) that throws if the invitee has never
  logged in — i.e. you cannot invite anyone who doesn't already use ProA.

User lifecycle is identity-provider domain. The application's actual domain
need is **project membership**: getting people into projects.

## Decision

1. **Remove in-app user management.** Delete the `ManageUsers` view, the
   admin-only user endpoints, `EditUserDialog`, and local profile editing
   (`EditProfileDialog`). The profile dialog stays read-only with the existing
   "Manage account" link to the Keycloak account console. User administration
   (rename, disable, delete, roles) happens in the Keycloak admin console.
2. **Local `UserTable` rows become pure read-caches**: the identity anchor for
   project membership and settings, plus display names for member lists.
   `CurrentUserService` syncs e-mail/first/last name and role from the token on
   every login (it already does role; names are completed).
3. **Retire the application-level `Admin` role.** With user management gone,
   nothing in the app consumes it; authorization is project-scoped
   (OWNER/COLLABORATEUR) plus authentication. The realm role may stay defined
   in Keycloak for future needs, but the app stops branching on it
   (`requiresAdmin` route meta, AppBar gating, `Role` plumbing where unused).
4. **Introduce project invitations** (the one genuinely missing capability):
   - `ProjectInvitationTable`: invited e-mail (normalized), project, project
     role, invited-by, created-at; unique per (e-mail, project).
   - "Invite member" (project owners): if a local user with that e-mail exists,
     create the membership immediately (today's behavior); otherwise store a
     pending invitation.
   - On first login, `CurrentUserService` provisioning resolves all pending
     invitations for the user's e-mail into memberships and deletes them.
   - Owners see pending invitations in the project detail view and can revoke
     them.
   - No Keycloak Admin API coupling: the app stays IdP-agnostic; invitees who
     don't have an account yet simply register via Keycloak.

## Consequences

- Net code deletion again (view, dialogs, endpoints, role plumbing); the
  domain boundary becomes crisp: **identity = Keycloak, membership = ProA**.
- Invitations work for people who never used ProA — previously impossible.
- No invitation e-mails are sent by the app (out of scope; the inviter shares
  the link). Follow-up option: notification e-mails.
- **Offboarding caveat**: deleting a user in Keycloak leaves the local cache
  row and memberships behind (they merely stop being usable). Documented as
  accepted; follow-up option: Keycloak event listener or scheduled
  reconciliation for cleanup.
- Desktop mode is unaffected (no users, no memberships UI changes there).

## Alternatives considered

- **Keycloak Admin API integration** (search users, send action e-mails):
  tighter coupling, needs a privileged service account, and still doesn't
  model *project* membership — rejected.
- **Keep ManageUsers as read-only directory**: little value over the project
  member lists; keeps the Admin-role machinery alive for nothing — rejected.
