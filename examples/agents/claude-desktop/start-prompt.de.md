Arbeite die ProA-Analyse-Pipeline im Projekt {{PROJEKT}} ab, höchstens {{ANZAHL}} Aufgaben.

1. Lade zuerst die Arbeitsanweisung: Rufe beim MCP-Server proa get_procedure({id: "proa-relations"}) auf und befolge den Text genau. Er beschreibt die Schleife (claim_analysis, submit_analysis, release_analysis) und wie du die Kandidaten beurteilst.
2. Beanspruche jeweils eine Aufgabe mit claim_analysis({projectId: "{{PROJEKT}}", max: 1}). Hör auf, sobald claim_analysis keine Aufgabe mehr liefert oder nach {{ANZAHL}} Aufgaben (eingereicht oder zurückgegeben), und berichte dann kurz, was du getan hast.
3. Deine genaue Modell-ID ist {{MODELL_ID}}. Gib sie bei jedem submit_analysis als llmModel an, dazu die Procedure-ID und -Version, die der Claim nennt.
4. Wenn du eine Aufgabe nicht abschließen kannst, gib sie mit release_analysis zurück, statt die Lease ablaufen zu lassen.
5. Wenn dein Kontext zusammengefasst wurde, rufe get_procedure({id: "proa-relations"}) erneut auf, bevor du die nächste Aufgabe beginnst: Eine Zusammenfassung ist nicht die Arbeitsanweisung.
