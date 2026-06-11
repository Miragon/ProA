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
2. **All Tailwind utilities are prefixed: `tw:flex`, `tw:bg-primary`,
   `tw:hover:bg-primary/90`** (prefix first, variants after). Reason: Vuetify
   ships unlayered `!important` utilities with the same names (`.border`,
   `.rounded-lg`, runtime theme `.bg-primary`) that would otherwise win.
   `components.json` sets `"prefix": "tw"`, so regenerated components come out
   prefixed. The utilities are also imported *unlayered* on purpose (Vuetify's
   element reset would beat layered rules).
3. **New/changed UI goes shadcn-first.** Only patch Vuetify views for bugs.
4. Use semantic tokens (`tw:bg-background`, `tw:text-muted-foreground`,
   `tw:bg-primary`) — never raw color utilities. The primary token is mapped to
   the existing brand blue.
5. Components live in `src/components/ui/` (generated via
   `npx shadcn-vue@latest add <name>`; do not hand-edit them, regenerate).
   **Known exceptions to re-apply after regenerating:**
   - `button/Button.vue`: `export interface Props` (Options-API consumers fail
     vue-tsc TS4023 under `composite: true` without it).
   - Portaled layers use `tw:z-[2400]` instead of `tw:z-50` so they stack above
     Vuetify's app bar/overlays (z ≈ 1000–2000): dialog (Overlay/Content/
     ScrollContent), select Content, dropdown-menu Content/SubContent, tooltip
     Content, sheet Overlay/Content. Drop these overrides together with the
     Vuetify removal.
6. `cn()` from `@/lib/utils` for conditional classes; `tw:flex tw:gap-*`
   instead of `space-*`; icons from `@lucide/vue`.

## Migration status

| Area | Components | Status |
|------|------------|--------|
| Sign-in / registration / passwords | Keycloak hosted pages (ADR-0001) | ➖ out of scope |
| OIDC callback | `views/SigninCallbackView.vue` | ✅ shadcn |
| Auth dialogs | `Authentication/*` (AuthenticationDialog, ProfileDialog, EditProfileDialog) | ✅ migrated |
| User management | being replaced by project invitations (ADR-0003) | ➖ see ADR |
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
- [ ] Switch `src/styles/shadcn.css` to `@import "tailwindcss" prefix(tw);`
      (enables preflight; optionally drop the prefix in a follow-up rename)
- [ ] Revert the `tw:z-[2400]` overrides in the portaled ui components to
      `tw:z-50` (no Vuetify layers left to out-stack)
- [ ] Delete `src/styles/settings.scss`
