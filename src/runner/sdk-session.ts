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

import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

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
 */
const BUILTIN_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

/**
 * One-time query options, built once at session-controller start. Backgrounded
 * Bash is intentionally left ungated here (no `canUseTool` denial) — the whole
 * point of the persistent session is that `run_in_background` now actually
 * works: its `task_notification` lands on this same long-lived stream instead
 * of vanishing with a per-turn process.
 */
/**
 * Subdirectory name under claudeHome for the SDK's native auto-memory store
 * — pinned explicitly (rather than left to the SDK's own
 * `~/.claude/projects/<sanitized-cwd>/memory/` default) so the operator's
 * /memories and /forget-memory commands (person-commands.ts, via
 * operator/nfs.ts) know exactly where to look without having to reproduce
 * the SDK's cwd-sanitization scheme. Already lands inside the per-person NFS
 * mount either way (claudeHome IS the mounted volume for this user), so
 * pinning it changes nothing about persistence — just the path shape.
 */
export const MEMORY_DIR_NAME = 'memory';

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
