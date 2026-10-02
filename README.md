# React Feature-Workflow für Claude Code

Ein wiederverwendbarer Blueprint, mit dem Claude Code Features in JS/React-Projekten in fünf überprüften Phasen umsetzt:

```
/feature <Idee>
   │
   ▼
 spec ──► plan ──► tests ──► implement ──► review ──► done
  │        │        │          │             │
  │     Freigabe    Red     Checks grün    APPROVED
  │     (Nutzer)  (Tests    (Typecheck,    + Diff-Hash
  │               schlagen   Lint, Tests,   + Reviewer-
  ▼               fehl)      Integrität)    Subagent lief
offene Fragen                    ▲              │
→ Nutzer                         └── CHANGES_REQUESTED
                         ◄─────────── REJECTED → plan
```

Jede Phase gehört einem eigenen Subagenten mit eigenen Schreibrechten. Hooks setzen die Regeln durch: Ein Subagent kann erst fertig melden, wenn das Gate seiner Phase bestanden ist.

## Was gegenüber dem ursprünglichen Workflow besser ist

| Problem vorher | Lösung jetzt |
|---|---|
| Gates prüften nur die Form („2 Kriterien vorhanden“) | **Rückverfolgbarkeit über AC-IDs**: Jede AC muss in Plan-Schritten, Teststrategie, getaggten Tests (`F001/AC-1`) und der Review-Matrix vorkommen |
| Tests nach dem Code, passend zum Code geschrieben | **Eigene Testphase vorab (Red)**: Tests werden vor dem Code geschrieben und müssen nachweislich fehlschlagen |
| Bei einer Feedback-Schleife kann Claude Tests aufweichen | Akzeptanztests sind nach der Testphase **gesperrt**; Integritätsprüfung erkennt entfernte Assertions, `.skip`, `.only` |
| Endlosschleife möglich | Nach `max_attempts` Fehlversuchen **eskaliert** der Workflow an dich |
| Fehler über den Umweg `hooks_logging.log` | Gate-Ausgabe geht **direkt** an Claude (Hook-Entscheidung `block` mit Begründung) |
| Claude reviewt seinen eigenen Code | **Reviewer-Subagent mit frischem Kontext**; nur er darf `review.md` schreiben, das Gate prüft, dass er auf genau diesem Code-Stand lief |
| `APPROVED` blieb gültig, auch wenn sich der Code danach änderte | **Diff-Hash** im Review; jede Code-Änderung macht die Freigabe ungültig |
| Keine menschliche Kontrolle vor dem Coden | **Planfreigabe durch dich** (du schreibst „freigabe“); gebunden an den Plan-Stand |
| Phasen konnten übersprungen werden | **Schreibrechte je Phase und Rolle** (PreToolUse-Hook): z. B. kein Produktionscode in Phase `spec` |
| Kein Weg zurück | `wf back <phase>` macht alle nachfolgenden Freigaben ungültig |
| Nur PowerShell (Windows) | Reines **Node.js** ohne Abhängigkeiten, läuft überall, wo dein Projekt läuft |

## Installation in ein Projekt

Voraussetzungen: Node ≥ 18, git und Claude Code. Das Projekt muss ein git-Repository mit mindestens einem Commit sein.

```bash
node install.mjs ../mein-react-projekt --dry-run
```
Zeigt die erkannte Konfiguration, ohne etwas zu schreiben.

```bash
node install.mjs ../mein-react-projekt
```

Der Installer
- erkennt Vitest/Jest/CRA, TypeScript (inkl. Projekt-Referenzen), ESLint, Prettier, Next.js/Vite und npm/pnpm/yarn/bun,
- erzeugt daraus `.claude/workflow/config.json`,
- kopiert Agenten, Skill, Gates und Vorlagen nach `.claude/`,
- **fügt** die Hooks in eine bestehende `.claude/settings.json` ein, ohne andere Hooks anzufassen; wiederholtes Ausführen ist unschädlich,
- trägt `.workflow/state.json` in `.gitignore` ein.

Danach: `config.json` prüfen, alles committen und Claude Code im Projekt neu starten.

## Benutzung

```
/feature Nutzer sollen die Kundenliste als CSV exportieren können
```

Was du tust:
1. **Offene Fragen beantworten**, die der spec-creator sammelt.
2. **Plan freigeben**: `freigabe` schreiben, oder Änderungswünsche ganz normal formulieren.
3. Bei **Eskalation** (Checks nach 5 Versuchen nicht grün oder maximale Review-Runden erreicht) entscheiden, wie es weitergeht. Mit `weitere runde` erlaubst du eine zusätzliche Review-Runde.

Alles andere orchestriert Claude. Artefakte landen in `.workflow/features/F001-<slug>/`:
`ticket.md`, `plan.md`, `review.md` (und `review-runde-N.md` für frühere Runden). Sie sind dafür gedacht, mit dem Feature committet zu werden, als Doku für das „Warum“.

### Kommandozeile `wf`

```bash
node .claude/workflow/wf.mjs status
```
Wo stehe ich, was ist der nächste Schritt?

```bash
node .claude/workflow/wf.mjs check
```
Gate der aktuellen Phase prüfen, ohne Phasenwechsel.

Weitere Befehle: `start`, `advance`, `back <phase> --reason "…"`, `diff [--summary]`, `list`, `resume <id>`, `abort --reason "…"`.

## Die Phasen im Detail

| Phase | Rolle (Subagent) | Darf schreiben | Gate prüft |
|---|---|---|---|
| **spec** | `spec-creator` (+ Orchestrator für Antworten) | nur `ticket.md` | Pflichtabschnitte · ≥ 2 AC als `### AC-n` · je AC Angenommen/Wenn/Dann · keine `{{Platzhalter}}`/TODO · keine offenen Fragen `- [ ]` · Warnung bei unscharfen Wörtern |
| **plan** | `tech-planner` | nur `plan.md` | Pflichtabschnitte · „ändern/löschen“-Dateien existieren · jede AC in einem Arbeitsschritt **und** in der Teststrategie · keine unbekannten AC · Ticket unverändert · **Freigabe durch dich** |
| **tests** | `test-writer` | nur Testdateien und Test-Helfer | jede AC hat einen Test mit Tag `F001/AC-n` · Assertions vorhanden · kein `.only` · **Testsuite schlägt fehl, und zwar wegen der neuen Tests** |
| **implement** | `code-implementer` | alles außer Akzeptanztests, Ticket, Plan | alle `checks` grün (Typecheck, Lint, Tests, Audit bei Abhängigkeitsänderung) · Akzeptanztests vollständig · keine entfernten Assertions · keine neuen `.skip`/`.todo` |
| **review** | `code-reviewer` | nur `review.md`, nur diese Rolle | Status · Diff-Hash = aktueller Code · Reviewer-Subagent lief auf diesem Stand · jede AC ✅ · keine offenen BLOCKER/MAJOR |

Die Hooks im Überblick (`.claude/settings.json` → `.claude/workflow/hooks.mjs`):

| Hook | Aufgabe |
|---|---|
| `UserPromptSubmit` | Erfasst deine Freigabe („freigabe“), setzt den Versuchszähler zurück und blendet die aktuelle Phase in den Kontext ein |
| `PreToolUse` | Setzt die Schreibrechte je Phase und Rolle durch und sperrt die Workflow-Dateien selbst |
| `PostToolUse` | Schnelle Checks pro bearbeiteter Datei (Prettier formatiert, ESLint meldet Fehler sofort) |
| `SubagentStop` | Jede Rolle darf erst nach bestandenem Gate ihrer Phase beenden; der Reviewer-Lauf wird mit Diff-Hash protokolliert |
| `Stop` | Absicherung in Phase `implement`, falls der Hauptagent selbst implementiert |

## Konfiguration (`.claude/workflow/config.json`)

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `commands.test` | erkannt | Testlauf für die Red-Prüfung. Muss sich selbst beenden (kein Watch-Modus; `CI=1` ist gesetzt) |
| `commands.checks[]` | erkannt | `{ name, run, enabled?, when_changed?, timeout_sec? }`. `when_changed` = Globs, nur dann ausführen |
| `on_edit[]` | erkannt | `{ name, glob, run, block }`. `{file}` = bearbeitete Datei. `block: false` = nur ausführen (Formatter) |
| `human_approval` | `["plan"]` | Phasen mit Nutzerfreigabe: `spec`, `plan`, `review` |
| `max_attempts` | `5` | Fehlversuche je Phase bis zur Eskalation |
| `max_review_rounds` | `3` | Review-Runden bis zur Eskalation |
| `min_acceptance_criteria` | `2` | |
| `strict_wording` | `false` | `true`: unscharfe Wörter sind Fehler statt Warnung (`vague_words` anpassbar) |
| `block_severities` | `["BLOCKER","MAJOR"]` | Befunde, die mit APPROVED unvereinbar sind |
| `require_reviewer_subagent` | `true` | Review zählt nur, wenn der `code-reviewer` auf dem aktuellen Stand lief |
| `stop_gate_phases` | `["implement"]` | Phasen, in denen auch der Hauptagent erst nach grünem Gate stoppen darf |
| `test_globs`, `test_support_globs` | Standard-JS-Muster | Was als Test bzw. Test-Helfer gilt |
| `skip_patterns`, `only_patterns`, `assertion_patterns` | Vitest/Jest/Node | Regex-Muster für die Integritätsprüfung |

Typische Anpassungen:
- **E2E mit Playwright** als zusätzlichen Check: `{ "name": "e2e", "run": "npx playwright test", "enabled": true }`
- **Build mitprüfen** (z. B. Next.js): beim `build`-Check `"enabled": true` setzen
- **Coverage** erzwingen: Testbefehl um `--coverage` ergänzen und Schwellen in der Vitest- oder Jest-Config setzen
- **Ticket auch freigeben**: `"human_approval": ["spec", "plan"]`

## Aufbau des Blueprints

```
react-feature-workflow/
├── install.mjs                     Installer mit Projekterkennung
├── test/e2e.mjs                    End-to-End-Test des ganzen Workflows (27 Prüfungen)
└── template/.claude/
    ├── settings.json               Hook-Registrierung
    ├── skills/feature/SKILL.md     /feature – Orchestrator
    ├── agents/                     spec-creator, tech-planner, test-writer,
    │                               code-implementer, code-reviewer
    └── workflow/
        ├── wf.mjs                  Kommandozeile (Phasen, Diff, Status)
        ├── hooks.mjs               Hook-Einstiegspunkt
        ├── lib.mjs                 Gates, Zustand, Git, Schreibrechte
        └── templates/              ticket.md, plan.md, review.md
```

Den Blueprint selbst testen:

```bash
node test/e2e.mjs
```
Legt ein Wegwerf-Projekt an und spielt alle Phasen samt Hooks durch.

## Grenzen (bewusst)

- **Leitplanke, keine Sandbox.** Die Hooks verhindern Abkürzungen und Versehen: Schreib-Tools, bekannte Shell-Muster, `state.json`. Ein entschlossener Agent könnte per Shell trotzdem Dateien ändern. Darum prüfen die Gates zusätzlich den *Inhalt* (Hashes, Test-Integrität) und nicht nur, wer etwas geschrieben hat.
- **Fail-open bei Hook-Fehlern.** Stürzt ein Hook ab (z. B. defekte `config.json`), blockiert er nicht, sondern meldet den Fehler. So legt ein Bug nie die ganze Sitzung lahm.
- **Freigabe per Schlüsselwort.** Erkannt wird `freigabe` / `approve` / `lgtm` **am Anfang** deiner Nachricht. Nur echte Nutzereingaben lösen den Hook aus; Claude kann sich nicht selbst freigeben.
- **Windows:** Claude Code führt Hook-Befehle über Git Bash aus, `$CLAUDE_PROJECT_DIR` funktioniert dort. Ohne Git Bash (Fallback PowerShell) in `settings.json` `$env:CLAUDE_PROJECT_DIR` verwenden.
- Das Diff bezieht sich auf den Commit beim Feature-Start. Am besten mit sauberem Arbeitsverzeichnis starten; `wf start` warnt sonst.
