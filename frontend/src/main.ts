/**
 * main.ts
 *
 * Bootstraps Vuetify and other plugins then mounts the App`
 */

// Styles
import "@/styles/shadcn.css";

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
