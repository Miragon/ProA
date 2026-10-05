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

## Migration status — COMPLETE

Vuetify has been fully removed; the entire app runs on shadcn-vue + Tailwind v4.

| Area | Components | Status |
|------|------------|--------|
| Sign-in / registration / passwords | Keycloak hosted pages (ADR-0001) | ➖ out of scope |
| OIDC callback | `views/SigninCallbackView.vue` | ✅ shadcn |
| Auth dialogs | `Authentication/*` (AuthenticationDialog, ProfileDialog, EditProfileDialog) | ✅ shadcn |
| User management | replaced by project invitations (ADR-0003) | ➖ see ADR |
| App shell | `layouts/default/*` (Default, AppBar, View), `SettingsDrawer` | ✅ shadcn (Sheet/DropdownMenu) |
| Home / projects | `Home/*` (2) | ✅ shadcn |
| Process list | `ProcessList/*` (2) | ✅ shadcn |
| Process map chrome | `ProcessMap/*` (Toolbar/Sidebar/Legend/NavigationButtons) | ✅ shadcn |
| Process map canvas | `ProcessMap.vue` JointJS paper | ⬜ still JointJS — replaced by diagram-js in ADR-0002 |
| Process model | `ProcessModel/*`, `ProcessDetailDialog.vue` | ✅ shadcn (bpmn-js viewer kept) |
| Camunda import | `CamundaCloudImport/*` | ✅ shadcn |
| Page not found | `PageNotFound/*` | ✅ shadcn |
| Snackbar/feedback | `vue-sonner` (`ui/sonner`, driven by `store.showSnackbar`) | ✅ done |

## Removal checklist — DONE

- [x] No `v-`/Vuetify usages left in `src/` (only `shadcn.css` comment mentions it historically)
- [x] Removed `vuetify`, `vite-plugin-vuetify`, `@mdi/font`, `webfontloader`,
      `roboto-fontface`, `@types/webfontloader`, `sass` from package.json; deleted
      `src/plugins/vuetify.ts`, `webfontloader.ts`, `src/styles/settings.scss`, `global.css`
- [x] Replaced `v-app`/`v-main`/`v-navigation-drawer` in `layouts/` with a flex shell + Sheet
- [x] Tailwind Preflight enabled in `src/styles/shadcn.css` (`preflight.css` in `layer(base)`;
      utilities kept unlayered + `tw:`-prefixed — see the file comment)

### Optional follow-up cleanups (not blocking)

- Canonicalize `shadcn.css` to `@import "tailwindcss" prefix(tw);` (re-verify specificity if you
  also move utilities into `layer(utilities)`).
- The `tw:z-[2400]` overrides on portaled components (dialog/select/dropdown/tooltip/sheet) were
  needed to out-stack the Vuetify app bar; with Vuetify gone they could revert to `tw:z-50`.
- Process map: `setTimeout(fitToScreen, 1)` doesn't auto-center a single isolated node on first
  load (manual fit works) — best addressed in the diagram-js renderer extraction (ADR-0002).
