#!/usr/bin/env node
// Installiert den Feature-Workflow in ein JS/React-Projekt.
//   node install.mjs <projektordner> [--force] [--dry-run]
// --force überschreibt vorhandene Workflow-Dateien (inkl. config.json), --dry-run zeigt nur die erkannte Konfiguration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLUEPRINT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(BLUEPRINT, 'template');
const HOOK_MARKER = '.claude/workflow/hooks.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
if (!target) {
  console.log('Aufruf: node install.mjs <projektordner> [--force] [--dry-run]');
  process.exit(1);
}
const ROOT = path.resolve(target);
if (!fs.existsSync(ROOT)) {
  console.error(`Ordner nicht gefunden: ${ROOT}`);
  process.exit(1);
}

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ---------------------------------------------------------------- Projekt erkennen

function detect() {
  const pkg = exists('package.json') ? readJson('package.json') : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const has = (name) => name in deps;

  const pm = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : exists('bun.lockb') || exists('bun.lock') ? 'bun' : 'npm';
  const x = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm];
  const script = (name) => (pm === 'npm' || pm === 'bun' ? `${pm} run ${name}` : `${pm} ${name}`);
  const hasScript = (name) => scripts[name] && !/no test specified/.test(scripts[name]);

  let test;
  if (has('vitest')) test = `${x} vitest run`;
  else if (has('jest')) test = `${x} jest`;
  else if (has('react-scripts')) test = `${x} react-scripts test --watchAll=false`;
  else if (hasScript('test')) test = `${pm} test`;
  else test = 'npm test';

  const checks = [];
  if (hasScript('typecheck')) checks.push({ name: 'typecheck', run: script('typecheck') });
  else if (has('typescript') && exists('tsconfig.json')) {
    let usesReferences = false;
    try { usesReferences = /"references"\s*:/.test(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')); } catch {}
    checks.push({ name: 'typecheck', run: usesReferences ? `${x} tsc -b` : `${x} tsc --noEmit` });
  }
  if (hasScript('lint')) checks.push({ name: 'lint', run: script('lint') });
  else if (has('eslint')) checks.push({ name: 'lint', run: `${x} eslint .` });
  checks.push({ name: 'test', run: test });
  if (hasScript('build')) checks.push({ name: 'build', run: script('build'), enabled: false });
  const audit = { npm: 'npm audit --audit-level=high', pnpm: 'pnpm audit --audit-level high', yarn: null, bun: null }[pm];
  if (audit) checks.push({ name: 'audit', run: audit, when_changed: ['package.json', 'package-lock.json', 'pnpm-lock.yaml'] });

  const onEdit = [];
  const code = '**/*.{js,jsx,ts,tsx,mjs,cjs}';
  if (has('prettier')) onEdit.push({ name: 'prettier', glob: `${code.slice(0, -1)},css,scss,json,md}`, run: `${x} prettier --write {file}`, block: false });
  if (has('eslint')) onEdit.push({ name: 'eslint', glob: code, run: `${x} eslint {file}`, block: true });

  const stack = [has('next') && 'Next.js', has('vite') && 'Vite', has('react-scripts') && 'CRA', has('react') && 'React',
    has('typescript') && 'TypeScript', has('vitest') && 'Vitest', has('jest') && 'Jest', has('@testing-library/react') && 'Testing Library',
    has('eslint') && 'ESLint', has('prettier') && 'Prettier'].filter(Boolean);
  return { pm, stack, hasPkg: Object.keys(pkg).length > 0, config: { commands: { test, checks }, on_edit: onEdit } };
}

const BASE_CONFIG = {
  human_approval: ['plan'],
  min_acceptance_criteria: 2,
  max_attempts: 5,
  max_review_rounds: 3,
  stop_gate_phases: ['implement'],
  require_reviewer_subagent: true,
  block_severities: ['BLOCKER', 'MAJOR'],
  strict_wording: false,
  output_tail_lines: 40,
  command_timeout_sec: 600,
};

// ---------------------------------------------------------------- Installieren

function copyTree(src, dest, written, skipped) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) { copyTree(s, d, written, skipped); continue; }
    const rel = path.relative(ROOT, d).split(path.sep).join('/');
    if (rel === '.claude/settings.json') continue; // wird zusammengeführt, nicht kopiert
    if (fs.existsSync(d) && !force) { skipped.push(rel); continue; }
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    written.push(rel);
  }
}

/** Unsere Hooks in eine bestehende settings.json einfügen, ohne fremde Hooks anzufassen. */
function mergeSettings() {
  const file = path.join(ROOT, '.claude', 'settings.json');
  const ours = JSON.parse(fs.readFileSync(path.join(TEMPLATE, '.claude', 'settings.json'), 'utf8'));
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  settings.hooks ??= {};
  for (const [event, groups] of Object.entries(ours.hooks)) {
    const current = (settings.hooks[event] ?? []).filter((g) => !JSON.stringify(g).includes(HOOK_MARKER));
    settings.hooks[event] = [...current, ...groups];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function ensureGitignore() {
  const file = path.join(ROOT, '.gitignore');
  const lines = ['.workflow/state.json', '.workflow/state.json.tmp'];
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !text.split(/\r?\n/).includes(l));
  if (!missing.length) return false;
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}\n# Claude Feature-Workflow (lokaler Zustand; Tickets/Pläne/Reviews werden versioniert)\n${missing.join('\n')}\n`);
  return true;
}

const info = detect();
const config = { ...BASE_CONFIG, ...info.config };

console.log(`Projekt:   ${ROOT}`);
console.log(`Erkannt:   ${info.stack.join(', ') || '(nichts – package.json fehlt?)'} · Paketmanager ${info.pm}`);
console.log(`Checks:    ${config.commands.checks.map((c) => `${c.name}${c.enabled === false ? ' (aus)' : ''}`).join(', ')}`);
console.log(`Testlauf:  ${config.commands.test}`);
if (dryRun) {
  console.log(`\nconfig.json (Vorschau):\n${JSON.stringify(config, null, 2)}`);
  process.exit(0);
}
if (!info.hasPkg) console.warn('WARNUNG: Keine package.json gefunden – Befehle in config.json bitte prüfen.');
if (!exists('.git')) console.warn('WARNUNG: Kein git-Repository. Der Workflow braucht git (git init && erster Commit).');

const written = [];
const skipped = [];
copyTree(path.join(TEMPLATE, '.claude'), path.join(ROOT, '.claude'), written, skipped);
mergeSettings();

const configFile = path.join(ROOT, '.claude', 'workflow', 'config.json');
if (!fs.existsSync(configFile) || force) {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  written.push('.claude/workflow/config.json');
} else {
  skipped.push('.claude/workflow/config.json');
}
const gitignoreUpdated = ensureGitignore();

console.log(`\nGeschrieben (${written.length}):\n  ${written.join('\n  ')}`);
console.log('  .claude/settings.json (Hooks zusammengeführt)');
if (gitignoreUpdated) console.log('  .gitignore (state.json ergänzt)');
if (skipped.length) console.log(`\nÜbersprungen, existiert bereits (mit --force überschreiben):\n  ${skipped.join('\n  ')}`);
console.log(`
Nächste Schritte:
  1. .claude/workflow/config.json prüfen (Befehle, Freigaben, Limits)
  2. Workflow-Dateien committen:  git add .claude .gitignore && git commit -m "Claude Feature-Workflow"
  3. Claude Code im Projekt neu starten (Hooks werden beim Start geladen)
  4. Feature starten:  /feature <deine Idee>`);
