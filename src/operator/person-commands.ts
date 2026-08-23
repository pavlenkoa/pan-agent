/**
 * Self-service per-person commands intercepted from a person's own DM,
 * before routing — mirrors admin-commands.ts's shape, but scoped to the
 * sender's own slug/pod rather than gated on the global admin. `/set-var`
 * never becomes a turn: the value never enters the model's conversation,
 * turn logs, or Loki's assistant-turn logging, and it's applied by
 * restarting the person's own pod (same mechanism admin's /restart uses).
 */
import { log } from '../shared/log.js';
import type { PersonIndexEntry } from '../shared/types.js';
import { deleteMemoryFile, listMemoryFiles } from './nfs.js';
import { readPersonState, removeCustomEnvVar, setCustomEnvVar } from './person-state.js';
import { recreatePod } from './pod-lifecycle.js';
import { RESERVED_ENV_NAMES } from './pod-template.js';
import type { RouterDeps } from './router-deps.js';

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

interface ParsedSetVar {
  key: string;
  value: string;
  description: string;
}

/**
 * Pure parser for `/set-var KEY=VALUE [description...]` — split out from the
 * k8s-touching handler below so the grammar/validation rules are unit
 * testable without a fake k8s client (same pattern as isAuthorized in
 * tasks-api.ts). `args` is the command text already split on whitespace with
 * the `/set-var` token itself removed.
 */
export function parseSetVarArgs(args: string[]): ParsedSetVar | { error: string } {
  const [kv, ...descParts] = args;
  if (!kv || !kv.includes('=')) {
    return { error: 'Usage: /set-var KEY=VALUE [description]' };
  }
  const eq = kv.indexOf('=');
  const key = kv.slice(0, eq);
  const value = kv.slice(eq + 1);
  if (!VAR_NAME_RE.test(key)) {
    return { error: `Invalid variable name "${key}" — letters/digits/underscore only, can't start with a digit.` };
  }
  if (RESERVED_ENV_NAMES.has(key)) {
    return { error: `"${key}" is a reserved name and can't be set this way.` };
  }
  if (!value) {
    return { error: 'Value cannot be empty.' };
  }
  return { key, value, description: descParts.join(' ') };
}

/** Returns true if `text` was a recognized person command (handled either way). */
export async function tryHandlePersonCommand(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const [cmd, ...args] = trimmed.split(/\s+/);
  switch (cmd) {
    case '/set-var':
      await handleSetVar(deps, slug, person, args);
      return true;
    case '/list-vars':
      await handleListVars(deps, slug, person);
      return true;
    case '/unset-var':
      await handleUnsetVar(deps, slug, person, args);
      return true;
    case '/memories':
      await handleListMemories(deps, slug, person);
      return true;
    case '/forget-memory':
      await handleForgetMemory(deps, slug, person, args);
      return true;
    default:
      return false;
  }
}

async function restartToApply(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  await recreatePod(deps.api, deps.cfg, slug, person.chatId, person.tz, person.tasksToken);
}

async function handleSetVar(deps: RouterDeps, slug: string, person: PersonIndexEntry, args: string[]): Promise<void> {
  const parsed = parseSetVarArgs(args);
  if ('error' in parsed) {
    await deps.telegram.sendMessage(person.chatId, parsed.error);
    return;
  }
  await setCustomEnvVar(deps.api, deps.cfg.namespace, slug, parsed.key, parsed.value, parsed.description);
  await deps.telegram.sendMessage(
    person.chatId,
    `Set ${parsed.key}. Restarting your pod to apply — back in a few seconds.`,
  );
  await restartToApply(deps, slug, person);
  log.line('custom_env_var_set', { person: slug, key: parsed.key });
}

async function handleListVars(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const state = await readPersonState(deps.api, deps.cfg.namespace, slug);
  const entries = Object.entries(state?.customEnv ?? {});
  if (entries.length === 0) {
    await deps.telegram.sendMessage(person.chatId, 'No custom variables set.');
    return;
  }
  const lines = entries.map(([key, v]) => `${key} — ${v.description || '(no description)'} (set ${v.setAt})`);
  await deps.telegram.sendMessage(person.chatId, lines.join('\n'));
}

async function handleUnsetVar(deps: RouterDeps, slug: string, person: PersonIndexEntry, args: string[]): Promise<void> {
  const [key] = args;
  if (!key) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /unset-var KEY');
    return;
  }
  const removed = await removeCustomEnvVar(deps.api, deps.cfg.namespace, slug, key);
  if (!removed) {
    await deps.telegram.sendMessage(person.chatId, `No such variable: ${key}`);
    return;
  }
  await deps.telegram.sendMessage(person.chatId, `Unset ${key}. Restarting your pod to apply — back in a few seconds.`);
  await restartToApply(deps, slug, person);
  log.line('custom_env_var_unset', { person: slug, key });
}

/**
 * /memories and /forget-memory manage the SDK's native auto-memory store
 * directly on the NFS mount (operator/nfs.ts) — no pod restart needed either
 * way, since the runner reads these files fresh on demand each turn rather
 * than baking them into the pod spec the way /set-var's env vars are.
 */
async function handleListMemories(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const files = await listMemoryFiles(slug);
  if (files.length === 0) {
    await deps.telegram.sendMessage(person.chatId, 'No memories yet.');
    return;
  }
  const lines = files.map((f) => `${f.name} — ${(f.sizeBytes / 1024).toFixed(1)}KB, updated ${f.modifiedAt}`);
  await deps.telegram.sendMessage(person.chatId, lines.join('\n'));
}

async function handleForgetMemory(deps: RouterDeps, slug: string, person: PersonIndexEntry, args: string[]): Promise<void> {
  const [name] = args;
  if (!name) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /forget-memory <filename> — see /memories for names.');
    return;
  }
  const removed = await deleteMemoryFile(slug, name);
  await deps.telegram.sendMessage(person.chatId, removed ? `Forgot ${name}.` : `No such memory file: ${name}`);
  if (removed) log.line('memory_file_forgotten', { person: slug, name });
}
