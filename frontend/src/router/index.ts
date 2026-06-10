// Composables
import {
  createRouter,
  createWebHistory,
  RouteLocationNormalized,
  START_LOCATION
} from "vue-router";
import { useAppStore } from "@/store/app";
import { Role } from "@/components/ProcessMap/types";

const routes = [
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
        path: "SignIn",
        name: "SignIn",
        component: () => import("@/views/SignInView.vue"),
        meta: { requiresGuest: true, requiresWebVersion: true }
      },
      {
        path: "ManageUsers",
        name: "ManageUsers",
        component: () => import("@/views/ManageUsersView.vue"),
        meta: {
          requiresAuth: true,
          requiresAdmin: true,
          requiresWebVersion: true
        }
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

router.beforeEach((to, from) => {
  const store = useAppStore();
  const isLoggedIn = store.getUserToken() != null;
  const isAdmin = store.getUserRole() === Role.ADMIN;
  const isWebVersion = import.meta.env.VITE_APP_MODE === "web";

  store.snackbar.visible = false;

  if (to.meta.requiresWebVersion && !isWebVersion) {
    return cancelNavigation(from);
  }

  if (to.meta.requiresAdmin && !isAdmin) {
    return cancelNavigation(from);
  }

  if (to.meta.requiresGuest && isLoggedIn) {
    return cancelNavigation(from);
  }

  if (to.meta.requiresAuth && isWebVersion && !isLoggedIn) {
    return { name: "SignIn" };
  }

  return true;
});

export default router;
