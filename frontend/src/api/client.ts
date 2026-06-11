import axios from "axios";

declare module "axios" {
  export interface AxiosRequestConfig {
    /**
     * Set to true to skip attaching the Authorization header and the
     * automatic 401 handling (e.g. for the login request itself).
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

apiClient.interceptors.response.use(
  (response) => response,
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
      // Close any open auth dialog so it does not linger on the sign-in page.
      store.setSelectedDialog(SelectedDialog.NONE);

      const { default: router } = await import("@/router");
      if (router.currentRoute.value.name !== "SignIn") {
        await router.push({ name: "SignIn" });
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
