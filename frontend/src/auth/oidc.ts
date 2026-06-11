import { User, UserManager, WebStorageStateStore } from "oidc-client-ts";
import { oidcAuthority, oidcClientId } from "@/auth/config";
import { useAppStore } from "@/store/app";
import { Role } from "@/components/ProcessMap/types";

/**
 * Thin wrapper around oidc-client-ts for the Keycloak Authorization Code
 * Flow + PKCE used in web mode (see ADR-0001). Desktop mode must never
 * import this module: it is only ever loaded via dynamic import behind
 * `import.meta.env.VITE_APP_MODE === "web"` checks.
 *
 * The wrapper pushes the current access token and realm role into the
 * Pinia app store, which stays the single source the axios interceptor
 * reads. oidc-client-ts itself persists the session in sessionStorage.
 */
const userManager = new UserManager({
  authority: oidcAuthority,
  client_id: oidcClientId,
  redirect_uri: `${window.location.origin}/signin-callback`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  scope: "openid profile email",
  response_type: "code",
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.sessionStorage })
});

/** Decodes the base64url-encoded JWT payload of the access token. */
const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "="
  );
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};

/** Maps the Keycloak realm roles claim to the application role. */
const toRole = (accessToken: string): Role => {
  let roles: string[] = [];
  try {
    const realmAccess = decodeJwtPayload(accessToken).realm_access as
      | { roles?: string[] }
      | undefined;
    roles = realmAccess?.roles ?? [];
  } catch {
    // Malformed token: fall through to the default role.
  }
  return roles.includes(Role.ADMIN) ? Role.ADMIN : Role.USER;
};

/** Pushes the session (or its absence) into the app store. */
const applyUser = (user: User | null) => {
  const store = useAppStore();
  if (user && !user.expired) {
    store.setUserToken(user.access_token);
    store.setUserRole(toRole(user.access_token));
  } else {
    store.setUserToken(null);
    store.setUserRole(null);
  }
};

// Guards against competing redirects (e.g. a sign-out racing watchers that
// trigger the router guard's sign-in): the first redirect wins.
let redirectInFlight = false;

const redirectOnce = async (redirect: () => Promise<void>): Promise<void> => {
  if (redirectInFlight) {
    return;
  }
  redirectInFlight = true;
  try {
    await redirect();
  } catch (error) {
    redirectInFlight = false;
    throw error;
  }
};

/** Starts the Authorization Code Flow by redirecting to Keycloak. */
export const signinRedirect = (): Promise<void> =>
  redirectOnce(() => userManager.signinRedirect());

/** Completes the flow on /signin-callback and stores the session. */
export const handleSigninCallback = async (): Promise<User> => {
  const user = await userManager.signinRedirectCallback();
  applyUser(user);
  return user;
};

/** Clears the local session and redirects to the Keycloak logout. */
export const signoutRedirect = (): Promise<void> =>
  redirectOnce(() => userManager.signoutRedirect());

/** Returns the current session, or null when signed out. */
export const getUser = (): Promise<User | null> => userManager.getUser();

let initialized = false;

/**
 * Loads an existing session from sessionStorage into the app store and
 * subscribes to oidc-client-ts events so token renewals and sign-outs
 * keep the store in sync. Idempotent; called from the router guard.
 */
export const initAuth = async (): Promise<void> => {
  if (initialized) {
    return;
  }
  initialized = true;

  userManager.events.addUserLoaded((user) => applyUser(user));
  userManager.events.addUserUnloaded(() => applyUser(null));
  userManager.events.addUserSignedOut(() => applyUser(null));
  userManager.events.addAccessTokenExpired(() => applyUser(null));

  applyUser(await userManager.getUser());
};
