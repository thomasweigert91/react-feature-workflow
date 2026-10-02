#!/usr/bin/env node
// End-to-End-Test: installiert den Blueprint in ein Wegwerf-Projekt und spielt
// einen kompletten Feature-Durchlauf inklusive aller Hooks durch.
//   node test/e2e.mjs [arbeitsordner]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BLUEPRINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const P = fs.mkdtempSync(path.join(base, 'wf-e2e-'));

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)} ${msg}`);
const sh = (cmd) => execSync(cmd, { cwd: P, stdio: 'pipe', encoding: 'utf8' });
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true }); fs.writeFileSync(path.join(P, rel), text); };
const read = (rel) => fs.readFileSync(path.join(P, rel), 'utf8');
const state = () => JSON.parse(read('.workflow/state.json'));
const feature = () => state().features.F001;

function wf(...args) {
  const r = spawnSync('node', ['.claude/workflow/wf.mjs', ...args], { cwd: P, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

function hook(event, input) {
  const r = spawnSync('node', ['.claude/workflow/hooks.mjs', event], { cwd: P, input: JSON.stringify(input), encoding: 'utf8' });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const writeTool = (rel, agent) => hook('pre-tool', { tool_name: 'Write', tool_input: { file_path: path.join(P, rel), content: '' }, ...(agent && { agent_type: agent }) });
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
const bash = (command, agent) => hook('pre-tool', { tool_name: 'Bash', tool_input: { command }, ...(agent && { agent_type: agent }) });

console.log(`Testprojekt: ${P}\n`);

// ------------------------------------------------------------ Projekt + Installation
write('package.json', JSON.stringify({ name: 'demo', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2));
write('src/math.mjs', 'export const add = (a, b) => a + b;\n');
write('src/math.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('add', () => assert.equal(add(1, 2), 3));\n");
sh('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init');

const inst = spawnSync('node', [path.join(BLUEPRINT, 'install.mjs'), P], { encoding: 'utf8' });
assert.equal(inst.status, 0, inst.stderr);
const cfg = JSON.parse(read('.claude/workflow/config.json'));
assert.equal(cfg.commands.test, 'npm test');
assert.ok(JSON.parse(read('.claude/settings.json')).hooks.SubagentStop);
assert.ok(read('.gitignore').includes('.workflow/state.json'));
sh('git add -A && git commit -qm workflow');
ok('Installer: Konfiguration erkannt, Hooks + .gitignore geschrieben');

// Zweite Installation darf Hooks nicht doppeln
spawnSync('node', [path.join(BLUEPRINT, 'install.mjs'), P], { encoding: 'utf8' });
assert.equal(JSON.parse(read('.claude/settings.json')).hooks.Stop.length, 1);
ok('Installer ist idempotent (keine doppelten Hooks)');

// Ohne aktives Feature greift der Guard nicht ein
assert.ok(!denied(writeTool('src/anything.mjs')));
ok('Ohne aktives Feature: keine Schreibsperren');

// ------------------------------------------------------------ Phase spec
let r = wf('start', 'greeting', 'Begrüßung');
assert.equal(r.code, 0, r.out);
const DIR = '.workflow/features/F001-greeting';
assert.ok(fs.existsSync(path.join(P, DIR, 'ticket.md')));
ok('wf start legt F001 mit ticket.md an');

r = wf('check');
assert.equal(r.code, 1);
assert.match(r.out, /Platzhalter nicht ersetzt/);
ok('Gate spec: unausgefülltes Template wird abgelehnt');

assert.ok(denied(writeTool('src/greet.mjs')));
assert.ok(!denied(writeTool(`${DIR}/ticket.md`)));
assert.ok(denied(writeTool(`${DIR}/ticket.md`, 'tech-planner')));
ok('Guard spec: nur ticket.md, und nur durch passende Rollen');

const TICKET = (open) => `# F001: Begrüßung

## Kontext
Die App begrüßt Nutzer bisher nicht.

## Ziel
Nutzer sehen eine persönliche Begrüßung.

## Akzeptanzkriterien

### AC-1: Begrüßung mit Namen
- **Angenommen** der Name "Ada" ist bekannt
- **Wenn** die Begrüßung möglichst früh erzeugt wird
- **Dann** lautet sie "Hallo, Ada!"

### AC-2: Fallback ohne Namen
- **Angenommen** kein Name ist bekannt
- **Wenn** die Begrüßung erzeugt wird
- **Dann** lautet sie "Hallo!"

## Nicht im Scope
- Übersetzungen

## Offene Fragen
${open ? '- [ ] Zählt ein leerer String als "kein Name"?' : '- [x] Zählt ein leerer String als "kein Name"? → Ja'}
`;
write(`${DIR}/ticket.md`, TICKET(true));
r = hook('subagent-stop', { agent_type: 'spec-creator' });
assert.equal(r.json, null, `spec-creator darf mit offenen Fragen beenden: ${r.stdout}`);
r = wf('advance');
assert.equal(r.code, 1);
assert.match(r.out, /WARTET[\s\S]*offene Frage/);
assert.match(r.out, /WARNUNGEN[\s\S]*möglichst/);
ok('Offene Fragen blockieren advance, aber nicht den spec-creator; unscharfe Wörter → Warnung');

write(`${DIR}/ticket.md`, TICKET(false));
r = wf('advance');
assert.equal(r.code, 0, r.out);
assert.equal(feature().phase, 'plan');
ok('spec → plan, Ticket-Hash gesperrt');

// ------------------------------------------------------------ Phase plan
assert.ok(denied(writeTool(`${DIR}/ticket.md`)));
ok('Guard plan: Ticket nach Freigabe gesperrt');

const PLAN = (good) => `# Plan F001

## Ansatz
Neue Funktion greet in src/greet.mjs.

## Betroffene Dateien
| Pfad | Aktion | Zweck |
|---|---|---|
| \`src/greet.mjs\` | neu | Begrüßungsfunktion |
| ${good ? '`src/math.mjs`' : '`src/gibtsnicht.mjs`'} | ändern | Export ergänzen |

## Komponenten & Datenfluss
greet(name?: string): string

## Arbeitsschritte
1. greet mit Namen implementieren (AC-1)
${good ? '2. Fallback ohne Namen (AC-2)' : '2. Aufräumen (AC-7)'}

## Teststrategie
| AC | Testart | Testdatei | Prüft |
|---|---|---|---|
| AC-1 | Unit | src/greet.test.mjs | Text mit Namen |
| AC-2 | Unit | src/greet.test.mjs | Fallback |

## Risiken & Rollback
Keine, Datei löschen.
`;
write(`${DIR}/plan.md`, PLAN(false));
r = hook('subagent-stop', { agent_type: 'tech-planner' });
assert.equal(r.json?.decision, 'block');
assert.match(r.json.reason, /gibtsnicht\.mjs[\s\S]*AC-7[\s\S]*Kein Arbeitsschritt deckt ab: AC-2/);
ok('Gate plan: nicht existierende Datei, unbekannte AC, fehlende Abdeckung → tech-planner blockiert');

write(`${DIR}/plan.md`, PLAN(true));
r = hook('subagent-stop', { agent_type: 'tech-planner' });
assert.equal(r.json, null, r.stdout);
r = wf('advance');
assert.equal(r.code, 1);
assert.match(r.out, /Wartet auf Freigabe/);
ok('Plan strukturell ok, wartet auf Nutzerfreigabe');

r = hook('prompt', { prompt: 'freigabe' });
assert.match(r.json.hookSpecificOutput.additionalContext, /freigegeben/);
write(`${DIR}/plan.md`, PLAN(true) + '\nNachträgliche Änderung\n');
r = wf('advance');
assert.equal(r.code, 1, 'Freigabe muss an den freigegebenen Stand gebunden sein');
write(`${DIR}/plan.md`, PLAN(true));
r = wf('advance');
assert.equal(r.code, 0, r.out);
ok('Freigabe per Nutzer-Prompt, gebunden an den Plan-Hash; plan → tests');

// ------------------------------------------------------------ Phase tests
assert.ok(denied(writeTool('src/greet.mjs', 'test-writer')));
assert.ok(!denied(writeTool('src/greet.test.mjs', 'test-writer')));
ok('Guard tests: nur Testdateien');

const TESTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from './greet.mjs';

test('F001/AC-1 Begrüßung mit Namen', () => {
  assert.equal(greet('Ada'), 'Hallo, Ada!');
});

test('F001/AC-2 Fallback ohne Namen', () => {
  assert.equal(greet(), 'Hallo!');
  assert.equal(greet(''), 'Hallo!');
});
`;
write('src/greet.test.mjs', TESTS.replace(/test\('F001\/AC-2[\s\S]*$/, ''));
r = wf('check');
assert.match(r.out, /Kein Test für: F001\/AC-2/);
write('src/greet.test.mjs', TESTS.replace("test('F001/AC-1", "test.only('F001/AC-1"));
r = wf('check');
assert.match(r.out, /\.only/);
ok('Gate tests: fehlende AC-Abdeckung und .only werden erkannt');

write('src/greet.test.mjs', TESTS);
r = hook('subagent-stop', { agent_type: 'test-writer' });
assert.equal(r.json, null, r.stdout);
r = wf('advance');
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Red bestätigt/);
assert.equal(feature().test_snapshot.tagged[0].path, 'src/greet.test.mjs');
ok('Red bestätigt (Tests schlagen wegen fehlendem Modul fehl); tests → implement');

// ------------------------------------------------------------ Phase implement
assert.ok(denied(writeTool('src/greet.test.mjs')));
assert.ok(!denied(writeTool('src/greet.mjs', 'code-implementer')));
assert.ok(denied(writeTool(`${DIR}/plan.md`, 'code-implementer')));
ok('Guard implement: Akzeptanztests und Plan gesperrt, Code frei');

write('src/greet.mjs', 'export const greet = (name) => `Hallo, ${name}!`;\n');
r = hook('subagent-stop', { agent_type: 'code-implementer' });
assert.equal(r.json?.decision, 'block');
assert.match(r.json.reason, /Versuch 1\/5[\s\S]*test fehlgeschlagen/);
r = hook('subagent-stop', { agent_type: 'Explore' });
assert.equal(r.json, null);
ok('Rote Tests blockieren den code-implementer (fremde Subagenten nicht)');

// Test per Shell aufweichen → Integritätsprüfung schlägt an
write('src/greet.test.mjs', TESTS.replace("  assert.equal(greet(''), 'Hallo!');\n", ''));
write('src/greet.mjs', "export const greet = (name) => (name ? `Hallo, ${name}!` : 'Hallo!');\n");
r = wf('check');
assert.match(r.out, /Assertions reduziert \(3 → 2\)/);
write('src/greet.test.mjs', TESTS.replace("test('F001/AC-1", "test.skip('F001/AC-1"));
r = wf('check');
assert.match(r.out, /Neue skip\/todo/);
write('src/greet.test.mjs', TESTS);
ok('Test-Integrität: entfernte Assertions und neue skips werden erkannt');

hook('prompt', { prompt: 'weiter' }); // Zähler zurücksetzen
for (let i = 0; i < 5; i++) write('src/greet.mjs', 'export const greet = () => "kaputt";\n'), (r = hook('stop', {}));
assert.match(r.json?.systemMessage ?? '', /nach 5 Versuchen/);
assert.equal(feature().escalated, true);
r = hook('stop', {});
assert.equal(r.json, null);
hook('prompt', { prompt: 'Schau dir den Fehler nochmal an' });
assert.equal(feature().escalated, false);
ok('Nach 5 Fehlversuchen: Eskalation an den Nutzer statt Endlosschleife; Nutzer-Prompt setzt zurück');

write('src/greet.mjs', "export const greet = (name) => (name ? `Hallo, ${name}!` : 'Hallo!');\n");
r = hook('subagent-stop', { agent_type: 'code-implementer' });
assert.equal(r.json, null, r.stdout);
r = wf('advance');
assert.equal(r.code, 0, r.out);
ok('Alles grün; implement → review');

// ------------------------------------------------------------ Phase review
assert.ok(denied(writeTool(`${DIR}/review.md`)));
assert.ok(denied(writeTool('src/greet.mjs', 'code-reviewer')));
assert.ok(!denied(writeTool(`${DIR}/review.md`, 'code-reviewer')));
assert.ok(!denied(bash('node .claude/workflow/wf.mjs diff', 'code-reviewer')));
assert.ok(denied(bash('node .claude/workflow/wf.mjs advance', 'code-reviewer')));
assert.ok(denied(bash('echo {} > .workflow/state.json')));
ok('Guard review: nur der code-reviewer schreibt review.md; Subagenten dürfen nicht advance');

const hash = wf('diff').out.match(/Diff-Hash: (\w+)/)[1];
const REVIEW = (status, h, finding = 'MINOR') => `# Review F001

**Status:** ${status}
**Diff-Hash:** ${h}

## Akzeptanzkriterien
| AC | Erfüllt | Nachweis |
|---|---|---|
| AC-1 | ✅ | src/greet.test.mjs: F001/AC-1 |
| AC-2 | ✅ | src/greet.test.mjs: F001/AC-2 |

## Befunde
| # | Schwere | Datei:Zeile | Befund | Empfehlung | Status |
|---|---|---|---|---|---|
| 1 | ${finding} | src/greet.mjs:1 | Leerzeichen-Namen | trim() | offen |

## Fazit
Solide.
`;
write(`${DIR}/review.md`, REVIEW('APPROVED', 'abcdef123456'));
r = hook('subagent-stop', { agent_type: 'code-reviewer' });
assert.equal(r.json?.decision, 'block');
assert.match(r.json.reason, /alten Code-Stand/);
ok('Review mit falschem Diff-Hash: Reviewer muss nachbessern');

write(`${DIR}/review.md`, REVIEW('APPROVED', hash, 'MAJOR'));
r = hook('subagent-stop', { agent_type: 'code-reviewer' });
assert.match(r.json?.reason ?? '', /Offener MAJOR-Befund/);
ok('APPROVED mit offenem MAJOR-Befund wird abgelehnt');

write(`${DIR}/review.md`, REVIEW('CHANGES_REQUESTED', hash, 'MAJOR'));
r = hook('subagent-stop', { agent_type: 'code-reviewer' });
assert.equal(r.json, null, r.stdout);
r = wf('advance');
assert.equal(r.code, 1);
assert.match(r.out, /back implement/);
r = wf('back', 'implement', '--reason', 'Review-Runde 1');
assert.equal(r.code, 0, r.out);
assert.ok(fs.existsSync(path.join(P, DIR, 'review-runde-1.md')));
ok('CHANGES_REQUESTED → back implement, Review archiviert als review-runde-1.md');

write('src/greet.mjs', "export const greet = (name) => (name?.trim() ? `Hallo, ${name.trim()}!` : 'Hallo!');\n");
assert.equal(wf('advance').code, 0);
write(`${DIR}/review.md`, REVIEW('APPROVED', hash));
r = wf('check');
assert.match(r.out, /alten Code-Stand/);
assert.match(r.out, /code-reviewer" ist für den aktuellen Code-Stand/);
const hash2 = wf('diff').out.match(/Diff-Hash: (\w+)/)[1];
assert.notEqual(hash, hash2);
write(`${DIR}/review.md`, REVIEW('APPROVED', hash2).replace('| offen |', '| behoben |'));
r = wf('advance');
assert.match(r.out, /code-reviewer" ist für den aktuellen Code-Stand/);
ok('Neuer Code-Stand: alter Hash ungültig; ohne echten Reviewer-Lauf kein advance');

r = hook('subagent-stop', { agent_type: 'code-reviewer' });
assert.equal(r.json, null, r.stdout);
r = wf('advance');
assert.equal(r.code, 0, r.out);
assert.equal(feature().phase, 'done');
assert.equal(state().active, null);
ok('Review APPROVED; review → done, Feature abgeschlossen');

assert.ok(!denied(writeTool('src/after.mjs')));
r = wf('start', 'second', 'Zweites');
assert.match(r.out, /F002/);
ok('Nach Abschluss: Sperren aufgehoben, nächstes Feature erhält F002');

console.log(`\nAlle ${step} Prüfungen bestanden.`);
fs.rmSync(P, { recursive: true, force: true });
