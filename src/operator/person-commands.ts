/**
 * Self-service per-person commands intercepted from a person's own DM,
 * before routing — mirrors admin-commands.ts's shape, but scoped to the
 * sender's own slug/pod rather than gated on the global admin. The
 * *values* in `/set_var`/`/unset_var` never become a turn — they never
 * enter the model's conversation, turn logs, or Loki's assistant-turn
 * logging, and are applied by restarting the person's own pod (same
 * mechanism admin's /restart uses). Mutating commands do still let the
 * model know something changed — see notifyModel below — since that fact
 * itself (unlike the secret value) carries no sensitive material, and a
 * model with no idea a command just ran can end up flatly contradicting
 * the person about their own just-taken action.
 */
import { log } from '../shared/log.js';
import {
  DEFAULT_CONTEXT_LIMIT,
  type ChatMessage,
  type ControlRequest,
  type ControlResponse,
  type EffortLevel,
  type PersonIndexEntry,
} from '../shared/types.js';
import { enqueueChatMessage, sendTurnWithRetry } from './delivery.js';
import { deleteMemoryFile, deletePersonSkill, listMemoryFiles, listPersonSkills } from './nfs.js';
import { readPersonState, removeCustomEnvVar, setCustomEnvVar } from './person-state.js';
import { podIp, recreatePod } from './pod-lifecycle.js';
import { RESERVED_ENV_NAMES, RUNNER_PORT } from './pod-template.js';
import type { RouterDeps } from './router-deps.js';

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

interface ParsedSetVar {
  key: string;
  value: string;
  description: string;
}

/**
 * Pure parser for `/set_var KEY=VALUE [description...]` — split out from the
 * k8s-touching handler below so the grammar/validation rules are unit
 * testable without a fake k8s client (same pattern as isAuthorized in
 * tasks-api.ts). `args` is the command text already split on whitespace with
 * the `/set_var` token itself removed.
 */
export function parseSetVarArgs(args: string[]): ParsedSetVar | { error: string } {
  const [kv, ...descParts] = args;
  if (!kv || !kv.includes('=')) {
    return { error: 'Usage: /set_var KEY=VALUE [description]' };
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
  updateId: number,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const [cmd, ...args] = trimmed.split(/\s+/);
  switch (cmd) {
    case '/set_var':
      await handleSetVar(deps, slug, person, args, updateId);
      return true;
    case '/list_vars':
      await handleListVars(deps, slug, person);
      return true;
    case '/unset_var':
      await handleUnsetVar(deps, slug, person, args, updateId);
      return true;
    case '/memories':
      await handleListMemories(deps, slug, person);
      return true;
    case '/forget_memory':
      await handleForgetMemory(deps, slug, person, args, updateId);
      return true;
    case '/skills':
      await handleListSkills(deps, slug, person);
      return true;
    case '/forget_skill':
      await handleForgetSkill(deps, slug, person, args, updateId);
      return true;
    case '/compact':
      await handleControlTurn(deps, slug, person, '/compact', updateId);
      return true;
    case '/clear':
      await handleControlTurn(deps, slug, person, '/clear', updateId);
      return true;
    case '/context':
      await handleContext(deps, slug, person);
      return true;
    case '/effort':
      await handleEffort(deps, slug, person, args);
      return true;
    case '/context_limit':
      await handleContextLimit(deps, slug, person, args);
      return true;
    default:
      return false;
  }
}

async function restartToApply(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  await recreatePod(deps.api, deps.cfg, slug, person.chatId, person.tz, person.tasksToken);
}

/**
 * Delivers a short informational note into the person's own live session —
 * same ChatTurn/`/turn` pipeline a normal message takes (so it gets the
 * exact same journal dedup and pod-not-ready retry behavior as any other
 * chat message), just synthesized here instead of coming from Telegram. Not
 * awaited by callers — the person's own deterministic command reply must
 * not block on a live LLM turn, which can take much longer (and, right
 * after /set_var or /unset_var, has to wait out a pod restart first).
 * Fire-and-forget with its own error log instead of silent swallowing.
 */
function notifyModel(deps: RouterDeps, slug: string, person: PersonIndexEntry, updateId: number, note: string): void {
  const message: ChatMessage = {
    messageId: 0,
    text: `[System note: ${note} Stay silent unless it's worth mentioning.]`,
    fromHandle: null,
    date: new Date().toISOString(),
  };
  void enqueueChatMessage(deps.api, deps.cfg, slug, person.chatId, person.tz, person.tasksToken, updateId, message).catch(
    (err) => log.error('person_command_notify_failed', err, { person: slug }),
  );
}

async function handleSetVar(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  args: string[],
  updateId: number,
): Promise<void> {
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
  const desc = parsed.description ? ` (${parsed.description})` : '';
  notifyModel(deps, slug, person, updateId, `The person just set ${parsed.key}${desc} — it's in your Bash environment now.`);
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

async function handleUnsetVar(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  args: string[],
  updateId: number,
): Promise<void> {
  const [key] = args;
  if (!key) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /unset_var KEY');
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
  notifyModel(deps, slug, person, updateId, `The person just unset ${key} — it's no longer in your Bash environment.`);
}

/**
 * /memories and /forget_memory manage the SDK's native auto-memory store
 * directly on the NFS mount (operator/nfs.ts) — no pod restart needed either
 * way, since the runner reads these files fresh on demand each turn rather
 * than baking them into the pod spec the way /set_var's env vars are.
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

async function handleForgetMemory(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  args: string[],
  updateId: number,
): Promise<void> {
  const [name] = args;
  if (!name) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /forget_memory <filename> — see /memories for names.');
    return;
  }
  const removed = await deleteMemoryFile(slug, name);
  await deps.telegram.sendMessage(person.chatId, removed ? `Forgot ${name}.` : `No such memory file: ${name}`);
  if (removed) {
    log.line('memory_file_forgotten', { person: slug, name });
    notifyModel(
      deps,
      slug,
      person,
      updateId,
      `The person just ran /forget_memory on ${name} — that memory file is gone, and its MEMORY.md index entry too. If they ask about it, it's really deleted, not still there.`,
    );
  }
}

/**
 * /skills and /forget_skill manage a person's own custom skills directly on
 * the NFS workspace mount (operator/nfs.ts), same as /memories/forget_memory
 * — no pod restart needed either way, and the SDK itself picks up filesystem
 * changes under .claude/skills/ live, mid-session, on its own (confirmed
 * against the installed SDK before relying on it). The shared `media` skill
 * is never listed or deletable here — it isn't this person's own state.
 */
async function handleListSkills(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const skills = await listPersonSkills(slug);
  if (skills.length === 0) {
    await deps.telegram.sendMessage(person.chatId, 'No custom skills yet.');
    return;
  }
  const lines = skills.map((s) => `${s.name} — ${s.description} (updated ${s.modifiedAt})`);
  await deps.telegram.sendMessage(person.chatId, lines.join('\n'));
}

async function handleForgetSkill(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  args: string[],
  updateId: number,
): Promise<void> {
  const [name] = args;
  if (!name) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /forget_skill <name> — see /skills for names.');
    return;
  }
  const removed = await deletePersonSkill(slug, name);
  await deps.telegram.sendMessage(person.chatId, removed ? `Forgot the ${name} skill.` : `No such skill: ${name}`);
  if (removed) {
    log.line('skill_forgotten', { person: slug, name });
    notifyModel(
      deps,
      slug,
      person,
      updateId,
      `The person just ran /forget_skill on ${name} — that skill's SKILL.md is gone. If they ask about it, or if you still see a stale reference to it in your own memory notes, it's really deleted, not still there.`,
    );
  }
}

/**
 * `/compact` and `/clear` — confirmed live these are genuine SDK-recognized
 * commands (a real `compact_boundary`/`conversation_reset` protocol event,
 * not a model reply), but ONLY when pushed as the bare command text with
 * nothing else in the message. A normal chat message would get
 * `${fromHandle}: ${text}` prefixed by `buildPrompt` (sdk-session.ts) —
 * confirmed live that's exactly what breaks it: the model sees
 * "Andrii Pavlenko: /compact" and answers it as a question instead of the
 * SDK ever recognizing the command. Routed as a `ControlTurn` through the
 * same `/turn` delivery path (journal dedup, busy/retry) specifically to
 * avoid that prefix, not through `enqueueChatMessage`.
 */
/**
 * Immediate ack before the real (possibly slow) work starts — confirmed
 * live 2026-08-23 a manual /compact can run well past a minute with zero
 * visible progress otherwise, which is exactly what read as "does nothing."
 * The actual result (success/timeout) follows later as its own message from
 * the runner once `session-controller.ts`'s control turn resolves — this
 * function doesn't wait for that, it only confirms the command was received.
 */
async function handleControlTurn(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  command: '/compact' | '/clear',
  updateId: number,
): Promise<void> {
  await deps.telegram.sendMessage(
    person.chatId,
    command === '/compact' ? '🔄 Compacting your conversation — can take a minute or two...' : '🧹 Clearing...',
  );
  const delivered = await sendTurnWithRetry(
    deps.api,
    deps.cfg,
    slug,
    person.chatId,
    person.tz,
    person.tasksToken,
    { kind: 'control', updateId, chatId: person.chatId, command },
    // A bit above session-controller.ts's own 180s control-turn timeout, so
    // delivery retries don't give up right before the runner would have
    // recovered on its own.
    200_000,
  );
  if (!delivered) {
    await deps.telegram.sendMessage(person.chatId, "⚠️ Couldn't reach your session right now — try again in a moment.");
  }
}

/** POSTs to the person's own pod's `/control` endpoint — a live call against their already-running session, not a turn (see shared/types.ts). Returns null on any failure to reach the pod. */
async function postControl(deps: RouterDeps, slug: string, body: ControlRequest): Promise<ControlResponse | null> {
  const ip = await podIp(deps.api, deps.cfg.namespace, slug);
  if (!ip) return null;
  try {
    const res = await fetch(`http://${ip}:${RUNNER_PORT}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.json()) as ControlResponse;
  } catch (err) {
    log.error('control_request_failed', err, { person: slug });
    return null;
  }
}

/** Fetches the live context-usage snapshot, or sends a "couldn't reach it" reply and returns null. Shared by /context, /effort (no args), /context_limit (no args). */
async function fetchContext(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
): Promise<Extract<ControlResponse, { action: 'context' }> | null> {
  const result = await postControl(deps, slug, { action: 'context' });
  if (!result) {
    await deps.telegram.sendMessage(person.chatId, "Couldn't reach your session right now — try again in a moment.");
    return null;
  }
  if (!result.ok || result.action !== 'context') {
    await deps.telegram.sendMessage(person.chatId, `Couldn't read context usage: ${!result.ok ? result.error : 'unexpected response'}`);
    return null;
  }
  return result;
}

async function handleContext(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const result = await fetchContext(deps, slug, person);
  if (!result) return;
  const c = result.context;
  const pct = ((c.totalTokens / c.maxTokens) * 100).toFixed(1);
  const lines = [
    `Model: ${c.model}`,
    `Effort: ${c.effortLevel}`,
    `Context: ${c.totalTokens.toLocaleString()} / ${c.maxTokens.toLocaleString()} tokens (${pct}%)`,
    `Your limit: ${c.contextLimit.toLocaleString()} tokens — auto-compacts here (change with /context_limit <n>)`,
    c.isAutoCompactEnabled && c.sdkAutoCompactCeiling != null
      ? `(the model's own hard ceiling is ${c.sdkAutoCompactCeiling.toLocaleString()} — should never be reached, your limit above kicks in first)`
      : '(the model has no ceiling of its own for this session)',
  ];
  await deps.telegram.sendMessage(person.chatId, lines.join('\n'));
}

const VALID_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

async function handleEffort(deps: RouterDeps, slug: string, person: PersonIndexEntry, args: string[]): Promise<void> {
  const [level] = args;
  if (!level) {
    const result = await fetchContext(deps, slug, person);
    if (!result) return;
    await deps.telegram.sendMessage(
      person.chatId,
      `Current effort: ${result.context.effortLevel}. Usage: /effort low|medium|high|xhigh`,
    );
    return;
  }
  if (!VALID_EFFORT_LEVELS.includes(level as EffortLevel)) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /effort low|medium|high|xhigh');
    return;
  }
  const result = await postControl(deps, slug, { action: 'set_effort', level: level as EffortLevel });
  if (!result) {
    await deps.telegram.sendMessage(person.chatId, "Couldn't reach your session right now — try again in a moment.");
    return;
  }
  if (!result.ok) {
    await deps.telegram.sendMessage(person.chatId, `Couldn't set effort level: ${result.error}`);
    return;
  }
  await deps.telegram.sendMessage(
    person.chatId,
    `Effort level set to ${level} for this session (resets to medium if your pod restarts).`,
  );
}

const MIN_CONTEXT_LIMIT = 10_000;
const MAX_CONTEXT_LIMIT = 2_000_000;

async function handleContextLimit(deps: RouterDeps, slug: string, person: PersonIndexEntry, args: string[]): Promise<void> {
  const [raw] = args;
  if (!raw) {
    const result = await fetchContext(deps, slug, person);
    if (!result) return;
    await deps.telegram.sendMessage(
      person.chatId,
      `Current limit: ${result.context.contextLimit.toLocaleString()} tokens. Usage: /context_limit <tokens>`,
    );
    return;
  }
  const tokens = Number(raw);
  if (!Number.isInteger(tokens) || tokens < MIN_CONTEXT_LIMIT || tokens > MAX_CONTEXT_LIMIT) {
    await deps.telegram.sendMessage(
      person.chatId,
      `Usage: /context_limit <tokens> — an integer between ${MIN_CONTEXT_LIMIT.toLocaleString()} and ${MAX_CONTEXT_LIMIT.toLocaleString()}.`,
    );
    return;
  }
  const result = await postControl(deps, slug, { action: 'set_context_limit', tokens });
  if (!result) {
    await deps.telegram.sendMessage(person.chatId, "Couldn't reach your session right now — try again in a moment.");
    return;
  }
  if (!result.ok) {
    await deps.telegram.sendMessage(person.chatId, `Couldn't set context limit: ${result.error}`);
    return;
  }
  await deps.telegram.sendMessage(
    person.chatId,
    `Context limit set to ${tokens.toLocaleString()} tokens for this session (resets to ${DEFAULT_CONTEXT_LIMIT.toLocaleString()} if your pod restarts).`,
  );
}
