# ProA eval corpus

Test landscapes of BPMN models for Camunda 7 and Camunda 8. They are the eval
corpus for relation detection (precision and recall per relation type and per
trap, CONCEPT §7) and demo data for ProA 2.0. Every model is written as a
compact YAML spec and generated into deployable BPMN with complete diagram
information; ground truth lives next to it in `expected.yaml`.

```
eval/
  README.md                  this file
  .gitignore                 tools/node_modules
  tools/                     workspace package @proa/eval-tools: spec format, generator, validator
    SPEC.md                  the spec format, with a complete example
    generate.mjs             spec -> BPMN
    validate.mjs             checks a landscape end to end
    deploy-check.mjs         deploys the models to real Camunda 7 and 8 engines
    engines.compose.yaml     those engines, for Docker
    src/candidates.ts        the eval:candidates gate (TypeScript, uses @proa/bpmn-facts and @proa/relations)
    lib/  test/
  reports/
    candidates.md, .json     last eval:candidates report (generated, deterministic)
  corpus/
    <landscape>/
      landscape.yaml         metadata (below)
      README.md              the landscape's story and its traps
      spec/<model-key>.yaml  source specs (edit these)
      models/<model-key>.bpmn  generated, never edited by hand
      expected.yaml          ground truth (below)
```

`_sample` is a three-model landscape that doubles as the toolchain's
regression test; it is not scored. Landscapes whose names start with `_` are
not part of the corpus.

## Working with the tools

Node 24 and pnpm 11. `eval/tools` is part of the repository's pnpm workspace:
install once at the repository root (`pnpm install`); dependencies are pinned to
exact versions (the root `pnpm-workspace.yaml` sets `saveExact`).

```sh
cd eval/tools

pnpm generate ../corpus/<landscape>          # spec/ -> models/ (also: a single spec file)
pnpm validate ../corpus/<landscape>          # full check, exit 1 on any error
pnpm generate:all && pnpm validate:all       # every landscape under corpus/
pnpm check                                   # generate --all --check: fail if models/ is stale
pnpm test                                    # _sample, generator fixtures, negative cases, SPEC.md example, src/
```

From the repository root, `pnpm eval:candidates` runs the LLM-free candidate gate
(CONCEPT §7) over every scored landscape: it extracts the facts, runs the rule tier,
the candidate generation and `baseline-proa1` (the 1.x algorithm) from
`@proa/relations`, and writes `reports/candidates.{md,json}`. It fails (exit 1) unless,
per landscape, the rule tier's accepted relations are all must_link or may_link (an
unlisted pair counts as wrong), no must_not_link is accepted, at least 98 % of the
must_link pairs are among rules ∪ candidates, `unresolved-call`, `dynamic-call` and
`duplicate-process-id` equal `expected_findings`, and every expected `dangling-throw`
and `unmatched-catch` is found (an extra one must be explained by a must_link or
may_link of that endpoint: the rule tier sees names only). The report also gives
recall within the key and lexical candidates and the same numbers for the baseline,
per relation type and per tag. Holdout landscapes are scored but never tuned against;
a miss that only the holdout shows is documented, not special-cased.

`generate` owns `models/`: it rewrites changed models and removes `.bpmn` files
without a spec. Output is byte-stable, so a diff in `models/` always means the
spec changed.

`validate` prints one line per section and the problems below it:

| Section | Checks |
|---|---|
| landscape | `landscape.yaml` against its schema, name equals the directory, README.md exists |
| specs | every spec against the zod schema and the semantic rules of SPEC.md |
| sync | every `models/*.bpmn` equals a fresh generation of its spec; no model without spec and vice versa |
| parse | bpmn-moddle with camunda-bpmn-moddle (c7) or zeebe-bpmn-moddle (c8): no warnings, no element or attribute from an unknown namespace, `modeler:executionPlatform` matches the spec's engine |
| lint | `bpmnlint:recommended` plus `bpmnlint-plugin-camunda-compat` for the model's engine and version (`camunda-platform-7-24`, `camunda-cloud-8-9`); errors and warnings fail |
| di | one diagram; DI for every participant, lane, flow node, data store, sequence flow, message flow and data association; valid bounds and waypoints; expanded subprocesses; shapes inside their pool, lane and subprocess; lanes tile their pool; boundary events on their host's border; edges start and end on their source and target |
| expected | refs resolve with the right kinds, findings hold, data store labels exist, closed-world completeness, trap coverage (below) |

**Lint overrides.** A spec may switch off a rule with
`lint.disable: [{rule, reason}]`, only where an intentional trap conflicts with
it, and the reason is mandatory. None are needed so far: every trap in the
catalog is expressible in lint-clean BPMN, because lint looks at one file and
traps live between files.

**Loading landscapes into ProA.** With a ProA server running locally,
`pnpm seed` (the `proa seed` CLI) creates one project per scored landscape,
named after `landscape.yaml`, and imports its `models/` through the REST API;
`pnpm seed _sample` loads the sample into project `sample`, and
`--issue-tokens` also creates a read+propose agent token per project for live
agent runs. Re-running it changes nothing. The server's integration test
`apps/server/test/integration/corpus.test.ts` checks that an import yields
exactly the rule relations and findings of `reports/candidates.json`. See
`docs/proa-2/DEVELOPMENT.md` for the owner key the CLI needs.

## Engines

| Engine | Version | Lint config | Docker image (used by deploy-check) |
|---|---|---|---|
| Camunda 7 | 7.24.0 | `camunda-platform-7-24` | `camunda/camunda-bpm-platform:run-7.24.0` |
| Camunda 8 | 8.9.0 | `camunda-cloud-8-9` | `camunda/camunda:8.9.22` (single orchestration-cluster image) |

7.24 is the newest Camunda 7 minor with a `run` image. 8.9 is the newest Camunda
8 minor with months of patch releases; it supports everything the spec format
emits, including conditional events (8.9+), signal catch events and Camunda
user tasks. A landscape sets its versions in `landscape.yaml`, and a spec can
override them with `engineVersion` (c7 7.19–7.24, c8 8.6–8.10).

## Deploy check

`validate` proves lint-clean BPMN; `deploy-check.mjs` proves that the engines
accept it. It needs Docker and about 3 GB of memory for both engines.

```sh
cd eval/tools
pnpm engines:up                            # docker compose -f engines.compose.yaml up -d --wait
pnpm deploy-check ../corpus/<landscape>    # one or more landscape directories; --json for a report as JSON
pnpm deploy-check:all                      # every landscape plus the generator fixtures (test/fixtures/stress)
pnpm engines:down                          # docker compose ... down -v: removes containers and volumes
```

`engines.compose.yaml` starts `camunda/camunda-bpm-platform:run-7.24.0` on
`127.0.0.1:18080` (REST `/engine-rest`, Cockpit `/camunda`, demo/demo) and
`camunda/camunda:8.9.22` on `127.0.0.1:18088` (REST `/v2`, Operate `/operate`,
demo/demo; gRPC on 26500), both on in-memory H2 and with unauthenticated APIs,
for local use only. `PROA_C7_PORT`, `PROA_C8_PORT`, `PROA_C8_GRPC_PORT` and
`PROA_C8_MGMT_PORT` move the host ports; deploy-check reads `PROA_C7_URL`
(default `http://127.0.0.1:18080/engine-rest`) and `PROA_C8_URL` (default
`http://127.0.0.1:18088`).

For each landscape and engine (taken from `modeler:executionPlatform`),
deploy-check runs two steps:

1. **Each model on its own.** c7: `POST /engine-rest/deployment/create` with
   the landscape name as tenant id; c8: `POST /v2/deployments`. Each
   deployment is deleted again right after the check (c7 with cascade, c8
   through `/v2/resources/{key}/deletion`), so models never see each other.
2. **All models of the engine in one deployment**, which surfaces conflicts
   between files. Duplicate process ids make both engines reject it. If
   `expected.yaml` lists exactly those models in a `duplicate-process-id`
   finding, that is the `call-ambiguous` trap and counts as expected; the
   bundle is then deployed once per copy (all other models plus that copy).

A deployment passes when the engine accepts it and creates one process
definition per executable process. A directory without `models/` (the
generator fixtures) is generated in memory. Exit code 1 means an unexpected
rejection and 2 an unreachable engine. `--keep` leaves the first passing bundle
per landscape and engine deployed as demo data. c7 keeps landscapes apart by
tenant, but c8 has no tenants here, so on c8 keep one landscape at a time,
because the landscapes reuse process ids. Operate keeps listing deleted
definitions as history.

Deployable does not mean runnable. Call activities have no variable mappings,
and there are no job workers or forms (see the landscape READMEs).

Last run (2026-10-06, run-7.24.0 and 8.9.22), per model on its own and per
engine together:

| Landscape | Camunda 7 | Camunda 8 |
|---|---|---|
| `_sample` | 2/2; together ok | 1/1; together ok |
| `nordwind-handel` | 17/17; together rejected as expected (`Process_Bestellfreigabe` in two models), ok with either copy | 14/14; together ok |
| `stadtwerke-auental` | 10/10; together rejected as expected (`Process_Abschlagsanpassung` in two models), ok with either copy | 16/16; together ok |
| `test/fixtures/stress` | 2/2; together ok | 2/2; together ok |

The runs also showed engine rules that lint does not check: duplicate
subscriptions in one scope, one message start per name, straight-through loops
on c8, and the c8 deployment binding. The generator now rejects these up front
(`tools/SPEC.md`, section "Deploy-time rules").

## landscape.yaml

```yaml
name: billing-de             # equals the directory name
description: >-
  What the landscape is about, who the teams are.
lang: de                     # de | en | mixed
split: dev                   # dev | holdout
closed_world: true           # unlisted cross-process endpoint pairs count as must_not_link
engines:
  c7: 7.24.0
  c8: 8.9.0
traps_not_applicable:        # optional: trap tag -> reason
  call-ambiguous: no outdated copies in this landscape
```

## expected.yaml

```yaml
relations:
  - type: message                       # call | message | signal | trigger
    from: vertrieb/auftragsabwicklung#Event_WareVersandbereit
    to: finanzen/rechnungsstellung#Start_WareVersandbereit
    expect: must_link                   # must_link | must_not_link | may_link
    tags: [cross-engine-message]        # at least one; trap or extra tag
    rationale: Why this is (not) a link.

expected_findings:
  - kind: unresolved-call               # unresolved-call | dynamic-call | duplicate-process-id | dangling-throw | unmatched-catch
    refs: [finanzen/rechnungsstellung#Call_Mahnwesen]
    tags: [call-unresolved]
    rationale: Process_Mahnwesen is defined nowhere.

data_store_groups:
  - name: Kundenstamm
    labels: [Kundenstamm, Kunden-Stammdaten, CRM Kunden]
    tags: [data-store-variants]
    rationale: Same customer master data, three names.
```

**Refs** are `<model_key>#<element_id>` for elements and
`<model_key>#<process_id>` for processes. The model key is the path below
`models/` without `.bpmn`: lowercase slug segments such as
`finanzen/rechnungsstellung`.

**Relation types and endpoints** (CONCEPT §2):

| type | from | to |
|---|---|---|
| `call` | call activity | process |
| `message` | message throw: intermediate throw, message end, send task | message catch: message start (also of an event subprocess), intermediate catch, boundary, receive task |
| `signal` | signal intermediate throw or end | signal start (also of an event subprocess), intermediate catch, boundary |
| `trigger` | labelled none end | labelled none start (agents only, no rule) |

For `must_link` and `may_link` the validator enforces these kinds strictly, and
the endpoints must lie in different processes. Start and end events inside an
embedded subprocess or an event subprocess are never endpoints, except the
typed start of an event subprocess. A message flow inside one collaboration
file is a fact, not a relation; listing such a pair is an error. A `must_link`
call needs a static `calledElement` equal to the target process id; dynamic
calls are at most `may_link`.

`must_not_link` entries are checked loosely: `from` must be an end, throw or
call and `to` a start, catch or process, in any scope and in any process (also
the same one, for `self-link`). `type` names the relation an agent would most
plausibly propose by mistake.

**Findings.** `unresolved-call` (static calledElement matching no process id),
`dynamic-call` (expression) and `duplicate-process-id` (same id in two or more
models, all refs in one finding) are recomputed by the validator and must match
exactly. `dangling-throw` and `unmatched-catch` refs must be message or signal
throws and catches without a `must_link` or `may_link`.

**Closed world.** With `closed_world: true` the validator also requires:

- every key-tier candidate to be listed with some `expect`: a throw and a catch
  with the same message or signal name in different processes (unless an
  internal message flow connects them), and every static calledElement that
  matches a process id;
- every message and signal throw or catch endpoint to have a `must_link` or
  `may_link`, an internal message flow, or a `dangling-throw` /
  `unmatched-catch` finding.

**Trap coverage.** Every trap tag of the catalog must appear in
`expected.yaml` or be listed in `traps_not_applicable` with a reason.

**Extra tags** for entries that are not traps: `exact-key` (plain key-tier
link), `lexical` (similar labels, no identical key), `semantic` (same meaning,
other words, same language), `distractor` (plausible must_not_link not covered
by a catalog trap).

## Trap catalog

Every landscape must embed and tag each applicable trap at least once (tag
names in brackets).

- **[near-miss]** labels within Levenshtein <= 4 but different meaning ("Auftrag eingegangen" vs "Auftrag abgelehnt", "Order received" vs "Order rejected", "Invoice paid" vs "Invoice sent") -> must_not_link.
- **[transliteration]** umlaut/ß variants of the same event ("Antrag prüfen"/"Antrag pruefen", "Gemäß"/"Gemaess") -> must_link.
- **[de-en]** German/English pairs meaning the same ("Rechnung versendet" / "Invoice sent") across teams -> must_link (semantic tier).
- **[event-def-mismatch]** same or similar label but incompatible event definitions (timer end vs message start; none end vs message start) -> must_not_link (or may_link with rationale).
- **[subprocess-scope]** start/end events inside an embedded subprocess or event subprocess that match labels of other processes -> must_not_link.
- **[call-unique]** static calledElement (C7 calledElement="id"; C8 `<zeebe:calledElement processId="id"/>`) matching exactly one process id -> must_link (rule tier).
- **[call-dynamic]** calledElement as expression (C7 "${target}"; C8 processId="=target") -> may_link to plausible candidates + finding dynamic-call.
- **[call-ambiguous]** the same process id defined in two models (e.g. an outdated copy) -> may_link to both + finding duplicate-process-id.
- **[call-unresolved]** calledElement pointing to a process that does not exist -> finding unresolved-call, no link.
- **[cross-engine-message]** identical message name between a C7 and a C8 model (integration via message bus) -> must_link (key tier).
- **[generic-name]** a generic message/label reused with different meanings ("Antwort erhalten", "Daten aktualisiert") -> must_not_link between unrelated pairs.
- **[signal-broadcast]** one signal thrown, caught in several processes -> must_link each.
- **[collaboration]** collaboration file with participants + message flows (internal facts), where one participant process ALSO talks to other files -> cross-file links from the participant elements only.
- **[data-store-variants]** data store label variants of the same store ("Kundenstamm", "Kunden-Stammdaten", "CRM Kunden") -> data_store_groups.
- **[self-link]** a process whose own end/start labels match -> must_not_link.
- **[trigger]** labelled none end -> labelled none start in another process meaning a handover ("Auftrag freigegeben") -> must_link or may_link (agents only).
- **[dangling-throw]/[unmatched-catch]** message thrown with no receiver / catch with no sender -> findings.

BPMN has no timer end events, so the generator rejects them. Build the "timer
vs message" variant of event-def-mismatch from a timer start or a timer catch.

## Adding a landscape

1. Create `corpus/<name>/` with `landscape.yaml`, `README.md` and
   `spec/<model-key>.yaml` per model (format: `tools/SPEC.md`).
2. `pnpm generate ../corpus/<name>`; open a few models in Camunda Modeler.
3. Write `expected.yaml`: every plausible link, every trap entry and every
   finding. Each `must_not_link` needs the reason a matcher would fall for it.
4. `pnpm validate ../corpus/<name>` until it passes.
5. `pnpm engines:up && pnpm deploy-check ../corpus/<name>`; a rejection that is
   not an intentional trap is a spec or generator bug. Commit specs, models
   and expected.yaml together.
