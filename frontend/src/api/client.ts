import axios from "axios";

declare module "axios" {
  export interface AxiosRequestConfig {
    /**
     * Set to true to skip attaching the Authorization header and the
     * automatic 401 handling.
     */
    skipAuth?: boolean;
  }
}

/**
 * Single axios instance for all backend calls. The Vite dev server proxies
 * "/api" to the backend; in production the app is served same-origin.
 */
const apiClient = axios.create({ baseURL: "/api" });

// The store and the router are imported lazily inside the interceptors to
// avoid circular imports (router -> store -> ... -> api -> router) and to
// make sure pinia is installed before the store is first used.
apiClient.interceptors.request.use(async (config) => {
  if (config.skipAuth) {
    return config;
  }
  const { useAppStore } = await import("@/store/app");
  const token = useAppStore().getUserToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect-loop breaker for the 401 interceptor below: if signing in at
// Keycloak does not stop the 401s (e.g. a clock-skewed token or a broken
// backend), blindly redirecting again would bounce the user between the
// app and Keycloak forever. The marker survives the redirect because it
// lives in sessionStorage.
const AUTH_REDIRECT_MARKER_KEY = "proa.auth.401-redirect";
const AUTH_REDIRECT_MIN_INTERVAL_MS = 30_000;
const AUTH_REDIRECT_MAX_ATTEMPTS = 2;

interface AuthRedirectMarker {
  lastAttemptAt: number;
  attempts: number;
}

const readAuthRedirectMarker = (): AuthRedirectMarker | null => {
  const raw = sessionStorage.getItem(AUTH_REDIRECT_MARKER_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AuthRedirectMarker;
  } catch {
    return null;
  }
};

const mayRedirectToSignin = (): boolean => {
  const marker = readAuthRedirectMarker();
  if (!marker) {
    return true;
  }
  return (
    Date.now() - marker.lastAttemptAt >= AUTH_REDIRECT_MIN_INTERVAL_MS &&
    marker.attempts < AUTH_REDIRECT_MAX_ATTEMPTS
  );
};

const recordSigninRedirectAttempt = (): void => {
  const marker = readAuthRedirectMarker();
  sessionStorage.setItem(
    AUTH_REDIRECT_MARKER_KEY,
    JSON.stringify({
      lastAttemptAt: Date.now(),
      attempts: (marker?.attempts ?? 0) + 1
    } satisfies AuthRedirectMarker)
  );
};

apiClient.interceptors.response.use(
  (response) => {
    // Any successful response proves auth works again: re-arm the breaker.
    sessionStorage.removeItem(AUTH_REDIRECT_MARKER_KEY);
    return response;
  },
  async (error: unknown) => {
    const isWebVersion = import.meta.env.VITE_APP_MODE === "web";
    if (
      isWebVersion &&
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !error.config?.skipAuth
    ) {
      const { useAppStore, SelectedDialog } = await import("@/store/app");
      const store = useAppStore();
      store.setUserToken(null);
      store.setUserRole(null);
      // Close any open auth dialog so it does not linger after the redirect.
      store.setSelectedDialog(SelectedDialog.NONE);

      // Send the user to Keycloak to sign in again - except while the
      // OIDC callback itself is being processed or when the loop breaker
      // trips: then reject and let the UI surface the error instead.
      if (
        window.location.pathname !== "/signin-callback" &&
        mayRedirectToSignin()
      ) {
        recordSigninRedirectAttempt();
        try {
          const { signinRedirect } = await import("@/auth/oidc");
          await signinRedirect();
        } catch {
          // Never mask the original 401: the caller must receive it even
          // when starting the redirect itself fails.
        }
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
