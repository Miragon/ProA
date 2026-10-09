# ProA 2.0 – Milestone M4 "Value chain"

Status: proposed (2026-10-08, revised after review); the owner accepted the defaults of §11 (2026-10-09); S0 done (2026-10-08, `@miragon/value-chain-*` 0.3.0), S1 done (2026-10-09, storage and placement lifecycle), S2 done (2026-10-09, REST, MCP, CLI, rule proposals, findings, `baseline-prefix/1`), S3 done (2026-10-09, the chain page in the web UI), S4 done (2026-10-09, `eval:placements`, `proa seed --value-chains`, German rule-tier texts; with it **M4a is done**, "`eval:placements` green in CI" pending the next push), S5–S6 open · Branch: `claude/proa-2` · Spec: [CONCEPT.md](CONCEPT.md) §2, §3, §5–§7 · Previous: [M2-PIPELINE-REVIEW.md](M2-PIPELINE-REVIEW.md) · Golden data: [eval/value-chains](../../eval/value-chains/README.md) · Modeler: `Miragon/value-chain-modeler` (MIT)

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
check); acyclic `sequence` edges; coordinates (bounds and waypoints) within ±10,000,000 and
widths and heights ≤ 1,000,000 (`geometry-out-of-range`, S2: schema-model takes any finite
number, but its 3-decimal rounding turns one above about 1.8e305 into `Infinity`, stored as
`null`, which no read loads again). The size and count limits are checked first; a document
beyond them gets only those violations. A `schemaVersion` newer than ProA's schema-model gives
422 `value-chain-unsupported-version`.

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
  chain starts with new generations and revives no placements implicitly. A tombstone is
  final, so the save or deletion that sets it withdraws the live proposals on that generation
  (each recorded under its proposer, caused by the saving human); a proposal-only placement
  turns `obsolete`, and a "live proposal" (`list_unplaced_processes`, the limit per process
  and principal, findings) is always one on a live generation. Decisions stay: an accepted or
  held placement on a removed step is an open item that only a rejection or `correct` closes,
  since accepting or holding it again is refused (`unknown-step`).
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

Separate tables, not a relation type: one endpoint is not a fact, and relation queries and
findings stay untouched while M2 is still changing them. The landscape ETag is computed as
before, but its value (`"s<seq>"` from `project.last_seq`) moves with every project event,
chain and placement writes included (§7). Shared: the status function, the assertion
columns, the review components.

**Multiplicity.** A step has any number of processes. A process has one home step, the most
specific one (the golden data and the procedure assume this); a reviewer may accept a second
step for a genuinely shared process. A parent step shows the roll-up of its subtree.
**Reached by call** (processes called through accepted `call` relations from a step's
processes) is computed and shown, never stored, and never replaces a placement: it does not
remove a process from agent inputs, findings or the eval.

**`@outside`** is a pseudo-step for "deliberately outside this chain", with the same
lifecycle and a required reason (a proposal without one is refused, `rationale-required`). Archived copies go there, with the current version named in
the reason (the golden choice, §11). Technical adapters normally sit on the step they serve;
`@outside` is acceptable for them.

**Tiers** are server-computed (CONCEPT §2), never sent: `key` for rule proposals (principal
`proa-rules`, confidence 1.0) when a step's `link` is `proa:process/<ref>` of the process or
its `name_norm` equals the process's; `lexical` for an agent proposal whose step is among the
top 3 of `baseline-prefix/1` for that process or shares a name stem with it (the derived
`name-match` rule of the golden README; an equal `name_norm` is a shared stem, a matching
`link` alone is not); `semantic` for every other agent proposal, including `@outside`;
`manual` for humans. Rule proposals are recorded with `source_kind = 'rule'`, so supersession
and token revocation, which end agent proposals, never touch them. Nothing is auto-accepted.

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
value_chain(id vch_, project_id, key, name, head_revision_id, deleted_seq, created_at, updated_at,
         unique(project_id, key),
         fk(project_id, id, head_revision_id) → value_chain_revision(project_id, value_chain_id, id))
value_chain_revision(id vcr_, project_id, value_chain_id, rev, content bytea, content_hash,
         structure_hash, schema_version, base_revision_id, principal_id, source_kind, seq, created_at,
         unique(value_chain_id, rev), check(source_kind = 'human'), check(rev >= 1),
         fk(project_id, value_chain_id, base_revision_id) → value_chain_revision (same chain))
                                                                  -- append-only
value_chain_step(project_id, value_chain_id, element_id, generation, created_rev, deleted_rev,
         deleted_seq, pk(value_chain_id, element_id, generation),
         unique(value_chain_id, element_id) where deleted_seq is null,
         fk created_rev, deleted_rev → value_chain_revision(value_chain_id, rev))
                                                                  -- tombstone-only; `@outside` too
placement(id plc_, project_id, value_chain_id, element_id, generation, process_ref,
         process_model generated (split_part(process_ref, '#', 1)), status, endpoint_state,
         tier (key|lexical|semantic|manual), confidence, version, step_fp, process_fp,
         unique(project_id, value_chain_id, element_id, generation, process_ref),
         fk(project_id, value_chain_id, element_id, generation) → value_chain_step)
placement_assertion(id pas_, project_id, placement_id, seq, kind, verdict, source_kind,
         principal_id, client_id, declared, submission_id, tier, confidence, rationale, evidence,
         question, label, linked_placement_id, step_fp, process_fp, step_hash, process_hash,
         check(not (kind = 'decision' and source_kind in ('agent', 'rule'))),
         check(kind <> 'note' or source_kind = 'human'),
         check((step_hash is null) = (process_hash is null) and (step_hash is null or kind = 'proposal')),
         fk linked_placement_id → placement, fk submission_id → analysis_submission (deferred))
                                                                  -- append-only
placement_input(value_chain_id, process_ref, input_hash, task_id, outcome, reason)   -- M4b
```

As delivered in S1 (migrations `0006_value_chain.sql`, generated, and `0007_value_chain_triggers.sql`,
hand-written). `value_chain_revision` and `placement_assertion` are append-only
(`proa_forbid_change`); a `value_chain_step` row only ever takes its tombstone, one UPDATE that
sets `deleted_seq` (the seq of the `value_chain.revised` or `value_chain.deleted` event) and, for
a revision, `deleted_rev` (the first revision without the step; null when the chain's deletion
ended it), so a tombstone is final and rows are never deleted. Generations track elements of
type `step` only, plus a row for the pseudo-step `@outside` that is created with the chain and
tombstoned with it, so one foreign key from `placement` to its step generation covers every
placement and also pins its chain and project; `@outside`'s step fingerprint is the constant
`@outside`. The foreign keys are stronger than on the relation side: the head and the base
revision belong to the same chain, `created_rev`/`deleted_rev` name real revisions,
`linked_placement_id` names a placement. Placement status reuses the relation status values; the
`rule` tier is excluded, and the rule tier never decides (nothing is auto-accepted). The basis
columns for M4b are there already: `step_hash` (the chain's `structure_hash`) and `process_hash`
(the `facts_hash` of the process's model) as the agent saw them, both or neither and only on
proposals, plus `submission_id` with a foreign key that is checked at commit (as 0003 did for
relation assertions), so S5 needs no change to an append-only table. `content` holds the
canonical bytes; the 1 MB limit is a ProA rule (S2), not a DB check. `key` has no DB check: the
domain allows only `main`.

## 3. AI-first flows

### 3.1 Propose placements ad hoc (M4a)

Any MCP client with `proa:propose` works on the chain without a task:
`list_unplaced_processes` returns processes with no accepted or held placement and none waiting
for review on a live step (a rejected one homes nothing), including called ones, each with name, model key, lanes, up to 5 start and end labels,
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
rationale ≤ 1,000 and question ≤ 500 characters, and a non-empty rationale for `@outside`
(`invalid:rationale-required`); ≤ 200 items; evidence items are fact refs, `rel_` ids or
`step:<element_id>`, and must exist. Each item comes back `applied`,
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
| `decide_placement` (a stub like `decide_relation`: always `human-decision-required` with the review URL) | none | M4a |
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

**As delivered in S3** (§9 "S3 as delivered"): the page is a full-viewport route
(`/projects/$p/value-chain`, like the model view and the review screen), its tab
"Wertschöpfungskette" sits between Prüfen and Relationen and counts the open placement items
(proposed, or accepted with an endpoint that is not `ok`); the drill-down
`/projects/$p/value-chain/steps/$elementId` is a list page in the project layout. A project without
a chain shows an empty state with the CLI command; "Wertschöpfungskette anlegen" opens the Modeler
on an empty document locally, and the first save is the dry run plus `PUT` with `If-None-Match: *`,
so no empty revision 1 is written. Badges read "3 Prozesse · 2 offen" (the processes homed on the
step, accepted or held, and its open items; a step with only a proposal reads "1 offen"), one row of
labels just above each step, with the finding labels "nichts angenommen" and "Link ungelöst" next to
them; the step tree and the step view count the same. One placement card is active (from
`?placement=`, else the first open one on the selected step); A/R/H/C act on it, J/K walk the
chain's open placements (live steps in tree order, then `@outside`, then removed steps). The save
asks for confirmation when it strands placements, sends accepted ones to re-confirm or withdraws
proposals (stricter than the CLI, which ignores withdrawn proposals).

## 5. Packaging

- `apps/web` depends on `@miragon/value-chain-renderer` and `@miragon/value-chain-schema-model`,
  `apps/server` on schema-model only (DOM-free by the modeler's rule P1), all at exactly
  **0.3.0** (owner decision 2026-10-08, HANDOFF §4 item 14); `eval/tools` pins schema-model
  0.3.0 for the validator (§6). 0.3.0 is a version sync: the published `dist` files of both
  packages are identical in 0.1.0, 0.2.0 and 0.3.0, only the version fields differ (checked with
  `npm pack`). The domain code lives in `apps/server/src/domain/value-chain/`; the web uses
  schema-model directly and the server's `dryRun` for impact. No sixth package (CONCEPT
  principle 7).
- **No overrides needed.** The published renderer pins `diagram-js` 15.28.0,
  `diagram-js-direct-editing` 3.6.0, `didi` 12.0.0, `tiny-svg` 4.1.4 and schema-model 0.3.0;
  schema-model pins `zod` 4.6.5. These are the versions `bpmn-js` 18.31.0 and ProA already
  resolve, so `pnpm-lock.yaml` holds one `diagram-js` (15.28.0), one
  `diagram-js-direct-editing` (3.6.0, peer diagram-js 15.28.0) and one zod v4 (4.6.5); zod
  3.25.76 is `shadcn`'s, as before. The overrides planned for the pre-release pins (15.18.1,
  3.4.0, zod 4.4.3) are not needed. The one second copy is `didi`: diagram-js 15.28.0 depends
  on `didi` ^11 (11.0.1 locked) and the renderer on 12.0.0, but the renderer's `dist/index.js`
  never imports `didi` (only its `.d.ts` files reference `ModuleDeclaration`), so 12.0.0 is a
  type-only dependency that never reaches a bundle; S3 decides on an exact override only if the
  two `didi` type versions clash in ProA's `additionalModules`. ProA does not ask for peer
  dependencies: the modeler's pin rule (enforced in CI) requires exact versions in
  `peerDependencies` too, and with aligned pins there is nothing to gain. Neither package has an
  install script (`allowBuilds` unchanged). pnpm 11 holds back releases younger than a day, so
  `pnpm-workspace.yaml` lists the two exact 0.3.0 versions under `minimumReleaseAgeExclude`
  (released the day they were pinned); the Docker build (`pnpm fetch`, then
  `pnpm install --offline --frozen-lockfile`) works with them.
- **CSS.** `@miragon/value-chain-renderer/assets/value-chain.css` (0.3.0: 23 KB) inlines a
  minified `diagram-js.css` at build time. In the published packages it is diagram-js 15.28.0's
  (the same selectors and the same 27 `--bio-*` tokens), whose file bpmn-js 18.31.0 ships byte
  for byte as `bpmn-js/dist/assets/diagram-js.css`. Imported in the lazy chunk, it re-injects
  those rules after `bpmn-js.css` for the rest of the session; the six tokens `bpmn-js.css`
  redefines on `.bio-theme-parent` carry the same values there, and the renderer's own rules are
  scoped to its `vc-*` classes except `.djs-popup .djs-popup-entry-icon svg { display: block }`.
  So the version mismatch the leak came from is gone with the published packages. The Playwright
  check of the review screen after the chain page stays in S3 as the proof; small differences
  are accepted, visible ones are scoped in ProA's CSS. The upstream ask for a stylesheet without
  `diagram-js.css` (§12) stays, with lower priority.
- **CI.** `apps/server/test/unit/runtime-pins.test.ts` (S0, in `pnpm test`) fails on `link:`,
  `file:`, `portal:`, tarball or Git specifiers and on any non-exact version in every workspace
  `package.json`, in the `overrides` of `pnpm-workspace.yaml` and in `pnpm-lock.yaml` (importer
  specifiers, a registry `integrity` as the only resolution of every package, exact snapshot
  versions); `workspace:` stays allowed for the workspace's own packages. It also fails unless
  `pnpm-lock.yaml` holds exactly one version each of schema-model, renderer, `diagram-js`,
  `diagram-js-direct-editing` and zod 4.x, every `package.json` pin of a
  `@miragon/value-chain-*` package names that version, the renderer depends on that
  schema-model and the schema-model on the server's zod. So a bump of one pin alone (say the
  server's to 0.4.0) fails `pnpm test`, and the validator's `VERIFIED_SCHEMA_MODEL` gate, which
  reads the `eval/tools` pin, always covers the release the server stores with. The bundle
  assertions come with S3, when the chain page imports the renderer (until then no web chunk
  contains it): on the built bundle, one `diagram-js` copy and one zod v4 copy in the web chunks,
  and the chain chunk ≤ 40 KB gzip beyond shared diagram-js code (the renderer's `index.js` is
  42 KB unminified). Version bumps are manual until the cut-over (CONCEPT §9): today
  `.github/dependabot.yml` covers only the 1.x tree; when it gets the pnpm workspace, it groups
  bpmn-js with the renderer and both `@miragon/value-chain-*` packages. Modeler needs go
  upstream as issues; ProA never patches or forks it.
- **As delivered in S3.** `apps/web` depends on `diagram-js` 15.28.0 directly (exact; pnpm's strict
  `node_modules` did not expose `diagram-js/lib/features/overlays` through the renderer, and the
  lockfile keeps one version). No `didi` override: the diagram-js overlays module and a
  `VcDiagramElementFactory` subclass type-check in the renderer's `additionalModules` (didi 12
  types), and the bundles pull only didi 11.0.1. **zod and the CSP:** schema-model's zod builds its
  object schemas at module evaluation and probes `new Function("")`, which raises a
  `securitypolicyviolation` under `script-src 'self'` even though zod swallows the error;
  `src/lib/zod-csp.ts` sets `globalThis.__zod_globalConfig.jitless = true` before any zod code runs
  (the first import of `main.tsx` and of the chain chunk; zod 4.6.5 skips the probe under
  `jitless`), and every chain page in the e2e flow is checked for CSP violations. **Bundle guard**
  (`apps/web/test/bundle.test.ts`, a node-environment vitest in `pnpm test`, two Vite builds in
  memory): exactly one `diagram-js`, one zod (4.x, no 3.x), one renderer and one schema-model in the
  module ids of the web chunks; the entry chunk and its static imports hold none of them; the main
  CSS has no rule whose selector starts with `.vc-` (ProA's own chain rules are scoped `.proa-vc
  …`); and, with the dependency closure of `diagram-js` and `diagram-js-direct-editing` split into a
  shared chunk (`build.rolldownOptions.output.codeSplitting` groups), the code only the chain canvas
  loads is at most 40 KB gzip. Measured: 36.0 KB gzip chain-only (zod about 24.5, renderer 9.8,
  schema-model 1.1, ProA's canvas glue the rest), the shared diagram-js chunk 76.0 KB; without the
  split the production chain chunk is 89.6 KB gzip next to bpmn-js' own chunks; after the S3 review
  fixes the chain-only code is 36.1 KB. The budget counts only the chunks reachable from the canvas'
  dynamic import and from no other entry, so it binds what the canvas module pulls in, not the page:
  the page (`routes/value-chain-page.tsx` with its panels, dialogs and save logic) and the step view
  are route chunks of their own (`lazyRouteComponent`), and the entry chunk every page loads holds
  none of them. The first S3 build had both routes in the entry (the review measured 729.5 KB /
  217.9 KB gzip as Vite reports it, 628.8 KB / 192.8 KB at S2); with the route chunks it is 638.4 KB
  / 195.9 KB, the page chunk 81.0 KB / 22.7 KB. The guard checks that no module of the page, its
  components or the step view is in the entry closure and keeps the entry under 200 KB gzip (192.9
  KB measured with Node's default level). It builds with `NODE_ENV=production`, as `pnpm build`
  does; under vitest's `NODE_ENV=test` it had built React's development code. Raising the chain-only
  budget is an owner decision. **CSS check** (Playwright, `e2e/value-chain.spec.ts`): the computed
  styles of the bpmn-js review screen (container font, task, flow, label, ProA's overlay and
  endpoint marker, zoom group, details panel) and screenshots of both panes are equal before and
  after visiting the chain page in view and edit mode within the same session, and the chain page's
  styles and canvas screenshot are equal before and after the review screen: no difference, so no
  scoped override was needed. ProA only adds `.proa-vc .vc-container { background: transparent }`
  (the chain sits on the dotted paper like the model view) and moves the palette below the floating
  header.
- **Node.** schema-model runs in Node (server, validator): the server's unit test
  `value-chain-schema-model.test.ts` parses both golden chains with the package and serializes
  them back to the committed bytes. The renderer does not: its ESM entry needs a DOM, and Node's
  ESM loader cannot even resolve it, because it imports diagram-js subpaths without extension
  (`diagram-js/lib/Diagram`, as bpmn-js does) and diagram-js has no `exports` map; only a bundler
  (Vite) or a browser loads it. Its checks therefore run in the browser (S3).

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
validator. Scoring: below.

**`eval:placements`** (every PR, no LLM, `pnpm eval:placements`, `eval/reports/placements.{md,json}`;
S4) fails (exit 1) unless, per scored landscape:

1. `validate-value-chains.mjs <landscape>` exits 0 (the npm schema-model at the pinned version,
   the built-in copy as cross-check; both since S0, when `eval/tools/test/value-chains.test.mjs`
   also put the validator into `pnpm test`). eval:placements spawns it and keeps only its summary
   lines; an exit 2 (the check could not run) makes eval:placements exit 2.
2. The golden placements name exactly the landscape's `process` facts (`@proa/bpmn-facts`, the
   server's view): none missing, none extra, none listed twice.
3. Every key-tier rule proposal computed from the golden chain is the process's `must` or one of
   its `may` steps (no `coarse`, trap or other step). The derivation is `derivePlacementRules` in
   `@proa/relations`, the code the server's rule tier runs.

The golden chains also pass the ProA rules, but that check runs in `pnpm test`
(`apps/server/test/unit/value-chain-golden.test.ts`: `prepareRevision` accepts both chains and
their committed bytes are already canonical, so the file's sha256 is the `content_hash` a seeded
project stores), not in eval:placements: `eval/tools` must not import from an app, and moving
`prepareRevision` into a package would pull schema-model into `@proa/contracts` or
`@proa/relations` (S4 deviation; the report header names the test).

**Scoring** (`eval/tools/src/placements-score.ts`, the API S5 plugs recordings into), in this
order: the must is `hit` (also `@outside`); a may is `may` (neutral); an ancestor of the must is
`coarse` (neutral, reported); a step in a `must_not` subtree is `trap`; any other step, also an
unknown process or step, is `wrong` (closed world); a process without a proposal is `none`.
Precision = hit / (hit + trap + wrong); recall runs over all `(process, must)` pairs, `@outside`
musts included (the baseline never proposes `@outside`, so those are its misses); recall@1 and
@3 come from ranks; F1 from both. Level 0 lifts the same classification to the top-level areas:
the proposal's area against the must's area (`@outside` is its own area), the may steps' areas
and the top-level `must_not` steps (a trap on a sub-step does not cover its area). Trap rate =
processes with a trap proposal / processes with a `must_not` (at level 0: with a top-level
`must_not`, the only processes level 0 can trap). Everything is reported per tag and per
landscape.

**Systems:** the rule tier's key proposals and `baseline-prefix/1` (frozen v1, `@proa/relations`:
key folders and process name tokens against step and ancestor names with the package's
normalization, plus votes from neighbours' steps), top-1 and top-3. With votes, the neighbours
are the `must_link` relations of `expected.yaml` mapped to their processes (both directions, the
same process skipped), as the accepted relations of a reviewed project, and a neighbour is known
on its golden must (`@outside` never votes; leave-one-out holds by construction, since the
baseline never reads a process's own known steps). A second row without votes (no neighbours,
nothing known) is what a fresh project's hints show and the fair comparison for M4b live runs.
The baselines are a floor, not a gate: the committed report and CI's drift check pin their
numbers. The holdout does not exercise prefix bias (README), so prefix bias is read from the dev
landscape. **Holdout hygiene:** for a landscape of split `holdout`, the report (Markdown and
JSON) and the console show aggregate numbers only, none over fewer than 5 processes
(`HOLDOUT_MIN_GROUP`): no per-item lists (traps, wrong top-1, misses, the steps that attract wrong
proposals, the rule proposals); the rule tier as its gate and proposal count only (its proposals
follow from the public chain file and model names, so even a hit/may split of them would name
classes of identifiable processes); per-tag numbers only for tags with at least 5 processes (a
tag row over one process is that process's result). Whoever works on a procedure can open the
report; `candidates.md` and `replay.md` still list holdout pairs.

**`eval:replay`** scores recorded placement submissions (M4b) with the same scorer;
recordings keep the path `<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`, and their
lines name a chain revision instead of a model revision (§8). **Live** (by hand before a
procedure release, 3 runs): no `must_not` at confidence ≥ 0.8; recall at least 20 points
above `baseline-prefix/1`; chains drafted with the prompt are rated by the owner.
`proa seed --value-chains` loads each landscape's golden chain (`value-chain.vc.json` only, never
`expected-placements.yaml`; the Docker image ships the chain files and nothing else of
`eval/value-chains`) without placements; the rule tier's key proposals appear as after any save.

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

**Events** (S1; `seq` from `project.last_seq` like every event, so the landscape ETag moves on
chain and placement writes too): `value_chain.created` (also when a deleted chain is created
again; payload `outcome` `created` or `revived`), `value_chain.revised` and `value_chain.deleted`,
with subject the `vch_` id; the payloads carry `valueChainId`, `key` and, for a revision,
`revisionId`, `rev`, `contentHash`, `structureHash`, the counts `stepsAdded` and `stepsRemoved`
(not id lists) and on `revised` `baseRevisionId`. `placement.proposed|withdrawn|decided|noted|endpoint_changed`
with subject the `plc_` id; payload `placementId`, `valueChainId`, `elementId`, `generation`,
`process`, `sourceKind`, and as they apply `verdict`, `tier` and `confidence`, `submissionId`,
`linkedPlacementId`, `principalId` (when caused by someone else, e.g. the human whose save or
chain deletion withdrew the proposal), `previous` and `endpointState` (`endpoint_changed`,
emitted when the endpoint state of a non-obsolete placement changes, also by a decision or
proposal that re-anchors it; a placement whose withdrawals make it obsolete gets none). `analysis.*` payloads carry `kind`
and subject (M4b).

| Capability | Scope | Min role | Principal |
|---|---|---|---|
| Read the chain, placements, findings | `proa:read` | viewer | any |
| Propose and withdraw own placements, claim, submit | `proa:propose` | editor | any |
| Create, save, import, delete the chain; decide placements; manual placements | `proa:review` | editor | user on an interactive client |

Agents never edit the chain; the DB checks back this up (`value_chain_revision.source_kind =
'human'`, no agent or rule decisions in `placement_assertion`). No new permission: the rows map
onto `read`, `propose` and `review` (human-only, `human-decision-required`) of `policy.ts`. S2's
use cases call `policy.require`; in S1 the domain functions refuse non-humans for chain writes,
decisions, manual placements and notes.

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
5. **Status** (M4a, done in S1): `recomputeStatus` is generalised over the subject (relation or
   placement), not copied; M2's tests stay unchanged and green.
6. **Snapshots** (M4a, M4b): `mcp-tools.json` and the contract tests gain the new tools and
   fields.

## 9. Slices

**M4a "Chain and placements"**

| Slice | Scope | Effort |
|---|---|---|
| S1 | **done** (2026-10-09): tables and migration (`value_chain`, revisions, step generations, `placement`, `placement_assertion`); placement lifecycle with generalised `recomputeStatus`; see below | 2.5 d |
| S0 | **done** (2026-10-08): consume the release, see below | 1 d |
| S2 | **done** (2026-10-09): `domain/value-chain` (canonicalize, ProA rules, kinds, ranks, fingerprints, `structure_hash`, generations); REST with `If-Match` and `dryRun`; events; policy matrix; `proa value-chain push\|pull`; endpoint state on save and model ingest/delete; key-tier rule proposals; server tiers with `baseline-prefix/1` (moved here from S4); decisions incl. bulk; read and propose MCP tools; findings; contract snapshots; see below | 4.5 d |
| S3 | **done** (2026-10-09): UI: page, viewer/modeler, collision-free ids, save with dry run and conflict, overlays, side panel, link editing, drill-down, Playwright incl. the CSS check; from S0: the bundle guard (one `diagram-js` and one zod v4 copy in the web chunks, chain chunk budget) and the Playwright import check (zero import warnings, stored waypoints equal `layouter.layoutConnection`; the dev chain and synthetic chains, see below); see below | 5.5 d |
| S4 | **done** (2026-10-09): `eval:placements` (gates, the rule tier and `baseline-prefix/1` scored, report with the holdout as numbers only, CI drift check), `proa seed --value-chains` (the image ships the chain files only), German rule-tier texts, the ProA rules check of the golden chains, the MCP evidence of the M4a criterion; see below | 1 d (+0.5 d German texts and M4a close-out) |

**S0 as delivered.** `@miragon/value-chain-schema-model` 0.3.0 in `apps/server`, `apps/web` and
`eval/tools`, `@miragon/value-chain-renderer` 0.3.0 in `apps/web`, exact; no overrides (§5);
`minimumReleaseAgeExclude` for the two 0.3.0 versions; the Docker build unchanged and passing.
`eval/value-chains/validate-value-chains.mjs` imports the npm package (ESM build) as `eval/tools`
resolves it, exits 2 when the installed version differs from that pin or is not in
`VERIFIED_SCHEMA_MODEL` (now `0.1.0`, `0.3.0`), and reports that the built-in re-implementation
agrees on every document; the read-only import from a sibling `value-chain-modeler` checkout
(`VALUE_CHAIN_MODELER`) is removed, `--builtin` stays. Tests in `pnpm test`: the specifier guard
in `apps/server/test/unit/runtime-pins.test.ts`, the Node round trip in
`apps/server/test/unit/value-chain-schema-model.test.ts` (both golden chains, `loadDocument`,
`parseDocumentJSON` and `validateDocument` each serialize back to the committed bytes, no
difference; a failure names the first differing line or the function and error class, never
an error message, since one chain is the holdout's; the package rejects a newer
`schemaVersion`, duplicate ids and unknown endpoints; its `zod` resolves, from the package's
real path as Node loads it, to the same package directory as the server's; `instanceof` would
not prove this, since zod v4 checks trait names), the lockfile check of one version each
(§5 CI), and `eval/tools/test/value-chains.test.mjs` (the validator in both modes). Not in S0:
Dependabot for the pnpm workspace (cut-over, §5 CI). **Moved to S3**, because no web code
imports the renderer before the chain page: the bundle guard and the Playwright import check.
Neither can run earlier without faking: the renderer's entry does not load in Node (§5), and
jsdom 30 has no `getBBox`, `createSVGMatrix` or `createSVGTransform`, which diagram-js and
tiny-svg call, so a component test would need stubbed geometry.

**S1 as delivered** (2026-10-09). Storage, the generalised status and the placement lifecycle
as domain functions, without REST, MCP or UI (S2, S3).
- **Contracts:** typed ids `ValueChainId` (`vch_`), `ValueChainRevisionId` (`vcr_`),
  `PlacementId` (`plc_`) and `PlacementAssertionId` (`pas_`; relation assertions keep `asr_`).
  No route references them yet, so the OpenAPI document and the client are unchanged.
- **Schema:** the five tables of §2 in `apps/server/src/db/schema.ts`, migrations `0006` and `0007`
  (above); a second `drizzle-kit generate` reports no changes. Ports and Drizzle repositories:
  `tx.valueChains`, `valueChainRevisions`, `valueChainSteps`, `placements`,
  `placementAssertions`.
- **Status:** `status.ts` has a subject descriptor (`Subject`: `anchor`, `sameAnchor`,
  `proposalView`) with `recomputeStatusOf`, `classifyProposalOf` and `pairEndpointState`;
  `currentStances` and `decisionsInForce` take any `StanceView`. The relation functions keep
  their names and signatures as instances (`RELATION`), so no relation caller changed. A golden
  digest over 2,000 seeded random relation histories, computed on the code before the change,
  pins relation behaviour byte for byte (`status-subjects.test.ts`); relation histories mapped to
  placement form give the same status, tier, confidence, basis and classification.
- **`apps/server/src/domain/value-chain/`:** `steps.ts` (`OUTSIDE`, `planStepGenerations`:
  the head's steps plus `@outside` live, a returning id gets the next generation, delete
  tombstones all, ids starting with `@` are refused), `revisions.ts` (`createValueChain` with
  revival of the same `vch_`, `saveValueChainRevision` with the `unchanged` no-op,
  `deleteValueChain`; humans only; `rev` continues after deletion and revival; each revision
  updates generations, head and name, withdraws the live proposals on the generations it
  tombstones, as the deletion does, and refreshes the placements' endpoint state),
  `placement-state.ts` (`recomputePlacementStatus`, `classifyPlacementProposal`,
  `placementEndpointState`, endpoints from the live generations, step fingerprints and the head's
  `process` facts, `refreshPlacement(s)`, events) and `placements.ts` (`placementTier`, which
  takes no key match for agents; `applyPlacementProposal`, which refuses a step generation that
  is not live (`unknown-step`) and `@outside` without a reason (`rationale-required`) and records
  the rule tier's key proposals as `rule` under `proa-rules` when `PlacementContext.proposer`
  names it, with `key` exactly for that source; `withdrawPlacementStance`;
  `withdrawProposalsOnRemovedSteps`; `recordPlacementDecision` with reasons required for reject
  and hold and accept and hold refused on a tombstoned generation (`unknown-step`: reject or
  correct); `acceptManualPlacement`, `correctPlacement`, `addPlacementNote`).
- **The seam to S2** is `PreparedRevision` (`content`, `contentHash`, `structureHash`,
  `schemaVersion`, `name` = `meta.name`, `stepFingerprints`): S1 trusts it, and revisions are
  append-only, so no production code calls the write path before S2's `prepareRevision`
  exists. S1's tests build it with schema-model and stand-in fingerprints.
- **Deviations from the plan:** `createValueChain` takes `{key}` and names the chain after
  `prepared.name` (S2 builds the empty document from the requested name, M4 §3.5);
  `saveValueChainRevision` and `deleteValueChain` take the chain id and re-read the chain; the
  revival outcome is `revived` (result and event payload) rather than `created`; a base revision
  of another chain is refused with `validation-failed` (`unknown-base-revision`) before the
  foreign key would; notes do not move a placement's version, as for relations.

**S2 as delivered** (2026-10-09). REST, MCP and CLI on S1's domain functions, the rule tier's
key proposals, the endpoint hooks of model changes, findings and `baseline-prefix/1`; no UI (S3).
- **Contracts** (`packages/contracts/src/api/{value-chains,placements}.ts`): the problem codes
  `value-chain-invalid` (422, `violations` ≤ 100 and `truncated`), `value-chain-unsupported-version`
  (422, `schemaVersion`, `supported`), `revision-conflict` (412, `headRev`, `etag`) and
  `precondition-required` (428); 19 routes under the OpenAPI tag `value-chains` (§3.5, plus notes,
  the assertion timeline and `DELETE …/placements/{plc}/proposal`, because every MCP capability
  needs REST and the UI has no private endpoints); one `SaveValueChainResult` (`dryRun`,
  `outcome`, `valueChain`, `revision`, `impact`) for POST, PUT and the dry run; `ValueChainFinding`
  separate from the relation `FindingKind`; `valueChainPath()` as the `reviewUrl` of chain and
  placement writes (`/projects/<key>/value-chain[?placement=plc_…]` or `…/steps/<id>`; S3 builds
  the page, until then the web app shows its not-found page); the limits as constants
  (`MAX_VALUE_CHAIN_*`, `STEP_KIND_COLORS`, `OUTSIDE_STEP`) for S3's web limits. The client is
  regenerated.
- **`baseline-prefix/1` and the stem rule** live in `packages/relations/src/placement.ts`
  (`baselinePrefix`, `sharesNameStem`): the package already holds the normalization, stopwords,
  synonyms and `baselineProa1` they build on, both the server domain and `eval/tools` depend on it
  (S4 imports the same code), a sixth package would break CONCEPT principle 7, and `eval/tools`
  must not import from an app; steps come in as plain `{id, name, parentId}`, so the package needs
  no schema-model. Frozen v1: words are `contentWords`, each kept with its `conceptOf` concept;
  two words match when equal, or when both have ≥ 4 characters and share a prefix of
  `min(5, |a|, |b|)`; score 3 × process name or file stem words on the step's name + 1 × on an
  ancestor's name + 2 × model key folder words (not the file) on the step or an ancestor + 1 per
  neighbour known on the step and 0.5 per neighbour known below it; score 0 dropped; ties by
  depth (deepest first), then id; top 3; `@outside` is never a candidate; leave-one-out holds by
  construction (a process's own placements are never read). Any change needs `/2`; nothing is
  tuned on the holdout. `sharesNameStem` is the README's derived `name-match` rule exactly (its
  transliteration, words of ≥ 4 letters, the shared stem in both directions, no sibling with
  it); a unit test checks it against the `name-match`/`semantic` tags of every dev placement.
  This moves `baseline-prefix/1` from S4 into S2 (0.5 d); S4 shrinks by the same.
- **`domain/value-chain/`**: `document.ts` (`prepareRevision`: not an object, the version
  before `migrate()`, schema-model's zod schema, ProA's copies of the cross-field rules so each
  violation names its element, `loadDocument` as the authority, canonical bytes and hash, the
  ProA rules (the size and count limits first and, when one fails, nothing else, so the graph
  rules only see ≤ 500 elements and ≤ 1,000 connections; then the rest collected together,
  including `geometry-out-of-range`; hierarchy depth and cycles in one memoized walk, sequence
  successors sorted once), then the canonical text loaded again with `parseDocumentJSON`
  exactly as a read loads the stored bytes on a cache miss (a failure would be `schema`), and
  the structure from that reloaded document, so the cached structure and one derived from the
  stored bytes are the same), `structure.ts`
  (kinds, ranks, fingerprints, owners, link kinds, `structure_hash` over
  `proa-vc-structure/1`, a 16-entry LRU per `content_hash`), `impact.ts`, `items.ts`
  (`validatePlacementItem`, reused by S5), `tiers.ts` (`lexicalMatcher`: top 3 of the baseline
  or a shared stem or an equal name; neighbours from accepted relations, votes from accepted
  placements on live generations), `views.ts`, `chain-state.ts`, `revocation.ts`, `rules.ts`,
  `sync.ts`, `findings.ts`; use cases `use-cases/{value-chains,placements,chain-access}.ts`, each
  with `policy.require` (`read`, `propose`, `review`; agents get `human-decision-required` with
  the `reviewUrl`).
- **Saves:** `POST …/value-chains` takes exactly one of `name` (an empty document) or `content`;
  `PUT …/content` needs `If-Match: "r<rev>"` (428 without, `*` or an unparsable tag), a stale
  revision is 412 `revision-conflict` with `headRev`, content equal to the head answers 200
  `unchanged` whatever the tag (RFC 9110 §13.1.1, so retries are idempotent), and
  `If-None-Match: *` creates or revives (201; 412 if a live chain exists); both headers at once,
  or an `If-None-Match` other than `*`, is 422. The body is raw JSON (2 MiB, 413; another media
  type 415; a syntax error `not-json`); canonical bytes may have 1 MiB (`document-too-large`).
  `GET …/content` sends the canonical bytes with `ETag: "r<rev>"`, `Cache-Control: private,
  no-cache` and 304 on a matching `If-None-Match`. A revision number is at most 999,999,999
  (`MAX_VALUE_CHAIN_REV`, the 9 digits of the tag) in the path and in `get_value_chain_document`
  (422 `validation-failed` or invalid input above it); a cursor's revision or generation must
  fit the `integer` column (else 422 `invalid cursor`), never a database error. Concurrent saves
  on one `If-Match`, concurrent `If-None-Match: *` creates and concurrent POST creates are
  tested: exactly one wins, the other gets 412 (409 for POST), `seq` stays dense.
- **Rule tier** (`rules.ts`): a step whose `link` is `proa:process/<ref>` of a head process, or
  whose non-empty `name_norm` equals `normalizeKey` of a head process's label, yields one
  proposal per (step, process) through `applyPlacementProposal` with `proposer = {sourceKind:
  'rule', principalId: proa-rules}`: tier `key`, confidence 1.0, a rationale naming the link or
  the normalized name (stable while the fingerprints are, so a case-only rename records nothing),
  evidence `[process ref, step:<id>]`. It runs in the save's transaction on every create,
  revival and revision (not on `unchanged` or a dry run), inside S1's write path through its
  `beforeRefresh` hook: after the step generations, the head and the withdrawals on removed
  steps, before the endpoint state is refreshed, as after model changes; and after every ingest
  that stored a revision and every model deletion. A rule proposal no longer derived is
  withdrawn under `proa-rules`. Rules before the refresh means a rename writes no `endpoint_changed`
  for a rule proposal: one re-asserted by a kept link moves to the new anchor with one
  `placement.proposed` (no `ok` → `changed` → `ok`), one the rename ends turns obsolete with
  its `placement.withdrawn`. An `endpoint_changed` the rule tier's writes record inside a save
  (an accepted placement under a re-asserted proposal turning `changed`) names the saving human,
  whose save moved the endpoint, as S1's refresh does; after model changes it names
  `proa-rules`. Tests pin the events of both renames. A human decision on the same fingerprints suppresses it, a kept link re-asserts
  it on a renamed step's new anchor (an accepted placement there stays accepted and turns
  `changed`: re-confirming is the human's), token revocation never touches it, and a step's
  removal withdraws it as S1 does (under the rule tier, caused by the saving human). The golden
  dev chain gets four rule proposals (equal names), each the process's `must`.
- **Endpoint hooks** (`sync.ts`): `syncValueChainAfterModels` runs in `ingest()` after
  `recomputeProject` and `touchNoLinkRelations` (only when a revision was stored) and in
  `deleteModel()`: for each live chain the rule proposals first (a withdrawn one turns obsolete
  without an `endpoint_changed`), then `refreshPlacements` with the cached head structure and
  the head process fingerprints; all events under `proa-rules` without a client. A project
  without a chain costs one query.
- **Findings** (`findings.ts`, pure, recomputed on read; `GET …/findings`, `ValueChainDetail.findings`,
  `get_value_chain`): `process-without-step` per head process without an accepted placement on a
  live generation (`@outside` counts; an accepted placement on a removed step does not), with
  `state` (`held`, `proposed` or `none`) and `calledFrom` (the steps of accepted callers through
  accepted `call` relations, never `@outside`); `step-without-process` at the topmost step
  without an accepted placement of a head process on it or below it; `unresolved-link` for an
  opaque link and a `proa:` link that is malformed or names no head process. Order: processes by
  ref, then steps, then links by id.
- **Unplaced and pending** mean the placement *status* on a live generation: a process is
  unplaced (`list_unplaced_processes`) without an accepted, held or `proposed` placement there.
  A rejected placement homes nothing, although the agent's proposal on it is still that agent's
  current stance (the first cut of S2 counted that stance, so a rejected process vanished from
  the list for good).
- **MCP:** `get_value_chain`, `get_value_chain_document` (paged like `get_model_xml`, ≤ 100,000
  characters), `list_unplaced_processes` (read), `propose_placement`,
  `withdraw_placement_proposal` (propose), and the stub `decide_placement` (always
  `human-decision-required` with the value chain `reviewUrl`, through the REST use case, like
  `decide_relation`); the instructions name placements and the value chain. No `stage` field
  (S5), no `place_processes` prompt (S5), no resource `proa://…/main.vc.json` (deferred with
  the model resources; `get_value_chain_document` covers it).
- **CLI:** `proa value-chain push <file> -p <project> [--key] [--base <rev> | --force]
  [--dry-run] [--yes] [--json]` (owner key only; an agent token is refused before any request;
  `If-Match` names `--base`, the revision the file was pulled from, as §3.5 defines it; for an
  existing chain push refuses to save without `--base` (exit 1, "pass --base … or --force"),
  since `If-Match` on the head read at push time would let a pull, edit, push round trip
  silently revert a save made in between; `--force` saves on the current head; content equal to
  the head is `unchanged` and a `--dry-run` runs against the current head without either;
  `If-None-Match: *` for a new chain; a dry run first, stops with exit 1 before stranding
  placements or sending them to re-confirm unless `--yes`; 412 says "pull first", 422 lists the
  violations with their element and connection ids) and `proa value-chain pull -p <project>
  [--key] [--rev <n>] [-o <file>]` (any credential; the canonical bytes verbatim through hey-api
  `parseAs: 'text'`, `r<rev> <sha256>` on stderr: the `--base` for the next push).
- **Token revocation** withdraws the token's live placement proposals under the token's
  principal, caused by the owner; nothing is queued (no placement pipeline before M4b).
- **Events:** no new types. A dry run and an `unchanged` save write none; rule and ingest-sync
  events carry `proa-rules` and no client, except an `endpoint_changed` the rule tier causes
  inside a save, which names the saving human; a rename writes no `endpoint_changed` for a rule
  proposal it re-asserts or ends (Rule tier above); revocation withdrawals carry the proposer as
  `principalId` in the payload; `seq` stays dense (tests).
- **Deviations from the plan:** ranks group the top-level steps by kind band (core chain,
  management, support), so the core chain ranks 0…n−1 instead of interleaving with the bands;
  the dry run runs in a REPEATABLE READ snapshot without the project lock (the S1 checklist said
  "under the project lock"; the save re-checks `If-Match` under the lock and returns its own
  impact, which can differ when placements changed in between); names allow tab and line breaks
  but no other control or bidi characters, links refuse bidi characters too; a dry run that
  would create the chain has `valueChain: null`; `decide_placement` carries write annotations
  like `decide_relation`; the rule tier runs before the refresh of the endpoint state, after
  model changes and inside saves (a hook in S1's write path); the unplaced definition above;
  the ProA rules gained `geometry-out-of-range` and stop after the size and count limits;
  `proa value-chain push` needs `--base` (or `--force`) for an existing chain.

**S3 checklist** (from S2; every item is closed in "S3 as delivered" below):
- Build the routes `valueChainPath()` names (`/projects/$p/value-chain`, `?placement=`,
  `/steps/$elementId`); mirror `MAX_VALUE_CHAIN_*`, `STEP_KIND_COLORS` and `OUTSIDE_STEP` in
  `src/lib/limits.ts` (compared with the contracts by `test/limits.test.ts`).
- Save with `serializeDocument` → `PUT …/content?dryRun=true` → confirm stranded and
  re-confirm placements → `PUT` with `If-Match`; show the save's own `impact`, which can differ
  from the dry run's.
- Bulk "re-confirm" leaves out placements with `stepLive: false` (the bulk answers
  `step-removed`) and offers reject or `correct` for them; findings and the rule tier's
  proposals (`source: rule`, handle `proa-rules`) come from `ValueChainDetail`.
- Once the page exists, name it again where agents are told how a chain is created: the
  not-found message `NO_VALUE_CHAIN` (`chain-state.ts`) and the `get_value_chain` description
  (MCP snapshot) name only `proa value-chain push` until then.
- The modeler's limits include `MAX_VALUE_CHAIN_COORDINATE` and `MAX_VALUE_CHAIN_ELEMENT_SIZE`
  (a shape dragged beyond them is refused on save).

**S3 as delivered** (2026-10-09). The value chain page in the web UI on S2's routes; no server
change beyond the texts that point to it.
- **Routes.** `/projects/$p/value-chain` (`validateSearch`: `step`, `placement`; the `reviewUrl` of
  refused agent writes selects the card) is a full-viewport child of the root route;
  `/projects/$p/value-chain/steps/$elementId` is a child of the project layout, whose tab
  "Wertschöpfungskette" stays active by prefix. Both components load with their routes
  (`routes/value-chain-page.tsx`, `routes/value-chain-step-page.tsx`), not with every page. The
  Prüfen inbox shows one callout "N Platzierungen warten auf deine Prüfung" with a link to the chain
  page; the relation queue and its bulk accept are unchanged.
- **The chain chunk** `src/components/value-chain/canvas/` (`chain-canvas.tsx`, `proa-modules.ts`,
  `overlays.ts`, `services.ts`) is the only code that imports the renderer, schema-model,
  diagram-js or zod values (ESLint `no-restricted-imports` outside that folder, type imports
  allowed; the bundle guard). View mode is the renderer's `NavigatedViewer`, edit mode its
  `Modeler`, both with ProA's modules (diagram-js overlays and `ProaElementFactory`); a switch
  destroys one and creates the other in the same place and keeps the viewbox. A document is
  imported when the mode or the page's document key changes (`view:r<rev>`, `edit:<n>`), never on
  a refetch, so a decision (which invalidates the whole project) never replaces an edit. The page
  talks to the chunk through props, callbacks (`onSelect`, `onOpen`, `onChange` debounced 300 ms
  after an executed, undone or redone command, never for an import's `commandStack.clear`,
  `onImported`, `onError`) and an imperative handle (`exportCanonical` =
  `serializeDocument(exportDocument())`, `emptyText` (the canonical empty chain, the clean state
  of a new chain), `takePendingChange` (a change still waiting for its debounce, which the page
  handles at once before deciding about unsaved changes), undo/redo, `elementInfo`, `setLink`,
  `setName`, `setColor`, `setChainName`, `saveSVG`, zoom, fit); `data-testid="vc-canvas"` carries
  `data-imported`, `data-mode`, `data-dirty` and `data-import-warnings`. The first view fits the
  drawing into the part the floating header and legend leave free (also under StrictMode: only an
  instance that showed a drawing hands its viewbox on).
- **Collision-free ids.** `ProaElementFactory` overrides `create(type, attrs)`: without an id it
  hands out `<type>_<ULID>` (48 bits of time, 80 random bits from `crypto.getRandomValues`,
  Crockford base32, `src/lib/ulid.ts`, no new dependency), probing the registry; imported ids are
  never changed. Palette, append and auto-place go through it.
- **Save** (`src/lib/value-chain-save.ts`, a state machine without canvas access): export, the
  no-op check against the base text, the client pre-check (canonical bytes and counts), the dry
  run with `If-Match: "r<base>"` (`If-None-Match: *` for a chain not created yet), the impact
  dialog when anything is stranded, sent to re-confirm or withdrawn, the save with the same
  precondition, a toast with the save's own impact and a result dialog when it differs from the
  dry run's. 412 opens the conflict dialog ("Neuere Revision laden" downloads the local copy as
  `<key>-r<base>-entwurf.vc.json` first and stays in edit mode on the new head; "Weiter
  bearbeiten"); 428 is shown as an internal error; 422 `value-chain-invalid` lists every
  violation in German with the element's name, a click selects it and the canvas marks it; 413,
  `value-chain-unsupported-version` and 404 explain themselves. Entering edit mode snapshots the
  base (revision and canonical text); a banner says when the server's head moves past it.
- **Drafts** (`src/lib/drafts.ts`): `localStorage` under `proa:vc-draft:<project>:<vch_|new>:r<base>`,
  written with every (debounced) change, cleared by a save, an `unchanged` answer, a discard or an
  edit back to the base (a new chain's base is the empty document); an import never touches it.
  A draft on the current head offers "Entwurf wiederherstellen", one on an older base only
  "Herunterladen" or "Verwerfen"; the dialog needs an explicit choice (no Escape, focus on the
  safe action) and nothing is written or cleared while it asks; every access is wrapped (private
  mode, quota). Dirtiness is the export compared with the base text, taken at once (with the
  canvas' pending change) when "Fertig" or a navigation asks, and recomputed after a save, so an
  edit made while the save ran stays unsaved, as a draft on the new revision. Leaving the page
  while dirty asks first (TanStack `useBlocker`; Escape stays); a reload does not (the draft
  survives it).
- **Panel.** Without a selection: summary, the step tree (`role="tree"`, one tab stop with a roving
  tabindex, arrow keys, Home/End, ArrowRight/ArrowLeft to a sub-step or the parent, Enter or Space;
  every node open, so no `aria-expanded`), "Offene Prüfungen" with "Alle erneut bestätigen (n)",
  findings, "Prozesse ohne Schritt" (up to three `baseline-prefix/1` hints, "Platzieren" as a manual
  placement), "Außerhalb der Kette" and "Auf entfernten Schritten" (cards, reject or correct only);
  in edit mode also the chain's name and the head steps with placements the drawing lost. With a
  step: "Zur Übersicht" (also Escape; the focus returns to the step in the tree), the path (each
  segment selects that parent), name (edit: one command on Enter or blur; the field keeps the focus
  and takes over an undo), kind ("Art" select for top-level steps in edit mode: no colour,
  management or support), owners, link (view: by `linkKind`; edit: the link editor), counts, the
  placement cards, the sub-steps' processes and "Über Aufrufe erreicht", "Prozess hinzufügen" and
  "Schritt öffnen"; a step saved after the last head shows "Neuer Schritt – Platzierungen nach dem
  Speichern"; an org unit shows the steps it owns. Viewers (`role = viewer`) get no edit, decisions
  or manual placements. The forms of "Prozess hinzufügen" and "Platzieren" take the focus and hand
  it back to their button; import warnings show closable in the panel.
- **Placement cards** (`placement-card.tsx`, `placement-decision-panel.tsx`): process, status,
  tier, endpoint state, confidence, the rule basis ("Regel: gleicher Name" or "Link des Schritts")
  for `proa-rules`, rationale, question and hold label as plain text, provenance, evidence (fact
  refs to the model view, `rel_…` to the review screen, `step:<id>` selects the step) and the
  timeline on demand, an answer field on held cards. Decisions reuse the M2 forms
  (`components/review/decision-forms.tsx`), send the `version` seen, show a 409 as a conflict
  that pauses the shortcuts; `correct` picks a step (or `@outside`) and sends exactly `{verdict:
  'correct', step, note, version}`. In edit mode the shortcuts work only while the panel has
  focus (the Modeler binds H, L, S, C and E on the canvas); a click on a card focuses it, and key
  hints show only while the keys work (viewers see J/K only). The active card scrolls into view
  when it becomes active (J/K, a `reviewUrl` to an `@outside` card).
- **Link editing:** none, a ProA process from the head facts (`proa:process/<ref>`), or other
  text (≤ 2,000 characters, no control or bidi characters); a click or the arrow keys only mark a
  process (Radix checks a radio when an arrow key focuses it), "Übernehmen" or Enter applies it;
  each applied change is one `vcModeling.updateProperties` call that sets `link` and
  `businessObject.link`, so clearing works and Ctrl+Z on the canvas restores it; the editor stays
  mounted (and focused) while the canvas reports the change.
- **Drill-down:** a double-click in view mode (or "Schritt öffnen") opens the model view for a
  resolved `proa:process/` link, otherwise the step view (breadcrumb, sub-steps with counts, own
  processes with "Im Modell" and "Auf der Kette zeigen", the sub-steps' processes, processes
  reached by call with their `/review/$rel` links; 404: "Den Schritt „x“ gibt es in der aktuellen
  Revision nicht.").
- **Server texts** (S2 checklist): `NO_VALUE_CHAIN` and the `get_value_chain` description name the
  web page (tab Wertschöpfungskette, `/projects/<project key>/value-chain`) and `proa value-chain
  push`; the MCP snapshot is regenerated; OpenAPI and the client are unchanged.
- **Tests.** Unit and component (vitest, a stand-in canvas): `value-chain-lib.test.ts`,
  `drafts.test.ts`, `chain-canvas.test.tsx` (the chunk with a stand-in renderer),
  `value-chain-page.test.tsx`, `placement-decision-panel.test.tsx`,
  `chain-save.test.tsx`, `link-editor.test.tsx`, `bulk-reconfirm-dialog.test.tsx`,
  `step-view.test.tsx`, `bundle.test.ts`, extended `app.test.tsx` and `limits.test.ts`.
  Playwright: `e2e/value-chain-import.spec.ts` (the harness page `e2e/harness`, served by Vite's
  `createServer` inside the spec, no ProA server: the golden dev chain imports with 0 warnings
  and all 39 stored waypoint lists equal `layouter.layoutConnection` rounded like
  `serializeDocument`; synthetic chains drawn with the modeling API (a row, a rake, a single
  centred sub-step, a sequence with a bendpoint, assignments) round-trip the same way; ProA's
  factory never repeats an id over create, delete, re-create, append and a second session, the
  stock factory hands out `shape_1` again) and `e2e/value-chain.spec.ts` (15 tests against a
  server, see DEVELOPMENT.md).
- **Deviations from the plan:** M4 §9's import check "of both golden chains" runs on the dev
  chain and synthetic chains; the holdout chain is never read by S3, `PROA_E2E_VC_EXTRA=<path>`
  lets the owner run it with counts-only output. `PickerList` lives in `src/components/` (shared
  with the review screen's correction dialog), not under `value-chain/`. Badges and finding
  labels sit in one row above the step (two overlays collided in the 30 px gaps between
  sub-steps). The page's zoom controls and legend are main-bundle code, not part of the chunk.
  The renderer's copy-paste copies nothing in 0.3.0 (it has no `element.copy` rule), so pasting
  is not a path for ids or links today (§12). The layout-only re-save of the M4a done criterion
  moves a step with the keyboard (Shift+Arrow) in the Modeler.

**S3 review fixes** (2026-10-09, before the commit; folded into the bullets above): a restored
draft of a new chain was marked clean and deleted 300 ms later (dirtiness came from `canUndo()`,
which an import resets), and entering edit mode deleted the stored draft while the draft dialog
still asked (the import's `commandStack.clear` reached `onChange`); edits committed by the click
on "Fertig" or a link, and edits made while the dry run ran, were dropped silently; the impact
dialog opened during every save; the bulk re-confirm re-checked a placement the reviewer had
unchecked once its version moved (now keyed by id, as the M2 bulk accept); StrictMode (`pnpm
dev`) opened every chain unfitted; the value chain routes sat in the entry chunk; and keyboard and
reading issues: arrow keys in the link picker wrote a link per press and lost the focus, the draft
dialog focused "Verwerfen", the active card did not scroll into view, there was no keyboard way
back from a step, the tree made every step a tab stop, key hints showed while the keys did
nothing, "1 Prozess · 1 offen" stood next to "ohne Prozess" (now "nichts angenommen", and the
badge counts accepted and held placements as processes), "offen" counted differently in the tree
and the step view, two forms dropped the focus, import warnings covered the header, and the step
view had a second `h1`. Each fix has a test (component, the canvas unit test or Playwright).

**S4 checklist** (from S3; closed in "S4 as delivered" below, the holdout import check stays the
owner's):
- `eval:placements` and its report, `proa seed --value-chains` (unchanged scope).
- When the renderer, zod or schema-model is bumped, re-run `bundle.test.ts` (the chain-only
  budget has about 4 KB left: 36.1 of 40 KB; the entry ceiling 200 KB gzip, 192.9 KB used), the
  import harness and the CSS check; Playwright is not in CI.
- Run `PROA_E2E_VC_EXTRA=eval/value-chains/stadtwerke-auental/value-chain.vc.json pnpm
  --filter @proa/web e2e value-chain-import` once as the owner (counts only) to close the
  holdout gap of the import check.

**S4 as delivered** (2026-10-09). The placement eval, seeding of golden chains and German texts
for the rule tier; no schema, route or MCP change.
- **`eval:placements`** (`eval/tools/src/placements.ts` CLI, `placements-load.ts` loading and the
  validator spawn, `placements-score.ts` pure scoring, `placements-report.ts` Markdown and
  redaction; root script `pnpm eval:placements`; `eval/reports/placements.{md,json}`): gates,
  scoring and systems as §6. `loadLandscape` (metadata, `expected.yaml`, models, facts) is
  factored out of `runLandscape` and shared. Steps come from the golden document (schema-model
  `loadDocument`; a `hierarchy` connection runs parent → child), processes from the `process`
  facts (name = label, `null` when empty, as the server's `lexicalMatcher` sees them); the
  classification uses the yaml's steps, which the validator keeps equal to the document.
  `golden.contentHash` is the sha256 of the chain file. Options `--out`, `--no-write`, positional
  landscapes; relative paths against `INIT_CWD`. Exit 0 pass, 1 a failed gate or unreadable
  golden data (no message quotes the files), 2 a usage error (an unknown option, a landscape the
  corpus does not have) or a validator exit 2. Deterministic: sorted keys and items, `formatRatio`,
  no timestamps; two runs give the same bytes (test). CI runs it after `eval:replay` and fails on
  a diff or an untracked file in `eval/reports`.
- **Numbers** (dev, `nordwind-handel`, 32 processes): the rule tier proposes 4 (equal names), all
  hits (precision 100 %, recall 12.5 %). `baseline-prefix/1` with votes, top-1: 14 hit, 5 may,
  1 coarse, 7 trap, 5 wrong, 0 none: recall@1 43.8 %, precision@1 53.8 %, recall@3 65.6 %,
  level-0 recall@1 59.4 %; without votes: 15 hit, 3 may, 0 coarse, 7 trap, 4 wrong, 3 none:
  46.9 %, 57.7 %, 62.5 %, 56.3 %. Votes give the three processes without a lexical match a
  hint and lift level-0 recall, but cost one leaf hit (votes for the area of the neighbours'
  steps outweigh the process's own step). Level 0 can trap only the 3 processes with a top-level
  `must_not` (24 have one on some step): the top-1 lands in their trapped area for 3 of 3 with
  votes, 2 of 3 without. The holdout passes all three gates; its numbers are in the report.
- **One rule derivation.** `derivePlacementRules(steps {id, nameNorm, link}, processes {ref,
  label})` in `@proa/relations` (`placement.ts`) is the logic of S2's `derivedRulePlacements`
  without the texts; the server maps its steps, calls it and adds rationale and evidence, so the
  gate checks the code the server runs (the reasoning that put `baseline-prefix/1` there in S2).
  Signature, order and events of `derivedRulePlacements` are unchanged.
- **German server texts** (names and refs verbatim in „…“ through `quoteDe` in
  `@proa/relations`, straight quotes and backslashes included; only control characters,
  invisible format characters such as zero-width and bidi controls, line separators, lone
  surrogates and the closing `“` are escaped JSON-style, so a name with a line break stays
  visible and the quote ends where the name ends): the
  rule tier's placement rationale (`Schlüsselregel: der Link des Schritts nennt diesen Prozess
  (proa:process/<ref>); der Name des Schritts entspricht dem Prozessnamen (normalisiert: „…“).`)
  and its withdrawal reason; the value chain finding details (`Keine angenommene Platzierung auf
  einem Schritt der Wertschöpfungskette (kein Vorschlag)…`, `Auf „…“ ist kein Prozess
  angenommen.`, the three `unresolved-link` texts); the chain withdrawal reasons (`Schritt in
  Revision <n> entfernt`, `Wertschöpfungskette gelöscht`); the relation rule tier's finding
  details (`dynamic-call`, `unresolved-call`, `duplicate-process-id`, `dangling-throw`,
  `unmatched-catch`; relation rule assertions store no rationale, so these are the relation
  side's rule-tier texts). They address nobody, so no "du". Still English (HANDOFF follow-up): the
  pipeline and token reasons ("superseded by submission …", "agent token … revoked"), API error
  messages, MCP tool descriptions and CLI output. **Existing databases:** stored relation findings
  keep their English details until the next recompute (an ingest or deletion in the project).
  Undecided rule placement proposals (status `proposed`) with an English rationale are
  re-asserted in German at the next chain save that stores a revision or at the next model change
  (a new assertion, a version bump and a `placement.proposed` event; a reviewer deciding at that
  moment may get 409). A rule placement a human accepted, rejected or held keeps its English rule
  proposal in the history (the timeline shows it) until its step or process fingerprint changes:
  a rule proposal on unchanged fingerprints is suppressed under any human decision, a hold
  included, because it carries no basis (`classifyProposalOf`). No migration: the text is
  display-only.
- **Recordings.** The claim input carries the relation finding details and the agent-sim
  recordings store its `bytes`, so both committed recordings were re-recorded
  (`vitest … agent-sim.test.ts -u`); a count-only comparison with HEAD shows that only
  `input.bytes` changed (dev: 10 of 31 lines, at most 88,778 bytes of the 100 KB ceiling), and
  `eval:replay` leaves `eval/reports` unchanged. The claim format `proa-claim/1` and the skill are
  unchanged, so no procedure version bump. The German details land before the owner's M3 live
  runs, so every live run sees the same text.
- **`proa seed --value-chains`** (`apps/cli/src/commands/seed.ts`): after the model import (the rule
  tier sees the process facts when the chain is created) and before the token, per landscape it
  reads only `<dir>/<landscape directory>/value-chain.vc.json` (`DEFAULT_VALUE_CHAINS`, resolved
  like `DEFAULT_CORPUS`, so `/app/eval/value-chains` in the image; `--value-chains-dir` overrides
  it and needs `--value-chains`). `GET …/content`: 404 → `PUT` with `If-None-Match: *`
  (`created`, or `revived` for a deleted chain, which the output says); 200 → a dry run with
  `If-Match: "r<head>"`: `unchanged`, or `differs` ("exists r<n>, differs from the golden chain:
  left unchanged", exit 0; an edited chain is never overwritten, so a re-run changes nothing); a
  412 reads again (3 attempts); a 422 lists the violations (`explain` of `value-chain.ts`). A
  landscape without a chain (`_sample`) prints "no golden value chain". `SeedResult.valueChain`
  is `{outcome, rev}` or `null` without the flag. Works with `--project` for M4b live runs.
- **Image.** `docker/Dockerfile.dockerignore` excludes `eval/value-chains/**` and re-includes
  `eval/value-chains/*/value-chain.vc.json` (BuildKit honours it: verified with an image tagged
  `proa:s4-check`), and the runtime stage copies `eval/value-chains`. A chain file is no ground
  truth: steps without links, the document an agent reads over MCP once a project is seeded.
  CI's docker job runs `proa seed --value-chains` in the container and checks that the chain
  files are there and that no `expected.yaml`, `expected-placements.yaml`, `*.md`, `*.mjs` or
  `*.jsonl` is under `/app/eval`.
- **M4a evidence over MCP:** `value-chain-ingest.test.ts` proposes with `propose_placement` through
  the SDK client and an agent token, accepts over REST, re-imports the models unchanged (no event)
  and re-saves the layout only (one `value_chain.revised`): the placement stays accepted and `ok`,
  its timeline a proposal (agent) and a decision (human). The Playwright test
  `value-chain.spec.ts:819` proposes over REST; MCP shares the use case.
- **Tests:** `packages/relations/test/placement.test.ts` (`derivePlacementRules`: link, equal
  name, both reasons, several processes with one name, a pasted link, unknown or malformed links,
  empty names, input order), `rules.test.ts` and `text.test.ts` (the German details, `quoteDe`:
  quotes and backslashes verbatim, control and format characters, separators, lone surrogates
  and the closing `“` escaped); `apps/server/test/unit/value-chain-golden.test.ts`; the server's
  rule, findings and chain tests with the German strings; `eval/tools/test/placements.test.ts`
  (both landscapes pass on their gates, two runs identical, the holdout without per-item fields,
  rule tier numbers or per-tag numbers of a tag with fewer than 5 processes, in JSON and
  Markdown; every class on a synthetic chain, the metrics, the level-0 trap rate over top-level
  `must_not` only, failing gates, leave-one-out, an unranked set with confidence as S5 passes it,
  redaction);
  `apps/cli/test/unit/seed-status.test.ts` (created, unchanged, differs, revived, none, 412, 422,
  option misuse, `--help`) and the e2e test (`proa seed nordwind-handel --project vc-seed
  --value-chains` → created r1 with the four rule proposals; after the push test's r2 edit,
  `differs`).
- **Deviations from the plan:** the ProA rules check runs in a server unit test (§6);
  `loadPlacementRun` is not exported from the `@proa/eval-tools` entry, which only exports light
  modules (it extracts the corpus facts through `loadLandscape`, which loads bpmn-moddle): S5's
  eval:replay imports it from `src/placements-load.ts`, the pure scorer and its types are exported;
  level 0 is the lifted classification above (the plan said "the same numbers by area"); the
  report adds F1 (the README names it); the CI step also fails on untracked report files.

**S5 checklist** (from S4):
- Score recordings with `scorePlacementProposals(run.golden, items)`: the union of a run's valid
  items per (process, step), unranked, each with its confidence (a duplicate keeps the highest);
  `trapsHighConfidence` is the live gate's "no `must_not` at confidence ≥ 0.8"; load the run with
  `loadPlacementRun` (`eval/tools/src/placements-load.ts`).
- Check that a recording's chain content hash equals `golden.contentHash`; a run on an edited
  chain is not comparable.
- Decide which baseline row the live gate's "recall at least 20 points above `baseline-prefix/1`"
  uses. Recommendation: with votes, as §6 describes the baseline; report the row without votes
  next to it.
- The placement sections of `replay.md` show numbers only for the holdout, as `placements.md`
  does: no per-item lists and no number over fewer than `HOLDOUT_MIN_GROUP` (5) processes, so
  per-tag numbers only for large tags and nothing split over a handful of identifiable
  proposals.
- Seed fresh projects for live runs with `proa seed <landscape> --project <key> --value-chains
  --issue-tokens --token-name <run>`.

**M4a done criteria status** (2026-10-09; M4a is done, the CI confirmation follows the next push):

| Criterion | Status | Evidence |
|---|---|---|
| The golden `nordwind-handel` chain pushed with the CLI renders | done | DEVELOPMENT.md "M4 S3" item 1 (pushed r1, rendered by the page); `cli.e2e.test.ts` (push, pull byte for byte) |
| An edit saves revision 2 and a concurrent save gets 412 | done | S2's "concurrent saves" in `value-chain-api.test.ts` (one `If-Match` wins, the other gets 412), `value-chain.spec.ts:483` in the browser |
| A step deleted and re-added in a new session gets a fresh id and no old placements | done | `value-chain.spec.ts:631` |
| Placements proposed ad hoc over MCP and decided survive re-ingest and a layout-only re-save | done | `value-chain-ingest.test.ts` (S4, over MCP), `value-chain.spec.ts:819` (over REST) |
| The bpmn-js review screen passes its check after visiting the chain page | done | `value-chain.spec.ts:976` (the CSS check) |
| `eval:placements` is green in CI | green locally; CI pending | `pnpm eval:placements` passes and its report is committed with S4; the `ci-2.yml` step runs on the next push |

Owner action (counts only, closes S3's holdout gap of the import check):
`PROA_E2E_VC_EXTRA=eval/value-chains/stadtwerke-auental/value-chain.vc.json pnpm --filter @proa/web e2e value-chain-import`.

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

**Decided** (2026-10-09): the owner accepted every default below (HANDOFF §4 item 18).

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
   imports `diagram-js.css` itself); lower priority since the published packages inline the
   diagram-js version bpmn-js ships (§5).
2. A step `category` (`core`, `management`, `support`) in schema v2 with a migration, replacing
   the colour convention.
3. An optional step `description`, so agents see what reviewers see in the golden `scope`.
4. Collision-free generated ids (the per-instance counter reuses deleted ids).
5. Clearing `link` through the modeling API (the exporter falls back to `businessObject.link`).
6. `validateDocument` rejecting duplicate same-type, same-pair connections, as the format docs
   already say.

7. German (or any) labels for the palette, context pad and colour picker through diagram-js'
   `translate` service (S3: ProA's modeler shows English tooltips such as "Create step" and colour
   names such as "Purple"; the legend explains the colours).
8. The modeler's rules refusing a second connection of the same type in the reverse direction
   (`ft()` only checks the source's outgoing connections), which ProA refuses on save
   (`duplicate-connection`), as it refuses sequence cycles, a second hierarchy parent and depth
   > 2 that the modeler allows.
9. Copy and paste: the renderer registers `copyPaste` but no `element.copy` rule, so diagram-js
   copies nothing (S3 observation).

Not asked: `peerDependencies` for diagram-js (§5).
