/**
 * One SDK query() per turn against the persistent, resumed session
 * (architecture doc section 3). Streams every message to stdout as
 * structured JSON (section 7) and returns the final reply text for the
 * runner to send via Telegram directly.
 */
import { readFile, writeFile } from 'node:fs/promises';

import { query, type CanUseTool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

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

async function readSavedSessionId(cfg: RunnerConfig): Promise<string | null> {
  try {
    const raw = await readFile(cfg.sessionIdFile, 'utf8');
    return raw.trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function saveSessionId(cfg: RunnerConfig, sessionId: string): Promise<void> {
  await writeFile(cfg.sessionIdFile, sessionId, 'utf8');
}

function buildPrompt(turn: TurnRequest): string {
  if (turn.kind === 'task') {
    return `[Scheduled task ${turn.taskId}, due ${turn.scheduledFor}]\n${turn.prompt}`;
  }
  return turn.messages.map((m) => (m.fromHandle ? `${m.fromHandle}: ${m.text}` : m.text)).join('\n');
}

/**
 * Chat turns with attachments need the SDK's streaming-input form (a single
 * yielded SDKUserMessage) so a photo can go in as real vision content, not
 * just its text form. Everything else keeps the plain string prompt.
 */
async function buildPromptInput(
  cfg: RunnerConfig,
  turn: TurnRequest,
  promptText: string,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (turn.kind !== 'chat') return promptText;
  const attachments = turn.messages.flatMap((m) => m.attachments ?? []);
  if (attachments.length === 0) return promptText;

  const { images, notes } = await resolveAttachments(cfg, attachments);
  const fullText = notes.length > 0 ? `${promptText}\n${notes.join('\n')}` : promptText;

  async function* single(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: fullText }, ...images] },
      parent_tool_use_id: null,
    };
  }
  return single();
}

/**
 * The SDK's Bash tool supports `run_in_background`, but this runner spins
 * up a fresh `query()` per /turn — when the turn ends the whole session
 * process (and any backgrounded command + its completion notification) dies
 * with it. Deny it up front so the model gets a live error and falls back
 * to a synchronous wait (Bash `timeout`, up to 10min) or `schedule_task` for
 * anything longer, instead of silently losing the follow-up.
 */
const denyBackgroundedBash: CanUseTool = async (toolName, input) => {
  if (toolName === 'Bash' && input['run_in_background'] === true) {
    return {
      behavior: 'deny',
      message:
        'Backgrounded bash does not work in this environment — the turn ends and the background process (and any ' +
        'notification about it) is killed with it. Re-run the command in the foreground (add a `timeout` up to ' +
        '600000ms if it needs to wait), or use schedule_task if you genuinely need to check back later.',
    };
  }
  return { behavior: 'allow', updatedInput: input };
};

export interface TurnResult {
  replyText: string;
  ok: boolean;
}

const SCHEDULING_TOOLS = [
  'mcp__pan-agent-scheduling__schedule_task',
  'mcp__pan-agent-scheduling__list_tasks',
  'mcp__pan-agent-scheduling__cancel_task',
];

const ATTACHMENT_TOOLS = ['mcp__pan-agent-attachments__send_file'];

export async function runTurn(cfg: RunnerConfig, turn: TurnRequest, turnId: string): Promise<TurnResult> {
  const promptText = buildPrompt(turn);
  const prompt = await buildPromptInput(cfg, turn, promptText);
  const sessionId = await readSavedSessionId(cfg);

  log.line('turn_start', { person: cfg.slug, session: sessionId, turn: turnId, kind: turn.kind });
  const { text: userText, bytes: userBytes } = truncateText(promptText);
  log.line('user', { person: cfg.slug, turn: turnId, text: userText, bytes: userBytes });

  const startedAt = Date.now();
  const stream = query({
    prompt,
    options: {
      cwd: cfg.workspaceCwd,
      ...(sessionId ? { resume: sessionId } : {}),
      permissionMode: 'acceptEdits',
      canUseTool: denyBackgroundedBash,
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
    },
  });

  let replyText = '';
  let ok = true;
  let newSessionId: string | null = null;
  let numTurns = 0;
  let costUsd = 0;
  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; contextWindow: number } | null =
    null;

  try {
    for await (const message of stream as AsyncIterable<SDKMessage & { session_id?: string }>) {
      if (message.session_id) newSessionId = message.session_id;
      logSdkMessage(cfg.slug, turnId, message);
      if (message.type === 'result') {
        ok = !message.is_error;
        numTurns = message.num_turns;
        costUsd = message.total_cost_usd;
        if (message.subtype === 'success') replyText = message.result;
        usage = summarizeUsage(message.modelUsage);
      }
    }
  } catch (err) {
    ok = false;
    log.error('turn_error', err, { person: cfg.slug, turn: turnId });
  }

  if (newSessionId && newSessionId !== sessionId) await saveSessionId(cfg, newSessionId);

  log.line('turn_end', {
    person: cfg.slug,
    turn: turnId,
    ok,
    dur_ms: Date.now() - startedAt,
    cost_usd: costUsd,
    turns: numTurns,
    ...usage,
  });

  return { replyText, ok };
}

interface ModelUsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
}

/** Sums token usage across every model used this turn (normally just one) — surfaces context growth in Loki without needing to trust auto-compaction blindly. */
function summarizeUsage(
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

function logSdkMessage(person: string, turnId: string, message: SDKMessage): void {
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    const { trigger, pre_tokens, post_tokens } = message.compact_metadata;
    log.line('compact_boundary', { person, turn: turnId, trigger, preTokens: pre_tokens, postTokens: post_tokens });
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
