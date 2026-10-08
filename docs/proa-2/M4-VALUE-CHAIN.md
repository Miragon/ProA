# ProA 2.0 – Milestone M4 "Value chain"

Status: proposed (2026-10-08, revised after review) · Branch: `claude/proa-2` · Spec: [CONCEPT.md](CONCEPT.md) §2, §3, §5–§7 · Previous: [M2-PIPELINE-REVIEW.md](M2-PIPELINE-REVIEW.md) · Golden data: [eval/value-chains](../../eval/value-chains/README.md) · Modeler: `Miragon/value-chain-modeler` (MIT)

M4 puts the classic process landscape map ("Prozesslandkarte") on top of the processes: one
value chain per project (Wertschöpfungskette, ARIS value-added chain diagram), edited in the
embedded value chain modeler, and **placements** (step → process) with the same lifecycle as
relations. The owner draws and saves the chain; agents propose placements; the owner decides.
M4 requires M2 (pipeline, review) and consumes `@miragon/value-chain-schema-model` and
`@miragon/value-chain-renderer` from npm. It ships in two parts: **M4a** (chain, placements
proposed ad hoc, review, eval) and **M4b** (the `placement` pipeline kind and the draft
prompt).

M1-SKELETON.md still names M4 "full v1 UI (inbox, review screen, landscape map)". That plan is
superseded: M2 delivers inbox and review, the landscape map is R1, and M4 is the value chain,
as M2's out-of-scope list says.

"Placement" avoids a clash: in the `.vc.json` format, an `assignment` connection links an org
unit to a step. ProA keeps upstream's names (`orgUnit`, `assignment`) for parsed elements.

## 1. Purpose

| Level | Content | In ProA | Example (`nordwind-handel`) |
|---|---|---|---|
| 0 | Top-level chain: 4–8 core steps toward the customer, plus management and support steps | value chain, top-level steps | Beschaffung → Lagerhaltung → Vertrieb → Versand → Fakturierung & Zahlung → Kundenservice; support: Rechnungswesen, Zentrale Dienste, … |
| 1–2 | Sub-steps via `hierarchy` | same document | Vertrieb: Auftragseingang, Auftragsabwicklung, Bonitätsprüfung, Partnermanagement |
| process | BPMN processes, placed on the most specific step | models, `process` facts, placements | `vertrieb/order-handling#Process_OrderHandling` → Auftragsabwicklung |

Called subprocesses and shared services are processes like any other: each gets its own home
step (`lager/kommissionierung` → Kommissionierung, `finanzen/briefversand` → Zentrale
Dienste). Accepted `call` relations add a roll-up view ("reached by call"), never a placement.

The chain answers what the relation graph cannot: which processes realise a step, which steps
have no process, which processes belong nowhere, and how a flow such as order-to-cash crosses
teams. Model key folders mirror departments, not the value stream: `finanzen/kreditpruefung`
belongs to sales (Bonitätsprüfung), `lager/kommissionierung` to shipping,
`partner/customer-account-lock` to dunning. That is why a placement is judged and decided, not
derived.

## 2. Domain model

**Value chain** `vch_` with an immutable `key`, `name`, `head_revision_id` and `deleted_seq`.
M4 allows exactly one chain per project, key `main`; the column stays so that more chains
need no migration later (§11). Re-creating a deleted chain restores the same `vch_`.

**Revision** `vcr_`, immutable, stores canonical bytes:
`serializeDocument(loadDocument(input))` from schema-model (migration, zod, unique ids,
connection matrix; sorted ids and keys, 3-decimal rounding). The web serializes the same way,
so an unchanged save is a no-op via `content_hash`. `structure_hash` covers ids, types,
normalized names, links, connections and the derived kind of every step, not bounds,
waypoints or raw colour (the counterpart of `facts_hash`). A revision also records
`schema_version`, `base_revision_id` and its principal, always a human.

**ProA rules on top of schema-model** (422 `value-chain-invalid`, reasons per element):
≤ 1 MB, ≤ 500 elements, ≤ 1,000 connections; names ≤ 200 characters without control or bidi
characters; element ids ≤ 128 characters, never `vc-root` (reserved by the renderer, whose
importer skips it) and never starting with `@` (ProA's pseudo-steps); at most one `hierarchy`
parent per step, acyclic, depth ≤ 2; no two connections of the same type between the same
pair (either direction; the modeler's docs call them invalid, `validateDocument` does not
check); acyclic `sequence` edges. A `schemaVersion` newer than ProA's schema-model gives 422
`value-chain-unsupported-version`.

**Steps** are parsed from the head content on read (≤ 500 elements; cached per
`content_hash`), not stored per revision: element type, name, `name_norm` (as for facts),
`link`, `parent_id`, `depth`, `kind` and `rank`.
- **Kind.** The schema has no kind field. Top-level steps on a `sequence` chain are `core`;
  the others take their kind from the modeler's colour picker, purple `hsl(287, 65%, 44%)`
  `management` and green `hsl(150, 86%, 34%)` `support`, as in the golden chains; any other
  top-level step is `other`. Sub-steps inherit. A recolour that changes a kind changes
  `structure_hash`. An explicit step category upstream replaces the convention (§12).
- **Rank** is the topological position among siblings over `sequence` edges, ties by x, then
  y (a column of sub-steps shares x).
- **Identity** is the element id; ProA never rewrites ids. The modeler keeps ids across
  renames and moves, but its id generator restarts per instance (`shape_N`, probing only the
  current registry), so a step added in a later session can get a deleted step's id. ProA
  therefore (1) gives its Modeler collision-free ids (§4) and (2) keeps a generation per element
  id: a deleted id is tombstoned, and if it reappears it is a new generation whose old
  placements stay `missing`. Deleting the chain tombstones all its steps, so a re-created
  chain starts with new generations and revives no placements implicitly.
- `fingerprint = sha256(type|name_norm|parent_id)[:12]`: a change of case or umlaut spelling
  keeps the meaning, a rename or a new parent changes it.

**Placement** `plc_`: a process belongs to a step. Natural key
`(value_chain_id, element_id, generation, process_ref)` with
`process_ref = <model_key>#<process_id>` (CONCEPT §2), so each pool of a collaboration can sit
on its own step. The lifecycle is the relation lifecycle: assertions (`proposal`,
`withdrawal`, `decision`, `note`), verdicts `accept`, `reject`, `hold`, derived
`source_kind`, declared procedure and LLM model, `recomputeStatus` (generalised over the
subject, not copied), reopening when a new proposal arrives with a step or process
fingerprint that differs from the rejection's. Endpoint state: `ok`; `changed` (step or
process fingerprint differs from the one stored at the decision); `missing` (step generation
gone from the head, or process gone from the head facts). An accepted placement that is not
`ok` is an open item.

Separate tables, not a relation type: one endpoint is not a fact, and relation queries,
landscape ETag and findings stay untouched while M2 is still changing them. Shared: the
status function, the assertion columns, the review components.

**Multiplicity.** A step has any number of processes. A process has one home step, the most
specific one (the golden data and the procedure assume this); a reviewer may accept a second
step for a genuinely shared process. A parent step shows the roll-up of its subtree.
**Reached by call** (processes called through accepted `call` relations from a step's
processes) is computed and shown, never stored, and never replaces a placement: it does not
remove a process from agent inputs, findings or the eval.

**`@outside`** is a pseudo-step for "deliberately outside this chain", with the same
lifecycle and a required reason. Archived copies go there, with the current version named in
the reason (the golden choice, §11). Technical adapters normally sit on the step they serve;
`@outside` is acceptable for them.

**Tiers** are server-computed (CONCEPT §2), never sent: `key` for rule proposals (principal
`proa-rules`, confidence 1.0) when a step's `link` is `proa:process/<ref>` of the process or
its `name_norm` equals the process's; `lexical` for an agent proposal whose step is among the
top 3 of `baseline-prefix/1` for that process or shares a name stem with it (the derived
`name-match` rule of the golden README); `semantic` for every other agent proposal, including
`@outside`; `manual` for humans. Nothing is auto-accepted.

**The `link` field** is one opaque string per step (upstream: "opaque reference to a more
detailed model"), so ProA accepts any string ≤ 2,000 characters and never rewrites it. It
cannot hold several processes and has no lifecycle, so it is navigation only; the record is
the placement.

| `link` | Drill-down target |
|---|---|
| absent (default) | the ProA step view (§4) |
| `proa:process/<model_key>#<process_id>` | that process's model view; also yields a key-tier proposal |
| `http://…` or `https://…` | shown as text with an external link (`rel="noopener noreferrer"`, new tab) |
| anything else (e.g. `operations-detail` from the modeler's docs) | kept, shown as text, reported as `unresolved-link` |

A `proa:process/` link whose process does not exist is `unresolved-link` too. A pasted step
keeps its link (the modeler's copy/paste copies it), so a duplicated `proa:process/` link
yields one key-tier proposal per step, each decided on its own.

**Org units** are parsed and shown as **owners** of a top-level step (accountable area), not
as performers of each sub-step: picking runs in the warehouse but belongs to Versand, owned by
Logistik. Their connections are drawing content without a lifecycle. M4 does not pass them to
agents as evidence; matching them to `lane` facts is later work (§10).

```sql
value_chain(id, project_id, key, name, head_revision_id, deleted_seq, unique(project_id, key))
value_chain_revision(id, project_id, value_chain_id, rev, content, content_hash, structure_hash,
         schema_version, base_revision_id, principal_id, source_kind, seq,
         check(source_kind = 'human'))
value_chain_step(project_id, value_chain_id, element_id, generation, created_rev, deleted_rev,
         pk(value_chain_id, element_id, generation))              -- tombstones
placement(id, project_id, value_chain_id, element_id, generation, process_ref, status,
         endpoint_state, tier, confidence, version,
         unique(project_id, value_chain_id, element_id, generation, process_ref))
placement_assertion(<columns of relation_assertion>, step_fp, process_fp,
         check(not (kind = 'decision' and source_kind = 'agent')))
placement_input(value_chain_id, process_ref, input_hash, task_id, outcome, reason)   -- M4b
```

## 3. AI-first flows

### 3.1 Propose placements ad hoc (M4a)

Any MCP client with `proa:propose` works on the chain without a task:
`list_unplaced_processes` returns processes with no accepted placement and no live proposal,
including called ones, each with name, model key, lanes, up to 5 start and end labels,
documentation cut to 200 characters, relation neighbours with their accepted steps, calls in
both directions, and the top 3 `baseline-prefix/1` hints. `propose_placement` takes one or
more items:

```jsonc
{ "procedure": {"id": "proa-placements", "version": "0.1.0"}, "llmModel": "claude-sonnet-5-5",
  "placements": [
    {"step": "step-rechnungsstellung", "process": "finanzen/rechnungsstellung#Process_Rechnungsstellung",
     "confidence": 0.86, "rationale": "Starts when an order ships; invoices the customer.",
     "evidence": ["rel_…", "finanzen/rechnungsstellung#Start_WareVersandbereit"], "question": null},
    {"step": "@outside", "process": "einkauf/archiv/bestellfreigabe-2019#Process_Bestellfreigabe",
     "confidence": 0.9, "rationale": "Archived copy of einkauf/bestellfreigabe#Process_Bestellfreigabe.",
     "evidence": ["einkauf/bestellfreigabe#Process_Bestellfreigabe"]}] }
```

**Validation:** `step` is a step of the head revision or `@outside`; `process` is a `process`
fact of the head revisions; ≤ 3 live steps per process and principal; confidence in [0, 1];
rationale ≤ 1,000 and question ≤ 500 characters; ≤ 200 items; evidence items are fact refs,
`rel_` ids or `step:<element_id>`, and must exist. Each item comes back `applied`,
`duplicate`, `suppressed`, `reopened` or `invalid:<reason>`; payloads are stored verbatim.
`withdraw_placement_proposal` withdraws the caller's own live proposals.

### 3.2 The `placement` pipeline kind (M4b)

| Kind | Subject | Queued | Procedure |
|---|---|---|---|
| `relations` | model | M2, unchanged | `proa-relations` |
| `placement` | the value chain | no placement task is open, and some open process has an input hash that differs from its `placement_input` row (after a save with a new `structure_hash`, or an ingest that adds or changes processes); deletes never queue | `proa-placements@0.1.0` |

**Open processes** have no accepted placement and no held one. A process's **input hash**
covers its fingerprint, its neighbours' accepted steps, the chain's `structure_hash` and its
own placement assertions. `claim_analysis` gains `kinds?`, default `['relations']`, so M2
clients never receive a task they cannot handle; `work_pipeline` passes all kinds and loads the
procedure each claim names. Leases and submissions work as in CONCEPT §3.

**Claim input** (`proa-claim-placement/1`, rendered at claim time, ≤ ~100 KB): the chain
(steps with path, kind and rank; no geometry, no org units); up to 50 open processes whose
input hash changed since the last done task, each as in §3.1 plus its live agent proposals and
the human rejections, holds, notes and answers about it; up to 5 accepted placements per step
as examples; `truncated: true` when more remain.

**Submission:** `placements` (items as in §3.1, `@outside` included) and `unsure`
(`[{process, reason}]`). As in M2, a submission withdraws the live agent proposals of this
chain for processes in the task's input that it does not repeat. Every input process gets a
`placement_input` row with the input hash and the outcome (`proposed`, `unsure` with the
reason, or `skipped`), so it is not offered again until its input changes; the panel lists
"agent unsure" items. A follow-up task is queued only when the claim was `truncated`.

A save with a new `structure_hash` does **not** cancel a claimed task, so an editing session
never turns agent runs into 409 `task-cancelled`. Items are validated against the head at
submit time (`invalid:unknown-step` for a step deleted meanwhile); processes whose items were
invalid get no `placement_input` row and are offered again.

### 3.3 Drafting a chain (prompt only, M4b)

The MCP prompt `draft_value_chain` asks an interactive agent to write a `.vc.json` from the
landscape (`list_processes`, `get_landscape`, `get_value_chain`) following the modeler's own
`value-chain-modeling` skill and the conventions of the golden chains: steps named in the
language of most process names as 1–3 word noun phrases; 4–8 core steps left to right toward
the customer, management and support steps off the chain in their colours; follow end-to-end
relation paths instead of copying the department folders; depth ≤ 2, every parent ≥ 2
children; no links. The owner opens the file in the chain page (**Import** in edit mode),
edits and saves it like any revision, so the human is the author and no draft entity, task
kind with a project subject or server-side layout is needed. The page re-lays every connection
after import with `modeling.layoutConnection`, so the real `VcLayouter` routes it (upstream:
"rough waypoints are fine"). Placements then follow through §3.1 or §3.2.

### 3.4 Findings

Deterministic, recomputed on read, never blocking; returned by `get_value_chain` and
`…/findings`.

| Finding | When |
|---|---|
| `process-without-step` | a head process with no accepted placement (`@outside` counts); a live proposal shows as pending; if it is reached by call, the calling step is named as a hint |
| `step-without-process` | no accepted placement on the step or below it; reported once, at the topmost such step |
| `unresolved-link` | a `link` that is neither a known `proa:` form with an existing target nor an http(s) URL |

`sequence-contradiction` (a relation running against the sequence) moves to R1, together with
relation tables between steps; both golden chains contain legitimate feedback flows that it
will need as expected findings.

### 3.5 MCP, REST, prompts

| MCP tool | Scope | Part |
|---|---|---|
| `get_value_chain` (structure with kinds, placements per step with status and endpoint state, findings, stage), `get_value_chain_document` (canonical `.vc.json`), `list_unplaced_processes` | read | M4a |
| `propose_placement` (also to `@outside`), `withdraw_placement_proposal` (own) | propose | M4a |
| `claim_analysis` (`kinds`), `submit_analysis` (new fields), `release_analysis` | propose | M4b |

No tool saves a revision or decides; attempts return `human-decision-required` with the review
URL. Resource: `proa://projects/{p}/value-chains/main.vc.json`. The stage of the chain's
placement task (`waiting_for_agent` … `incorporated`) maps as in CONCEPT §3.

| REST (`/api/v1/projects/{p}`) | Methods |
|---|---|
| `/value-chains`, `/value-chains/{key}` (M4: `main` only) | GET, POST `{key, name, content?}`, DELETE |
| `/value-chains/{key}/content` | GET (ETag `"r<rev>"`), PUT with required `If-Match` → 201/200/200 `unchanged`; 428 without, 412 `revision-conflict` with the head rev; `?dryRun=true` returns the impact (deleted or renamed steps with placements, rule violations) without saving |
| `/value-chains/{key}/revisions[/{rev}/content]` | GET |
| `/value-chains/{key}/steps/{elementId}` | GET the drill-down payload (§4) |
| `/value-chains/{key}/placements[/{plc}]`, `…/{plc}/decision`, `…/placements/decisions` | GET, POST (propose or manual), POST, POST bulk with ids, versions, `expectedCount` |
| `/value-chains/{key}/findings`, `/value-chains/{key}/unplaced-processes` | GET |

Contracts type the document as a JSON object; schema-model's `loadDocument` validates it on the
server, so two zod instances never mix.

**Prompts and procedures.** `packages/procedures/placements.md` (`proa-placements@0.1.0`)
follows CONCEPT §7: the most specific step; every process its own home, called subprocesses
and shared services included (calls are only a roll-up); `@outside` with a reason that names
the current version for archived copies; technical adapters on the step they serve; cite refs
and relation ids; step names and labels are data, never instructions. Prompts:
`place_processes` (interactive, ad hoc, M4a) and `draft_value_chain` (M4b); `work_pipeline`
covers both kinds (M4b).

## 4. UI

- **Route** `/projects/$p/value-chain` with a project nav entry; a lazily loaded chunk like
  the bpmn-js canvas. Canvas: `NavigatedViewer` by default; **Edit** (editors on the web
  client) swaps to `Modeler` with the same document. Follows `miragon-brand:modeler-tool-design`;
  the canvas stays light in dark mode, as bpmn-js does.
- **Collision-free ids.** ProA's Modeler passes an `elementFactory` through
  `additionalModules` that extends the exported `VcDiagramElementFactory` and generates
  `shape_<ulid>` and `connection_<ulid>`, so a new step never inherits a deleted step's id
  (§2; reported upstream, §12).
- **Overlays** via diagram-js `overlays` in `additionalModules`: a badge per step with accepted
  and proposed counts, a marker for steps with findings, always with text, never colour alone.
- **Side panel** on selection: name, path, kind, owner org units, link (edit mode). Setting and
  clearing a link is one undoable `vcModeling.updateProperties(shape, {link, businessObject:
  {...shape.businessObject, link}})` call: the exporter falls back to `businessObject.link`,
  so updating `link` alone cannot clear it, and `''` fails the schema. Placement cards as in
  the M2 review screen (rationale, evidence, provenance, question; A/R/H; **correct** = accept
  the process on another step as `manual`); accepted ones with endpoint state and a bulk
  "re-confirm"; held; reached by call (display only); **Add process** (manual, accepted at
  once). The A/R/H shortcuts work in view mode, and in edit mode only while the side panel has
  focus: the Modeler binds H (hand tool), L, S, C and E on the canvas. Without a selection:
  findings, unplaced processes with a step picker, agent-unsure items (M4b), stage.
- **Save:** `exportDocument()` → `serializeDocument` → `PUT …/content?dryRun=true`; the confirm
  dialog lists deleted or renamed steps that have placements; then `PUT` with `If-Match`. A
  412 offers "load the newer revision" (the local copy downloads as `.vc.json`) or "keep
  editing"; no merging. Unsaved work survives reloads in `localStorage` per chain and base
  revision. **Import** (edit mode, M4b) loads a `.vc.json` and re-lays its connections (§3.3).
- **Drill-down:** double-click in view mode or **Open step** → `/…/value-chain/steps/$elementId`:
  breadcrumb, sub-steps, the step's processes (own, subtree, reached by call) linking to their
  model views. Relations between steps come with the landscape map (R1).
- **Viewers** get read-only canvas and panels. Playwright covers view, save, conflict, review,
  drill-down, link set and clear, a deleted and re-added step getting a fresh id, and the bpmn-js
  review screen after visiting the chain page (CSS, §5).

## 5. Packaging

- `apps/web` depends on `@miragon/value-chain-renderer` and `@miragon/value-chain-schema-model`,
  `apps/server` on schema-model only (DOM-free by the modeler's rule P1), all at the exact
  version of the **first published release** (the modeler's release-please PR currently
  prepares 0.2.0 for both, as linked versions). The domain code lives in
  `apps/server/src/domain/value-chain/`; the web uses schema-model directly and the server's
  `dryRun` for impact. No sixth package (CONCEPT principle 7).
- **diagram-js alignment by overrides.** The renderer pins `diagram-js` 15.18.1 and
  `diagram-js-direct-editing` 3.4.0; `bpmn-js` 18.31.0 in `apps/web` resolves 15.28.0 and 3.6.0;
  schema-model pins `zod` 4.4.3, ProA uses 4.6.5. Exact `overrides` in `pnpm-workspace.yaml`
  (`@miragon/value-chain-renderer>diagram-js: 15.28.0`,
  `@miragon/value-chain-renderer>diagram-js-direct-editing: 3.6.0`,
  `@miragon/value-chain-schema-model>zod: 4.6.5`) work today without an upstream change and are
  proven by the Playwright round trip. ProA does not ask for peer dependencies: the modeler's
  pin rule (enforced in CI) requires exact versions in `peerDependencies` too, an exact peer
  15.18.1 is not satisfied by 15.28.0, `apps/web` has no direct `diagram-js` dependency, so
  pnpm's auto-install-peers would install the duplicate anyway; a range would need an
  exception to that rule, not a release-day change.
- **CSS.** `@miragon/value-chain-renderer/assets/value-chain.css` (19 KB) inlines diagram-js
  15.18.1's `diagram-js.css` at build time; overrides do not change it. Imported in the lazy
  chunk, its `.djs-parent` variables and `.djs-*` rules are injected after bpmn-js's
  `diagram-js.css` (15.28.0, `--bio-*` tokens) at equal specificity and restyle the bpmn-js
  review canvases for the rest of the session. Upstream ask: a stylesheet without
  `diagram-js.css` (§12). Until it ships, a Playwright check of the review screen after the chain
  page shows the leak; small differences are accepted, visible ones are scoped in ProA's CSS.
- **CI.** Fails on `link:`, `file:`, `portal:` or tarball specifiers in any `package.json` or
  the lockfile. It asserts on the built bundle, not on dependency resolution (`shadcn` 4.21.2
  already resolves zod 3.25.76 for its CLI): one `diagram-js` copy and one zod v4 copy in the
  web chunks, and the chain chunk ≤ 40 KB gzip beyond shared diagram-js code (the renderer's
  `index.js` is 42 KB unminified). Dependabot groups bpmn-js with the renderer. Modeler needs go
  upstream as issues; ProA never patches or forks it.
- **Until the release is on npm**, work starts with the tables and the placement lifecycle,
  which need no package (§9); there is no tarball path.

## 6. Eval

`eval/value-chains/README.md` and `validate-value-chains.mjs` are the format authority; this
section only summarises them.

```
eval/value-chains/<landscape>/
  value-chain.vc.json            # golden chain, canonical serialization, no links
  expected-placements.yaml       # steps (id, name, kind, level, parent, scope) and every process
```

Per process: one `must` (a leaf step, or `@outside` for archived copies), `may` (tolerated
alternatives, neutral), `must_not` (named traps; a trap covers its subtree), tags, a one-line
rationale, and `superseded_by` for archived copies. `may` follows one written rule in both
landscapes (the steps of callers, the steps that start a cross-domain process, overlapping
scopes; never an ancestor of the must); the tags
`name-match`/`semantic`, `domain-prefix`, `ambiguous` and the kind tags are derived by the
validator. **Scoring:** the must is a hit; a may is neutral; an ancestor of the must is
`coarse` (reported, neither hit nor error); a step in a `must_not` subtree is an error and a
trap hit; any other step is a false positive (closed world). Recall runs over the
`(process, must)` pairs.

**`eval:placements`** (every PR, no LLM, `eval/reports/placements.{md,json}`) fails unless the
validator passes (importing the npm schema-model at the pinned version, the built-in copy as
cross-check), the golden chains pass the ProA rules, and the key-tier rule proposals computed
from them hit only `must` or `may`. It reports precision and recall@1/@3 of
`baseline-prefix/1` (key folders and process name tokens against step and ancestor names with
`@proa/relations` normalization, plus votes from neighbours' steps, leave-one-out) per tag, per
landscape, and separately at level 0 (the top-level area) and at the leaf. The holdout does not
exercise prefix bias (README), so prefix bias is read from the dev landscape. The baselines are
a floor, not a gate. **`eval:replay`** scores recorded placement submissions (M4b);
recordings keep the path `<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`, and their
lines name a chain revision instead of a model revision (§8). **Live** (by hand before a
procedure release, 3 runs): no `must_not` at confidence ≥ 0.8; recall at least 20 points
above `baseline-prefix/1`; chains drafted with the prompt are rated by the owner.
`proa seed --value-chains` loads golden chains without placements.

## 7. Export, events, permissions

**OKF (extends the R1 projection).** Tasks are never exported.

```
value-chains/main.vc.json                                   # head content, verbatim
value-chains/main.md                                        # type: Value Chain; kinds, step tree, owners, links to processes/*.md
placements/<element-id>--<process-id>--<hash8>.md           # type: Process Placement; proa: {state, tier, endpoint_state}
```

Status and trust fields map as for relations (CONCEPT §4); rejected placements are exported as
`deprecated`, so offline agents do not propose them again. `processes/*.md` gain
`proa.value_chain_steps`.

**Events:** `value_chain.created|revised|deleted`, `placement.proposed|decided|endpoint_changed`;
`analysis.*` payloads carry `kind` and subject (M4b).

| Capability | Scope | Min role | Principal |
|---|---|---|---|
| Read the chain, placements, findings | `proa:read` | viewer | any |
| Propose and withdraw own placements, claim, submit | `proa:propose` | editor | any |
| Create, save, import, delete the chain; decide placements; manual placements | `proa:review` | editor | user on an interactive client |

Agents never edit the chain; the DB checks back this up (`value_chain_revision.source_kind =
'human'`, no agent decisions in `placement_assertion`).

## 8. Changes to M2 contracts

1. **`SubmitAnalysisBody`** (M4b): `relations` becomes optional (default `[]`); new optional
   `placements` (≤ 200) and `unsure` (≤ 200); a field of the other kind gives 422
   `wrong-task-kind`. Flat optional fields instead of `oneOf`, because not every MCP client
   handles `oneOf` inputs.
2. **Claim result** (M4b): `{taskId, leaseToken, leaseUntil, kind, procedure, input}`, where
   `input` is today's relations input or `proa-claim-placement/1`, discriminated by `kind`.
   This is server output, which clients only read, and M2 clients never see the new shape
   because `kinds` defaults to `['relations']`.
3. **`analysis_task` migration** (M4b): `subject_kind` (`model` | `value_chain`),
   `value_chain_id`, `value_chain_revision_id`; `model_id` and `revision_id` become nullable,
   with a check that the subject columns match `subject_kind`; `facts_hash` is renamed
   `input_hash` (relations tasks keep the facts hash in it); the open-unique index becomes two
   partial unique indexes, `(model_id, kind)` for model tasks and `(value_chain_id, kind)` for
   chain tasks, instead of a `coalesce`; composite FKs for the chain subject. `model_pipeline`
   stays; a new `value_chain_pipeline` view gives the chain's stage.
4. **Recordings** (M4b): `RecordingLine` gains a `subject` (model revision or chain revision);
   `eval:replay` scores by kind.
5. **Status** (M4a): `recomputeStatus` is generalised over the subject (relation or
   placement), not copied; M2's tests stay unchanged and green.
6. **Snapshots** (M4a, M4b): `mcp-tools.json` and the contract tests gain the new tools and
   fields.

## 9. Slices

**M4a "Chain and placements"**

| Slice | Scope | Effort |
|---|---|---|
| S1 | tables and migration (`value_chain`, revisions, step generations, `placement`, `placement_assertion`); placement lifecycle with generalised `recomputeStatus`; needs no package | 2.5 d |
| S0 | consume the release once published: exact deps, overrides, CI guards (specifiers, bundle), schema-model round trip in Node, validator on the npm package, Playwright import check (zero warnings, stored waypoints equal `layouter.layoutConnection`) | 1 d |
| S2 | `domain/value-chain` (canonicalize, ProA rules, kinds, ranks, fingerprints, `structure_hash`, generations); REST with `If-Match` and `dryRun`; events; policy matrix; `proa value-chain push\|pull`; endpoint state on save and model ingest/delete; key-tier rule proposals; server tiers; decisions incl. bulk; read and propose MCP tools; findings; contract snapshots | 4 d |
| S3 | UI: page, viewer/modeler, collision-free ids, save with dry run and conflict, overlays, side panel, link editing, drill-down, Playwright incl. the CSS check | 5 d |
| S4 | `eval:placements`, `baseline-prefix/1`, report, `proa seed --value-chains` | 1.5 d |

**M4b "Pipeline and drafts"**

| Slice | Scope | Effort |
|---|---|---|
| S5 | task subject migration (§8), `placement` kind, claim input with per-process input hashes, submit fields, supersession, unsure memory, follow-ups, chain stage; `proa-placements` procedure, prompts `place_processes` and `draft_value_chain`, Import in the page; simulation agent policy for placements; recordings and `eval:replay` | 4.5 d |
| S6 | OKF extension (once the R1 export exists); `DEVELOPMENT.md` | 1 d |

About four weeks, M4a about three. **M4a is done when** the golden `nordwind-handel` chain
pushed with the CLI renders; an edit saves revision 2 and a concurrent save gets 412; a step
deleted and re-added in a new session gets a fresh id and no old placements; placements
proposed ad hoc over MCP and decided survive re-ingest and a layout-only re-save; the bpmn-js
review screen passes its check after visiting the chain page; `eval:placements` is green in
CI. **M4b is done when** the simulation agent works placement tasks over MCP (supersession,
unsure memory, follow-up only on truncation, no cancellation by saves); a chain drafted with
`draft_value_chain` in Claude Desktop is imported, edited and saved; `eval:replay` scores the
recorded runs.

## 10. Out of scope

The graphical process network (landscape map, R1), relation tables between steps and
`sequence-contradiction` (R1); several chains per project and `proa:chain/` or `proa:view/`
links; draft entities, project-subject tasks and server-side layout; org unit ↔ lane matching
and org units as agent evidence; auto-accepting placements; agents saving revisions; merging
concurrent edits or real-time co-editing; server-side SVG (the renderer needs a DOM; the UI
offers `saveSVG()` as a download); linked Git sync of `*.vc.json`; cross-project chains; KPIs on
steps; ARIS (AML) import; dismissing findings; changes to the modeler itself.

## 11. Open questions for the owner

1. **Archived copies:** `@outside` with the current version as the reason (default; the golden
   data use it), or the current step plus a "superseded" flag, which needs a new assertion
   field?
2. **Home step:** one home step per process as the norm, a second one only by a reviewer's
   decision (default), or strictly one?
3. **Step renames:** should a rename send accepted placements to "re-confirm" (default, bulk
   action), or is step identity the element id alone?
4. **Org units:** owners of top-level steps (default; shown, not agent evidence), or performers
   on sub-steps with lane matching soon (the golden chains would need org units on sub-steps)?
5. **Several chains per project**, e.g. utility vs grid subsidiary in `stadtwerke-auental`
   (unbundling): later, with project-wide coverage (a process needs a step in any chain or
   `@outside` once) and a roll-up defined first. Default for M4: one chain.
6. **Kinds by colour:** acceptable until the modeler has a step category (default), or should
   M4 wait for it?

## 12. Upstream asks

Filed as issues on `Miragon/value-chain-modeler` after the release; nothing here needs to change
the release in flight.

1. A stylesheet without `diagram-js.css` (e.g. `assets/value-chain-only.css`, the consumer
   imports `diagram-js.css` itself): the only ask worth raising during the release.
2. A step `category` (`core`, `management`, `support`) in schema v2 with a migration, replacing
   the colour convention.
3. An optional step `description`, so agents see what reviewers see in the golden `scope`.
4. Collision-free generated ids (the per-instance counter reuses deleted ids).
5. Clearing `link` through the modeling API (the exporter falls back to `businessObject.link`).
6. `validateDocument` rejecting duplicate same-type, same-pair connections, as the format docs
   already say.

Not asked: `peerDependencies` for diagram-js (§5).
