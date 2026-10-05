# ADR-0002: Extract a framework-free diagram core; consolidate on diagram-js

- Status: **accepted** (2026-06-11) — implementation starts after ADR-0001
- Deciders: Dominik Horn
- Related: `docs/UI-MIGRATION.md`, `docs/ARCHITECTURE.md`, ADR-0001

## Context

ProA should also ship as a **VS Code extension** (view BPMN models and the
derived process landscape directly in the workspace). Today that is impossible
without carrying the whole stack:

1. The UI ships **two diagram ecosystems**: bpmn-js (BPMN detail view — which
   already embeds diagram-js) and JointJS (`@joint/core` +
   `@joint/layout-directed-graph`) for the process map. The JointJS map is the
   largest build chunk (~570 kB) and has its own interaction/theming model.
2. **Relation detection lives in the backend** (Java `BpmnOperations` +
   SQL `levenshtein` via the PostgreSQL `fuzzystrmatch` extension, with an
   H2 fallback path). A VS Code extension has neither Quarkus nor PostgreSQL.
3. BPMN itself is **not** in question: BPMN semantics (call activities, message
   flows, data stores, events) are exactly what ProA derives its value from.
   The process map, however, is *not* BPMN — it is a custom node/edge diagram.

## Decision

1. **Keep BPMN as the domain/input format** and keep bpmn-js for rendering BPMN
   models. The product derives the landscape from BPMN semantics; that stays.
2. **Consolidate all diagram rendering on the diagram-js foundation.** Port the
   process map from JointJS to a custom diagram-js implementation (renderer,
   element factory, rules; auto-layout via **elkjs** — dagre is effectively
   unmaintained). bpmn-js and the map then share one stack, one interaction
   model, one theming story; `@joint/*` is removed.
   - Persisted JointJS graph layouts (`graphByProject` in the Pinia store)
     become invalid; we accept a one-time layout reset (the layouts are
     recomputable) rather than writing a migration.
3. **Create a framework-free core package** (yarn workspace `packages/`):
   - `@proa/diagram-core`: the diagram-js map editor + BPMN viewer wiring, no
     Vue/Vuetify/shadcn dependencies; thin adapters live in the web app
     (Vue) and in the VS Code extension (webview).
   - `@proa/relations`: a TypeScript implementation of the relation detection
     (parsing via `bpmn-moddle`, fuzzy label matching via a Levenshtein
     library), with a **data-access port**: REST adapter (web app) and
     workspace adapter (VS Code: scan `.bpmn` files).
4. **Dual implementations are kept honest by a shared conformance suite**, not
   by sharing code across languages: golden BPMN fixtures + expected relations
   as JSON, executed against both the Java backend and `@proa/relations`.
   The existing backend test BPMN resources are the seed for this suite.
5. **VS Code extension** (`packages/vscode-extension`): webview hosting
   `@proa/diagram-core`, fed by the workspace adapter of `@proa/relations`.
   Distribution via the VS Code Marketplace.

## Sequencing

After the Keycloak migration (ADR-0001), to avoid two structural initiatives
moving the frontend at once:

1. Workspace scaffolding + conformance fixture suite (extracted from backend
   test resources, validated against the Java implementation).
2. `@proa/relations` in TS until the conformance suite is green.
3. JointJS → diagram-js port of the map inside `@proa/diagram-core`; web app
   consumes it through the Vue adapter.
4. VS Code extension + marketplace publishing.

Each step is independently shippable; the web app never depends on an
unfinished extension.

## Consequences

Positive: one diagram stack (bundle −~400 kB on the map view), an extractable
and publishable core, relation detection becomes portable and DB-independent
(long-term option: drop the SQL `levenshtein`/`fuzzystrmatch` dependency by
computing relations in application code at upload time).

Costs / risks: diagram-js is lower-level than JointJS (custom renderer/rules
work, ~1 week for the port); duplicated detection logic in Java and TS (bounded
by the conformance suite); the persisted-layout reset on the map.

## Alternatives considered

- **JointJS in the extension too**: keeps the port cost at zero but doubles the
  shipped diagram stacks forever and adds ~570 kB to the webview; rejected.
- **Sharing detection logic via one language** (e.g. running the TS lib inside
  the backend, or GraalVM polyglot): operationally exotic for what is a small,
  stable algorithm; conformance tests are cheaper.
- **Generic diagramming without BPMN**: rejected — deriving the landscape from
  BPMN semantics *is* the product.
