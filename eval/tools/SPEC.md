# Model spec format

One YAML file describes one BPMN model (one `.bpmn` file). Specs live in
`eval/corpus/<landscape>/spec/<model-key>.yaml`; `generate.mjs` turns each into
`eval/corpus/<landscape>/models/<model-key>.bpmn`, deployable on the declared
engine and with complete BPMN DI. The schema is in `lib/schema.mjs` (zod,
strict: unknown keys are errors), the semantic checks are in `lib/model.mjs`.

Write the spec, never the BPMN: `models/` is generated, and `validate.mjs` fails
when a model differs from a fresh generation.

## Top level

| Key | Required | Meaning |
|---|---|---|
| `key` | yes | Model key: lowercase slug segments separated by `/`. Must equal the spec path below `spec/` without `.yaml` (`spec/finanzen/rechnungsstellung.yaml` → `finanzen/rechnungsstellung`). Refs use it: `<key>#<id>`. |
| `engine` | yes | `c7` (Camunda 7) or `c8` (Camunda 8). Must be declared in `landscape.yaml` `engines`. |
| `engineVersion` | no | Overrides the landscape's version for this model, e.g. `8.8.0`. Supported: c7 7.19–7.24, c8 8.6–8.10. |
| `name` | no | `bpmn:definitions` name. |
| `notes` | no | Free text for authors (which traps the model carries). Not emitted. |
| `processes` | yes | One or more processes (below). More than one requires a collaboration. |
| `collaboration` | no | Pools and message flows (below). Required with more than one process or with lanes. |
| `lint.disable` | no | `[{rule, reason}]`: bpmnlint rules to switch off for this model, only for intentional traps. `reason` is mandatory; unknown rule names are errors. |

## Ids

Every id is an NCName without dots: `[A-Za-z_][A-Za-z0-9_-]*`, unique per file.
Use stable, meaningful ids with a type prefix (`Start_`, `End_`, `Event_`,
`Task_`, `Call_`, `Gateway_`, `Sub_`, `EventSub_`, `Boundary_`, `Lane_`,
`DataStore_`, `Participant_`, `Process_`); expected.yaml refers to them.

Generated ids, which your ids must not collide with:

| Element | Id |
|---|---|
| definitions | `Definitions_<key with / and - as _>` |
| collaboration (default) | `Collaboration_<key with / and - as _>` |
| sequence flow (default) | `Flow_<source>_<target>` |
| message flow (default) | `MessageFlow_<from>_<to>` |
| lane set | `LaneSet_<processId>` |
| event definition | `<eventId>_ed` |
| message / signal / error / escalation | `Message_<name>`, `Signal_<name>`, `Error_<code>`, `Escalation_<code>` (umlauts transliterated, other characters → `_`) |
| data associations | `DataInputAssociation_<activity>_<store>`, `DataOutputAssociation_<activity>_<store>`, `Property_<activity>` |
| DI | `<elementId>_di`, `BPMNDiagram_1`, `BPMNPlane_1` |

## Processes

```yaml
processes:
  - id: Process_Rechnungsstellung     # bpmn:process id (what calledElement targets)
    name: Rechnungsstellung
    isExecutable: true                # default true
    documentation: Free text.
    historyTimeToLive: "180"          # c7 only; default "180"
    lanes:                            # optional; requires a participant
      - { id: Lane_Buchhaltung, name: Buchhaltung }
    dataStores:                       # data store references of this process
      - { id: DataStore_Kundenstamm, name: Kundenstamm }
    elements: [...]                   # flow elements in list order
```

**Lanes.** With lanes, every top-level element sits in one lane. `lane:` sets
it; an element without `lane:` inherits the lane of the previous element in the
list, and the first element defaults to the first lane. Boundary events share
their host's lane. Nested elements (inside subprocesses) have no lane.

**Data stores.** Activities reference them with `reads: [...]` (data input
association, store → activity) and `writes: [...]` (data output association,
activity → store). Nested activities may use the process's stores. Label
variants of the same store across models go into `data_store_groups` of
expected.yaml.

## Elements

Every element has `type`, `id` and usually `name`; `documentation` is optional
everywhere. Names are required for all events, tasks and call activities, for
forking exclusive gateways and for conditional flows (bpmnlint
`label-required`).

| `type` | Extra keys | c7 output | c8 output |
|---|---|---|---|
| `startEvent` | event definition, `interrupting` (event subprocess only) | | |
| `endEvent` | event definition, `topic` (message ends) | message end: `camunda:type="external" camunda:topic` | message end: `zeebe:taskDefinition type` |
| `intermediateThrowEvent` | event definition, `topic` (message throws) | as message end | as message end |
| `intermediateCatchEvent` | event definition (required) | | message: `zeebe:subscription` on the message |
| `task`, `manualTask` | | | |
| `userTask` | `assignee`, `candidateGroups`, `form` | `camunda:assignee`, `camunda:candidateGroups`, `camunda:formKey` | `zeebe:userTask`, `zeebe:assignmentDefinition`, `zeebe:formDefinition externalReference` (default `custom:<topic>`) |
| `serviceTask`, `businessRuleTask` | `topic` | `camunda:type="external" camunda:topic` | `zeebe:taskDefinition type` |
| `sendTask` | `topic`, `message` | external task + `messageRef` | `zeebe:taskDefinition` + `messageRef` |
| `receiveTask` | `message` (required) | `messageRef` | `messageRef` + `zeebe:subscription` |
| `scriptTask` | `script`, `scriptFormat`, `resultVariable` | `scriptFormat` (default `groovy`), script (default `// no-op`) | `zeebe:script expression` (default `=true`), `resultVariable` (default `scriptResult`) |
| `callActivity` | `calledElement` (required), `binding`, `version`, `versionTag` | `calledElement`, `camunda:calledElementBinding/Version/VersionTag` | `zeebe:calledElement processId propagateAllChildVariables="false"`, `bindingType`, `versionTag` |
| `subProcess` | `elements` (required) | expanded subprocess | expanded subprocess |
| `eventSubProcess` | `elements` (required) | `triggeredByEvent="true"` | `triggeredByEvent="true"` |
| `exclusiveGateway`, `parallelGateway`, `eventBasedGateway` | | | |

Activities (all tasks, `callActivity`, `subProcess`) also take `reads`,
`writes` and `boundary`. Every element except end events and event subprocesses
takes `next`.

`topic` is the c7 external-task topic or the c8 job type. Default: the id
without its prefix, in kebab case (`Task_RechnungErstellen` →
`rechnung-erstellen`).

**calledElement.** A plain id is static (`Process_Rechnungsstellung`). An
expression is dynamic: c7 `${target}` or `#{target}`, c8 FEEL `=target`.
`binding`: c7 `latest | deployment | version | versionTag` (`version` and
`versionTag` need the matching key), c8 `latest | deployment | versionTag`.
On c8, `binding: deployment` with a static target needs that process in the
same file: Zeebe resolves it at deploy time and rejects the deployment
otherwise (c7 resolves it at runtime).

### Event definitions

At most one per event; none means a none event.

| Key | Form | Notes |
|---|---|---|
| `message` | `Name` or `{name, correlationKey}` | `correlationKey` is c8 only (FEEL, e.g. `"=orderId"`) and lands in `zeebe:subscription` on the `bpmn:message`; one key per message name and file. c8 needs it for every message used by a catch other than a process-level start, by a receive task, or by a message throw. |
| `signal` | `Name` or `{name}` | |
| `timer` | `{duration: P3D}`, `{cycle: R/P1D}` or `{date: 2030-01-01T00:00:00Z}` | c7 cycles may also be cron expressions. |
| `error` | `CODE` or `{code, name}` | Throws need a code; catches without a code catch all. |
| `escalation` | `CODE` or `{code, name}` | As error. |
| `conditional` | `"${ready}"` (c7) / `"=ready"` (c8), or `{condition, variableName}` | `variableName` is c7 only. c8 needs 8.9 or newer. |
| `terminate` | `true` | End events only. |

Allowed definitions by position:

| Position | Allowed | Timer forms |
|---|---|---|
| start, process level | none, message, signal, timer, conditional | cycle, date |
| start in an embedded subprocess | none (exactly one start) | |
| start in an event subprocess | message, signal, timer, error, escalation, conditional (exactly one start, typed) | interrupting: date, duration; non-interrupting: cycle, date, duration |
| end | none, message, signal, error, escalation, terminate | |
| intermediate throw | none, message, signal, escalation | |
| intermediate catch | message, signal, timer, conditional | duration, date |
| boundary | message, signal, timer, error, escalation, conditional | interrupting: duration, date; non-interrupting: cycle, date, duration |

There are no timer end events in BPMN. For a "timer vs message" trap, use a
timer start or a timer catch.

`interrupting` (default `true`) is allowed on boundary events and on start
events of event subprocesses; error events are always interrupting.

## Sequence flows

Flows are **linear by default**: an element without `next` flows to the next
element of the same list. Exceptions:

- End events never get an implicit successor.
- Start events, event subprocesses and boundary events are never implicit
  targets. An element followed by one of them needs `next:`, otherwise
  generation fails with "no outgoing sequence flow".
- `next: []` means "no outgoing flow", on purpose.

`next` is one id or a list. List items are ids or flow objects:

```yaml
next:
  - { to: Task_Freigeben, name: ja, condition: "${betrag < 1000}" }   # c7 expression
  - { to: Task_Pruefen, name: nein, default: true }
  - { to: Task_Other, id: Flow_Custom }                                # explicit flow id
```

Conditions are only allowed on flows leaving a forking exclusive gateway: every
such flow has a `condition` (c7 `${...}`, c8 FEEL `=...`) and a `name`, or is
the one `default: true` flow. Event-based gateways point to intermediate catch
events (c7: message, timer, signal, conditional; c8: message, timer). Flows
never cross (sub)process borders; targets must be in the same `elements` list.

Write paths that do not continue the main line after an end event, so that the
implicit chaining does not connect them:

```yaml
elements:
  - { type: startEvent, id: Start_A, name: Antrag eingegangen }
  - type: userTask
    id: Task_Pruefen
    name: Antrag prüfen
    boundary:
      - { id: Boundary_Frist, name: 3 Tage vergangen, timer: { duration: P3D }, interrupting: false, next: Task_Erinnern }
  - { type: endEvent, id: End_Geprueft, name: Antrag geprüft }
  - { type: serviceTask, id: Task_Erinnern, name: Erinnern }      # reached from the boundary event only
  - { type: endEvent, id: End_Erinnert, name: Erinnert }
```

Joins need a gateway: give a task at most one incoming flow (bpmnlint
`fake-join`). Boundary events: at most two per task or call activity (the
layout puts them on the bottom edge); `next` is required.

## Subprocesses and event subprocesses

`subProcess` and `eventSubProcess` carry their own `elements` list with the same
rules. An embedded subprocess has exactly one none start event. An event
subprocess has exactly one typed start event and no incoming or outgoing flows.
Start and end events inside either are never relation endpoints (CONCEPT §2),
which is what the `subprocess-scope` trap uses. Event subprocesses at process
level take a `lane` like any other element.

## Collaborations

```yaml
collaboration:
  id: Collaboration_Bestellung      # optional
  participants:
    - { id: Participant_Kunde, name: Kunde }                                  # black box, no process
    - { id: Participant_Shop, name: Online-Shop, process: Process_Shop }
  messageFlows:
    - { from: Participant_Kunde, to: Start_BestellungEingegangen, name: Bestellung }
    - { from: Task_BestaetigungSenden, to: Participant_Kunde, message: Bestaetigung }
```

Every process of the file must belong to exactly one participant. Message flows
connect participants or elements (also nested ones) of **different** pools.
Sources: participants, activities, message throw/end events. Targets:
participants, activities, message start/catch/boundary events. `message` on a
message flow sets its `messageRef`. Message flows are facts inside the file,
never cross-file relations.

## Deploy-time rules

Lint looks at one element at a time; the engines also check combinations.
`deploy-check.mjs` found these on camunda-bpm-platform run-7.24.0 and
camunda/camunda 8.9.22, and the generator rejects them up front:

- **Duplicate subscriptions** (c7 and c8): within one scope, no two catch
  events may wait for the same message name, signal name or condition. Scopes
  are the start events of a process, the event subprocess starts of one
  (sub)process, the boundary events of one activity, and the targets of one
  event-based gateway. Different scopes may share a name (a process start and
  an event subprocess start, a boundary event and an event subprocess).
- **One message start per name and file** (c7 and c8): a message name starts at
  most one process of the file. c7 enforces this across deployments too (per
  tenant), so a landscape whose c7 models start two processes with one message
  name fails the bundle step of `deploy-check`.
- **Straight-through loops** (c8): a sequence-flow cycle without a wait state
  is rejected. Plain and manual tasks, FEEL script tasks and every
  intermediate throw event (message throws included) count as pass-through;
  put a service, user, send, receive or business rule task, a call activity, a
  subprocess or a catch event into the loop. c7 accepts such loops.
- **Deployment binding** (c8): see calledElement above.

Duplicate process ids across files are fine one model at a time but make a
joint deployment fail on both engines; that is the `call-ambiguous` trap.

## Engine output in short

- **c7** (`modeler:executionPlatform="Camunda Platform"`): `xmlns:camunda`,
  `isExecutable="true"`, `camunda:historyTimeToLive`, external tasks for
  service/send/business-rule tasks and message throws, root `bpmn:message
  name`, `calledElement` (+ binding attributes).
- **c8** (`modeler:executionPlatform="Camunda Cloud"`): `xmlns:zeebe`,
  `zeebe:taskDefinition` on service/send/business-rule tasks and message
  throws, `zeebe:subscription correlationKey` on messages, `zeebe:calledElement
  processId propagateAllChildVariables="false"`, Camunda user tasks
  (`zeebe:userTask`) with a custom form reference.
- Both: `modeler:executionPlatformVersion` from the landscape (or
  `engineVersion`), complete DI, a header comment naming the spec, byte-stable
  output.

## Layout

The generator lays out every model itself, deterministically, left to right
(`lib/layout.mjs`). bpmn-auto-layout is not used because it supports neither
pools, lanes nor expanded subprocesses.

- Per (sub)process: cycles are broken in list order, layers follow the longest
  path, long edges reserve slots in the layers they cross, and rows are
  assigned per lane (the first successor stays on its predecessor's row,
  branches and boundary paths go below).
- Columns and rows are sized to their largest shape; shapes are centred in
  their cell, so straight paths stay straight.
- Edges are orthogonal and bend in the gaps between columns. Back edges loop
  below or above the rows, whichever crosses fewer shapes, on separate tracks.
- Expanded subprocesses and event subprocesses are laid out recursively. Event
  subprocesses sit in a band below the rows of their lane, data stores in a
  band below the rows of the lane that first uses them.
- Pools are stacked in participant order with equal width, lanes tile the pool
  body, and message flows run vertically and bend in the gap next to the
  source pool.

The order of `elements` therefore shapes the drawing only through the flows;
the layout depends on nothing but the spec, so a spec always gives the same XML.

## Complete example

A c8 collaboration with a black-box pool, lanes, a data store, a boundary
timer, an exclusive split and merge, an embedded subprocess, a message throw
and a message event subprocess. `pnpm test` generates, parses, lints and
DI-checks this exact block.

<!-- spec-example:start -->
```yaml
key: service/reklamation
engine: c8
name: Reklamationsbearbeitung
notes: Example from eval/tools/SPEC.md; checked by test/spec-doc.test.mjs.

collaboration:
  participants:
    - { id: Participant_Kunde, name: Kunde }
    - { id: Participant_Service, name: Kundenservice, process: Process_Reklamation }
  messageFlows:
    - { from: Participant_Kunde, to: Start_ReklamationEingegangen, name: Reklamation }
    - { from: Task_AntwortSenden, to: Participant_Kunde, name: Antwort }
    - { from: Participant_Kunde, to: Start_ReklamationZurueckgezogen, name: Rückzug }

processes:
  - id: Process_Reklamation
    name: Reklamationsbearbeitung
    documentation: Bearbeitet Kundenreklamationen bis zur Gutschrift oder Ablehnung.
    lanes:
      - { id: Lane_Service, name: Service }
      - { id: Lane_Fachabteilung, name: Fachabteilung }
    dataStores:
      - { id: DataStore_Crm, name: CRM Kunden }
    elements:
      - type: startEvent
        id: Start_ReklamationEingegangen
        name: Reklamation eingegangen
        message: Reklamation                 # process-level message start: no correlationKey needed
      - type: userTask
        id: Task_ReklamationPruefen
        name: Reklamation prüfen
        candidateGroups: service
        reads: [DataStore_Crm]
        boundary:
          - id: Boundary_Frist
            name: 5 Tage vergangen
            timer: { duration: P5D }
            interrupting: false
            next: Task_TeamleitungInformieren
      - type: exclusiveGateway
        id: Gateway_Berechtigt
        name: Berechtigt?
        next:
          - { to: Sub_Gutschrift, name: ja, condition: "=berechtigt" }
          - { to: Gateway_Antwort, name: nein, default: true }
      - type: subProcess
        id: Sub_Gutschrift
        name: Gutschrift erstellen
        lane: Lane_Fachabteilung
        elements:
          - { type: startEvent, id: Start_GutschriftAngefordert, name: Gutschrift angefordert }
          - { type: serviceTask, id: Task_GutschriftBuchen, name: Gutschrift buchen, writes: [DataStore_Crm] }
          - { type: endEvent, id: End_GutschriftGebucht, name: Gutschrift gebucht }
      - type: intermediateThrowEvent
        id: Event_GutschriftErteilt
        name: Gutschrift erteilt
        message: { name: GutschriftErteilt, correlationKey: "=kundennummer" }
        topic: gutschrift-melden
      - { type: exclusiveGateway, id: Gateway_Antwort, lane: Lane_Service }
      - { type: sendTask, id: Task_AntwortSenden, name: Antwort senden }
      - { type: endEvent, id: End_ReklamationErledigt, name: Reklamation erledigt }

      - { type: userTask, id: Task_TeamleitungInformieren, name: Teamleitung informieren }
      - { type: endEvent, id: End_TeamleitungInformiert, name: Teamleitung informiert }

      - type: eventSubProcess
        id: EventSub_Rueckzug
        name: Rückzug
        elements:
          - type: startEvent
            id: Start_ReklamationZurueckgezogen
            name: Reklamation zurückgezogen
            message: { name: ReklamationZurueckgezogen, correlationKey: "=kundennummer" }
          - { type: serviceTask, id: Task_VorgangSchliessen, name: Vorgang schließen }
          - { type: endEvent, id: End_VorgangGeschlossen, name: Vorgang geschlossen }
```
<!-- spec-example:end -->

The same model for c7 differs only in `engine: c7`, conditions written as
`"${berechtigt}"`, and no `correlationKey`s.
