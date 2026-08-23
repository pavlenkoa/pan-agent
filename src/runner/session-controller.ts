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
import { DEFAULT_CONTEXT_LIMIT, type ContextUsageSummary, type EffortLevel, type TurnRequest } from '../shared/types.js';
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
  /** App-enforced soft cap, not an SDK setting — see `maybeTriggerAutoCompact` below for why. Pure local state, no queryHandle needed, safe to call before the session starts. */
  setContextLimit(tokens: number): void;
}

type QueryFn = typeof sdkQuery;

interface PendingReaction {
  taskId: string;
  status: string;
  summary: string;
}

interface Job {
  turnId: string;
  trigger: 'http' | 'task_notification' | 'auto_compact';
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

export function createSessionController(
  cfg: RunnerConfig,
  queryFn: QueryFn = sdkQuery,
  controlTurnTimeoutMs = 180_000,
): SessionController {
  const inputQueue = createPushableQueue<SDKUserMessage>();
  const reactionQueue: PendingReaction[] = [];

  let queryHandle: Query | null = null;
  let sessionId: string | null = null;
  let currentJob: Job | null = null;
  let stopped = false;
  let consecutiveCrashes = 0;
  let supervisorLoop: Promise<void> | null = null;
  // Tracked locally rather than read back from the SDK — it exposes no
  // getter for either (confirmed: no getSettings()-equivalent on Query).
  let effortLevel: EffortLevel = 'medium';
  let contextLimit = DEFAULT_CONTEXT_LIMIT;

  function isBusy(): boolean {
    return currentJob !== null;
  }

  /**
   * Confirmed live 2026-08-23: a real incoming HTTP turn silently overwrote
   * an in-flight `auto_compact` job's `currentJob` — `index.ts`'s own `busy`
   * flag has no visibility into internally-triggered jobs (auto-compact,
   * task-notification reactions), so it let a second turn through while one
   * was still running. That orphaned the first job's promise forever (never
   * resolved/rejected — the caller just hangs) and interleaved both jobs'
   * SDK messages under the wrong `currentJob`, misattributing one job's
   * `compact_boundary`/tool calls/reply to the other. Every caller is
   * already supposed to check busy-ness first (`index.ts` now also checks
   * `isBusy()`, not just its own flag; `reactToTaskNotification` and
   * `maybeTriggerAutoCompact` already guard on `currentJob`) — this throw is
   * defense in depth, turning any future gap in that gating into a loud,
   * visible error instead of silent single-flight corruption.
   */
  function startJob(trigger: Job['trigger'], turnId: string, message: SDKUserMessage): Promise<TurnResult> {
    if (currentJob) {
      return Promise.reject(new Error(`startJob(${turnId}) called while turn ${currentJob.turnId} is still in flight`));
    }
    return new Promise((resolve, reject) => {
      currentJob = { turnId, trigger, startedAt: Date.now(), resolve, reject, replyText: '', ok: true, numTurns: 0, costUsd: 0, usage: null };
      log.line('turn_start', { person: cfg.slug, session: sessionId, turn: turnId, trigger });
      inputQueue.push(message);
    });
  }

  /**
   * `/compact`/`/clear` only, not chat/task turns — those can legitimately
   * run long on real synchronous work (a big Bash download, etc.), a
   * control turn has no legitimate reason to. Confirmed live 2026-08-23:
   * `/compact` on a *resumed* session (the real production shape — my
   * earlier verification only ever used fresh sessions) hung for 2.5+
   * minutes with zero further SDK output, wedging the single-flight queue
   * and every message the person sent after it. This is the safety net —
   * `timeoutControlTurn` force-clears `currentJob` and best-effort
   * `interrupt()`s the stuck call so the queue can move again, rather than
   * trusting the SDK to always resolve control turns in reasonable time.
   * `controlTurnTimeoutMs` is a constructor param (default 180s) rather than
   * a local const so tests can shrink it instead of faking wall-clock time.
   */
  function timeoutControlTurn(turnId: string): void {
    const job = currentJob;
    if (!job || job.turnId !== turnId) return; // already resolved normally, or this timer is stale
    currentJob = null;
    log.error('control_turn_timed_out', new Error(`control turn exceeded ${controlTurnTimeoutMs}ms`), {
      person: cfg.slug,
      turn: turnId,
      trigger: job.trigger,
    });
    job.resolve({ replyText: '', ok: false });
    drainReactionQueue();
    // try/catch, not just .catch() on the returned promise — interrupt()
    // isn't guaranteed to exist as a real function on every Query-shaped
    // value this gets called with (confirmed in the test harness's fake
    // generator), and this runs inside a bare setTimeout callback where a
    // synchronous throw would be a genuine unhandled exception.
    try {
      void queryHandle?.interrupt().catch((err) => log.error('control_turn_interrupt_failed', err, { person: cfg.slug }));
    } catch (err) {
      log.error('control_turn_interrupt_failed', err, { person: cfg.slug });
    }
  }

  async function submitTurn(turn: TurnRequest, turnId: string): Promise<TurnResult> {
    const promptText = buildPrompt(turn);
    const { text: userText, bytes: userBytes } = truncateText(promptText);
    log.line('user', { person: cfg.slug, turn: turnId, text: userText, bytes: userBytes });
    const message = await buildUserMessage(cfg, turn, promptText);
    const resultPromise = startJob('http', turnId, message);
    if (turn.kind !== 'control') return resultPromise;
    const timer = setTimeout(() => timeoutControlTurn(turnId), controlTurnTimeoutMs);
    try {
      return await resultPromise;
    } finally {
      clearTimeout(timer);
    }
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
    maybeTriggerAutoCompact(job);
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

  /**
   * App-enforced ceiling, checked after every job — the SDK's own
   * `autoCompactThreshold` scales up near the model's full window (see
   * `DEFAULT_CONTEXT_LIMIT`'s comment), so it never actually protects
   * against a 250K-scale budget. Uses a live `getContextUsage()` call for
   * the real current total — confirmed live 2026-08-23 that a turn's own
   * reported `cacheReadTokens` is NOT current context size, it's cumulative
   * across every internal tool-call round-trip *within* that turn (each
   * round-trip re-reads the growing prefix from cache, so a turn with
   * several tool calls keeps adding to it even though real context barely
   * grows): a turn that reported 305,144 that way had a real context of
   * just 32,629 once actually measured, and the gap between those two
   * numbers is exactly what triggered a cascade of unnecessary compactions
   * (and, compounding with a separate single-flight gap since fixed, real
   * incoming turns colliding with them). Skips when `job.trigger ===
   * 'auto_compact'` so a compact's own result can never chain into another
   * one, and checks `currentJob`/`reactionQueue` both before *and* after the
   * `getContextUsage()` await — something can start in the gap while it's
   * in flight.
   */
  function maybeTriggerAutoCompact(job: Job): void {
    if (job.trigger === 'auto_compact' || currentJob || reactionQueue.length > 0) return;
    void checkContextAndMaybeAutoCompact();
  }

  async function checkContextAndMaybeAutoCompact(): Promise<void> {
    if (!queryHandle || currentJob || reactionQueue.length > 0) return;
    let totalTokens: number;
    try {
      totalTokens = (await queryHandle.getContextUsage()).totalTokens;
    } catch (err) {
      log.error('context_usage_check_failed', err, { person: cfg.slug });
      return;
    }
    if (totalTokens <= contextLimit || currentJob || reactionQueue.length > 0) return;
    void runAutoCompact(totalTokens);
  }

  async function runAutoCompact(totalTokens: number): Promise<void> {
    const turnId = `auto-compact:${Date.now()}`;
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null };
    const timer = setTimeout(() => timeoutControlTurn(turnId), controlTurnTimeoutMs);
    try {
      const result = await startJob('auto_compact', turnId, message);
      log.line('auto_compact_triggered', { person: cfg.slug, totalTokens, contextLimit, ok: result.ok });
      await sendTelegramReply(
        cfg.telegramBotToken,
        cfg.chatId,
        result.ok
          ? `✅ Auto-compacted: context passed your ${contextLimit.toLocaleString()}-token limit.`
          : `⚠️ Auto-compact timed out — context is still over your ${contextLimit.toLocaleString()}-token limit, will retry after your next message.`,
      );
    } catch (err) {
      log.error('auto_compact_failed', err, { person: cfg.slug });
    } finally {
      clearTimeout(timer);
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
      return summarizeContextUsage(await queryHandle.getContextUsage(), effortLevel, contextLimit);
    },
    async setEffortLevel(level: EffortLevel): Promise<void> {
      if (!queryHandle) throw new Error('session not started yet');
      await queryHandle.applyFlagSettings({ effortLevel: level });
      effortLevel = level;
    },
    setContextLimit(tokens: number): void {
      contextLimit = tokens;
    },
  };
}
