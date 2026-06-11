// Composables
import {
  createRouter,
  createWebHistory,
  RouteLocationNormalized,
  START_LOCATION
} from "vue-router";
import { useAppStore } from "@/store/app";

const routes = [
  {
    // OIDC redirect target (web mode): rendered without the default layout
    // and exempt from the auth guard so the callback can be processed.
    path: "/signin-callback",
    name: "SigninCallback",
    component: () => import("@/views/SigninCallbackView.vue"),
    meta: { requiresWebVersion: true }
  },
  {
    path: "/",
    component: () => import("@/layouts/default/Default.vue"),
    children: [
      {
        path: "",
        name: "ProjectOverview",
        // route level code-splitting
        // this generates a separate chunk (about.[hash].js) for this route
        // which is lazy-loaded when the route is visited.
        component: () => import("@/views/Home.vue"),
        meta: { requiresAuth: true }
      },
      {
        path: "CamundaCloudImport",
        name: "CamundaCloudImport",
        component: () => import("@/views/CamundaCloudImportView.vue"),
        meta: { requiresAuth: true }
      },
      {
        path: "ProcessView/:id",
        name: "ProcessView",
        component: () => import("@/views/ProcessView.vue"),
        meta: { requiresAuth: true }
      },
      {
        path: "ProcessList",
        name: "ProcessList",
        component: () => import("@/views/ProcessListView.vue"),
        meta: { requiresAuth: true }
      },
      {
        path: "ProcessMap",
        name: "ProcessMap",
        component: () => import("@/views/ProcessMapView.vue"),
        meta: { requiresAuth: true }
      },
      {
        path: ":pathMatch(.*)*",
        name: "PageNotFound",
        component: () => import("@/views/PageNotFoundView.vue"),
        meta: { requiresAuth: true }
      }
    ]
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

/**
 * Cancels a forbidden navigation: stays on the current route when there is
 * one, otherwise (e.g. direct URL entry) falls back to the project overview.
 */
const cancelNavigation = (from: RouteLocationNormalized) =>
  from === START_LOCATION ? { name: "ProjectOverview" } : false;

router.beforeEach(async (to, from) => {
  const store = useAppStore();
  const isWebVersion = import.meta.env.VITE_APP_MODE === "web";

  store.snackbar.visible = false;

  if (to.meta.requiresWebVersion && !isWebVersion) {
    return cancelNavigation(from);
  }

  // The OIDC redirect callback must stay reachable while signed out.
  if (to.name === "SigninCallback") {
    return true;
  }

  if (isWebVersion) {
    // Lazy import: desktop mode must never load the OIDC machinery.
    const { initAuth, signinRedirect } = await import("@/auth/oidc");
    // Restores an existing Keycloak session from sessionStorage into the
    // store (no-op after the first navigation).
    await initAuth();

    if (to.meta.requiresAuth && store.getUserToken() == null) {
      await signinRedirect();
      return false;
    }
  }

  return true;
});

export default router;
