# nordwind-handel

Nordwind Handel GmbH is a fictional mid-sized wholesale and e-commerce company
in Hamburg, halfway through its migration from Camunda 7 to Camunda 8.

- **Camunda 7 (7.24, German labels):** finance (invoicing, receivables,
  dunning, cash application, credit check, credit notes, supplier invoices,
  payment run, month-end closing, output channels), controlling, procurement
  (requisition, approval, supplier onboarding) and the legacy pallet freight
  process.
- **Camunda 8 (8.9):** the newer teams. The shop, shipping, returns and
  partner teams model in English; warehouse, complaints and quality model in
  German.

The two engines talk over a message bus. Message names follow the legacy C7
integration contract (`KreditpruefungAngefordert`, `LieferungVersendet`,
`ZahlungZugeordnet`, ...), so English C8 events often carry German message
names. That is where most of the cross-engine traps come from. Call
activities stay within one engine; shared subprocesses (picking, parcel
shipping, letter output, dunning, order approval) are reused by several
callers.

31 models (32 processes): 17 C7, 14 C8, closed world, split `dev`.

## Main end-to-end flows

1. **Order to cash.** `vertrieb/marketplace-order-import` or the customer →
   `vertrieb/order-handling` (C8) → credit check in `finanzen/kreditpruefung`
   (C7) → `lager/kommissionierung` → `logistik/shipping` (parcels) or
   `logistik/speditionsversand` (pallets, C7) → `finanzen/rechnungsstellung`
   (C7) → `finanzen/forderungsmanagement` → `finanzen/mahnwesen` →
   `partner/customer-account-lock` (C8). `finanzen/zahlungseingang` reports
   allocated payments to receivables, dunning and the shop.
2. **Procure to pay.** `lager/bestandsueberwachung` (C8) →
   `einkauf/bestellanforderung` (C7) → `einkauf/bestellfreigabe` →
   `lager/wareneingang` (C8) → `qualitaet/wareneingangspruefung` (blocked
   goods end with a BPMN error and go back to the supplier) →
   `finanzen/lieferantenrechnung` (C7) ↔ `finanzen/zahlungslauf`.
3. **After sales.** `service/reklamation` (C8, German) → credit note in
   `finanzen/gutschrift` (C7), replacement via `service/ersatzlieferung`, or
   return via `service/returns` (C8, English). Parcel delays reach
   `service/kundenbenachrichtigung`.
4. **Quality and closing.** `qualitaet/produktrueckruf` broadcasts a C8
   signal; `finanzen/monatsabschluss` broadcasts a C7 signal and hands over to
   `controlling/management-reporting`.

## Models

| Model | Engine | Shape | Notes |
|---|---|---|---|
| `finanzen/rechnungsstellung` | c7 | process | message start, dynamic call, de-en throw, signal event subprocess |
| `finanzen/forderungsmanagement` | c7 | process | event-based gateway, unresolved call, unmatched chargeback catch |
| `finanzen/mahnwesen` | c7 | process | loop over dunning levels, message end to C8 |
| `finanzen/zahlungseingang` | c7 | process | cron timer start, two send tasks (one dangling) |
| `finanzen/kreditpruefung` | c7 | collaboration, 2 executable pools (credit check, credit agency adapter) | answers two C8 requesters; same-name pairs inside the file joined by message flows; generic `Antwort` |
| `finanzen/gutschrift` | c7 | process | two senders (de and en), message end |
| `finanzen/lieferantenrechnung` | c7 | collaboration (supplier), 2 lanes | status check before the transliteration catch, semantic throw |
| `finanzen/zahlungslauf` | c7 | process | timer and message start, dangling bank file |
| `finanzen/monatsabschluss` | c7 | process | signal broadcast, trigger end |
| `finanzen/e-rechnung-versand` | c7 | process | dynamic call target |
| `finanzen/briefversand` | c7 | process | shared letter output |
| `controlling/management-reporting` | c7 | process | trigger start |
| `einkauf/bestellanforderung` | c7 | collaboration (supplier), 2 lanes | two starts, ambiguous call, trigger end |
| `einkauf/bestellfreigabe` | c7 | single pool, 3 lanes | current approval process |
| `einkauf/archiv/bestellfreigabe-2019` | c7 7.19 | process | outdated copy with the same process id |
| `einkauf/lieferantenanlage` | c7 | process | labels without umlauts |
| `logistik/speditionsversand` | c7 | collaboration (forwarder) | legacy pallet freight |
| `vertrieb/order-handling` | c8 | collaboration (customer) | hub of order to cash, three event subprocesses |
| `vertrieb/marketplace-order-import` | c8 | process | unmatched webhook start, dangling rejection |
| `lager/kommissionierung` | c8 | single pool, 3 lanes | embedded packing subprocess, signal event subprocess |
| `lager/wareneingang` | c8 | process | timer boundary, error boundary on the inspection call, embedded putaway subprocess with the subprocess-scope start |
| `lager/bestandsueberwachung` | c8 | process | timer start, message throw to C7 |
| `logistik/shipping` | c8 | collaboration (carrier) | embedded handover subprocess, receive tasks |
| `service/returns` | c8 | process | dynamic call, de-en send task |
| `service/reklamation` | c8 | collaboration (customer), 2 lanes | parallel split, generic `Antwort` |
| `service/ersatzlieferung` | c8 | process | reuses picking and shipping |
| `service/kundenbenachrichtigung` | c8 | process | delay notification |
| `partner/partner-onboarding` | c8 | process | umlaut message name, self-link near-miss |
| `partner/customer-account-lock` | c8 | process | started from C7 dunning |
| `qualitaet/wareneingangspruefung` | c8 | process | called by goods receipt, error end `WARE_GESPERRT`, none end "Ware freigegeben" |
| `qualitaet/produktrueckruf` | c8 | process | signal broadcast, parallel gateway |

## Embedded traps

Refs are `<model>#<element>`. `expected.yaml` has all 77 relations (42
must_link, 28 must_not_link, 7 may_link), 10 findings and 4 data store groups;
this table lists one or more representative entries per trap.

| Trap | Expect | Entry |
|---|---|---|
| near-miss | must_not_link | `vertrieb/marketplace-order-import#End_OrderRejected` → `vertrieb/order-handling#Start_OrderReceived` ("Order rejected" vs "Order received") |
| near-miss | must_not_link | `logistik/speditionsversand#Event_LieferungVersendet` → `service/kundenbenachrichtigung#Start_LieferungVerspaetet` ("versendet" vs "verspätet"), and the reverse `LieferungVerspaetet` → invoicing |
| near-miss | must_not_link | `finanzen/zahlungslauf#Event_ZahlungAngeordnet` → the three `ZahlungZugeordnet` catches (outgoing vs incoming payments), and the reverse |
| near-miss | must_not_link | `finanzen/zahlungseingang#Task_KundensperreAufheben` (`KundeEntsperrt`) → `partner/customer-account-lock#Start_CustomerBlocked` (`KundeGesperrt`) |
| near-miss, self-link | must_not_link | trigger `partner/partner-onboarding#End_ApplicationRejected` → `#Start_DealerApplicationReceived` ("Dealer application rejected" vs "received", own end and start; the only label-only near-miss) |
| transliteration | must_link | `partner/partner-onboarding#Task_RequestCreditCheck` (`KreditprüfungAngefordert`) → `finanzen/kreditpruefung#Start_KreditpruefungAngefordert` |
| transliteration | must_link | `lager/wareneingang#Event_WareneingangGeprueft` (`WareneingangGeprüft`) → `finanzen/lieferantenrechnung#Event_WareneingangGeprueft` |
| transliteration, trigger | must_link | `einkauf/bestellanforderung#End_NeuerLieferantBenoetigt` ("benötigt") → `einkauf/lieferantenanlage#Start_NeuerLieferantBenoetigt` ("benoetigt") |
| de-en | must_link | `finanzen/rechnungsstellung#Event_RechnungVersendet` → `vertrieb/order-handling#Start_InvoiceSent` |
| de-en | must_link | `service/returns#Task_RequestCreditNote` (`CreditNoteRequested`) → `finanzen/gutschrift#Start_GutschriftAngefordert` |
| event-def-mismatch | must_not_link | `service/ersatzlieferung#End_LieferungVersendet` (none end) → `finanzen/rechnungsstellung#Start_LieferungVersendet` (message start) |
| event-def-mismatch | must_not_link | `logistik/speditionsversand#End_LieferungVerspaetet` (none end) → `service/kundenbenachrichtigung#Start_LieferungVerspaetet` |
| subprocess-scope | must_not_link | trigger `qualitaet/wareneingangspruefung#End_WareFreigegeben` (process-level none end) → `lager/wareneingang#Start_EinlagerungGestartet` (none start "Ware freigegeben" inside `Sub_Einlagerung`): identical label and compatible kinds, only the scope rules it out |
| event-def-mismatch, subprocess-scope | must_not_link | `lager/kommissionierung#End_WareVersandbereit` (none end inside `Sub_Verpacken`) → `logistik/speditionsversand#Start_WareVersandbereit` and `logistik/shipping#End_ShipmentDispatched` (none end inside `Sub_CarrierHandover`) → `finanzen/rechnungsstellung#Start_LieferungVersendet`: excluded by kind already, so they do not test scope alone |
| call-unique | must_link | 9 static calls, e.g. `vertrieb/order-handling#Call_PickAndPack` → `lager/kommissionierung#Process_Kommissionierung`, `finanzen/mahnwesen#Call_MahnungVersenden` → `finanzen/briefversand#Process_Briefversand` |
| call-dynamic | may_link + finding | `finanzen/rechnungsstellung#Call_RechnungAusgeben` (`${ausgabekanal}`) → e-invoice and letter output; `service/returns#Call_ShipExchangeItem` (`=exchangeProcess`) → `service/ersatzlieferung#Process_Ersatzlieferung` |
| call-dynamic | must_not_link | `service/returns#Call_ShipExchangeItem` → `logistik/shipping#Process_Shipping` (lexically closest, but skips the replacement order and picking) |
| call-ambiguous | may_link + finding | `einkauf/bestellanforderung#Call_Bestellfreigabe` → `Process_Bestellfreigabe` in `einkauf/bestellfreigabe` and `einkauf/archiv/bestellfreigabe-2019` |
| call-unresolved | finding | `finanzen/forderungsmanagement#Call_Inkasso` (`Process_Inkasso`), `vertrieb/order-handling#Call_FraudCheck` (`Process_FraudCheck`) |
| call-unresolved | must_not_link | `vertrieb/order-handling#Call_FraudCheck` → `finanzen/kreditpruefung#Process_Kreditpruefung` (no semantic substitute for the missing target) |
| cross-engine-message | must_link | 14 links (2 of them also transliteration: same `key_norm`), e.g. `vertrieb/order-handling#Task_RequestCreditCheck` → `finanzen/kreditpruefung#Start_KreditpruefungAngefordert`, `finanzen/mahnwesen#End_KundeGesperrt` → `partner/customer-account-lock#Start_CustomerBlocked` |
| generic-name | must_not_link | `service/reklamation#Task_AntwortSenden` (message `Antwort` to the customer) → `finanzen/kreditpruefung#Event_AntwortErhalten` and `einkauf/bestellanforderung#Event_AntwortErhalten`; `finanzen/kreditpruefung#End_AntwortGesendet` (credit agency adapter) → `einkauf/bestellanforderung#Event_AntwortErhalten` |
| signal-broadcast | must_link | `qualitaet/produktrueckruf#Event_ProduktrueckrufAusgeloest` → order handling, picking, returns (C8); `finanzen/monatsabschluss#Event_BuchungsperiodeGesperrt` → invoicing, credit notes, supplier invoices (C7) |
| collaboration | must_link | links from participant processes of the 7 multi-pool files, e.g. `logistik/shipping#Event_ShipmentDispatched` → `finanzen/rechnungsstellung#Start_LieferungVersendet`; their message flows to black-box pools are facts only |
| collaboration | not listed | `finanzen/kreditpruefung` holds two executable processes. `#Task_AuskunftAnfordern` → `#Start_AuskunftsanfrageEingegangen` (`Auskunftsanfrage`) and `#End_AntwortGesendet` → `#Event_AntwortErhalten` (`Antwort`) share names across `Process_Kreditpruefung` and `Process_AuskunfteiAdapter`, but message flows join them, so they are facts, not relations; a key-tier match on them is a false positive |
| collaboration | must_not_link | sends whose message flow already ends in a black-box pool: `einkauf/bestellanforderung#Task_BestellungUebermitteln` → `lager/wareneingang#Start_BestellungAusgeloest`, and the generic-name entries |
| data-store-variants | groups | Kundenstamm / Kunden-Stammdaten / CRM Kunden / Customer master; Offene Posten / OP-Liste / Debitorenkonten; Lieferantenstamm / Kreditorenstamm; WMS Lagerbestand / Lagerbestand / Inventory (Artikelstamm stays separate) |
| self-link | must_not_link | trigger `partner/partner-onboarding#End_ApplicationRejected` → `#Start_DealerApplicationReceived` (labels Levenshtein 3); message `finanzen/kreditpruefung#End_KreditpruefungAbgeschlossen` → `#Start_KreditpruefungAngefordert` |
| trigger | must_link | `finanzen/monatsabschluss#End_MonatsabschlussErstellt` → `controlling/management-reporting#Start_MonatsabschlussErstellt` |
| trigger | may_link | `service/reklamation#End_SerienfehlerGemeldet` → `qualitaet/produktrueckruf#Start_RueckrufBeschlossen`; `einkauf/lieferantenanlage#End_LieferantAngelegt` → `einkauf/bestellanforderung#Start_BedarfGemeldet` |
| dangling-throw | finding | `finanzen/zahlungslauf#Task_ZahlungsdateiUebermitteln` (bank), `vertrieb/marketplace-order-import#End_OrderRejected` (marketplace API), `finanzen/zahlungseingang#Task_KundensperreAufheben` (no C8 receiver yet) |
| unmatched-catch | finding | `vertrieb/marketplace-order-import#Start_MarketplaceOrderNotified` (webhook), `finanzen/forderungsmanagement#Start_RuecklastschriftEingegangen` (R-transaction import via EBICS, not modelled; `finanzen/zahlungseingang` reads only camt.053) |

Extra `distractor` entries (must_not_link):

- None ends that only name a handover whose message is thrown just before
  them. `lager/bestandsueberwachung#End_NachbestellungAngestossen` →
  `einkauf/bestellanforderung#Start_BedarfGemeldet` is a kind-compatible
  trigger an agent may propose. `lager/kommissionierung#End_AnSpeditionUebergeben`
  and `lager/wareneingang#End_WareneingangAbgeschlossen` point at message
  catches, so only a kind-blind matcher falls for them.
- Picking → parcel shipping as a trigger, although the caller orchestrates
  both (`lager/kommissionierung#End_KommissionierungAbgeschlossen` →
  `logistik/shipping#Start_ShipmentRequested`).
- `lexical`: `LieferungVersendet` (pallet and parcel dispatch) →
  `finanzen/forderungsmanagement#Start_RechnungVersendet` (Levenshtein 5).
- The dynamic and unresolved call distractors and the collaboration send
  listed in the table above.

## Known limitations

- **Variables through call activities.** The generator emits no
  `camunda:in`/`camunda:out` mappings on C7 call activities and sets
  `propagateAllChildVariables="false"` on C8, so results of called processes
  do not reach the caller at runtime. The variable names are consistent
  (`freigegeben` from both `Process_Bestellfreigabe` models, `beglichen`
  from `Process_Mahnwesen`, `shippingMode` from the order into picking) and
  documented on the processes, but a deployment needs the mappings, which
  is a change to `eval/tools` for all landscapes. Goods receipt does not
  depend on this: the inspection reports blocked goods with the BPMN error
  `WARE_GESPERRT`, which propagates through the call activity.
- **One message per payment.** `finanzen/zahlungseingang#Task_ZuordnungMelden`
  stands for one `ZahlungZugeordnet` per allocated payment (documented on the
  task); the spec format has no multi-instance activities.

## Layout notes

Branch order and lanes in a few specs were chosen so that sequence flow labels
do not overlap, a limitation of `eval/tools/lib/layout.mjs`: labels of flows
that leave a gateway vertically sit at the gateway port, so two named
downward branches stack and an upward branch hits the gateway name. Where
needed, the upward or second downward branch is the unlabelled default flow
(e.g. `Gateway_Genehmigt` in `einkauf/bestellfreigabe`, `Gateway_Loesung` in
`service/reklamation`).
