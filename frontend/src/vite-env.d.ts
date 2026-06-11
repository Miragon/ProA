/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "web" (auth, multi-user) or "desktop" (single user, no auth). */
  readonly VITE_APP_MODE?: string;
  /** OIDC issuer (Keycloak realm URL); web mode only. */
  readonly VITE_OIDC_AUTHORITY?: string;
  /** OIDC client id of the public (PKCE) frontend client; web mode only. */
  readonly VITE_OIDC_CLIENT_ID?: string;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
