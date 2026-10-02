// Kernlogik des Feature-Workflows: Konfiguration, Zustand, Git, Gates.
// Keine Abhängigkeiten außer Node >= 18 und git.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WF_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(WF_DIR, '..', '..');
export const RUNTIME_DIR = path.join(ROOT, '.workflow');
export const FEATURES_DIR = path.join(RUNTIME_DIR, 'features');
export const STATE_FILE = path.join(RUNTIME_DIR, 'state.json');
export const WF = 'node .claude/workflow/wf.mjs';

export const PHASES = ['spec', 'plan', 'tests', 'implement', 'review', 'done'];
export const ARTIFACTS = { spec: 'ticket.md', plan: 'plan.md', review: 'review.md' };

const TICKET_SECTIONS = ['Kontext', 'Ziel', 'Akzeptanzkriterien', 'Nicht im Scope', 'Offene Fragen'];
const PLAN_SECTIONS = ['Ansatz', 'Betroffene Dateien', 'Komponenten & Datenfluss', 'Arbeitsschritte', 'Teststrategie', 'Risiken & Rollback'];

// ---------------------------------------------------------------- Konfiguration

const DEFAULT_CONFIG = {
  test_globs: ['**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs}'],
  test_support_globs: ['**/__mocks__/**', '**/test-utils/**', '**/test/**', '**/tests/**', '**/fixtures/**', '**/mocks/**', '**/setupTests.{js,ts,jsx,tsx}', '**/*.setup.{js,ts,mjs}', 'e2e/**'],
  commands: { test: 'npm test', checks: [{ name: 'test', run: 'npm test' }] },
  on_edit: [],
  human_approval: ['plan'],
  min_acceptance_criteria: 2,
  max_attempts: 5,
  max_review_rounds: 3,
  stop_gate_phases: ['implement'],
  require_reviewer_subagent: true,
  block_severities: ['BLOCKER', 'MAJOR'],
  strict_wording: false,
  vague_words: ['schnell', 'einfach', 'benutzerfreundlich', 'intuitiv', 'performant', 'modern', 'flexibel', 'möglichst', 'ggf.', 'etc.', 'usw.', 'sollte', 'eventuell', 'nice', 'smooth'],
  red_output_must_mention_tests: true,
  output_tail_lines: 40,
  command_timeout_sec: 600,
  skip_patterns: ['\\b(?:it|test|describe|suite)\\.(?:skip|todo|fails)\\b', '\\bx(?:it|test|describe)\\s*\\('],
  only_patterns: ['\\b(?:it|test|describe|suite)\\.only\\b', '\\bf(?:it|describe)\\s*\\('],
  assertion_patterns: ['\\bexpect\\s*\\(', '\\bexpect\\.(?:assertions|hasAssertions)\\s*\\(', '\\bassert(?:\\.\\w+)?\\s*\\('],
};

export function loadConfig() {
  const file = path.join(WF_DIR, 'config.json');
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { ...DEFAULT_CONFIG, ...user, commands: { ...DEFAULT_CONFIG.commands, ...(user.commands || {}) } };
}

// ---------------------------------------------------------------- Zustand

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { active: null, features: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

export function saveState(state) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

export function activeFeature(state) {
  return state.active ? state.features[state.active] ?? null : null;
}

export function artifactPath(feature, phase) {
  return path.join(ROOT, feature.dir, ARTIFACTS[phase]);
}

export function readArtifact(feature, phase) {
  return readText(artifactPath(feature, phase));
}

export function logEvent(feature, event, details = {}) {
  feature.history.push({ ts: new Date().toISOString(), phase: feature.phase, event, ...details });
}

// ---------------------------------------------------------------- Hilfsfunktionen

export const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
export const sha = (data) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
export const toPosix = (p) => p.split(path.sep).join('/');

/** Pfad relativ zum Projekt (posix) oder null, wenn er außerhalb liegt. */
export function relToRoot(p) {
  const r = path.relative(ROOT, path.resolve(ROOT, p));
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return toPosix(r);
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function run(cmd, timeoutSec) {
  const r = spawnSync(cmd, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.replace(ANSI, '');
  return { code: r.status ?? 1, out, timedOut: r.error?.code === 'ETIMEDOUT' };
}

export const tail = (text, n) => text.trimEnd().split(/\r?\n/).slice(-n).join('\n');

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } else { re += '.*'; i += 2; }
    } else if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '?') { re += '[^/]'; i++; }
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
      i = end + 1;
    } else { re += escapeRe(c); i++; }
  }
  return new RegExp(`^${re}$`);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

// ---------------------------------------------------------------- Git

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EXCLUDE_RUNTIME = ':(exclude).workflow';

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} fehlgeschlagen: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

const zsplit = (s) => s.split('\0').filter(Boolean);

export function isGitRepo() {
  try { return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; }
}

export function headCommit() {
  try { return git(['rev-parse', 'HEAD']).trim(); } catch { return EMPTY_TREE; }
}

/** Alle Dateien im Projekt, die nicht ignoriert sind (respektiert .gitignore). */
export function listFiles() {
  return zsplit(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
}

function untrackedFiles() {
  return zsplit(git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', EXCLUDE_RUNTIME]));
}

/** Seit `base` geänderte Dateien (inkl. neuer, ungetrackter Dateien), ohne .workflow/. */
export function changedFiles(base) {
  const tracked = zsplit(git(['diff', '--name-only', '-z', base, '--', '.', EXCLUDE_RUNTIME]));
  return [...new Set([...tracked, ...untrackedFiles()])].sort();
}

/** Fingerabdruck des aktuellen Code-Stands relativ zu `base`. */
export function diffHash(base) {
  let data = git(['diff', '--no-color', base, '--', '.', EXCLUDE_RUNTIME]);
  for (const f of untrackedFiles().sort()) data += `\n${f}:${sha(fs.readFileSync(path.join(ROOT, f)))}`;
  return sha(data);
}

export function diffText(base) {
  let text = git(['diff', '--no-color', base, '--', '.', EXCLUDE_RUNTIME]);
  for (const f of untrackedFiles().sort()) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    const binary = buf.includes(0) || buf.length > 200_000;
    text += `\n=== Neue Datei: ${f} ===\n${binary ? '(binär oder zu groß, ausgelassen)\n' : buf.toString('utf8')}`;
  }
  return text;
}

// ---------------------------------------------------------------- Markdown

export const stripComments = (md) => md.replace(/<!--[\s\S]*?-->/g, '');

/** Level-2-Abschnitte (## Titel) -> Inhalt. */
export function sections(md) {
  const out = {};
  let cur = null;
  for (const line of stripComments(md).split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) { cur = m[1]; out[cur] = []; } else if (cur) out[cur].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

function section(secs, name) {
  const key = Object.keys(secs).find((k) => k.toLowerCase().startsWith(name.toLowerCase()));
  return key === undefined ? null : secs[key];
}

/** Zeilen einer Markdown-Tabelle als Zellen-Arrays (ohne Kopf- und Trennzeile). */
export function tableRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
  const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const sepIdx = rows.findIndex((r) => r.every((c) => /^:?-{2,}:?$/.test(c)));
  return sepIdx === -1 ? rows : rows.slice(sepIdx + 1);
}

export function parseAcceptanceCriteria(md) {
  const text = section(sections(md), 'Akzeptanzkriterien') ?? '';
  const acs = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^###\s+(AC-\d+)\b[:\s–-]*(.*)$/);
    if (m) { cur = { id: m[1], title: m[2].trim(), body: [] }; acs.push(cur); } else if (cur) cur.body.push(line);
  }
  return acs.map((a) => ({ ...a, body: a.body.join('\n') }));
}

const unique = (arr) => [...new Set(arr)];
const acRefs = (text) => unique(text.match(/\bAC-\d+\b/g) ?? []);

// ---------------------------------------------------------------- Gates

function newResult(phase) {
  // pending: wartet auf den Nutzer oder ist ein legitimes Rollenergebnis
  // (blockiert `advance`, aber nicht das Beenden eines Subagenten).
  return { phase, errors: [], warnings: [], pending: [], notes: [], data: {} };
}

function checkPlaceholders(md, res, file) {
  const body = stripComments(md);
  const ph = unique(body.match(/\{\{[^}]*\}\}/g) ?? []);
  if (ph.length) res.errors.push(`${file}: Platzhalter nicht ersetzt: ${ph.slice(0, 5).join(', ')}`);
  const todo = unique(body.match(/\b(?:TODO|TBD|FIXME)\b/g) ?? []);
  if (todo.length) res.errors.push(`${file}: enthält ${todo.join('/')} – offene Punkte erst klären`);
}

function checkLocked(feature, res, phase) {
  const md = readArtifact(feature, phase);
  const recorded = feature.hashes[phase];
  if (recorded && md !== null && sha(md) !== recorded) {
    res.errors.push(`${ARTIFACTS[phase]} wurde nach der Freigabe geändert. Änderungen am ${phase === 'spec' ? 'Ticket' : 'Plan'} nur über \`${WF} back ${phase} --reason "..."\`.`);
  }
}

function ticketAcIds(feature) {
  const md = readArtifact(feature, 'spec');
  return md ? parseAcceptanceCriteria(md).map((a) => a.id) : [];
}

export function gateSpec(feature, cfg) {
  const res = newResult('spec');
  const md = readArtifact(feature, 'spec');
  if (!md) { res.errors.push(`${feature.dir}/ticket.md fehlt`); return res; }
  checkPlaceholders(md, res, 'ticket.md');

  const secs = sections(md);
  for (const name of TICKET_SECTIONS) {
    const content = section(secs, name);
    if (content === null) res.errors.push(`Pflichtabschnitt "## ${name}" fehlt`);
    else if (!content && name !== 'Offene Fragen') res.errors.push(`Abschnitt "## ${name}" ist leer`);
  }

  const acs = parseAcceptanceCriteria(md);
  if (acs.length < cfg.min_acceptance_criteria) {
    res.errors.push(`Mindestens ${cfg.min_acceptance_criteria} Akzeptanzkriterien nötig (als "### AC-1: Titel"), gefunden: ${acs.length}`);
  }
  const dupes = acs.map((a) => a.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) res.errors.push(`Doppelte AC-IDs: ${unique(dupes).join(', ')}`);

  const parts = [['Angenommen', /\b(?:angenommen|gegeben|given)\b/i], ['Wenn', /\b(?:wenn|when)\b/i], ['Dann', /\b(?:dann|then)\b/i]];
  const vague = cfg.vague_words.map((w) => [w, new RegExp(`(?:^|[^\\p{L}])${escapeRe(w)}(?=$|[^\\p{L}])`, 'iu')]);
  for (const ac of acs) {
    const missing = parts.filter(([, re]) => !re.test(ac.body)).map(([n]) => n);
    if (missing.length) res.errors.push(`${ac.id}: Angenommen/Wenn/Dann unvollständig (fehlt: ${missing.join(', ')})`);
    const found = vague.filter(([, re]) => re.test(`${ac.title}\n${ac.body}`)).map(([w]) => w);
    if (found.length) {
      const msg = `${ac.id}: unscharfe Formulierung (${found.join(', ')}) – durch messbare Aussage ersetzen`;
      (cfg.strict_wording ? res.errors : res.warnings).push(msg);
    }
  }

  const open = (section(secs, 'Offene Fragen') ?? '').split(/\r?\n/).filter((l) => /^\s*[-*]\s+\[ \]/.test(l));
  if (open.length) res.pending.push(`${open.length} offene Frage(n) – mit dem Nutzer klären und als "- [x] Frage → Antwort" markieren:\n${open.map((l) => '    ' + l.trim()).join('\n')}`);

  res.data.acs = acs.map((a) => a.id);
  return res;
}

export function gatePlan(feature, cfg) {
  const res = newResult('plan');
  checkLocked(feature, res, 'spec');
  const md = readArtifact(feature, 'plan');
  if (!md) { res.errors.push(`${feature.dir}/plan.md fehlt`); return res; }
  checkPlaceholders(md, res, 'plan.md');

  const secs = sections(md);
  for (const name of PLAN_SECTIONS) {
    const content = section(secs, name);
    if (content === null) res.errors.push(`Pflichtabschnitt "## ${name}" fehlt`);
    else if (!content) res.errors.push(`Abschnitt "## ${name}" ist leer`);
  }

  const acIds = ticketAcIds(feature);
  const existing = new Set(listFiles());

  const rows = tableRows(section(secs, 'Betroffene Dateien') ?? '').filter((r) => r[0]);
  if (!rows.length) res.errors.push('Tabelle "Betroffene Dateien" enthält keine Zeilen (| Pfad | neu/ändern/löschen | Zweck |)');
  for (const [rawPath, rawAction = ''] of rows) {
    const file = rawPath.replace(/`/g, '').trim();
    const action = rawAction.toLowerCase();
    if (/(ändern|aendern|change|modify|edit|löschen|loeschen|delete|remove)/.test(action)) {
      if (!existing.has(file)) res.errors.push(`Betroffene Dateien: "${file}" soll geändert/gelöscht werden, existiert aber nicht`);
    } else if (/(neu|new|add|create|anlegen)/.test(action)) {
      if (existing.has(file)) res.warnings.push(`Betroffene Dateien: "${file}" ist als neu markiert, existiert aber bereits`);
    } else {
      res.warnings.push(`Betroffene Dateien: unbekannte Aktion "${rawAction}" bei "${file}" (erwartet: neu/ändern/löschen)`);
    }
  }

  const steps = (section(secs, 'Arbeitsschritte') ?? '').split(/\r?\n/)
    .map((l) => l.match(/^\s*(\d+)[.)]\s+(.*)$/)).filter(Boolean).map((m) => ({ n: m[1], text: m[2], refs: acRefs(m[2]) }));
  if (!steps.length) res.errors.push('Keine nummerierten Arbeitsschritte gefunden ("1. ... (AC-1)")');
  for (const s of steps) {
    const unknown = s.refs.filter((r) => !acIds.includes(r));
    if (unknown.length) res.errors.push(`Schritt ${s.n} verweist auf unbekannte AC: ${unknown.join(', ')}`);
    if (!s.refs.length) res.warnings.push(`Schritt ${s.n} ist keinem Akzeptanzkriterium zugeordnet`);
  }
  const covered = new Set(steps.flatMap((s) => s.refs));
  const uncovered = acIds.filter((id) => !covered.has(id));
  if (uncovered.length) res.errors.push(`Kein Arbeitsschritt deckt ab: ${uncovered.join(', ')}`);

  const strategyRefs = acRefs(section(secs, 'Teststrategie') ?? '');
  const untested = acIds.filter((id) => !strategyRefs.includes(id));
  if (untested.length) res.errors.push(`Teststrategie nennt keinen Test für: ${untested.join(', ')}`);
  return res;
}

/** Durchsucht alle Testdateien nach Feature-Tags, Assertions, skip/only. */
export function scanTests(feature, cfg) {
  const tagRe = new RegExp(`\\b${feature.id}/(AC-\\d+)\\b`, 'g');
  const count = (text, patterns) => patterns.reduce((n, p) => n + (text.match(new RegExp(p, 'g'))?.length ?? 0), 0);
  const files = listFiles().filter((f) => matchesAny(f, cfg.test_globs)).map((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return {
      path: f,
      tags: unique([...text.matchAll(tagRe)].map((m) => m[1])).sort(),
      assertions: count(text, cfg.assertion_patterns),
      skips: count(text, cfg.skip_patterns),
      only: count(text, cfg.only_patterns),
    };
  });
  const tagged = files.filter((f) => f.tags.length);
  return {
    tagged,
    tags: unique(tagged.flatMap((f) => f.tags)).sort(),
    total_skips: files.reduce((n, f) => n + f.skips, 0),
    only_files: files.filter((f) => f.only).map((f) => f.path),
  };
}

export function gateTests(feature, cfg) {
  const res = newResult('tests');
  checkLocked(feature, res, 'spec');
  checkLocked(feature, res, 'plan');
  const acIds = ticketAcIds(feature);
  const scan = scanTests(feature, cfg);
  res.data.snapshot = scan;

  if (!scan.tagged.length) {
    res.errors.push(`Keine Testdatei enthält Tags "${feature.id}/AC-n". Jeder Test braucht den Tag im Testnamen, z. B. it('${feature.id}/AC-1 zeigt ...')`);
  }
  const missing = acIds.filter((id) => !scan.tags.includes(id));
  if (scan.tagged.length && missing.length) res.errors.push(`Kein Test für: ${missing.map((id) => `${feature.id}/${id}`).join(', ')}`);
  const unknown = scan.tags.filter((t) => !acIds.includes(t));
  if (unknown.length) res.errors.push(`Tests verweisen auf AC, die nicht im Ticket stehen: ${unknown.join(', ')}`);
  if (scan.only_files.length) res.errors.push(`.only in Testdateien (blendet andere Tests aus): ${scan.only_files.join(', ')}`);
  for (const f of scan.tagged) if (!f.assertions) res.errors.push(`${f.path}: keine Assertions (expect/assert) gefunden`);
  if (res.errors.length) return res;

  // Red-Phase: Die neuen Tests müssen fehlschlagen, solange das Feature fehlt.
  const r = run(cfg.commands.test, cfg.command_timeout_sec);
  if (r.timedOut) res.errors.push(`Testlauf nach ${cfg.command_timeout_sec}s abgebrochen (Watch-Modus? Testbefehl muss sich selbst beenden)`);
  else if (r.code === 0) res.errors.push(`Testsuite ist grün. Die neuen Tests müssen vor der Implementierung FEHLSCHLAGEN (Red). Prüfe, ob sie das neue Verhalten wirklich testen.`);
  else if (cfg.red_output_must_mention_tests) {
    const markers = [`${feature.id}/AC-`, ...scan.tagged.map((f) => path.posix.basename(f.path))];
    if (!markers.some((m) => r.out.includes(m))) {
      res.errors.push(`Testsuite schlägt fehl, aber nicht wegen der neuen Tests (Ausgabe nennt weder Tags noch Testdateien). Zuerst die bestehenden Fehler beheben:\n${indent(tail(r.out, cfg.output_tail_lines))}`);
    }
  }
  if (!res.errors.length) res.notes.push(`Red bestätigt: Testsuite schlägt fehl (Exit ${r.code}), neue Tests sind beteiligt.`);
  return res;
}

export function gateImplement(feature, cfg) {
  const res = newResult('implement');
  checkLocked(feature, res, 'spec');
  checkLocked(feature, res, 'plan');
  const acIds = ticketAcIds(feature);

  // Test-Integrität: Tests dürfen nicht geschwächt werden, um grün zu werden.
  const snap = feature.test_snapshot;
  const scan = scanTests(feature, cfg);
  if (snap) {
    const now = new Map(scan.tagged.map((f) => [f.path, f]));
    for (const before of snap.tagged) {
      const after = now.get(before.path);
      if (!after) { res.errors.push(`Testdatei ${before.path} wurde gelöscht oder hat keine Feature-Tags mehr`); continue; }
      const lostTags = before.tags.filter((t) => !after.tags.includes(t));
      if (lostTags.length) res.errors.push(`${before.path}: Tests entfernt für ${lostTags.join(', ')}`);
      if (after.assertions < before.assertions) res.errors.push(`${before.path}: Assertions reduziert (${before.assertions} → ${after.assertions})`);
    }
    if (scan.total_skips > snap.total_skips) res.errors.push(`Neue skip/todo-Markierungen in Testdateien (${snap.total_skips} → ${scan.total_skips})`);
  }
  if (scan.only_files.length) res.errors.push(`.only in Testdateien: ${scan.only_files.join(', ')}`);
  const missing = acIds.filter((id) => !scan.tags.includes(id));
  if (missing.length) res.errors.push(`Kein Test mehr für: ${missing.join(', ')}`);

  const changed = changedFiles(feature.base);
  const prodChanges = changed.filter((f) => !matchesAny(f, [...cfg.test_globs, ...cfg.test_support_globs]));
  if (!prodChanges.length) res.warnings.push('Keine Änderungen außerhalb von Testdateien gefunden');

  for (const check of cfg.commands.checks) {
    if (check.enabled === false) continue;
    if (check.when_changed && !changed.some((f) => matchesAny(f, check.when_changed))) {
      res.notes.push(`${check.name}: übersprungen (keine passenden Änderungen)`);
      continue;
    }
    const r = run(check.run, check.timeout_sec ?? cfg.command_timeout_sec);
    if (r.code === 0) res.notes.push(`${check.name}: ok`);
    else res.errors.push(`${check.name} fehlgeschlagen (\`${check.run}\`, Exit ${r.timedOut ? 'Timeout' : r.code}):\n${indent(tail(r.out, cfg.output_tail_lines))}`);
  }
  return res;
}

export function gateReview(feature, cfg) {
  const res = newResult('review');
  const md = readArtifact(feature, 'review');
  if (!md) { res.errors.push(`${feature.dir}/review.md fehlt`); return res; }
  checkPlaceholders(md, res, 'review.md');
  const body = stripComments(md);

  const status = body.match(/\*\*Status:\*\*\s*`?([A-Z_]+)/)?.[1];
  const reviewedHash = body.match(/\*\*Diff-Hash:\*\*\s*`?([0-9a-f]{12})/)?.[1];
  const current = diffHash(feature.base);

  if (status === 'CHANGES_REQUESTED') {
    res.pending.push(`Reviewer fordert Änderungen. Befunde umsetzen über: ${WF} back implement --reason "Review-Runde ${feature.review_rounds + 1}"`);
    return res;
  }
  if (status === 'REJECTED') {
    res.pending.push(`Reviewer lehnt den Ansatz ab. Zurück zur Planung: ${WF} back plan --reason "..."`);
    return res;
  }
  if (status !== 'APPROVED') res.errors.push(`"**Status:**" muss APPROVED, CHANGES_REQUESTED oder REJECTED sein (gefunden: ${status ?? 'nichts'})`);
  if (!reviewedHash) res.errors.push('"**Diff-Hash:**" fehlt (aus `wf.mjs diff` übernehmen)');
  else if (reviewedHash !== current) res.errors.push(`Review bezieht sich auf einen alten Code-Stand (Review: ${reviewedHash}, aktuell: ${current}). Erneut reviewen.`);
  if (cfg.require_reviewer_subagent && feature.reviewer_hash !== current) {
    res.errors.push(`Der Subagent "code-reviewer" ist für den aktuellen Code-Stand (${current}) noch nicht gelaufen.`);
  }

  const secs = sections(md);
  const matrix = tableRows(section(secs, 'Akzeptanzkriterien') ?? '');
  for (const id of ticketAcIds(feature)) {
    const row = matrix.find((r) => r[0].replace(/[`*]/g, '').trim() === id);
    if (!row) res.errors.push(`AC-Matrix: Zeile für ${id} fehlt`);
    else if (!row.some((c) => /✅|\b(?:erfüllt|ja|pass(?:ed)?)\b/i.test(c)) || row.some((c) => /❌|nicht erfüllt/i.test(c))) {
      res.errors.push(`AC-Matrix: ${id} ist nicht als erfüllt (✅) markiert`);
    }
  }

  const findings = tableRows(section(secs, 'Befunde') ?? '');
  for (const row of findings) {
    const severity = row.find((c) => cfg.block_severities.includes(c.replace(/[`*]/g, '').toUpperCase()));
    const resolved = row.some((c) => /\b(?:behoben|erledigt|fixed|resolved)\b/i.test(c));
    if (severity && !resolved) res.errors.push(`Offener ${severity}-Befund: ${row.join(' | ')}`);
  }
  return res;
}

export const GATES = { spec: gateSpec, plan: gatePlan, tests: gateTests, implement: gateImplement, review: gateReview };

/** Gate plus menschliche Freigabe (sofern für die Phase konfiguriert). */
export function gateWithApproval(feature, cfg) {
  const res = GATES[feature.phase](feature, cfg);
  if (cfg.human_approval.includes(feature.phase) && ARTIFACTS[feature.phase]) {
    const md = readArtifact(feature, feature.phase);
    if (md !== null && feature.approvals[feature.phase] !== sha(md)) {
      res.pending.push(`Wartet auf Freigabe von ${ARTIFACTS[feature.phase]} durch den Nutzer. Dokument zusammenfassen und den Nutzer bitten, "freigabe" zu schreiben (Änderungswünsche normal formulieren).`);
    }
  }
  return res;
}

// ---------------------------------------------------------------- Rollen & Schreibrechte

/** Subagent-Rollen: in welcher Phase sie arbeiten dürfen. */
export const ROLES = {
  'spec-creator': 'spec',
  'tech-planner': 'plan',
  'test-writer': 'tests',
  'code-implementer': 'implement',
  'code-reviewer': 'review',
};

const INFRA_GLOBS = ['.claude/workflow/**', '.claude/settings.json', '.claude/settings.local.json', '.claude/agents/**', '.claude/skills/feature/**'];

/**
 * Darf `agentType` (undefined = Hauptagent) die Datei `file` jetzt schreiben?
 * Gibt null (erlaubt) oder eine Begründung (verboten) zurück.
 */
export function writeDenial(state, cfg, file, agentType) {
  if (file === null) return null; // außerhalb des Projekts: nicht unsere Sache
  if (file === '.workflow/state.json') return `Der Workflow-Zustand wird nur über \`${WF}\` geändert.`;
  const feature = activeFeature(state);
  if (!feature) return null;
  if (matchesAny(file, INFRA_GLOBS)) return 'Workflow-Dateien (Gates, Hooks, Agenten, Settings) sind während eines aktiven Features gesperrt. Der Nutzer kann sie selbst ändern.';

  const phase = feature.phase;
  const role = ROLES[agentType];
  if (role && role !== phase) return `Die Rolle "${agentType}" arbeitet nur in Phase "${role}", aktuell ist "${phase}".`;

  const artifact = (p) => `${feature.dir}/${ARTIFACTS[p]}`;
  const locked = (feature.test_snapshot?.tagged ?? []).map((f) => f.path);
  switch (phase) {
    case 'spec':
    case 'plan':
      if (file === artifact(phase)) return null;
      return `In Phase "${phase}" darf nur ${artifact(phase)} geschrieben werden.`;
    case 'tests':
      if (matchesAny(file, [...cfg.test_globs, ...cfg.test_support_globs])) return null;
      return `In Phase "tests" dürfen nur Testdateien geschrieben werden (${cfg.test_globs.join(', ')}). Produktionscode folgt in Phase "implement".`;
    case 'implement':
      if (file.startsWith('.workflow/')) return 'Ticket, Plan und Review sind in Phase "implement" gesperrt.';
      if (locked.includes(file)) return `${file} enthält die freigegebenen Akzeptanztests und ist gesperrt. Ist ein Test falsch, zurück mit \`${WF} back tests --reason "..."\`.`;
      return null;
    case 'review':
      if (file === artifact('review') && agentType === 'code-reviewer') return null;
      return `In Phase "review" schreibt nur der Subagent "code-reviewer", und nur ${artifact('review')}. Für Korrekturen: \`${WF} back implement --reason "..."\`.`;
    default:
      return null;
  }
}

/** Shell-Befehle, die den Workflow umgehen würden. */
export function commandDenial(state, command, agentType) {
  const wfCall = command.match(/^\s*node\s+["']?(?:\.\/)?\.claude[\\/]workflow[\\/]wf\.mjs["']?\s+(\w+)/);
  const chained = /[;&|>`]|\$\(/.test(command);
  if (wfCall && !chained) {
    if (ROLES[agentType] && !['status', 'check', 'diff'].includes(wfCall[1])) {
      return `Subagenten dürfen nur \`${WF} status|check|diff\` ausführen. Phasenwechsel macht der Hauptagent.`;
    }
    return null;
  }
  if (wfCall) return `\`${WF}\` bitte ohne Verkettung, Pipe oder Umleitung aufrufen (große Diffs: \`${WF} diff --summary\`).`;
  if (/\.workflow[\\/]+state\.json/.test(command)) return `Der Workflow-Zustand wird nur über \`${WF}\` geändert.`;
  if (activeFeature(state) && /\.claude[\\/]+(?:workflow|agents|settings)/.test(command)) {
    return 'Workflow-Dateien sind während eines aktiven Features gesperrt. Zum Lesen das Read-Tool verwenden.';
  }
  return null;
}

// ---------------------------------------------------------------- Ausgabe

const indent = (text) => text.split(/\r?\n/).map((l) => `      ${l}`).join('\n');

export function formatReport(feature, res) {
  const ok = !res.errors.length && !res.pending.length;
  const lines = [`Gate "${res.phase}" für ${feature.id}: ${ok ? 'BESTANDEN' : 'NICHT BESTANDEN'}`];
  const block = (label, items) => items.length && lines.push(`${label} (${items.length}):`, ...items.map((i) => `  - ${i}`));
  block('FEHLER', res.errors);
  block('WARTET', res.pending);
  block('WARNUNGEN', res.warnings);
  block('INFO', res.notes);
  return lines.join('\n');
}

export const NEXT_STEPS = {
  spec: `Subagent "spec-creator" füllt ticket.md. Offene Fragen mit dem Nutzer klären. Dann \`${WF} advance\`.`,
  plan: `Subagent "tech-planner" schreibt plan.md. Dann \`${WF} check\`.`,
  tests: `Subagent "test-writer" schreibt fehlschlagende Tests mit Tags. Dann \`${WF} advance\` (prüft Red).`,
  implement: `Subagent "code-implementer" implementiert, bis alle Checks grün sind. Dann \`${WF} advance\`.`,
  review: `Subagent "code-reviewer" prüft den Diff und schreibt review.md. Dann \`${WF} advance\`.`,
  done: 'Feature abgeschlossen. Änderungen dem Nutzer zusammenfassen (Commit nur auf Wunsch).',
};
