import { DEFAULT_CONTEXT_LIMIT } from '../shared/types.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export interface CustomVarDoc {
  name: string;
  description: string;
}

/** PERSON_CUSTOM_VARS_DOC is a JSON array of {name, description} — names/descriptions only, never values (the values are already real env vars by the time this process starts). */
function parseCustomVarsDoc(raw: string | undefined): CustomVarDoc[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is CustomVarDoc => typeof v === 'object' && v !== null && typeof v.name === 'string' && typeof v.description === 'string',
    );
  } catch {
    return [];
  }
}

/** PERSON_TOOL_PERMISSIONS is a JSON array of tool names already granted `always_allow` (PersonState.toolPermissions' keys, as of pod create/recreate time) — boot-time seed for the runner's in-memory PermissionGate (permission-gate.ts), so a persisted grant survives a restart. */
function parseToolPermissions(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export interface RunnerConfig {
  slug: string;
  chatId: number;
  tz: string;
  port: number;
  operatorTasksUrl: string;
  tasksToken: string;
  telegramBotToken: string;
  journalDir: string;
  workspaceCwd: string;
  claudeHome: string;
  sessionIdFile: string;
  customVarsDoc: CustomVarDoc[];
  toolPermissions: string[];
  /** The auto-compact ceiling to boot session-controller.ts with — this person's computed default (pod-lifecycle.ts's resolveDefaultContextLimit), overridden at runtime by main() if a saved /context_limit override exists on NFS (sdk-session.ts's readSavedContextLimit). Falls back to DEFAULT_CONTEXT_LIMIT only if the operator somehow didn't set PERSON_CONTEXT_LIMIT (should never happen outside tests/dev). */
  contextLimit: number;
  /** NFS-persisted /context_limit override — same durability pattern as sessionIdFile (survives an in-place container restart, unlike the env var above, which is fixed at Pod creation). */
  contextLimitFile: string;
}

export function loadRunnerConfig(): RunnerConfig {
  const claudeHome = process.env['CLAUDE_HOME'] ?? '/home/claude/.claude';
  return {
    slug: requireEnv('PERSON_SLUG'),
    chatId: Number(requireEnv('PERSON_CHAT_ID')),
    tz: process.env['TZ'] ?? 'Europe/Warsaw',
    port: Number(process.env['PORT'] ?? 8080),
    operatorTasksUrl: requireEnv('OPERATOR_TASKS_URL'),
    tasksToken: requireEnv('PERSON_TASKS_TOKEN'),
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    journalDir: process.env['JOURNAL_DIR'] ?? `${claudeHome}/pan-agent-journal`,
    workspaceCwd: process.env['WORKSPACE_CWD'] ?? '/home/claude/workspace',
    claudeHome,
    sessionIdFile: process.env['SESSION_ID_FILE'] ?? `${claudeHome}/pan-agent-session-id`,
    customVarsDoc: parseCustomVarsDoc(process.env['PERSON_CUSTOM_VARS_DOC']),
    toolPermissions: parseToolPermissions(process.env['PERSON_TOOL_PERMISSIONS']),
    contextLimit: Number(process.env['PERSON_CONTEXT_LIMIT'] ?? DEFAULT_CONTEXT_LIMIT),
    contextLimitFile: process.env['CONTEXT_LIMIT_FILE'] ?? `${claudeHome}/pan-agent-context-limit`,
  };
}
