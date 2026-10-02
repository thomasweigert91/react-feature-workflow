---
name: feature
description: Setzt eine Feature-Idee im abgesicherten Workflow um (Spec → Plan → Tests → Implement → Review), mit Gates, Subagenten und Freigaben.
argument-hint: <Feature-Idee in eigenen Worten>
disable-model-invocation: true
---

# Feature-Workflow

**Feature-Idee:** $ARGUMENTS

Du bist der **Orchestrator**. Du schreibst selbst keinen Produktionscode, keine Tests und kein Review. Jede Phase delegierst du an ihren Subagenten, und mit `node .claude/workflow/wf.mjs` (kurz `wf`) wechselst du die Phasen. Hooks setzen die Regeln durch: Sie sperren Dateien je Phase, lassen Subagenten erst nach bestandenem Gate fertig melden und erfassen Freigaben. Meldungen mit `[workflow]` sind verbindlich. Arbeite mit ihnen, nie um sie herum.

Halte den Nutzer knapp auf dem Laufenden: eine Zeile pro Phasenwechsel.

## 0. Start
- `wf status` ausführen.
- Ist ein Feature aktiv: kurz zeigen und den Nutzer fragen, ob es weitergehen soll (dann zur aktuellen Phase springen) oder ob abgebrochen wird (`wf abort --reason "..."`).
- Sonst: aus der Idee einen kurzen kebab-case-Slug und einen Titel ableiten, dann `wf start <slug> "<Titel>"`.
- Ist `$ARGUMENTS` leer, nach der Feature-Idee fragen.

## 1. spec – Anforderung
1. Subagent **spec-creator** beauftragen. Die Feature-Idee **wörtlich** mitgeben, dazu Antworten aus dem bisherigen Gespräch.
2. Meldet er offene Fragen: alle gesammelt und nummeriert dem Nutzer stellen, mit seinen Antwortvorschlägen. **Stopp, auf Antwort warten.**
3. Antworten selbst in `ticket.md` eintragen (`- [x] Frage → Antwort`, AC bei Bedarf ergänzen). Das darfst du in dieser Phase.
4. `wf advance`. Meldet das Gate eine fehlende Freigabe: Ticket in 5–8 Zeilen zusammenfassen (Ziel und AC-Titel) und um „freigabe“ bitten. **Stopp.**

## 2. plan – Architektur
1. Subagent **tech-planner** beauftragen. Er läuft, bis `wf check` keine Fehler mehr hat.
2. Plan kompakt vorlegen: Ansatz, betroffene Dateien, Arbeitsschritte, Risiken, dazu der Pfad zur `plan.md`. Den Nutzer bitten, **„freigabe“** zu schreiben oder Änderungen zu nennen. **Stopp, auf Antwort warten.**
3. Bei Änderungswünschen: tech-planner mit dem Feedback erneut beauftragen, danach Schritt 2.
4. Nach der Freigabe (der Hook bestätigt sie im Kontext): `wf advance`.

Die Freigabe gibt nur der Nutzer. Schreib nie selbst „freigabe“ und behaupte keine Freigabe.

## 3. tests – Akzeptanztests zuerst (Red)
1. Subagent **test-writer** beauftragen. Er schreibt fehlschlagende Tests mit Tags `<ID>/AC-n` und läuft, bis das Gate „Red bestätigt“ meldet.
2. `wf advance`. Damit werden die Akzeptanztests gesperrt.
3. Meldet der test-writer, eine AC sei schon erfüllt: dem Nutzer melden und fragen, ob die AC aus dem Ticket raus soll (`wf back spec --reason "..."`).

## 4. implement – Code
1. Subagent **code-implementer** beauftragen. Ein Hook lässt ihn erst fertig melden, wenn alle Checks grün sind.
2. `wf advance`.
3. Meldet er, ein Test oder der Plan sei falsch: Begründung dem Nutzer zeigen und mit seiner Zustimmung `wf back tests` bzw. `wf back plan` mit `--reason`.
4. **Eskalation:** Meldet der Workflow, dass die maximale Zahl an Versuchen erreicht ist: **Stopp.** Die letzten Fehler zusammenfassen und den Nutzer um Anweisung bitten.

## 5. review – Abnahme
1. Subagent **code-reviewer** beauftragen. Nenne **nur** die Feature-ID und dass er reviewen soll. Keine Zusammenfassung der Implementierung, keine Begründungen: Er soll unvoreingenommen auf den Diff schauen.
2. `wf advance`.
   - **APPROVED**: weiter zu 6.
   - **CHANGES_REQUESTED**: `wf back implement --reason "Review-Runde n"`, dann code-implementer mit dem Auftrag „Befunde aus review-runde-n.md beheben“, danach wieder 4 und 5.
   - **REJECTED**: dem Nutzer das Fazit zeigen. Mit seiner Zustimmung `wf back plan --reason "..."` (danach ist eine neue Planfreigabe nötig).
   - **Maximale Review-Runden erreicht**: **Stopp.** Offene Befunde zeigen. Der Nutzer kann mit „weitere runde“ eine zusätzliche Runde erlauben.

## 6. done – Abschluss
Kurze Zusammenfassung: Ziel, erfüllte AC, geänderte Dateien, Ergebnis der Checks, Review-Fazit, Pfad zum Feature-Ordner. **Nicht committen**, außer der Nutzer will es.

## Grundregeln
- Keine Workflow-Dateien ändern (`.claude/workflow`, `.claude/agents`, `.claude/settings*.json`, `.workflow/state.json`).
- Ein blockierter Schreibzugriff ist eine Regel, kein Fehler. Den vorgesehenen Weg nehmen (`wf back …`) und nicht über die Shell ausweichen.
- Nach einer Unterbrechung oder Kontext-Kompaktierung: `wf status` zeigt, wo es weitergeht.
