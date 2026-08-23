/**
 * One persistent Agent SDK `query()` per person pod (see CLAUDE.md's
 * "Session model" section for the full rationale): the underlying `claude`
 * subprocess now spans the pod's whole lifetime instead of being recreated
 * per `/turn`, so a backgrounded Bash command's `task_notification` has
 * somewhere to land. Checked against `nanocoai/nanoclaw`'s prior art for
 * doing this at the Agent SDK level.
 *
 * Single-flight by construction: only one pushed message is ever outstanding
 * waiting for its `result` at a time, so "the next `result` is the answer to
 * what was just pushed" needs no correlation id. A `task_notification`
 * arriving while a turn is in flight queues in `reactionQueue` and runs once
 * the current job resolves, through the exact same path.
 */
import { query as sdkQuery, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { log, truncateText } from '../shared/log.js';
import type { ContextUsageSummary, EffortLevel, TurnRequest } from '../shared/types.js';
import type { RunnerConfig } from './config.js';
import {
  buildPrompt,
  buildQueryOptions,
  buildUserMessage,
  logSdkMessage,
  readSavedSessionId,
  saveSessionId,
  summarizeContextUsage,
  summarizeUsage,
} from './sdk-session.js';
import { sendTelegramReply } from './telegram-send.js';
import { createPushableQueue } from './pushable-queue.js';

export interface TurnResult {
  replyText: string;
  ok: boolean;
}

export interface SessionController {
  start(): Promise<void>;
  stop(): Promise<void>;
  isBusy(): boolean;
  submitTurn(turn: TurnRequest, turnId: string): Promise<TurnResult>;
  /** Live control-plane read, not a turn — no journal entry, doesn't wait on `isBusy()`. Throws if the session hasn't started yet. */
  getContextUsage(): Promise<ContextUsageSummary>;
  /** Live control-plane write, not a turn — session-scoped only (confirmed live: not persisted to a settings file, resets to the `buildQueryOptions` default on pod restart). Throws if the session hasn't started yet. */
  setEffortLevel(level: EffortLevel): Promise<void>;
}

type QueryFn = typeof sdkQuery;

interface PendingReaction {
  taskId: string;
  status: string;
  summary: string;
}

interface Job {
  turnId: string;
  trigger: 'http' | 'task_notification';
  startedAt: number;
  resolve: (result: TurnResult) => void;
  reject: (err: unknown) => void;
  replyText: string;
  ok: boolean;
  numTurns: number;
  costUsd: number;
  usage: ReturnType<typeof summarizeUsage>;
}

// Bounded in-process retries for a genuinely transient blip; beyond this we
// exit and let k8s's restartPolicy: Always bring up a fresh container —
// simpler and more robust than an indefinite in-process supervisor (adopted
// from nanoclaw's MAILBOX_FAILURE_STREAK_EXIT -> process.exit pattern).
const RESTART_BACKOFFS_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionController(cfg: RunnerConfig, queryFn: QueryFn = sdkQuery): SessionController {
  const inputQueue = createPushableQueue<SDKUserMessage>();
  const reactionQueue: PendingReaction[] = [];

  let queryHandle: Query | null = null;
  let sessionId: string | null = null;
  let currentJob: Job | null = null;
  let stopped = false;
  let consecutiveCrashes = 0;
  let supervisorLoop: Promise<void> | null = null;

  function isBusy(): boolean {
    return currentJob !== null;
  }

  function startJob(trigger: Job['trigger'], turnId: string, message: SDKUserMessage): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      currentJob = { turnId, trigger, startedAt: Date.now(), resolve, reject, replyText: '', ok: true, numTurns: 0, costUsd: 0, usage: null };
      log.line('turn_start', { person: cfg.slug, session: sessionId, turn: turnId, trigger });
      inputQueue.push(message);
    });
  }

  async function submitTurn(turn: TurnRequest, turnId: string): Promise<TurnResult> {
    const promptText = buildPrompt(turn);
    const { text: userText, bytes: userBytes } = truncateText(promptText);
    log.line('user', { person: cfg.slug, turn: turnId, text: userText, bytes: userBytes });
    const message = await buildUserMessage(cfg, turn, promptText);
    return startJob('http', turnId, message);
  }

  function finishCurrentJob(): void {
    const job = currentJob;
    if (!job) return;
    currentJob = null;
    consecutiveCrashes = 0; // genuine forward progress — reset the crash-retry budget
    log.line('turn_end', {
      person: cfg.slug,
      turn: job.turnId,
      trigger: job.trigger,
      ok: job.ok,
      dur_ms: Date.now() - job.startedAt,
      cost_usd: job.costUsd,
      turns: job.numTurns,
      ...job.usage,
    });
    job.resolve({ replyText: job.replyText, ok: job.ok });
    drainReactionQueue();
  }

  function failCurrentJob(err: unknown): void {
    const job = currentJob;
    if (!job) return;
    currentJob = null;
    log.error('turn_error', err, { person: cfg.slug, turn: job.turnId, trigger: job.trigger });
    job.reject(err);
  }

  function drainReactionQueue(): void {
    if (currentJob || reactionQueue.length === 0) return;
    const reaction = reactionQueue.shift();
    if (reaction) void reactToTaskNotification(reaction);
  }

  async function reactToTaskNotification(reaction: PendingReaction): Promise<void> {
    const turnId = `bgtask:${reaction.taskId}:${Date.now()}`;
    const text = `[Background task ${reaction.taskId} ${reaction.status}]\n${reaction.summary}`;
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    try {
      const result = await startJob('task_notification', turnId, message);
      if (result.replyText.trim()) {
        await sendTelegramReply(cfg.telegramBotToken, cfg.chatId, result.replyText);
      }
    } catch (err) {
      log.error('task_notification_reaction_failed', err, { person: cfg.slug, taskId: reaction.taskId });
    }
  }

  function handleTaskNotification(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_notification' }>): void {
    const { text: summary } = truncateText(message.summary ?? '');
    log.line('task_notification', { person: cfg.slug, taskId: message.task_id, status: message.status, summary });
    const reaction: PendingReaction = { taskId: message.task_id, status: message.status, summary: message.summary ?? '' };
    if (currentJob) {
      reactionQueue.push(reaction);
      return;
    }
    void reactToTaskNotification(reaction);
  }

  async function consumeQuery(handle: Query): Promise<void> {
    for await (const message of handle as AsyncIterable<SDKMessage & { session_id?: string }>) {
      if (message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
        // Persisted the moment it's known, not batched to end-of-turn — a
        // crash between this and a turn's `result` would otherwise orphan
        // the session on the next restart (lesson from nanoclaw's own fix).
        await saveSessionId(cfg, sessionId);
      }

      logSdkMessage(cfg.slug, currentJob?.turnId ?? 'idle', message);

      if (message.type === 'system' && message.subtype === 'task_notification') {
        handleTaskNotification(message);
        continue;
      }

      if (!currentJob || message.type !== 'result') continue;

      currentJob.ok = !message.is_error;
      currentJob.numTurns = message.num_turns;
      currentJob.costUsd = message.total_cost_usd;
      if (message.subtype === 'success') currentJob.replyText = message.result;
      currentJob.usage = summarizeUsage(message.modelUsage);
      finishCurrentJob();
    }
  }

  async function runSupervised(): Promise<void> {
    while (!stopped) {
      try {
        sessionId = sessionId ?? (await readSavedSessionId(cfg));
        const handle = queryFn({ prompt: inputQueue, options: buildQueryOptions(cfg, sessionId) });
        queryHandle = handle;
        await consumeQuery(handle);
        if (stopped) return;
        throw new Error('session stream ended unexpectedly');
      } catch (err) {
        if (stopped) return;
        log.error('session_crashed', err, { person: cfg.slug });
        if (currentJob) failCurrentJob(err);
        if (reactionQueue.length > 0) {
          log.line('task_notification_dropped_on_crash', { person: cfg.slug, count: reactionQueue.length });
          reactionQueue.length = 0;
        }

        consecutiveCrashes += 1;
        if (consecutiveCrashes > RESTART_BACKOFFS_MS.length) {
          log.error('session_restart_exhausted', err, { person: cfg.slug, attempts: consecutiveCrashes });
          process.exit(1);
        }
        const delay = RESTART_BACKOFFS_MS[consecutiveCrashes - 1] ?? RESTART_BACKOFFS_MS[RESTART_BACKOFFS_MS.length - 1] ?? 4000;
        log.line('session_restart_attempt', { person: cfg.slug, attempt: consecutiveCrashes, delayMs: delay });
        await sleep(delay);
      }
    }
  }

  return {
    async start(): Promise<void> {
      supervisorLoop = runSupervised();
      // Fire-and-forget background task — attach a safety net immediately so
      // an unexpected rejection (a bug, or process.exit() itself throwing in
      // tests) can never surface as an unhandled promise rejection before
      // stop() gets around to awaiting it.
      supervisorLoop.catch((err) => log.error('session_supervisor_fatal', err, { person: cfg.slug }));
    },
    async stop(): Promise<void> {
      stopped = true;
      inputQueue.close();
      if (queryHandle) await queryHandle.return(undefined).catch(() => {});
      await supervisorLoop?.catch(() => {});
    },
    isBusy,
    submitTurn,
    async getContextUsage(): Promise<ContextUsageSummary> {
      if (!queryHandle) throw new Error('session not started yet');
      return summarizeContextUsage(await queryHandle.getContextUsage());
    },
    async setEffortLevel(level: EffortLevel): Promise<void> {
      if (!queryHandle) throw new Error('session not started yet');
      await queryHandle.applyFlagSettings({ effortLevel: level });
    },
  };
}
