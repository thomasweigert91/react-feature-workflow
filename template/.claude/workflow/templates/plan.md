# Plan __ID__: __TITLE__

<!-- Rolle: tech-planner. Alle {{...}}-Platzhalter ersetzen. Jede AC aus dem Ticket muss in Arbeitsschritten UND Teststrategie vorkommen. -->

## Ansatz
{{Lösungsidee in 3–6 Sätzen. Verworfene Alternativen kurz mit Grund.}}

## Betroffene Dateien
<!-- Aktion: neu / ändern / löschen. "ändern"/"löschen" muss auf existierende Dateien zeigen (prüft das Gate). -->
| Pfad | Aktion | Zweck |
|---|---|---|
| {{src/components/Beispiel.tsx}} | {{neu/ändern/löschen}} | {{Zweck}} |

## Komponenten & Datenfluss
<!-- Komponentenbaum, Props und State (wo lebt er?), Hooks, Context, API-Aufrufe und Typen, Lade-/Fehlerzustände, neue Abhängigkeiten. -->
{{Beschreibung}}

## Arbeitsschritte
<!-- Nummeriert, klein und einzeln prüfbar, jeweils mit AC-Bezug in Klammern. -->
1. {{Schritt}} (AC-1)
2. {{Schritt}} (AC-2)

## Teststrategie
<!-- Je AC: Testart (Unit / Komponente mit Testing Library / E2E), Testdatei, was geprüft wird. -->
| AC | Testart | Testdatei | Prüft |
|---|---|---|---|
| AC-1 | {{Komponente}} | {{src/components/Beispiel.test.tsx}} | {{Verhalten}} |

## Risiken & Rollback
{{Risiken (Breaking Changes, Performance, Datenmigration im Client, Feature-Flag) und wie man zurückrollt.}}
