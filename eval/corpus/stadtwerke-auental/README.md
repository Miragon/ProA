# stadtwerke-auental

**Holdout landscape, closed world.** Stadtwerke Auental is a fictional
municipal utility for power, gas, water and district heating. Its grid
subsidiary Auental Netz runs the grid service, the grid control centre and
metering (Messstellenbetrieb). 26 models, 84 expected relations (40 must_link,
39 must_not_link, 5 may_link), 7 findings and 5 data store groups.

The vocabulary is deliberately different from the other landscapes: house
connections, grid checks, meter setting, changes and removal, Befundprüfung,
meter reading, annual consumption billing, instalments (Abschläge), moves and
GPKE supplier switches as they ran before the 24-hour switch (LFW24, April
2025), fault reports and repair, PV feed-in, disconnection for non-payment and
tariff changes.

## Engines and teams

| Engine | Teams | Models |
|---|---|---|
| Camunda 8 (8.9) | Netz, Messwesen, Vertrieb, Marktkommunikation, Kundenservice, Sperrung | 16 |
| Camunda 7 (7.24) | Billing core (Abrechnung), receivables (Forderung) | 10 |

The two engines talk over a message bus with shared message names. The bus
adapter matches names after umlaut transliteration (ä → ae), because the C7
billing core cannot carry umlauts; that is why the C8 name
`ZählerwechselDurchgeführt` reaches the C7 `ZaehlerwechselDurchgefuehrt` and the
C7 `AbschlagGeaendert` reaches the C8 `AbschlagGeändert`. The C7 billing team
writes labels without umlauts ("Zaehler eingebaut", "Abschlag geaendert"); this
comes from a legacy migration. The C7 receivables team uses umlauts. The
customer portal and the e-invoice platform name their integration events in
English ("Meter reading submitted", "Invoice published").

## Models

| Model | Engine | Content |
|---|---|---|
| `netz/hausanschluss` | c8 | Collaboration (Anschlussnehmer, Installateur as black boxes), 3 lanes, document loop, call, offer with timer boundary, embedded construction subprocess, handover to metering |
| `netz/netzanschlusspruefung` | c8 | Called grid check: parallel Strom/Gas-Wasser assessment, grid reinforcement decision |
| `netz/pv-einspeisung` | c8 | PV registration: dynamic call, meter order, generic "Rückmeldung" wait with timer, MaStR confirmation, message to feed-in billing |
| `netz/stoerungsannahme` | c8 | Collaboration (caller as black box): fault intake, safety hints, repair order, escalation timer, outage event subprocess (signal) |
| `netz/entstoerung` | c8 | Single-pool collaboration with 2 lanes: assessment, signal throws "Großstörung" / "Großstörung beendet", embedded repair subprocess, report back |
| `messwesen/zaehlermontage` | c8 | First meter after a new connection: appointment with reminder timer, smart meter decision, message end to billing |
| `messwesen/zaehlerwechsel` | c8 | Timer and message start, swap or removal (message end "Zähler ausgebaut" to billing), umlaut message name, generic "Rückmeldung", Befundprüfung call to a process outside the landscape, outage event subprocess |
| `messwesen/zaehlerablesung` | c8 | Timer and message start, wait for the reading date, embedded subprocess with three reading modes and event-based gateway, call, routing by occasion to annual billing, final invoice or storage only |
| `messwesen/messwertplausibilisierung` | c8 | Called plausibility check with substitute values; flags meters past their calibration period ("Turnuswechsel fällig") |
| `vertrieb/tarifwechsel` | c8 | Tariff change: eligibility rule, timer on the switch date, interim reading, message to instalments |
| `vertrieb/umzug` | c8 | Collaboration (customer as black box): interim reading, move-out to final invoice, embedded subprocess ordering supply at the new address |
| `marktkommunikation/lieferantenwechsel` | c8 | Collaboration with two black-box market partners (UTILMD flows, GPKE before LFW24): losing supplier view, end of supply to final invoice, win-back in the CRM |
| `marktkommunikation/lieferbeginn` | c8 | Collaboration with the grid operator: registration, event-based answer, start of supply to billing |
| `kundenservice/kundenportal` | c8 | Portal integration: classification, three English message throws |
| `kundenservice/kundeninformation` | c8 | One file, two participant processes plus black-box customer: notification hub with four message starts (one with an umlaut message name); outage information started by signal |
| `forderung/sperrung` | c8 | Collaboration with 2 lanes (the grid subsidiary's field service works on the supplier's behalf): disconnection notice, event-based payment or deadline, disconnection, reconnection, outage event subprocess with signal catch |
| `forderung/mahnverfahren` | c7 | Dunning with timers, disconnection order, handover to an external collection agency (dangling message), interrupting payment event subprocess |
| `forderung/zahlungseingang` | c7 | Daily payment posting batch, payment and overdue messages |
| `abrechnung/jahresverbrauchsabrechnung` | c7 | Annual billing: dynamic output call, ambiguous instalment call, credit or back-payment |
| `abrechnung/abschlagsanpassung` | c7 | Current instalment process: none start (called) plus two message starts, message end |
| `abrechnung/archiv/abschlagsanpassung-2021` | c7 | Outdated copy with the same process id |
| `abrechnung/schlussrechnung` | c7 | Final invoice: two message starts, timer on the end-of-supply date, receive task with a 30-day safety timeout, static print call |
| `abrechnung/rechnungsausgabe-druck` | c7 | Print output with dispatch confirmation from the print provider |
| `abrechnung/rechnungsausgabe-digital` | c7 | XRechnung or portal upload, English "Invoice published" |
| `abrechnung/stammdatenuebernahme` | c7 | Billing intake with four message starts (meter installed, meter changed, meter removed, start of supply) |
| `abrechnung/einspeiseverguetung` | c7 | Feed-in tariff setup with direct marketing decision |

## Main end-to-end flows

1. **New connection and meter life cycle.** `netz/hausanschluss` calls
   `netz/netzanschlusspruefung`, builds the connection and hands over (trigger)
   to `messwesen/zaehlermontage`, whose "Zähler eingebaut" reaches
   `abrechnung/stammdatenuebernahme` (C7). A removal without replacement in
   `messwesen/zaehlerwechsel` reports "Zähler ausgebaut" to the same intake,
   which shuts the installation down.
2. **PV feed-in.** `netz/pv-einspeisung` calls the grid check dynamically,
   orders a bidirectional meter from `messwesen/zaehlerwechsel`, waits for its
   "Rückmeldung" and starts `abrechnung/einspeiseverguetung` (C7).
3. **Reading and annual bill.** `messwesen/zaehlerablesung` (yearly timer, no
   occasion, so the default branch) calls `messwesen/messwertplausibilisierung`
   and starts `abrechnung/jahresverbrauchsabrechnung` (C7). The bill goes out
   through `${ausgabeprozess}` (print or digital) and recalculates the
   instalment; both reach `kundenservice/kundeninformation` ("Invoice
   published", "Abschlag geaendert"). Portal readings enter the reading process
   as "Meter reading submitted". Meters past their calibration period are
   flagged in the Gerätestamm and picked up by the monthly rotation run of
   `messwesen/zaehlerwechsel`.
4. **Move and supplier switch.** `vertrieb/umzug` and
   `marktkommunikation/lieferantenwechsel` request an interim reading (occasion
   "schlussablesung", reading date the day after the last day of supply) and
   start `abrechnung/schlussrechnung` (C7). The final invoice waits for the
   end-of-supply date and then receives the final reading; because the reading
   process waits for its reading date first, the C7 receive task is already
   active when the message arrives (C7 does not buffer messages). It then calls
   the print output. A move within the supply area starts
   `marktkommunikation/lieferbeginn`, which reports to the billing intake.
5. **Tariff change.** `kundenservice/kundenportal` → `vertrieb/tarifwechsel` →
   interim reading on the switch date (occasion "tarifwechsel": stored in the
   meter data management for the next annual bill, no message back) and
   `abrechnung/abschlagsanpassung` (C7) → `kundenservice/kundeninformation`.
6. **Non-payment.** `forderung/zahlungseingang` (C7) starts
   `forderung/mahnverfahren` (C7), which orders `forderung/sperrung` (C8) or
   hands the debt to an external collection agency; payments stop dunning and
   disconnection; "Anlage gesperrt" / "Anlage entsperrt" go to the notification
   hub.
7. **Faults.** `netz/stoerungsannahme` → `netz/entstoerung` → "Rückmeldung"
   back. A major outage broadcasts "Großstörung" to four processes and
   "Großstörung beendet" to two.

## Traps

| Trap | Entries (model#element) | Expect |
|---|---|---|
| near-miss | `messwesen/zaehlerwechsel#End_ZaehlerAusgebaut` → `abrechnung/stammdatenuebernahme#Start_ZaehlerEingebaut` and `messwesen/zaehlermontage#End_ZaehlerEingebaut` → `#Start_ZaehlerAusgebaut` (Lev. 3 in label and message name, both message endpoints); `forderung/sperrung#Event_AnlageGesperrt` → `kundenservice/kundeninformation#Start_AnlageEntsperrt` and the reverse (Lev. 3); `marktkommunikation/lieferantenwechsel#Event_AbmeldungBestaetigt` → `marktkommunikation/lieferbeginn#Event_AnmeldungBestaetigt` (Lev. 1); `vertrieb/umzug#Event_AuszugGemeldet` → `#Start_UmzugGemeldet` (same process) | must_not_link |
| transliteration | `messwesen/zaehlerwechsel#Event_ZaehlerwechselDurchgefuehrt` (message "ZählerwechselDurchgeführt") → `abrechnung/stammdatenuebernahme#Start_ZaehlerwechselDurchgefuehrt` ("ZaehlerwechselDurchgefuehrt"); `abrechnung/abschlagsanpassung#End_AbschlagGeaendert` ("AbschlagGeaendert") → `kundenservice/kundeninformation#Start_AbschlagGeaendert` ("AbschlagGeändert"). Pairs with identical message names and only umlaut-free labels (e.g. "Zaehler eingebaut") are not tagged, because the key tier finds them anyway | must_link |
| de-en | `kundenservice/kundenportal#Event_MeterReadingSubmitted` → `messwesen/zaehlerablesung#Event_ZaehlerstandUebermittelt`; `#Event_TariffChangeRequested` → `vertrieb/tarifwechsel#Start_TarifwechselBeantragt`; `#Event_InstalmentChangeRequested` → `abrechnung/abschlagsanpassung#Start_AbschlagsaenderungGewuenscht`; `abrechnung/rechnungsausgabe-digital#Event_InvoicePublished` → `kundenservice/kundeninformation#Start_RechnungBereitgestellt` | must_link |
| event-def-mismatch | Type-plausible: `messwesen/messwertplausibilisierung#End_TurnuswechselFaellig` → `messwesen/zaehlerwechsel#Start_TurnuswechselFaellig` (identical label, trigger; the target is a timer start, which the facts put into the same kind `evt_start` as none starts). Type-incompatible (9): none end vs message start or catch, e.g. `netz/pv-einspeisung#End_EinspeiseanlageInBetrieb` → `abrechnung/einspeiseverguetung#Start_EinspeiseanlageInBetrieb` (identical label), plus hausanschluss, tarifwechsel, zaehlerwechsel, lieferantenwechsel, lieferbeginn, the archived instalment copy and the PV rejection; message throw vs timer catch: `marktkommunikation/lieferantenwechsel#Event_LieferendeGemeldet` → `abrechnung/schlussrechnung#Event_LieferendeErreicht`. The server's endpoint type check drops these nine deterministically, so they measure the type filter and the gain over `baseline-proa1`, not an agent's judgement | must_not_link |
| subprocess-scope | Negative: `netz/hausanschluss#End_HausanschlussFertiggestellt` → `messwesen/zaehlermontage#Start_HausanschlussFertiggestellt` (identical label); `messwesen/zaehlerablesung#End_ZaehlerstaendeErfasst` → `messwesen/messwertplausibilisierung#Start_ZaehlerstaendeErfasst` (identical label); `netz/entstoerung#End_VersorgungWiederhergestellt` → `kundenservice/kundeninformation#Event_GrossstoerungBeendet`. Positive counterparts (valid endpoints inside a subprocess, so an agent that filters too much loses recall here): the catch `messwesen/zaehlerablesung#Event_ZaehlerstandUebermittelt`, the send task `vertrieb/umzug#Task_BelieferungBeauftragen`, the typed event-subprocess starts in `forderung/mahnverfahren`, `netz/stoerungsannahme`, `forderung/sperrung` and `messwesen/zaehlerwechsel`, and the catch `forderung/sperrung#Event_GrossstoerungBeendet` inside an event subprocess | must_not_link (3), must_link (7) |
| call-unique | `netz/hausanschluss#Call_NetzanschlussPruefen`, `messwesen/zaehlerablesung#Call_MesswertePlausibilisieren`, `abrechnung/schlussrechnung#Call_SchlussrechnungDrucken` | must_link |
| call-dynamic | `abrechnung/jahresverbrauchsabrechnung#Call_RechnungAusgeben` (`${ausgabeprozess}`) → print and digital output; `netz/pv-einspeisung#Call_NetzvertraeglichkeitPruefen` (`=pruefprozess`) → grid check | may_link + dynamic-call |
| call-ambiguous | `abrechnung/jahresverbrauchsabrechnung#Call_AbschlagNeuFestsetzen` → `abrechnung/abschlagsanpassung` and `abrechnung/archiv/abschlagsanpassung-2021` (both `Process_Abschlagsanpassung`) | may_link + duplicate-process-id |
| call-unresolved | `messwesen/zaehlerwechsel#Call_BefundpruefungBeauftragen` (`Process_Befundpruefung`, the test lab coordination is outside the landscape) | finding only |
| cross-engine-message | 12 links with identical message names between C7 and C8, e.g. `messwesen/zaehlerablesung#Event_AblesedatenBereitgestellt` → `abrechnung/jahresverbrauchsabrechnung#Start_AblesedatenBereitgestellt`, `messwesen/zaehlerwechsel#End_ZaehlerAusgebaut` → `abrechnung/stammdatenuebernahme#Start_ZaehlerAusgebaut`, `forderung/mahnverfahren#End_SperrauftragErteilt` → `forderung/sperrung#Start_SperrauftragEingegangen`, `forderung/zahlungseingang#Event_ZahlungEingegangen` → two catches in `forderung/sperrung` | must_link |
| generic-name | message "Rueckmeldung": `netz/entstoerung#Event_RueckmeldungGesendet` → `netz/pv-einspeisung#Task_RueckmeldungErhalten` and `messwesen/zaehlerwechsel#Task_RueckmeldungSenden` → `netz/stoerungsannahme#Task_RueckmeldungErhalten` (the crossed pairs are the must_links); label "Anmeldung abgelehnt": `netz/pv-einspeisung#End_AnmeldungAbgelehnt` → `marktkommunikation/lieferbeginn#Event_AnmeldungAbgelehnt` | must_not_link |
| signal-broadcast | `netz/entstoerung#Event_GrossstoerungAusgerufen` → 4 catches (stoerungsannahme, sperrung, zaehlerwechsel, kundeninformation); `#Event_GrossstoerungBeendet` → 2 catches | must_link |
| collaboration | Participant processes of `netz/hausanschluss`, `netz/stoerungsannahme`, `netz/entstoerung`, `vertrieb/umzug`, `marktkommunikation/*`, `forderung/sperrung`, `kundenservice/kundeninformation` link to other files; their message flows to black-box pools are facts | links tagged collaboration |
| data-store-variants | 5 groups (below) | data_store_groups |
| self-link | `vertrieb/umzug#Event_AuszugGemeldet` → `vertrieb/umzug#Start_UmzugGemeldet` (Lev. 2) | must_not_link |
| trigger | `netz/hausanschluss#End_ZaehlersetzungBeauftragt` → `messwesen/zaehlermontage#Start_HausanschlussFertiggestellt` (handover, labels differ) | must_link |
| dangling-throw | `netz/pv-einspeisung#Task_MastrBestaetigen` (Marktstammdatenregister); `forderung/mahnverfahren#Task_ForderungAbgeben` (message "Inkassoauftrag" to an external collection agency) | finding |
| unmatched-catch | `kundenservice/kundenportal#Start_PortalRequestReceived`, `netz/pv-einspeisung#Start_AnmeldungEingegangen`, `abrechnung/rechnungsausgabe-druck#Task_VersandbestaetigungErhalten` | finding |

Further must_not_link distractors (20) cover the plausible confusions between
reading events ("Ablesedaten" vs "Zwischenstand bereitgestellt", a portal
self-reading vs the final reading), requests and their outcomes ("Tariff change
requested" vs "Tarif umgestellt", "Instalment change requested" vs "Abschlag
geändert"), start vs end of supply ("Lieferbeginn gemeldet" / "Lieferende
gemeldet", both directions), the two final invoice starts, the two invoice
output processes, a meter change vs installation or removal, overdue payment vs
disconnection, "Zählersetzung beauftragt" vs "Zählerwechsel beauftragt", the
crossed outage signals ("Großstörung" is a prefix of "Großstörung beendet") and
a trigger from the annual bill to the instalment process it already calls. The
closed world counts every other unlisted pair as must_not_link too; the listed
ones make the most likely mistakes visible per tag.

## Data stores

| Group | Labels |
|---|---|
| Kundenstamm IS-U | Kundenstamm IS-U, Geschäftspartner (IS-U), Kunden-Stammdaten |
| Gerätestamm | Gerätestamm, Zaehlerstammdaten |
| Messwerte | Messwertdatenbank, MDM-Messwerte |
| Netzinformationssystem | Netzinformationssystem, GIS Netzdaten, NIS |
| EEG-Anlagen | EEG-Anlagenstamm, Einspeiseanlagen EEG |

Grouping is closed world as well: a label that is in no group is a store of
its own. "CRM Kundenakte" (contact history, preferred channel, win-back),
"Marktpartnerstamm" (other market participants) and "Störungsdatenbank" are
separate stores, although the first two sound like customer or partner master
data. Only metering writes the device master; the C7 billing intake reads it
as "Zaehlerstammdaten" and writes installations and contracts to the IS-U
customer master.

## Checks and known limitations

`pnpm validate ../corpus/stadtwerke-auental` passes: specs, sync, parse,
bpmnlint (recommended plus camunda-compat 8.9 / 7.24, no overrides), DI,
expected.yaml and all 18 traps. The bpmn-js import check (zero warnings) was
run ad hoc before the review changes and has not been rerun since.
`pnpm deploy-check ../corpus/stadtwerke-auental` (eval/README.md) deploys all
26 models to camunda-bpm-platform run-7.24.0 and camunda/camunda 8.9.22, each
on its own and per engine together. The joint C7 deployment is rejected only
for the duplicate `Process_Abschlagsanpassung` (the call-ambiguous trap) and
passes with either copy. Deployable is not runnable: see the next point.

- **Variables across call activities.** The generator emits C8 call activities
  with `propagateAllChildVariables="false"` and no output mappings, and C7 call
  activities without `camunda:in` / `camunda:out`. Results of called processes
  therefore never reach the caller (the gateways after
  `netz/hausanschluss#Call_NetzanschlussPruefen` and
  `netz/pv-einspeisung#Call_NetzvertraeglichkeitPruefen` would raise
  incidents), and C7 called processes start without variables or business key.
  This needs a generator change (eval/tools) before the models run as demo
  instances; the relation facts are not affected.
- **Simplifications.** The yearly and monthly timer starts in
  `messwesen/zaehlerablesung` and `messwesen/zaehlerwechsel` stand for the
  reading and rotation runs; in production a batch starts one instance per
  reading unit or metering point. Variables such as `anlass`, `ablesetermin`
  or `lieferende` arrive as message payload.
- **Layout.** Remaining blemishes are cosmetic: a few message flows and data
  associations cross other shapes, and branch labels of the three-way splits
  in `messwesen/zaehlerablesung` may overlap.
