#!/usr/bin/env node
// Hook-Einstiegspunkt für Claude Code (siehe .claude/settings.json).
// Aufruf: node hooks.mjs <pre-tool|post-tool|stop|subagent-stop|prompt>  – Hook-Input kommt als JSON über stdin.
import {
  WF, ARTIFACTS, GATES, ROLES,
  loadConfig, loadState, saveState, activeFeature, readArtifact, logEvent,
  writeDenial, commandDenial, formatReport, relToRoot, matchesAny, run, tail, sha, diffHash,
} from './lib.mjs';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const emit = (obj) => process.stdout.write(JSON.stringify(obj));
const filePathOf = (toolInput) => toolInput.file_path ?? toolInput.notebook_path ?? null;

/** PreToolUse: Schreibrechte je Phase und Rolle durchsetzen. */
function preTool(input) {
  const toolInput = input.tool_input ?? {};
  const state = loadState();
  let reason = null;
  if (FILE_TOOLS.has(input.tool_name)) {
    const file = filePathOf(toolInput);
    if (file) reason = writeDenial(state, loadConfig(), relToRoot(file), input.agent_type);
  } else if (SHELL_TOOLS.has(input.tool_name) && toolInput.command) {
    reason = commandDenial(state, toolInput.command, input.agent_type);
  }
  if (reason) {
    emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[workflow] ${reason}` } });
  }
}

/** PostToolUse: schnelle Checks (z. B. ESLint) für die gerade bearbeitete Datei. */
function postTool(input) {
  if (!FILE_TOOLS.has(input.tool_name)) return;
  const feature = activeFeature(loadState());
  if (!feature || !['tests', 'implement'].includes(feature.phase)) return;
  const file = relToRoot(filePathOf(input.tool_input ?? {}) ?? '');
  if (!file) return;

  const cfg = loadConfig();
  const failures = [];
  for (const rule of cfg.on_edit) {
    if (!matchesAny(file, [rule.glob].flat())) continue;
    const r = run(rule.run.replaceAll('{file}', JSON.stringify(file)), rule.timeout_sec ?? 60);
    if (r.code !== 0 && rule.block !== false) failures.push(`${rule.name ?? rule.run}:\n${tail(r.out, cfg.output_tail_lines)}`);
  }
  if (failures.length) {
    process.stderr.write(`[workflow] Prüfung nach Bearbeitung von ${file} fehlgeschlagen:\n${failures.join('\n\n')}`);
    process.exit(2);
  }
}

/**
 * Stop / SubagentStop: Eine Rolle darf erst aufhören, wenn das Gate ihrer Phase grün ist.
 * Nach max_attempts Fehlversuchen wird an den Nutzer eskaliert statt endlos zu schleifen.
 */
function stopGate(input, isSubagent) {
  const state = loadState();
  const feature = activeFeature(state);
  if (!feature) return;
  const cfg = loadConfig();

  if (isSubagent) {
    // Fremde Subagenten (Explore, Plan, ...) und Rollen außerhalb ihrer Phase nicht blockieren.
    if (ROLES[input.agent_type] !== feature.phase) return;
    if (input.agent_type === 'code-reviewer') feature.reviewer_hash = diffHash(feature.base);
  } else if (!cfg.stop_gate_phases.includes(feature.phase)) {
    return;
  }
  if (feature.escalated) return saveState(state);

  const res = GATES[feature.phase](feature, cfg);
  if (!res.errors.length) {
    feature.attempts = 0;
    return saveState(state);
  }

  feature.attempts++;
  logEvent(feature, 'gate-failed', { by: input.agent_type ?? 'main', attempt: feature.attempts, errors: res.errors.length });
  if (feature.attempts >= cfg.max_attempts) {
    feature.escalated = true;
    logEvent(feature, 'escalated');
    saveState(state);
    emit({ systemMessage: `[workflow] Gate "${feature.phase}" für ${feature.id} ist nach ${feature.attempts} Versuchen nicht grün. Bitte eingreifen (jede Nachricht setzt den Zähler zurück).\n\n${formatReport(feature, res)}` });
    return;
  }
  saveState(state);
  emit({
    decision: 'block',
    reason: `[workflow] Versuch ${feature.attempts}/${cfg.max_attempts}: Das Gate "${feature.phase}" ist nicht bestanden, du kannst noch nicht abschließen. Behebe die Ursachen (Tests nicht abschwächen).\n\n${formatReport(feature, res)}`,
  });
}

/** UserPromptSubmit: Freigaben des Nutzers erfassen und Workflow-Kontext einblenden. */
function prompt(input) {
  const state = loadState();
  const feature = activeFeature(state);
  if (!feature) return;
  const cfg = loadConfig();
  const text = (input.prompt ?? '').trim();
  const notes = [];

  if (feature.attempts || feature.escalated) {
    feature.attempts = 0;
    feature.escalated = false;
    notes.push('Der Nutzer hat eingegriffen, Versuchszähler zurückgesetzt.');
  }
  if (/^\/?(?:freigabe|freigeben|approve|approved|lgtm)\b/i.test(text)) {
    const md = ARTIFACTS[feature.phase] ? readArtifact(feature, feature.phase) : null;
    if (cfg.human_approval.includes(feature.phase) && md !== null) {
      feature.approvals[feature.phase] = sha(md);
      logEvent(feature, 'approved', { hash: sha(md) });
      notes.push(`Der Nutzer hat ${ARTIFACTS[feature.phase]} (Stand ${sha(md)}) freigegeben. Führe jetzt \`${WF} advance\` aus und fahre mit der nächsten Phase fort.`);
    } else {
      notes.push(`In Phase "${feature.phase}" ist keine Freigabe vorgesehen.`);
    }
  }
  if (/^\/?weitere runde\b/i.test(text)) {
    feature.extra_rounds++;
    logEvent(feature, 'extra-round');
    notes.push('Der Nutzer erlaubt eine weitere Review-Runde.');
  }
  saveState(state);
  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[workflow] Aktives Feature ${feature.id} "${feature.title}", Phase "${feature.phase}". ${notes.join(' ')}`.trim(),
    },
  });
}

const HANDLERS = {
  'pre-tool': preTool,
  'post-tool': postTool,
  stop: (input) => stopGate(input, false),
  'subagent-stop': (input) => stopGate(input, true),
  prompt,
};

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const handler = HANDLERS[process.argv[2]];
  if (!handler) throw new Error(`Unbekanntes Hook-Ereignis: ${process.argv[2]}`);
  handler(raw.trim() ? JSON.parse(raw) : {});
} catch (err) {
  // Exit 1 = nicht blockierender Fehler: ein defekter Hook soll die Sitzung nicht lahmlegen.
  process.stderr.write(`[workflow-hook] ${err.stack || err.message}\n`);
  process.exit(1);
}
