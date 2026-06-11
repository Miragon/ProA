/**
 * OIDC configuration values shared between the oidc-client-ts wrapper
 * (src/auth/oidc.ts) and plain UI code (e.g. the link to the Keycloak
 * account console). This module intentionally has no oidc-client-ts
 * import so desktop mode never pulls in the OIDC machinery.
 */
export const oidcAuthority: string =
  import.meta.env.VITE_OIDC_AUTHORITY ?? "http://localhost:8181/realms/proa";

export const oidcClientId: string =
  import.meta.env.VITE_OIDC_CLIENT_ID ?? "proa-frontend";

/** Keycloak account console of the realm (profile, password, sessions). */
export const accountConsoleUrl = `${oidcAuthority}/account`;
