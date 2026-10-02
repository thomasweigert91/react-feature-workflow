# Review __ID__: __TITLE__

<!-- Rolle: code-reviewer. Alle {{...}}-Platzhalter ersetzen. -->

**Status:** {{APPROVED | CHANGES_REQUESTED | REJECTED}}
**Diff-Hash:** {{Wert aus `node .claude/workflow/wf.mjs diff`}}

## Akzeptanzkriterien
<!-- Eine Zeile pro AC aus dem Ticket. ✅ nur mit konkretem Nachweis. -->
| AC | Erfüllt | Nachweis (Test / Code-Stelle) |
|---|---|---|
| AC-1 | {{✅ / ❌}} | {{Nachweis}} |

## Befunde
<!--
Schwere: BLOCKER (muss), MAJOR (muss), MINOR (sollte), NIT (kann). Status: offen / behoben.
Offene BLOCKER/MAJOR sind mit APPROVED unvereinbar (prüft das Gate). Keine Befunde: nur die Kopfzeile stehen lassen.
-->
| # | Schwere | Datei:Zeile | Befund | Empfehlung | Status |
|---|---|---|---|---|---|

## Prüfbereiche
- [ ] Korrektheit & Randfälle (leer, Fehler, Laden, viele Daten)
- [ ] React: Hook-Regeln, Effekt-Abhängigkeiten, stabile `key`s, State am richtigen Ort, unnötige Re-Renders
- [ ] Sicherheit: kein `dangerouslySetInnerHTML` mit Nutzerdaten, keine Secrets im Client-Bundle (`VITE_*`, `NEXT_PUBLIC_*`), Eingaben validiert
- [ ] Barrierefreiheit: semantisches HTML, Labels, Tastatur, Fokus, Kontrast
- [ ] Tests: prüfen Verhalten statt Implementierung (`getByRole` & Co.), decken alle AC ab
- [ ] Codequalität: Lesbarkeit, Benennung, Typen ohne `any`, keine toten Pfade
- [ ] Scope: nur, was Ticket und Plan verlangen

## Fazit
{{Zwei bis drei Sätze.}}
