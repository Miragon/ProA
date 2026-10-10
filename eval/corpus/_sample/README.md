# _sample

Three models, the smallest landscape that exercises the whole toolchain. It is
the regression test of `eval/tools` (`pnpm test`) and not part of the scored
corpus.

| Model | Engine | Content |
|---|---|---|
| `vertrieb/auftragsabwicklung` | c7 7.24 | Collaboration: black-box pool Kunde, pool Vertrieb with lanes Innendienst/Lager, message start, user task with timer boundary, exclusive gateway, embedded subprocess, message throw, call activity, two event subprocesses (message, signal), data store |
| `finanzen/rechnungsstellung` | c8 8.9 | Message start, service task, dynamic call, message throw with correlation key, unresolved call, signal end, data store |
| `finance/payment-collection` | c7 7.24 | English labels; none start (called), message catch, event-based gateway, timer catch, send task, signal event subprocess, data store |

## Relations and traps

| Entry | Expect | Tags |
|---|---|---|
| `Call_ZahlungAbwickeln` → `Process_PaymentCollection` | must_link | call-unique, collaboration |
| `Event_WareVersandbereit` (c7) → `Start_WareVersandbereit` (c8) | must_link | cross-engine-message, collaboration |
| `End_WareVersandbereit` (none end inside a subprocess) → `Start_WareVersandbereit` | must_not_link | subprocess-scope, event-def-mismatch |
| `Event_RechnungVersendet` → `Event_InvoiceSent` | must_link | de-en |
| `End_RechnungsstellungAbgeschlossen` → both signal event subprocesses | must_link | signal-broadcast (+ collaboration) |
| `End_InvoicePaid` → `Event_InvoiceSent` (same process) | must_not_link | near-miss, self-link |

Findings: `Call_RechnungAusgeben` (dynamic-call), `Call_Mahnwesen`
(unresolved-call), `Task_SendReminder` (dangling-throw), `Event_PaymentReceived`
(unmatched-catch). Data stores "Kundenstamm", "Kunden-Stammdaten" and "CRM
Kunden" form one group (data-store-variants).

Not applicable here (declared in `landscape.yaml`): transliteration,
call-ambiguous, generic-name, trigger.
