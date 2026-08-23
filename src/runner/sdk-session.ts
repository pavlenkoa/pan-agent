/**
 * Prompt-building and query-options helpers for the persistent per-person
 * session (architecture doc section 3): one SDK `query()` call spans the
 * whole pod's lifetime, not one per turn — see `session-controller.ts` for
 * the actual long-lived stream/single-flight logic. This module stays pure:
 * turning a `TurnRequest` into the message pushed onto that stream, and the
 * one-time query options built once at session start.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CanUseTool, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { log, truncateText } from '../shared/log.js';
import type { TurnRequest } from '../shared/types.js';
import { buildAttachmentMcpServer } from './attachment-tools.js';
import { resolveAttachments } from './attachments.js';
import type { RunnerConfig } from './config.js';
import { buildSchedulingMcpServer } from './scheduling-tools.js';

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

export function buildPrompt(turn: TurnRequest): string {
  if (turn.kind === 'task') {
    return `[Scheduled task ${turn.taskId}, due ${turn.scheduledFor}]\n${turn.prompt}`;
  }
  return turn.messages.map((m) => (m.fromHandle ? `${m.fromHandle}: ${m.text}` : m.text)).join('\n');
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
 */
function buildSkillsCanUseTool(cfg: RunnerConfig): CanUseTool {
  const skillsDir = path.join(cfg.workspaceCwd, '.claude', 'skills');
  const isSkillsPath = (p: string | undefined): boolean =>
    !!p && (path.resolve(p) === skillsDir || path.resolve(p).startsWith(skillsDir + path.sep));

  return async (toolName, input, options) => {
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

export function buildQueryOptions(cfg: RunnerConfig, sessionId: string | null): Options {
  return {
    cwd: cfg.workspaceCwd,
    ...(sessionId ? { resume: sessionId } : {}),
    permissionMode: 'acceptEdits',
    // Explicit rather than relying on the SDK's own default-when-omitted
    // behavior — guarantees the auto-memory instructions (and everything
    // else the preset carries) are actually present regardless of SDK
    // version. Layered underneath/alongside the persona's own CLAUDE.md,
    // which is a separate discovery mechanism, not a systemPrompt swap.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settings: {
      autoMemoryEnabled: true,
      autoMemoryDirectory: path.join(cfg.claudeHome, MEMORY_DIR_NAME),
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
    canUseTool: buildSkillsCanUseTool(cfg),
    mcpServers: {
      'pan-agent-scheduling': buildSchedulingMcpServer(cfg),
      'pan-agent-attachments': buildAttachmentMcpServer(cfg),
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
    ],
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
