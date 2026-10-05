/**
 * main.ts
 *
 * Registers plugins then mounts the App.
 */

// Styles
import "@/styles/shadcn.css";
// vue-sonner ships its CSS separately and does no runtime style injection;
// without this the toaster (store.showSnackbar -> toast) renders unstyled.
import "vue-sonner/style.css";

// Components
import App from "./App.vue";

// Composables
import { createApp } from "vue";

// Plugins
import { registerPlugins } from "@/plugins";

import i18n from "./i18n";

const app = createApp(App);

registerPlugins(app);

app.use(i18n);

app.mount("#app");
