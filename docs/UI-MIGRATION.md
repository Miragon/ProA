# UI migration: Vuetify → shadcn-vue

The frontend is migrating from Vuetify to [shadcn-vue](https://www.shadcn-vue.com/)
(Reka UI primitives + Tailwind v4) using a strangler-fig approach: both systems
coexist, views are migrated one by one, and Vuetify is removed once nothing uses
it anymore.

## Ground rules during coexistence

1. **Tailwind preflight stays off** until Vuetify is gone — it would reset
   Vuetify's global styles. See the comment in `src/styles/shadcn.css`.
   Consequence: in migrated views, do not rely on preflight resets; shadcn
   components bring their own classes and work fine without it.
2. **New/changed UI goes shadcn-first.** Only patch Vuetify views for bugs.
3. Use semantic tokens (`bg-background`, `text-muted-foreground`, `bg-primary`)
   — never raw color utilities. The primary token is mapped to the existing
   brand blue.
4. Components live in `src/components/ui/` (generated via
   `npx shadcn-vue@latest add <name>`; do not hand-edit them, regenerate).
5. `cn()` from `@/lib/utils` for conditional classes; `flex gap-*` instead of
   `space-*`; icons from `@lucide/vue`.

## Migration status

| Area | Components | Status |
|------|------------|--------|
| Sign-in | `SignIn/SignIn.vue` | ✅ migrated |
| Auth dialogs | `Authentication/*` (5 dialogs) | ✅ migrated |
| User management | `ManageUsers/*` (2) | ✅ migrated |
| App shell | `layouts/default/*`, `AppBar.vue` | ⬜ Vuetify |
| Home / projects | `Home/*` (2) | ⬜ Vuetify |
| Settings drawer | `SettingsDrawer.vue` | ⬜ Vuetify |
| Process list | `ProcessList/*` (2) | ⬜ Vuetify |
| Process map | `ProcessMap/*` (7, JointJS-heavy) | ⬜ Vuetify |
| Process model | `ProcessModel/*`, `ProcessDetailDialog.vue` | ⬜ Vuetify |
| Camunda import | `CamundaCloudImport/*` | ⬜ Vuetify |
| Page not found | `PageNotFound/*` | ⬜ Vuetify |
| Snackbar/feedback | Vuetify `v-snackbar` (global) | ⬜ replace with `sonner` at the end |

## Removal checklist (last step)

- [ ] No `v-` component usages left (`grep -r "v-btn\|v-card\|v-dialog" src/`)
- [ ] Remove `vuetify`, `vite-plugin-vuetify`, `@mdi/font`, `webfontloader`,
      `roboto-fontface` from package.json and `src/plugins/`
- [ ] Replace `v-app`/layout wrappers in `layouts/`
- [ ] Switch `src/styles/shadcn.css` to the full `@import "tailwindcss";`
      (enables preflight)
- [ ] Delete `src/styles/settings.scss`
