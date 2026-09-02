/**
 * Prompt-building and query-options helpers for the persistent per-person
 * session (architecture doc section 3): one SDK `query()` call spans the
 * whole pod's lifetime, not one per turn — see `session-controller.ts` for
 * the actual long-lived stream/single-flight logic. This module stays pure:
 * turning a `TurnRequest` into the message pushed onto that stream, and the
 * one-time query options built once at session start.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CanUseTool, McpServerConfig, McpServerToolPolicy, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { log, truncateText } from '../shared/log.js';
import { ESPUTNIK_SERVER_URL, type ChatMessage, type ContextUsageSummary, type EffortLevel, type TurnRequest } from '../shared/types.js';
import { buildAttachmentMcpServer } from './attachment-tools.js';
import { resolveAttachments } from './attachments.js';
import type { RunnerConfig } from './config.js';
import type { PermissionGate } from './permission-gate.js';
import { buildSchedulingMcpServer } from './scheduling-tools.js';
import { buildTelegramExtrasMcpServer, type ReactableMessageRef } from './telegram-extras-tools.js';

interface LooseContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

export async function readSavedSessionId(cfg: RunnerConfig): Promise<string | null> {
  try {
    const raw = await readFile(cfg.sessionIdFile, 'utf8');
    return raw.trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveSessionId(cfg: RunnerConfig, sessionId: string): Promise<void> {
  await writeFile(cfg.sessionIdFile, sessionId, 'utf8');
}

/**
 * Confirmed against the installed SDK's own type declarations (`sdk.d.ts`):
 * a resumed session's CLAUDE.md reload is not automatic — the only reload
 * primitive found (`SDKControlRegisterRepoRootRequest.reload_claude_md`) is
 * scoped to a directory registered under `cwd`, which the persona file
 * (`claudeHome`, i.e. `~/.claude/CLAUDE.md`) isn't. Confirmed live
 * 2026-08-26: a resumed person session kept describing old (pre-update)
 * behavior as current well after a persona update had already landed on
 * disk and the pod had restarted — a plain routine restart doesn't re-inject
 * CLAUDE.md into an already-established `resume: sessionId` conversation the
 * way it would for a genuinely new one. `Read` on the file itself is always
 * a fresh disk read regardless, so the fix is having the model do that
 * itself (session-controller.ts's `nudgePersonaRefresh`) — this function
 * just decides *when* that's worth doing: compares the freshly-installed
 * content's hash against the hash last acknowledged, persisted on the same
 * NFS mount so it survives restarts. No prior hash file counts as "changed"
 * (conservative default) rather than "first boot, skip" — confirmed live
 * 2026-08-26 that the naive version of this got that backwards: this
 * function's own first-ever run (the day this mechanism shipped) hit
 * exactly that branch for four people whose sessions were already resumed
 * and had already missed several real persona changes earlier that same
 * day, and the "no prior hash = unchanged" default silently skipped
 * nudging every one of them. Whether a genuinely brand-new person's first
 * boot needs a nudge at all is `index.ts`'s call (it gates on
 * `readSavedSessionId` separately) — this function has no way to tell "new
 * person" from "resumed session, never hash-checked before" apart, so it
 * must not assume "no nudge" on their behalf.
 */
export async function personaChangedSinceLastAck(cfg: RunnerConfig, currentContent: string): Promise<boolean> {
  const ackPath = path.join(cfg.claudeHome, 'pan-agent-persona-hash');
  const hash = createHash('sha256').update(currentContent).digest('hex');
  let prevHash: string | null;
  try {
    prevHash = (await readFile(ackPath, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    prevHash = null;
  }
  await writeFile(ackPath, hash, 'utf8');
  return prevHash !== hash;
}

/**
 * Confirmed live 2026-08-24: the `claude` CLI itself (not the SDK, not
 * anything in this repo) hardcodes a nudge — "Your previous response had no
 * visible output. Please continue and produce a user-visible response." —
 * injected whenever a turn ends with no visible text, e.g. after a
 * background cron check that finds nothing new. There's no SDK option to
 * disable it; a model that tries to genuinely say nothing gets forced into
 * saying *something* anyway (which then went straight to Telegram, so a
 * "no news" cron check produced a "I'm staying silent" message — visibly
 * contradictory, and the actual bug reported). Since real silence isn't
 * achievable at the model layer, this gives the model a real, non-empty
 * response that still satisfies the CLI's requirement but that our own
 * layer (`index.ts`'s handleTurn) recognizes and swallows before it reaches
 * Telegram — logged via the normal SDK-message log either way, just not
 * delivered. Same "app-enforced, not SDK-trusted" pattern as the context
 * limit.
 */
export const NO_UPDATE_MARKER = 'NO_UPDATE';

/**
 * Shared wording for every place a turn is allowed to legitimately end in
 * silence — factored out after `task_notification`'s own hand-rolled prompt
 * (session-controller.ts's `reactToTaskNotification`) shipped *without* this
 * instruction and leaked raw "no response needed" reasoning straight to
 * Telegram in English, mid-Ukrainian-conversation (incident write-up:
 * ~/task-notification-no-update-bug.md). One shared string means a future
 * new silence-eligible turn kind can't repeat that mistake by simply
 * forgetting to write its own copy.
 */
export function noUpdateInstruction(context: string): string {
  return `${context} If there is genuinely nothing worth telling the person right now, reply with exactly the single line ${NO_UPDATE_MARKER} and nothing else; that suppresses delivery entirely while still being logged. Only write a real message when there's something they'd actually want to know.`;
}

export function buildPrompt(turn: TurnRequest): string {
  if (turn.kind === 'task') {
    return `[Scheduled task ${turn.taskId}, due ${turn.scheduledFor}]
${turn.prompt}

${noUpdateInstruction(
      "This is an unattended background check-in, not a live question from the person — they won't see anything unless you tell them something.",
    )}`;
  }
  if (turn.kind === 'control') {
    // Must be the bare command with nothing else in the message — confirmed
    // live this is what the SDK's own command recognition requires. A
    // ChatTurn's `${fromHandle}: ${text}` prefix below is exactly what
    // broke this in production before ControlTurn existed.
    return turn.command;
  }
  return turn.messages.map(formatChatMessage).join('\n');
}

/** Surfaces Telegram's native reply-to-message quoting, if present — otherwise the model has no way to know a message was a reply at all, and can misread it as a fresh, unrelated statement. */
function formatChatMessage(m: ChatMessage): string {
  const body = m.fromHandle ? `${m.fromHandle}: ${m.text}` : m.text;
  if (!m.replyTo) return body;
  const quotedFrom = m.replyTo.fromHandle ?? 'a message';
  const quoted = m.replyTo.snippet ? `"${m.replyTo.snippet}"` : '(no text)';
  return `[replying to ${quotedFrom}: ${quoted}]\n${body}`;
}

export interface ResolvedReply {
  /** What to actually send to Telegram — empty means "send nothing". */
  replyText: string;
  /**
   * True when the model chose to end the turn with the bare
   * `NO_UPDATE_MARKER` instead of real text. Legitimate for a task turn
   * (nothing new to report) or a chat turn (e.g. a `react_to_message`/
   * `send_sticker` call already was the whole response) — never for a
   * control turn, which never reaches the model in a way that could emit it.
   */
  isNoUpdate: boolean;
  /**
   * The reply with its trailing `NO_UPDATE_MARKER` line removed — populated
   * only when `isNoUpdate` is true, empty otherwise. This is the reasoning
   * the model wrote before deciding to stay silent; `index.ts` logs it on
   * `reply_muted` so "why did this stay quiet" is answerable from Loki
   * instead of just "(no message sent)".
   */
  suppressedReasoning: string;
}

/**
 * A `NO_UPDATE_MARKER` reply is only recognized on its own trailing line —
 * the model sometimes prepends genuine reasoning before it (confirmed live:
 * "Still only TELESYNC/HDTS cam-rips, no real upgrade.\n\nNO_UPDATE"), and an
 * exact `trim() === MARKER` match misses that case entirely, delivering the
 * literal marker text to Telegram despite asking to stay silent. Trims each
 * line individually (not just the whole string) so a trailing blank line or
 * trailing spaces on the marker's own line don't defeat the match either.
 */
function stripTrailingNoUpdateMarker(text: string): { isMarker: boolean; reasoning: string } {
  const lines = text.split('\n');
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx]!.trim() === '') lastIdx -= 1;
  if (lastIdx < 0 || lines[lastIdx]!.trim() !== NO_UPDATE_MARKER) {
    return { isMarker: false, reasoning: '' };
  }
  return { isMarker: true, reasoning: lines.slice(0, lastIdx).join('\n').trim() };
}

/**
 * Decides what (if anything) `index.ts`'s handleTurn should deliver to
 * Telegram for a finished turn — pulled out of handleTurn itself so this
 * branching (the exact source of both the no-update and the stale-reply
 * bugs fixed on 2026-08-24) is unit-testable without spinning up the HTTP
 * server or a session controller. Takes a minimal structural shape rather
 * than importing `TurnResult` from session-controller.ts to avoid a
 * circular import (session-controller.ts already imports from this file).
 * `task_notification`'s own reply (session-controller.ts) is also routed
 * through this, via a synthesized `TaskTurn`, rather than than duplicating
 * the marker-check logic there — see this file's `noUpdateInstruction` doc
 * comment for why that duplication was the actual root cause last time.
 */
export function resolveReplyText(turn: TurnRequest, result: { replyText: string; ok: boolean }): ResolvedReply {
  if (turn.kind === 'task' || turn.kind === 'chat') {
    const { isMarker, reasoning } = stripTrailingNoUpdateMarker(result.replyText);
    if (isMarker) {
      return { replyText: '', isNoUpdate: true, suppressedReasoning: reasoning };
    }
  }
  // A successful /compact or /clear produces an empty SDK result (confirmed
  // live: the SDK handles these as a protocol-level event, not a model
  // turn), and session-controller.ts's control-turn timeout also resolves
  // with an empty, ok:false result rather than throwing — synthesize a
  // reply for both cases so the person sees *something* rather than
  // silence either way (confirmed live: silence is exactly what made a
  // genuinely hung /compact read as "does nothing").
  const replyText =
    result.replyText ||
    (turn.kind === 'control'
      ? result.ok
        ? turn.command === '/compact'
          ? '✅ Compacted your conversation history.'
          : '✅ Cleared — starting fresh from here. Memory notes and scheduled tasks are unaffected.'
        : `⚠️ ${turn.command} timed out — try again in a moment.`
      : '');
  return { replyText, isNoUpdate: false, suppressedReasoning: '' };
}

/**
 * One message pushed onto the persistent stream per turn. Chat turns with a
 * photo attachment get it inlined as real vision content; documents were
 * already saved to the workspace by `resolveAttachments` and are referenced
 * by path in the text instead.
 */
export async function buildUserMessage(
  cfg: RunnerConfig,
  turn: TurnRequest,
  promptText: string,
): Promise<SDKUserMessage> {
  const attachments = turn.kind === 'chat' ? turn.messages.flatMap((m) => m.attachments ?? []) : [];
  if (attachments.length === 0) {
    return { type: 'user', message: { role: 'user', content: promptText }, parent_tool_use_id: null };
  }

  const { images, notes } = await resolveAttachments(cfg, attachments);
  const fullText = notes.length > 0 ? `${promptText}\n${notes.join('\n')}` : promptText;
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: fullText }, ...images] },
    parent_tool_use_id: null,
  };
}

const SCHEDULING_TOOLS = [
  'mcp__pan-agent-scheduling__schedule_task',
  'mcp__pan-agent-scheduling__list_tasks',
  'mcp__pan-agent-scheduling__cancel_task',
];

const ATTACHMENT_TOOLS = ['mcp__pan-agent-attachments__send_file'];

const TELEGRAM_EXTRAS_TOOLS = [
  'mcp__pan-agent-telegram-extras__list_stickers',
  'mcp__pan-agent-telegram-extras__send_sticker',
  'mcp__pan-agent-telegram-extras__react_to_message',
];

/**
 * The full eSputnik MCP tool name list (bare, as the server itself exposes
 * them — not the `mcp__<server>__<tool>` prefixed form `allowedTools` uses
 * for the in-process servers above). Captured from a real, live-connected
 * `esputnik` MCP server session, 2026-08-29. The installed SDK's
 * `McpServerToolPolicy` has no wildcard (`{name, permission_policy}` only,
 * `name` required per tool — confirmed directly against sdk.d.ts, not
 * inferred), so every tool needs its own explicit entry here to avoid an
 * interactive permission prompt this headless bot can never answer. If
 * eSputnik adds/removes tools, this list needs a manual refresh.
 */
const ESPUTNIK_TOOL_NAMES = [
  'attach_group_contacts', 'bulk_upsert_contacts', 'create_app_inbox_message', 'create_email_message',
  'create_event', 'create_mobile_push_message', 'create_past_events', 'create_sms_message',
  'delete_app_inbox_message', 'delete_app_inbox_message_translation', 'delete_broadcast', 'delete_contact',
  'delete_contact_by_external_customer_id', 'delete_email_message', 'delete_email_message_translation',
  'delete_mobile_push_message', 'delete_mobile_push_message_translation', 'delete_sms_message',
  'delete_sms_message_translation', 'detach_group_contacts', 'get_account_info', 'get_addressbooks',
  'get_app_inbox_message', 'get_brandkit', 'get_broadcast', 'get_contact', 'get_contact_devices',
  'get_contact_id_by_token', 'get_contact_in_app_message_statuses', 'get_contact_message_history',
  'get_contacts_activity_v2', 'get_contacts_by_email', 'get_email_deliverability_setup',
  'get_email_message_export', 'get_email_message_preview_png', 'get_email_message_view_link',
  'get_event_types', 'get_events_analytics', 'get_group_contacts', 'get_import_status',
  'get_message_status', 'get_messaging_analytics', 'get_mobile_push_message',
  'get_mobile_push_token_activation', 'get_organisation_info', 'get_segment', 'get_segment_definition',
  'get_segment_schema', 'get_sms_callouts', 'get_sms_message', 'get_workflow_export',
  'list_app_inbox_messages', 'list_broadcasts', 'list_contacts', 'list_email_interfaces',
  'list_email_messages', 'list_groups', 'list_mobile_push_messages', 'list_segment_definition_facets',
  'list_segment_definitions', 'list_sms_interfaces', 'list_sms_messages', 'list_workflows',
  'prepare_email_message_upload', 'prepare_image_upload', 'send_broadcast', 'send_email_message',
  'send_sms_message', 'smart_send_message', 'subscribe_contact', 'update_app_inbox_message',
  'update_app_inbox_message_translation', 'update_brandkit', 'update_brandkit_patch', 'update_contact',
  'update_email_message', 'update_email_message_translation', 'update_interaction_status',
  'update_mobile_push_message', 'update_mobile_push_message_translation', 'update_sms_message',
  'update_sms_message_translation', 'upload_contacts', 'upload_image', 'upsert_contact',
];

export function esputnikToolPolicy(): McpServerToolPolicy[] {
  return ESPUTNIK_TOOL_NAMES.map((name) => ({ name, permission_policy: 'always_allow' }));
}

/**
 * The subset of `ESPUTNIK_TOOL_NAMES` above that mutates something —
 * everything except the `get_*`/`list_*` reads and
 * `prepare_email_message_upload`/`prepare_image_upload` (these two only
 * mint a signed upload URL; the actual `create_*`/`update_*` call that
 * follows is what's gated, so an upload step isn't double-prompted). These
 * are the only eSputnik tool calls routed through the Telegram permission
 * gate (`permission-gate.ts`) instead of being auto-allowed — reads stay
 * exactly as frictionless as before. Same "manual refresh if eSputnik adds
 * tools" caveat as `ESPUTNIK_TOOL_NAMES` itself already documents.
 */
const ESPUTNIK_WRITE_TOOL_NAMES = new Set([
  'attach_group_contacts', 'bulk_upsert_contacts', 'create_app_inbox_message', 'create_email_message',
  'create_event', 'create_mobile_push_message', 'create_past_events', 'create_sms_message',
  'delete_app_inbox_message', 'delete_app_inbox_message_translation', 'delete_broadcast', 'delete_contact',
  'delete_contact_by_external_customer_id', 'delete_email_message', 'delete_email_message_translation',
  'delete_mobile_push_message', 'delete_mobile_push_message_translation', 'delete_sms_message',
  'delete_sms_message_translation', 'detach_group_contacts', 'send_broadcast', 'send_email_message',
  'send_sms_message', 'smart_send_message', 'subscribe_contact', 'update_app_inbox_message',
  'update_app_inbox_message_translation', 'update_brandkit', 'update_brandkit_patch', 'update_contact',
  'update_email_message', 'update_email_message_translation', 'update_interaction_status',
  'update_mobile_push_message', 'update_mobile_push_message_translation', 'update_sms_message',
  'update_sms_message_translation', 'upload_contacts', 'upload_image', 'upsert_contact',
]);

/**
 * `toolName` here is always `mcp__<serverKey>__<bareName>`, and only
 * `bareName` is a fixed, known dictionary — `serverKey` (`esputnik-<account>`)
 * carries a person-chosen account label we don't want to parse out. None of
 * `ESPUTNIK_WRITE_TOOL_NAMES` is a suffix of another, so matching on
 * `toolName.endsWith('__' + name)` is unambiguous without needing to split
 * out the account substring at all.
 */
export function isEsputnikWriteTool(toolName: string): boolean {
  for (const name of ESPUTNIK_WRITE_TOOL_NAMES) {
    if (toolName.endsWith(`__${name}`)) return true;
  }
  return false;
}

/** `esputnik-work` from either `esputnik-work` (this project's own write shape, nfs.ts's writeEsputnikCredential) or a possible SDK-rewritten `esputnik-work|<hash>` — robust to either since it's unconfirmed locally which one the SDK settles on (see CLAUDE.md's "Phase 0 status" note). */
function serverKeyFromCredentialKey(key: string): string {
  const pipeIdx = key.indexOf('|');
  return pipeIdx === -1 ? key : key.slice(0, pipeIdx);
}

/**
 * Scans the person's own `.credentials.json` for already-connected eSputnik
 * accounts (written by the operator's OAuth callback, esputnik-oauth.ts) and
 * returns one static `Options.mcpServers` entry per account — this file is
 * the single source of truth for "which accounts does this pod already know
 * about," no separate manifest to keep in sync. Covers cold start and
 * crash-restart. A newly-connected account while a session is already
 * running instead goes through session-controller.ts's live `syncMcpServer`
 * (via the runner's /control endpoint), not this function.
 */
export async function readEsputnikMcpServers(cfg: RunnerConfig): Promise<Record<string, McpServerConfig>> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path.join(cfg.claudeHome, '.credentials.json'), 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const mcpOAuth = (raw['mcpOAuth'] as Record<string, unknown> | undefined) ?? {};
  const serverKeys = new Set<string>();
  for (const key of Object.keys(mcpOAuth)) {
    const serverKey = serverKeyFromCredentialKey(key);
    if (serverKey.startsWith('esputnik-')) serverKeys.add(serverKey);
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const serverKey of serverKeys) {
    servers[serverKey] = { type: 'http', url: ESPUTNIK_SERVER_URL, tools: esputnikToolPolicy() };
  }
  return servers;
}

/**
 * `allowedTools` only auto-approves listed tools without a permission
 * prompt — it does NOT restrict which built-in tools exist. Without `tools`
 * set, the SDK's full native Claude Code toolset (CronCreate, ScheduleWakeup,
 * Monitor, TaskCreate/Output/Stop, Artifact, ...) stays available regardless
 * of what's listed here, and a model that knows those tools from elsewhere
 * will reach for them — confirmed live: it called `CronCreate` directly
 * (bypassing `schedule_task` entirely, despite the persona explicitly
 * forbidding it), and the "fire" was real but nothing about that tool is
 * wired to this runner's Telegram delivery, so the message never arrived.
 * `tools` is the actual allowlist; everything not named here is unavailable.
 * `CronCreate` stays excluded permanently even now that sessions are
 * persistent — it's session-only/non-durable with a 7-day hard expiry
 * (confirmed from the tool's own spec), strictly worse than `schedule_task`
 * regardless of process lifetime.
 *
 * `Skill` hits the exact same gotcha and was confirmed the same way: a
 * `SKILL.md` under `<cwd>/.claude/skills/<name>/` with YAML frontmatter is
 * auto-discovered and listed in the SDK's `system/init` message regardless
 * of `tools`, but the model can't actually invoke it via the `Skill` tool
 * unless `'Skill'` is in this array — confirmed live against the installed
 * SDK (discovered-but-uninvokable without it, invokable with it).
 */
const BUILTIN_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill'];

/**
 * One-time query options, built once at session-controller start. Backgrounded
 * Bash itself is intentionally left ungated (no denial for it specifically in
 * `buildSkillsCanUseTool` below) — the whole point of the persistent session
 * is that `run_in_background` now actually works: its `task_notification`
 * lands on this same long-lived stream instead of vanishing with a per-turn
 * process. The `canUseTool` this builds is only ever consulted for the one
 * case bare `tools`/`allowedTools` entries don't already auto-approve (see
 * `buildSkillsCanUseTool`'s comment) — ordinary Bash calls never reach it.
 */
/**
 * Subdirectory name under claudeHome for the SDK's native auto-memory store
 * — pinned explicitly (rather than left to the SDK's own
 * `~/.claude/projects/<sanitized-cwd>/memory/` default) so the operator's
 * /memories and /forget_memory commands (person-commands.ts, via
 * operator/nfs.ts) know exactly where to look without having to reproduce
 * the SDK's cwd-sanitization scheme. Already lands inside the per-person NFS
 * mount either way (claudeHome IS the mounted volume for this user), so
 * pinning it changes nothing about persistence — just the path shape.
 */
export const MEMORY_DIR_NAME = 'memory';

/**
 * Claude Code treats `.claude/skills/` (like `hooks/`, `commands/`,
 * `settings*`) as a protected "customization surface" — confirmed live that
 * a `Write`/`Edit`/`Bash` call targeting it is denied unconditionally, even
 * under `permissionMode: 'acceptEdits'` and even with an explicit
 * `settings.permissions.allow` rule for it. Neither bypasses this; only a
 * `canUseTool` callback can. Without one, a person asking the model to
 * "create a skill for X" gets permanently stuck — the model's tool call
 * fails with "you haven't granted it yet" and there is no dialog, no
 * button, nowhere in this headless Telegram bot for a human to grant it.
 * This callback is the fix: allow exactly `Write`/`Edit` into this person's
 * own `<workspaceCwd>/.claude/skills/`, and (since Claude Code separately
 * surfaces the same block for `Bash` via `options.blockedPath`, or with no
 * `blockedPath` at all for a compound/redirected command) also allow a
 * `Bash` call whose reported blocked path — or, failing that, whose literal
 * command text — targets that same directory. Confirmed live this callback
 * is *only* ever invoked for calls the bare `tools`/`allowedTools` entries
 * don't already auto-approve (the SDK's own `CAN_USE_TOOL_SHADOWED` warning
 * describes this) — so this is additive: it cannot loosen anything for a
 * tool call that already succeeds today.
 *
 * Also covers eSputnik MCP tools (`mcp__esputnik-<account>__...`). Confirmed
 * live 2026-08-29: a per-server `tools: [{name, permission_policy:
 * 'always_allow'}]` entry on the `McpHttpServerConfig` (`esputnikToolPolicy`
 * above) does NOT bypass `canUseTool` the way a bare `allowedTools` entry
 * does — the CAN_USE_TOOL_SHADOWED warning's list is exhaustive, and every
 * esputnik tool call fell through to this callback and was denied as
 * "outside the auto-approved surface" on first live test. Static
 * `allowedTools` isn't a fix either: an account connected live mid-session
 * via `syncMcpServer`'s `setMcpServers` path (session-controller.ts) has a
 * server key `allowedTools` couldn't have known about at `buildQueryOptions`
 * time. Matching the `mcp__esputnik-` prefix here instead covers both the
 * boot-time and live-added cases uniformly, with no extra plumbing.
 *
 * Write-shaped eSputnik calls (`isEsputnikWriteTool`) are the one exception
 * to "this callback only ever allows or denies, never actually asks
 * anyone" — those are routed through `gate.request()` (permission-gate.ts),
 * which pauses on a real Telegram Allow-once/Always-allow/Deny prompt. This
 * is the actual, only technical gate on an eSputnik write in this codebase
 * — `esputnikToolPolicy()`'s `always_allow` never even matters, since a
 * per-server `always_allow` entry doesn't bypass this callback either (see
 * this function's own doc comment above).
 */
function buildSkillsCanUseTool(cfg: RunnerConfig, gate: PermissionGate): CanUseTool {
  const skillsDir = path.join(cfg.workspaceCwd, '.claude', 'skills');
  const isSkillsPath = (p: string | undefined): boolean =>
    !!p && (path.resolve(p) === skillsDir || path.resolve(p).startsWith(skillsDir + path.sep));

  return async (toolName, input, options) => {
    if (toolName.startsWith('mcp__esputnik-')) {
      if (!isEsputnikWriteTool(toolName)) return { behavior: 'allow', updatedInput: input };
      const decision = await gate.request(toolName, input);
      if (decision === 'deny') {
        return { behavior: 'deny', message: `Permission denied by the person for ${toolName}.` };
      }
      return { behavior: 'allow', updatedInput: input };
    }

    const filePath = typeof input['file_path'] === 'string' ? (input['file_path'] as string) : undefined;
    const command = typeof input['command'] === 'string' ? (input['command'] as string) : undefined;
    const targetsSkillsDir =
      isSkillsPath(filePath) || isSkillsPath(options.blockedPath) || (command?.includes('.claude/skills') ?? false);

    if (targetsSkillsDir) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `pan-agent: unexpected permission request for ${toolName} outside the auto-approved surface` };
  };
}

export function buildQueryOptions(
  cfg: RunnerConfig,
  sessionId: string | null,
  reactable: ReactableMessageRef,
  gate: PermissionGate,
  esputnikServers: Record<string, McpServerConfig> = {},
): Options {
  return {
    cwd: cfg.workspaceCwd,
    ...(sessionId ? { resume: sessionId } : {}),
    permissionMode: 'acceptEdits',
    // Explicit rather than relying on "whatever the account/SDK currently
    // defaults to" — confirmed live this SDK version already defaults to
    // claude-sonnet-5 with no model set, but pinning it means a future
    // default-model change on Anthropic's side can't silently change what
    // every person pod runs.
    model: 'claude-sonnet-5',
    // Explicit rather than relying on the SDK's own default-when-omitted
    // behavior — guarantees the auto-memory instructions (and everything
    // else the preset carries) are actually present regardless of SDK
    // version. Layered underneath/alongside the persona's own CLAUDE.md,
    // which is a separate discovery mechanism, not a systemPrompt swap.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settings: {
      autoMemoryEnabled: true,
      autoMemoryDirectory: path.join(cfg.claudeHome, MEMORY_DIR_NAME),
      // Confirmed live 2026-08-23: the SDK's own default autoCompactThreshold
      // is already ~217,000 tokens regardless of the model's much larger raw
      // context window (1,000,000 for Sonnet 5) — well under the 250K target,
      // so no override needed. `settings.autoCompactWindow` was tried (both
      // here at session-start and via `applyFlagSettings` mid-session, set to
      // both 250000 and 100000) and had zero observed effect on
      // `getContextUsage()`'s reported `autoCompactThreshold` either time —
      // don't reach for it expecting it to set an explicit ceiling, it
      // doesn't appear to do that. `effortLevel` here is overridable live via
      // `/effort` (person-commands.ts -> runner's /control endpoint ->
      // `applyFlagSettings`), confirmed live to accept the change without
      // error; not independently confirmed to change model output, but
      // matches the SDK's documented behavior for this field exactly.
      effortLevel: 'medium',
    },
    tools: BUILTIN_TOOLS,
    // Explicit rather than relying on "omitted = CLI defaults apply" (same
    // philosophy as the systemPrompt preset above) — 'all' enables every
    // skill discovered under cwd's .claude/skills/, which for this runner
    // means only the shared `media` skill (once it gets frontmatter) and
    // whatever a person has created for themselves under their own
    // workspace. Confirmed live that this option doesn't gate discovery
    // (skills show up in system/init's `skills` list either way) — it's
    // `'Skill'` in `tools` above that actually gates invocation.
    skills: 'all',
    canUseTool: buildSkillsCanUseTool(cfg, gate),
    mcpServers: {
      'pan-agent-scheduling': buildSchedulingMcpServer(cfg),
      'pan-agent-attachments': buildAttachmentMcpServer(cfg),
      'pan-agent-telegram-extras': buildTelegramExtrasMcpServer(cfg, reactable),
      ...esputnikServers,
    },
    allowedTools: [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'Skill',
      ...SCHEDULING_TOOLS,
      ...ATTACHMENT_TOOLS,
      ...TELEGRAM_EXTRAS_TOOLS,
    ],
  };
}

/** Narrows the SDK's much larger `getContextUsage()` response (category breakdowns, grid rows, per-tool/skill token costs, ...) down to what a `/context` reply actually needs, plus the two values session-controller.ts tracks itself (the SDK exposes no getter for either). */
export function summarizeContextUsage(
  usage: {
    model: string;
    totalTokens: number;
    maxTokens: number;
    autoCompactThreshold?: number;
    isAutoCompactEnabled: boolean;
  },
  effortLevel: EffortLevel,
  contextLimit: number,
): ContextUsageSummary {
  return {
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    sdkAutoCompactCeiling: usage.autoCompactThreshold ?? null,
    isAutoCompactEnabled: usage.isAutoCompactEnabled,
    effortLevel,
    contextLimit,
  };
}

export interface ModelUsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
}

/** Sums token usage across every model used this turn (normally just one) — surfaces context growth in Loki without needing to trust auto-compaction blindly. */
export function summarizeUsage(
  modelUsage: Record<string, ModelUsageLike> | undefined,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; contextWindow: number } | null {
  const entries = Object.values(modelUsage ?? {});
  if (entries.length === 0) return null;
  return entries.reduce(
    (acc, m) => ({
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadInputTokens,
      contextWindow: Math.max(acc.contextWindow, m.contextWindow),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, contextWindow: 0 },
  );
}

export function logSdkMessage(person: string, turnId: string, message: SDKMessage): void {
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    const { trigger, pre_tokens, post_tokens } = message.compact_metadata;
    log.line('compact_boundary', { person, turn: turnId, trigger, preTokens: pre_tokens, postTokens: post_tokens });
    return;
  }
  if (message.type === 'system' && message.subtype === 'memory_recall') {
    log.line('memory_recall', {
      person,
      turn: turnId,
      mode: message.mode,
      count: message.memories.length,
      paths: message.memories.map((m) => m.path),
    });
    return;
  }
  if (message.type === 'assistant') {
    const content = (message.message.content as LooseContentBlock[]) ?? [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        const { text, bytes } = truncateText(block.text);
        log.line('assistant', { person, turn: turnId, text, bytes });
      } else if (block.type === 'thinking' && block.text) {
        const { text, bytes } = truncateText(block.text);
        log.line('thinking', { person, turn: turnId, text, bytes });
      } else if (block.type === 'tool_use') {
        const { text, bytes } = truncateText(JSON.stringify(block.input ?? {}));
        log.line('tool_use', { person, turn: turnId, tool: block.name, input: text, bytes });
      }
    }
    return;
  }
  if (message.type === 'user') {
    const rawContent = message.message.content;
    const blocks = Array.isArray(rawContent) ? (rawContent as LooseContentBlock[]) : [];
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const contentText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      const { text, bytes } = truncateText(contentText);
      log.line('tool_result', { person, turn: turnId, ok: !block.is_error, text, bytes });
    }
  }
}
