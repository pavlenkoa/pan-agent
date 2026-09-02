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
  esputnikServerKey,
  type ChatMessage,
  type ControlResponse,
  type EffortLevel,
  type PersonIndexEntry,
} from '../shared/types.js';
import { enqueueChatMessage, sendTurnWithRetry } from './delivery.js';
import { beginEsputnikConnect } from './esputnik-oauth.js';
import {
  deleteEsputnikCredential,
  deleteMemoryFile,
  deletePersonSkill,
  getSharedSkillNames,
  listMemoryFiles,
  listPersonSkills,
  listStickerPacks,
  removeStickerPack,
} from './nfs.js';
import { postControl } from './pod-control.js';
import { readPersonState, removeCustomEnvVar, removeEsputnikConnection, removeToolPermission, setCustomEnvVar } from './person-state.js';
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
    case '/sticker_packs':
      await handleListStickerPacks(deps, slug, person);
      return true;
    case '/forget_sticker_pack':
      await handleForgetStickerPack(deps, slug, person, args, updateId);
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
    case '/esputnik_connect':
      await handleEsputnikConnect(deps, slug, person, args);
      return true;
    case '/esputnik_accounts':
      await handleEsputnikAccounts(deps, slug, person);
      return true;
    case '/esputnik_disconnect':
      await handleEsputnikDisconnect(deps, slug, person, args, updateId);
      return true;
    case '/permissions':
      await handleListPermissions(deps, slug, person);
      return true;
    case '/forget_permission':
      await handleForgetPermission(deps, slug, person, args);
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
 * against the installed SDK before relying on it). Shared skills (derived
 * live from the persona ConfigMap's own `SKILL-*.md` keys — see
 * `getSharedSkillNames`, not a hardcoded list) are never listed or
 * deletable here — they aren't this person's own state.
 */
async function handleListSkills(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const sharedNames = await getSharedSkillNames(deps.api, deps.cfg.namespace, deps.cfg.personaConfigMapName);
  const skills = await listPersonSkills(slug, sharedNames);
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
  const sharedNames = await getSharedSkillNames(deps.api, deps.cfg.namespace, deps.cfg.personaConfigMapName);
  const removed = await deletePersonSkill(slug, name, sharedNames);
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
 * /permissions and /forget_permission manage the Telegram permission gate's
 * persisted "always allow" grants (runner/permission-gate.ts,
 * shared/types.ts's PersonState.toolPermissions) — the ConfigMap-side
 * companion to the live Allow-once/Always-allow/Deny buttons themselves
 * (router.ts's routeCallbackQuery). Revoking here doesn't need to reach an
 * already-running pod live: the pod's own in-memory always-allowed set only
 * ever grows via a real button tap, so a revoked grant simply isn't
 * re-seeded on its *next* restart — no restart is forced from here.
 */
async function handleListPermissions(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const state = await readPersonState(deps.api, deps.cfg.namespace, slug);
  const entries = Object.keys(state?.toolPermissions ?? {});
  if (entries.length === 0) {
    await deps.telegram.sendMessage(person.chatId, 'No standing "always allow" permissions.');
    return;
  }
  await deps.telegram.sendMessage(person.chatId, entries.join('\n'));
}

async function handleForgetPermission(deps: RouterDeps, slug: string, person: PersonIndexEntry, args: string[]): Promise<void> {
  const [toolName] = args;
  if (!toolName) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /forget_permission <toolName> — see /permissions for names.');
    return;
  }
  const removed = await removeToolPermission(deps.api, deps.cfg.namespace, slug, toolName);
  await deps.telegram.sendMessage(
    person.chatId,
    removed ? `Revoked always-allow for ${toolName}. Takes effect on your pod's next restart.` : `No such permission: ${toolName}`,
  );
  if (removed) log.line('tool_permission_forgotten', { person: slug, toolName });
}

/**
 * /sticker_packs and /forget_sticker_pack manage the same NFS-file list a
 * forwarded sticker writes to (router.ts's handleIncomingSticker) — no pod
 * restart either way, the runner (runner/sticker-store.ts) reads it fresh
 * before every list_stickers/send_sticker tool call.
 */
async function handleListStickerPacks(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const packs = await listStickerPacks(slug);
  if (packs.length === 0) {
    await deps.telegram.sendMessage(person.chatId, 'No sticker packs yet — send me a sticker from a pack to add it.');
    return;
  }
  const lines = packs.map((p) => `${p.name} — added ${p.addedAt}`);
  await deps.telegram.sendMessage(person.chatId, lines.join('\n'));
}

async function handleForgetStickerPack(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  args: string[],
  updateId: number,
): Promise<void> {
  const [name] = args;
  if (!name) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /forget_sticker_pack <name> — see /sticker_packs for names.');
    return;
  }
  const removed = await removeStickerPack(slug, name);
  await deps.telegram.sendMessage(person.chatId, removed ? `Forgot the "${name}" sticker pack.` : `No such pack: ${name}`);
  if (removed) {
    log.line('sticker_pack_forgotten', { person: slug, name });
    notifyModel(
      deps,
      slug,
      person,
      updateId,
      `The person just ran /forget_sticker_pack on "${name}" — you can no longer send stickers from that pack.`,
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

/** Fetches the live context-usage snapshot, or sends a "couldn't reach it" reply and returns null. Shared by /context, /effort (no args), /context_limit (no args). */
async function fetchContext(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
): Promise<Extract<ControlResponse, { action: 'context' }> | null> {
  const result = await postControl(deps.api, deps.cfg, slug, { action: 'context' });
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
  const result = await postControl(deps.api, deps.cfg, slug, { action: 'set_effort', level: level as EffortLevel });
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
  const result = await postControl(deps.api, deps.cfg, slug, { action: 'set_context_limit', tokens });
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

const ESPUTNIK_ACCOUNT_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Pure parser for `/esputnik_connect <account>` — same split-out-for-
 * testability shape as parseSetVarArgs. `account` becomes part of
 * `esputnikServerKey` (`esputnik-<account>`), which is both the runner's
 * `Options.mcpServers` key and the `mcpOAuth` credential prefix — kept
 * lowercase/lowercase-and-digits so it's safe in both contexts without
 * further sanitizing.
 */
export function parseEsputnikAccount(args: string[]): { account: string } | { error: string } {
  const [account] = args;
  if (!account) {
    return { error: 'Usage: /esputnik_connect <account> — pick a short label, e.g. work or personal.' };
  }
  if (!ESPUTNIK_ACCOUNT_RE.test(account)) {
    return {
      error: `Invalid account label "${account}" — lowercase letters/digits/underscore only, must start with a letter.`,
    };
  }
  return { account };
}

/**
 * /esputnik_connect is idempotent, not insert-only: running it again for an
 * already-connected account is how a dead/expired token gets renewed (see
 * CLAUDE.md's eSputnik OAuth renewal note) — never rejected as "already
 * connected." The reply wording is the only thing that differs between a
 * first connect and a renewal; the OAuth flow itself (esputnik-oauth.ts) is
 * identical either way.
 */
async function handleEsputnikConnect(deps: RouterDeps, slug: string, person: PersonIndexEntry, args: string[]): Promise<void> {
  const parsed = parseEsputnikAccount(args);
  if ('error' in parsed) {
    await deps.telegram.sendMessage(person.chatId, parsed.error);
    return;
  }
  const { account } = parsed;
  const serverKey = esputnikServerKey(account);
  const state = await readPersonState(deps.api, deps.cfg.namespace, slug);
  const isReconnect = state?.esputnikConnections.some((c) => c.account === account) ?? false;

  const result = await beginEsputnikConnect(deps.api, deps.cfg, slug, account, serverKey);
  if ('error' in result) {
    await deps.telegram.sendMessage(person.chatId, `Couldn't start the eSputnik connection: ${result.error}`);
    return;
  }
  await deps.telegram.sendMessage(
    person.chatId,
    `${isReconnect ? 'Reconnecting' : 'Connecting'} your eSputnik account "${account}" — open this link, log in with eSputnik, and approve:\n${result.url}\n\nThis link expires in 10 minutes.`,
  );
  log.line('esputnik_connect_started', { person: slug, account, isReconnect });
}

/**
 * Read-only lister, same shape as /list_vars, but also live: shows each
 * connected account's real `mcpServerStatus()` health (via /control) so a
 * dead token is discoverable before a tool call silently fails mid-
 * conversation — see CLAUDE.md's eSputnik OAuth renewal note. Tolerates an
 * unreachable pod the same way fetchContext does, without failing the whole
 * command — the PersonState listing itself is still useful on its own.
 */
async function handleEsputnikAccounts(deps: RouterDeps, slug: string, person: PersonIndexEntry): Promise<void> {
  const state = await readPersonState(deps.api, deps.cfg.namespace, slug);
  const connections = state?.esputnikConnections ?? [];
  if (connections.length === 0) {
    await deps.telegram.sendMessage(person.chatId, 'No eSputnik accounts connected. Use /esputnik_connect <account> to connect one.');
    return;
  }
  const statusResult = await postControl(deps.api, deps.cfg, slug, { action: 'esputnik_status' });
  const statusByKey = new Map<string, string>();
  if (statusResult?.ok && statusResult.action === 'esputnik_status') {
    for (const s of statusResult.servers) statusByKey.set(s.serverKey, s.status);
  }
  const lines = connections.map((c) => {
    const status = statusByKey.get(c.serverKey);
    const statusText =
      status === 'connected'
        ? 'ok'
        : status
          ? `needs reconnecting — run /esputnik_connect ${c.account}`
          : 'status unknown right now';
    return `${c.account} — connected since ${c.connectedAt} (${statusText})`;
  });
  await deps.telegram.sendMessage(person.chatId, lines.join('\n'));
}

/**
 * Forgets an eSputnik account entirely: the ConfigMap connection record +
 * registered OAuth client (person-state.ts's `removeEsputnikConnection`)
 * and the actual token pair on NFS (nfs.ts's `deleteEsputnikCredential`,
 * the write side's exact counterpart). A pod restart is required after —
 * unlike /memories or /skills, the MCP server is wired into `Options.mcpServers`
 * at query-stream start (or added live via `syncMcpServer`, sdk-session.ts),
 * and there's no live "remove a connected MCP server" call exposed by the
 * SDK, so the only way to make the running session stop offering
 * `mcp__esputnik-<account>__...` tools is the same restartToApply
 * /set_var/unset_var already use.
 */
async function handleEsputnikDisconnect(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  args: string[],
  updateId: number,
): Promise<void> {
  if (!args[0]) {
    await deps.telegram.sendMessage(person.chatId, 'Usage: /esputnik_disconnect <account> — see /esputnik_accounts for names.');
    return;
  }
  const parsed = parseEsputnikAccount(args);
  if ('error' in parsed) {
    await deps.telegram.sendMessage(person.chatId, parsed.error);
    return;
  }
  const { account } = parsed;
  const removed = await removeEsputnikConnection(deps.api, deps.cfg.namespace, slug, account);
  if (!removed) {
    await deps.telegram.sendMessage(person.chatId, `No such connected account: ${account}. See /esputnik_accounts.`);
    return;
  }
  await deleteEsputnikCredential(slug, esputnikServerKey(account));
  await deps.telegram.sendMessage(
    person.chatId,
    `Disconnected eSputnik account "${account}". Restarting your pod to apply — back in a few seconds.`,
  );
  await restartToApply(deps, slug, person);
  log.line('esputnik_disconnected', { person: slug, account });
  notifyModel(
    deps,
    slug,
    person,
    updateId,
    `The person just ran /esputnik_disconnect on eSputnik account "${account}" — its mcp__esputnik-${account}__... tools are gone. If they ask about that account, it's really disconnected, not still usable; they'd need to run /esputnik_connect ${account} again first.`,
  );
}
