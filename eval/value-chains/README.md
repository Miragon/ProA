# Golden value chains

The classic process landscape map ("Prozesslandkarte") as a value chain
(Wertschöpfungskette, ARIS value-added chain diagram) for each scored test
landscape in `eval/corpus/`, together with the expected place of every process
on it. M4 places processes on value chain steps (a **placement**: step →
process; not to be confused with the modeler's `assignment` connection, which
links an org unit to a step). These files are the ground truth for that eval
(`eval:placements`), the same way `expected.yaml` is the ground truth for
relations, and they are the format authority for
[M4 §6](../../docs/proa-2/M4-VALUE-CHAIN.md).

```
eval/value-chains/
  README.md                     this file
  validate-value-chains.mjs     checks everything below (read-only)
  <landscape>/
    value-chain.vc.json         the value chain (@miragon/value-chain-schema-model)
    expected-placements.yaml    steps and the expected step of every process
```

| Landscape | Split | Level 0 (core + management + support) | Sub-steps | Org units | Processes | must (`@outside`) | may | must_not |
|---|---|---|---|---|---|---|---|---|
| `nordwind-handel` | dev | 6 + 2 + 4 | 22 | 12 | 32 | 32 (1) | 34 (22 processes) | 25 (24 processes) |
| `stadtwerke-auental` | holdout | 8 + 2 + 4 | 24 | 14 | 27 | 27 (1) | 18 (14 processes) | 31 (23 processes) |

`stadtwerke-auental` is the holdout landscape: its golden placements are scored,
never tuned against (eval/README.md). It is calibrated by the same written rules
as the dev landscape (the may rule and the derived tags below), fixed before any
agent run. It does **not** exercise prefix bias: every model folder there points
to the top-level step of its processes, and it has no `domain-prefix`,
`english-label`, support or management process. A prefix baseline is therefore
strong at level 0 on the holdout; prefix bias shows only on `nordwind-handel`.

## The value chains

Both are German, like the domains. Level 0 is the core chain (steps joined by
"ist Vorgänger von"), decomposed into level-1 sub-steps ("ist prozessorientiert
übergeordnet"), with a management band above and a support band below.

**Nordwind Handel** (wholesale and e-commerce):

| Core step | Sub-steps | Org unit |
|---|---|---|
| Beschaffung | Disposition, Bestellwesen, Lieferantenmanagement | Einkauf |
| Lagerhaltung | Wareneingang, Qualitätsprüfung, Bestandsführung | Lager Billbrook |
| Vertrieb | Auftragseingang, Auftragsabwicklung, Bonitätsprüfung, Partnermanagement | Online-Shop & Vertrieb |
| Versand | Kommissionierung, Paketversand, Speditionsversand | Logistik |
| Fakturierung & Zahlung | Rechnungsstellung, Zahlungseingang, Offene Posten, Mahnwesen | Debitorenbuchhaltung |
| Kundenservice | Reklamationen, Retouren, Kundeninformation | Service-Center |

Management: Unternehmenssteuerung (Controlling), Qualitätsmanagement
(Qualitätssicherung). Support: Rechnungswesen with Kreditorenbuchhaltung and
Hauptbuch & Abschluss (Finanzbuchhaltung), Zentrale Dienste (Zentrale Dienste:
print and letter output, mailroom), IT-Services (IT), Personal
(Personalabteilung).

**Stadtwerke Auental** (municipal utility with its grid subsidiary):

| Core step | Sub-steps | Org unit |
|---|---|---|
| Energiebeschaffung | none | Energiehandel |
| Netzanschluss | Hausanschlüsse, Netzverträglichkeit, Erzeugungsanlagen | Netzservice |
| Netzbetrieb | Störungsannahme, Störungsbehebung, Instandhaltung | Netzleitstelle |
| Messstellenbetrieb | Zählereinbau, Zählerwechsel, Ablesung, Messwertaufbereitung | Messwesen |
| Vertrieb | Tarifmanagement, Ein- und Auszug, Wechselmanagement | Vertrieb Privatkunden |
| Abrechnung | Stammdatenpflege, Turnusabrechnung, Schlussabrechnung, Abschläge, Rechnungsausgabe, EEG-Abrechnung | Kundenabrechnung |
| Forderungsmanagement | Zahlungseingang, Mahnwesen, Versorgungssperre | Debitorenbuchhaltung |
| Kundenservice | Self-Service, Kundenkommunikation | Kundencenter |

Management: Unternehmenssteuerung (Geschäftsführung), Regulierung (Stabsstelle
Regulierung). Support: Rechnungswesen (Finanzbuchhaltung), Einkauf & Material
(Zentraleinkauf), IT-Services (IT), Personal (Personalabteilung).

The Stadtwerke chain is **one chain across two market roles**: Auental Netz (grid
operator and default metering operator: Netzanschluss, Netzbetrieb,
Messstellenbetrieb) and the utility as supplier. M4 has one chain per project;
a split by market role (two chains, or bands with market communication as the
interface) is an open question for later (M4 §11). Two assumptions follow from
the single chain: billing is one shared service (EEG-Abrechnung also pays the
grid operator's feed-in tariffs, so Erzeugungsanlagen is a `may` for
Einspeisevergütung), and the core order follows the energy value chain
(procurement, grid, metering, sales, billing, receivables, service) with the grid
operator's steps kept together. Both chains therefore contain legitimate feedback
flows against the sequence (Nordwind: payment and invoice notices back to order
handling; Stadtwerke: interim readings requested by sales, portal requests); the
`sequence-contradiction` finding is deferred to R1 and will need expected
findings for them.

Steps without a process are deliberate: a value chain describes the business,
not only what is modelled, and these steps are realistic wrong answers
(`leaf steps without a must process` in the validator output).

## value-chain.vc.json

The document format of the
[value-chain-modeler](https://github.com/Miragon/value-chain-modeler) packages
(`@miragon/value-chain-schema-model`, `schemaVersion` 1; MIT): `meta.name`,
`elements` (`step` with optional `color`, `orgUnit`) and `connections`
(`sequence`, `hierarchy`, `assignment` from org unit to step) with waypoints.
Files are in the canonical form of `serializeDocument` (ids and keys sorted,
three decimals), so they open in the modeler and diff cleanly.

- **Ids** are stable ASCII kebab-case (`step-zaehlerwechsel`, `org-messwesen`,
  `hier-messstellenbetrieb-zaehlerwechsel`). The eval refers to step ids, never to
  names. `vc-root` (the renderer's root) and ids starting with `@` (ProA's
  pseudo-steps) are reserved.
- **Kinds.** Core steps carry no color; management steps are purple
  (`hsl(287, 65%, 44%)`) and support steps green (`hsl(150, 86%, 34%)`), both
  from the modeler's color picker. The kind of a step follows from that: the
  top-level sequence chain and its sub-steps are core, every other top-level step
  takes its kind from its color, and sub-steps inherit it. The schema has no kind
  field, so M4 derives the kind the same way (M4 §2) until the modeler offers an
  explicit step category; recoloring a top-level step off the chain changes its
  kind.
- **No `link`.** Steps carry no `link`: linking steps to processes is the job
  under test, and in M4 a `proa:process/…` link yields a key-tier proposal that
  would leak the answer.
- **No description.** The schema has no step description, so agents see step
  names only. The `scope` lines in `expected-placements.yaml` are for reviewers;
  where a scope decides between overlapping siblings, the alternative is a `may`.
- **Org units are owners**, the accountable area of a top-level step, not the
  performers of each sub-step (picking runs in the Billbrook warehouse but belongs
  to Versand, owned by Logistik). M4 shows them but does not use them as evidence
  for placements.
- **Geometry.** Top-level steps 220×64, sub-steps 220×60, org units 160×60;
  positions lie on a 10px grid (the 64px steps make their bottom edges end in 4).
  The chain runs left to right with 50px gaps; sub-steps form a column 120px
  right of the parent's left edge with 30px gaps (the column reaches 70px under
  the next top-level step), so the renderer draws the ARIS rake straight down from
  the parent's bottom center into each left notch. Every waypoint is exactly what
  `VcLayouter` plus contour cropping computes, so the import looks the same as
  after a re-layout. Labels wrap without cutting words and keep at least 8px from
  the notch apex.
- **Org units sit above their step** (40px gap), not below as the editor's
  "append org unit" places them: below each core step the rake of its sub-steps
  takes the space. The rule holds in all three bands.
- **Deviations from the renderer defaults**, all deliberate for readability:
  steps 220 wide instead of 160×60 (`DEFAULT_STEP_SIZE`), org units 160 instead
  of 130 wide, 50px instead of 45px gaps, org units above instead of below. An
  agent-written chain (M4 drafts) may follow either; ProA re-lays connections after
  import and checks nothing about sizes.
- **Sub-steps are not sequenced yet.** Order matters in some groups (Disposition →
  Bestellwesen, Rechnungsstellung → Zahlungseingang → Offene Posten → Mahnwesen,
  Zählereinbau → Ablesung → Messwertaufbereitung). The notation allows one
  sequence chain per sibling group, but sequenced groups read best as rows, and the
  layout check covers columns only; adding them waits for the row check.

## expected-placements.yaml

```yaml
landscape: nordwind-handel          # equals the directory name
value_chain: value-chain.vc.json
closed_world: true                  # a step not named in must or may counts as wrong

steps:                              # every step of the document, checked against it
  - id: step-bestellwesen
    name: Bestellwesen
    kind: core                      # core | management | support
    level: 1                        # 0 = top level
    parent: step-beschaffung        # superior step (hierarchy), level > 0 only
    scope: Purchase requisitions, approval and purchase orders to suppliers.

placements:                         # every process of the landscape, exactly once
  - process: einkauf/bestellanforderung#Process_Bestellanforderung   # <model_key>#<process_id>
    name: Bestellanforderung        # the BPMN process name, checked
    must: step-bestellwesen         # one leaf step (the most specific), or '@outside'
    may: [step-disposition]         # plausible alternatives: neither rewarded nor penalised
    must_not: [step-auftragseingang]  # named traps; a trap on a step covers its sub-steps
    tags: [name-match, ambiguous, shared-word]
    rationale: One line, why must is right and why the trap is wrong.
```

**One home per process.** Every process has exactly one `must`, including called
subprocesses and shared services: Kommissionierung, Mahnwesen, the invoice output
processes and Netzanschlussprüfung have their own steps, and the letter output
belongs to Zentrale Dienste. Being reached by a call from a placed process does
not replace a placement; M4 shows call coverage as a roll-up only.

**`@outside`** is the pseudo-step for "deliberately outside this chain". It can be
a `must` or a `may`, never a trap.

**Outdated copies.** A process id defined in two models (`call-ambiguous` in the
relation corpus) gets one entry per model. The archived copy has `must: '@outside'`
(the reason names the current version), `superseded_by: <ref of the current
version>`, the tag `outdated-copy`, and the current version's step as `may`, so
an agent that puts it next to the current version is tolerated but not rewarded.

**The may rule** (both landscapes, fixed before any agent run). `may` lists the
steps a reviewer would accept without objection:

1. **Hand-over.** The step of a process that calls this one (`call`, also as
   `may_link` in `expected.yaml`), and, for a `cross-domain` process, the step of a
   process that starts it at a top-level message start event. Signals (broadcasts),
   event subprocesses and outdated copies do not count. A step that is the must, an
   ancestor of it or inside a named trap stays out. The validator derives these
   from `expected.yaml` and requires them.
2. **Overlap.** A step whose scope covers part of the process's work
   (Bestellanforderung → Disposition, because it starts from the stock monitor;
   Customer account lock → Bonitätsprüfung, because a credit block is credit
   management). The rationale says why.
3. Never an ancestor of `must` (that is "too coarse"), never inside a trap.

**Traps** name a step a matcher would plausibly pick: a shared word or false
friend, a misleading folder, a step the process hands over to. Lures that fool
neither a lexical matcher nor an LLM (only "-eingang" in common) are left out,
because they inflate the trap hit rate's denominator.

**Tags.** Every placed process is `name-match` or `semantic`; a process outside
the chain is neither. The validator derives the tags marked *derived*:

| Tag | Meaning |
|---|---|
| `name-match` | *derived:* a word stem (at least 4 letters, after lower-casing and ä→ae, ö→oe, ü→ue, ß→ss) of the process name or model key (folders included) occurs in the must step's name and in no sibling step's name ("Mahnverfahren" → Mahnwesen, `kundenservice/…` → Kundenkommunikation next to Self-Service) |
| `semantic` | *derived:* no such stem; the must step follows from meaning only (other words, other language) |
| `ambiguous` | *derived:* `may` is not empty |
| `shared-word` | a must_not step is suggested by a shared word, stem or false friend ("Kredit" / "Kreditoren", "order" / "Bestellung", "Wechsel", "Lieferant"); needs a trap |
| `domain-prefix` | *derived:* a folder of the model key shares a stem with a step or org unit name in another top-level area, and with none in the must step's area (`finanzen/` → Finanzbuchhaltung on Rechnungswesen for invoicing and dunning, `lager/kommissionierung` → Lagerhaltung, `partner/customer-account-lock` → Partnermanagement) |
| `cross-domain` | the process serves or is triggered by several steps (shared subprocess, hub, event intake) |
| `outdated-copy` | *derived:* archived duplicate, `superseded_by` set |
| `support-process` / `management-process` | *derived:* must is a support / management step |
| `english-label` | English process name on a German value chain |
| `integration` | technical adapter, import or portal integration process |

## How it was built

1. Read each landscape's `README.md`, `landscape.yaml`, `expected.yaml`, the
   specs (process documentation, lanes, participants) and the generated models.
2. Designed the chain per domain: a wholesale order-to-cash and procure-to-pay
   chain for Nordwind, an energy value chain (procurement, grid, metering, sales,
   billing, receivables, service) for Stadtwerke. Steps are named the way the
   business names its areas, not copied from the processes, so a good part of the
   processes needs meaning rather than string matching (`semantic`: 13 of 31 and
   7 of 26 placed processes), and both maps contain steps that share words with
   processes they must not get.
3. Placed every process (BPMN `<process>` elements; black-box pools have none)
   with must, may, traps and a rationale, then applied the may rule and the
   derived tags to both landscapes.
4. Generated the geometry from the renderer's conventions (chevron notch depth
   `min(h/2, 0.4·w)`, `VcLayouter` rake rules, contour cropping) and serialized
   it with the upstream `serializeDocument`.
5. Rendered both documents once with the real renderer (value-chain-modeler
   0.1.0, commit `9983f71`, headless Chromium): no import warnings, every stored
   waypoint equal to a fresh `layouter.layoutConnection`, no label shortened.
   That one-off check is not reproducible from this repository yet; M4 S3 adds it as
   a Playwright test against the published renderer (moved from S0: the renderer
   needs a browser). The validator encodes the same rules.

## Validation

```sh
node eval/value-chains/validate-value-chains.mjs                  # all landscapes
node eval/value-chains/validate-value-chains.mjs nordwind-handel
node eval/value-chains/validate-value-chains.mjs --builtin        # the built-in schema copy only
node eval/value-chains/validate-value-chains.mjs --help
```

Node 24, after `pnpm install` at the repository root: this directory is no
workspace package, so the script resolves its dependencies from `eval/tools`,
whose `package.json` pins `@miragon/value-chain-schema-model` (0.3.0) and `yaml`
exactly. The script reads only. Exit code 1 means a finding in the data, 2 that
the check could not run as configured. `pnpm test` runs it in both modes
(`eval/tools/test/value-chains.test.mjs`) and round-trips both chains through the
package the way the server will store them
(`apps/server/test/unit/value-chain-schema-model.test.ts`). It checks:

- **Schema.** It imports `loadDocument` (migration, zod schema, cross-field rules)
  and `serializeDocument` from the npm package `@miragon/value-chain-schema-model`
  (its ESM build), resolved as `eval/tools` resolves it, and prints the package
  version next to the pin. A failed import, an installed version other than the
  pin (a stale `node_modules`), or a version outside `VERIFIED_SCHEMA_MODEL`
  (`0.1.0` and `0.3.0`; 0.2.0 and 0.3.0 publish the same files as 0.1.0) exits 2.
  `pnpm test` keeps the `eval/tools` pin equal to the server's and the web's
  (`apps/server/test/unit/runtime-pins.test.ts`), so this gate covers the release
  the server stores with. The built-in re-implementation of the same schema, migration check, cross-field
  rules (unique ids, endpoints, type matrix) and canonical serialization runs
  alongside: both must accept or reject each document alike and serialize it to
  the same bytes, and the output ends with `cross-check: the built-in
  re-implementation agrees with … on N of N documents`. `--builtin` uses the
  built-in copy alone, without the package (for diagnosis). Until M4 S0 the
  script imported the TypeScript source of a sibling `value-chain-modeler`
  checkout instead; that mode is gone.
- **Notation.** One core chain of 5–8 top-level steps and at most one sequence
  chain per group of sibling steps, never across groups; hierarchy is a forest,
  at most two levels deep, every parent has two or more sub-steps; one org unit
  per top-level step, every org unit assigned once; no duplicate relation; no
  reserved id; no step link.
- **Layout.** Sizes at least the editor minimum, shapes at least 10px apart,
  waypoints equal to the renderer route (row arrangements are reported as not
  covered), no edge through a foreign shape, labels laid out like diagram-js
  with Arial metrics: no cut word, lines fit the height and keep clear of the
  notch.
- **Placements.** Steps list equals the document (name, kind, level, parent);
  every process ref exists in `eval/corpus/<landscape>/models` (XML scan) with
  that name, and every process is listed exactly once; must is a leaf step or
  `@outside`, may are steps or `@outside` and no ancestor of must, must_not are
  steps, must and may lie outside every must_not subtree, no redundant trap; the
  may rule's hand-over steps (from `expected.yaml`); the derived tags and the tag
  rules above; outdated copies point to the single current version, lie outside
  and tolerate its step; rationale is one line of at most 300 characters.

`eval:placements` (M4 S4) will run the validator as part of its gate.

## Use in M4 (`eval:placements`)

M4 embeds the value-chain modeler and stores placements. The eval loads
`value-chain.vc.json` into a project seeded with the landscape (`pnpm seed`),
lets an agent propose placements over MCP (the same pipeline and provenance as
relations: agents propose, humans decide), and scores the proposals per process
against `expected-placements.yaml`:

| Proposal | Counts as |
|---|---|
| the must step (or `@outside` where that is the must) | hit (recall) |
| a may step | neutral |
| an ancestor of the must step | too coarse (reported, not a hit) |
| a step in a must_not subtree | wrong, and a trap hit reported per tag |
| any other step, or `@outside` where it is neither must nor may | wrong (closed world) |
| no proposal | miss |

Reported like `eval:candidates`: precision, recall and F1 overall, per tag and
per landscape, separately at level 0 (the top-level area of the proposed step)
and at the leaf, the trap hit rate, and the steps that attracted wrong proposals.
A `may` that a reviewer keeps rejecting, or a `must` that agents consistently
dispute with a good argument, is a change to these files with a rationale, not
a scoring exception.
