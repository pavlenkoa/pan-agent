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
import { query as sdkQuery, type McpServerConfig, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { log, truncateText } from '../shared/log.js';
import {
  type ContextUsageSummary,
  type EffortLevel,
  type EsputnikServerStatus,
  type TaskTurn,
  type TurnRequest,
} from '../shared/types.js';
import type { RunnerConfig } from './config.js';
import { createPermissionGate, type PermissionDecision } from './permission-gate.js';
import {
  buildPrompt,
  buildQueryOptions,
  buildUserMessage,
  logSdkMessage,
  noUpdateInstruction,
  readEsputnikMcpServers,
  readSavedSessionId,
  resolveReplyText,
  saveSessionId,
  summarizeContextUsage,
  summarizeUsage,
} from './sdk-session.js';
import { sendTelegramReply } from './telegram-send.js';
import { createPushableQueue } from './pushable-queue.js';
import type { ReactableMessageRef } from './telegram-extras-tools.js';

/**
 * Everything `evt="turn_end"` logs besides `person`/`turn` (which the caller
 * already has). Only populated for `trigger: 'http'` jobs — those are the
 * ones `index.ts`'s handleTurn drives, and it logs `turn_end` itself
 * *after* `reply_sent`/`reply_muted` (see `finishCurrentJob`'s comment for
 * why: logging it here, before control returns to handleTurn, is what made
 * the summary row render above the reply row). `task_notification` and
 * `auto_compact` jobs never flow through handleTurn, have no ordering
 * problem, and keep logging `turn_end` unconditionally inside
 * `finishCurrentJob` — their `TurnResult` never carries this field.
 */
export interface TurnEndFields {
  trigger: Job['trigger'];
  durMs: number;
  costUsd: number;
  turns: number;
  usage: ReturnType<typeof summarizeUsage>;
}

export interface TurnResult {
  replyText: string;
  ok: boolean;
  turnEnd?: TurnEndFields;
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
  /**
   * One-shot, internal-only push telling the model to re-read its own
   * CLAUDE.md via the Read tool — see `personaChangedSinceLastAck`'s doc
   * comment (sdk-session.ts) for why this is needed at all: a resumed
   * session doesn't pick up a persona update on its own. `index.ts`'s
   * `main()` calls this once at boot, only when that function says the
   * content actually changed since last acknowledged AND this is a resumed
   * session (a fresh one reads CLAUDE.md naturally, no nudge needed). Never
   * delivers whatever the model replies to Telegram — purely internal.
   */
  nudgePersonaRefresh(): Promise<void>;
  /**
   * Same shape as `nudgePersonaRefresh` above, generalized to one or more
   * shared skill files (see `skillChangedSinceLastAck`'s doc comment,
   * sdk-session.ts, for why a resumed session needs this too) — a shared
   * `.claude/skills/<name>/SKILL.md` getting reinstalled with new content on
   * disk doesn't update a long-lived session's own memorized understanding
   * of that skill's procedure on its own. `index.ts`'s `main()` calls this
   * once at boot per boot (not once per changed skill) with every skill name
   * that changed since last acknowledged, only when this is a resumed
   * session. Never delivers whatever the model replies to Telegram — purely
   * internal.
   */
  nudgeSkillRefresh(changedSkillNames: string[]): Promise<void>;
  /**
   * One action whether `serverKey` is brand new to this session or a
   * renewal of one it already has wired up (from `Options.mcpServers` at
   * boot, or a previous call to this same method) — this is the decision
   * the operator can't reliably make itself (see shared/types.ts's
   * `ControlRequest`'s `sync_esputnik_mcp` doc comment), made here from
   * `knownEsputnikKeys`, the only place that actually knows the live
   * session's current server set. Throws if the session hasn't started yet.
   */
  syncMcpServer(serverKey: string, config: McpServerConfig): Promise<'added' | 'reconnected'>;
  /** Live per-account connection health, filtered to eSputnik servers only. Throws if the session hasn't started yet. */
  getEsputnikStatus(): Promise<EsputnikServerStatus[]>;
  /**
   * Resolves a pending Telegram permission-gate request (permission-gate.ts)
   * once the operator relays a button tap via /control. `applied: false`
   * means no pending request exists under this id (already resolved, timed
   * out, or lost to a pod restart) — the operator must not persist an
   * "always allow" grant or otherwise treat that as a real decision. Safe
   * to call even if the session hasn't started yet (the gate itself has no
   * dependency on `queryHandle`).
   */
  resolvePermissionDecision(requestId: string, decision: PermissionDecision): { applied: boolean; toolName?: string };
}

type QueryFn = typeof sdkQuery;

interface PendingReaction {
  taskId: string;
  status: string;
  summary: string;
}

interface Job {
  turnId: string;
  trigger: 'http' | 'task_notification' | 'auto_compact' | 'persona_refresh' | 'skill_refresh';
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

// A failed auto-compact otherwise only retries opportunistically, the next
// time some unrelated real turn happens to finish (maybeTriggerAutoCompact is
// called from finishCurrentJob, never on its own timer). Confirmed live
// 2026-09-06: for a person whose only regular activity is a single daily
// scheduled task, that's one retry opportunity per 24h — one person's
// context grew unchecked for 3 straight days (459k -> 467k -> 474k tokens
// against a 250k limit) because each day's lone retry attempt also failed
// and nothing else ever nudged it again in between. This gives a failed
// auto-compact its own independent retry schedule regardless of chat
// activity. Capped rather than fixed-interval: a person who's actively
// chatting will usually clear it via the opportunistic path long before the
// first backoff even fires, so this only matters for the low-activity case
// it exists for — and if the SDK-side hang is more than transient, retrying
// every couple of minutes forever would just spend money on repeated
// multi-minute /compact attempts for no benefit.
const AUTO_COMPACT_RETRY_BACKOFFS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionController(
  cfg: RunnerConfig,
  queryFn: QueryFn = sdkQuery,
  controlTurnTimeoutMs = 180_000,
  autoCompactRetryBackoffsMs = AUTO_COMPACT_RETRY_BACKOFFS_MS,
): SessionController {
  const inputQueue = createPushableQueue<SDKUserMessage>();
  const reactionQueue: PendingReaction[] = [];

  let queryHandle: Query | null = null;
  let sessionId: string | null = null;
  let currentJob: Job | null = null;
  let stopped = false;
  let consecutiveCrashes = 0;
  let supervisorLoop: Promise<void> | null = null;
  // The SDK's `result.total_cost_usd` is cumulative for the whole query()
  // stream, not per-turn (confirmed live 2026-09-14: a single person pod's
  // successive turn_end lines read 3.07, 3.16, 3.30, ... — each the running
  // total-to-date, not that turn's own cost). Logging it as-is made the
  // Grafana usage dashboard's `sum(sum_over_time(...cost_usd...))` panel
  // re-add the same running total once per turn, inflating a real ~$20/day
  // fleet spend into a reported $452/day. This baseline is subtracted off so
  // `job.costUsd` (and the `cost_usd` log field) is the true incremental
  // cost of that one turn. Reset to 0 wherever a fresh `queryFn()` stream is
  // started (runSupervised, below) since that's a brand new cost counter on
  // the SDK side, whether from a genuine crash-restart or the pod's first boot.
  let costBaseline = 0;
  // Tracked locally rather than read back from the SDK — it exposes no
  // getter for either (confirmed: no getSettings()-equivalent on Query).
  let effortLevel: EffortLevel = 'medium';
  // cfg.contextLimit is the operator-resolved boot-time value — this
  // person's own /context_limit override if they have one, else their
  // computed per-person default (see pod-lifecycle.ts's resolveContextLimit
  // and runner/config.ts). setContextLimit below only ever changes it
  // in-memory for the rest of this process's life.
  let contextLimit = cfg.contextLimit;
  // See AUTO_COMPACT_RETRY_BACKOFFS_MS's comment — an independent retry
  // schedule for a failed auto-compact, on top of the opportunistic
  // next-real-turn path. Reset to 0 the moment a compact actually succeeds.
  let autoCompactRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let autoCompactRetryAttempt = 0;
  // Reset at the top of every runSupervised loop iteration (cold start and
  // every crash-restart both re-read the credentials file fresh, so a prior
  // session's dynamic-add history is meaningless to the new one — see
  // readEsputnikMcpServers' doc comment). `knownEsputnikKeys` covers both
  // the static, boot-time entries AND anything added dynamically this
  // session; `dynamicEsputnikServers` is only the latter, since
  // `setMcpServers` replaces its whole dynamic tier on every call (confirmed
  // from the SDK's own doc comment on that method — not additive per-call).
  let knownEsputnikKeys = new Set<string>();
  const dynamicEsputnikServers = new Map<string, McpServerConfig>();
  // The Telegram message a react_to_message tool call targets — only ever a
  // real inbound chat message's id (see submitTurn below); explicitly
  // cleared for synthetic pushes (task-notification replies, auto-compact)
  // so the model can't accidentally react to a stale/unrelated message.
  const reactable: ReactableMessageRef = { messageId: null };
  // Constructed once, reused across every stream (re)start below — its
  // pending-request map and in-memory always-allowed set must survive a
  // crash-restart of the query() stream itself (the whole point of tracking
  // "always allow" in memory at all is to avoid re-prompting within this
  // pod's lifetime; a stream restart is not a pod restart).
  const permissionGate = createPermissionGate(cfg);

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
    job.resolve({
      replyText: '',
      ok: false,
      ...(job.trigger === 'http'
        ? { turnEnd: { trigger: job.trigger, durMs: Date.now() - job.startedAt, costUsd: job.costUsd, turns: job.numTurns, usage: job.usage } }
        : {}),
    });
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
    reactable.messageId = turn.kind === 'chat' ? (turn.messages.at(-1)?.messageId ?? null) : null;
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
    const durMs = Date.now() - job.startedAt;
    if (job.trigger === 'http') {
      // index.ts logs turn_end itself, after reply_sent/reply_muted — see TurnEndFields' comment.
      job.resolve({
        replyText: job.replyText,
        ok: job.ok,
        turnEnd: { trigger: job.trigger, durMs, costUsd: job.costUsd, turns: job.numTurns, usage: job.usage },
      });
    } else {
      log.line('turn_end', {
        person: cfg.slug,
        turn: job.turnId,
        trigger: job.trigger,
        ok: job.ok,
        dur_ms: durMs,
        cost_usd: job.costUsd,
        turns: job.numTurns,
        ...job.usage,
      });
      job.resolve({ replyText: job.replyText, ok: job.ok });
    }
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

  /**
   * Confirmed live 2026-08-26 (~/task-notification-no-update-bug.md): this
   * prompt used to have no NO_UPDATE escape hatch at all, unlike
   * `buildPrompt`'s task-kind branch — a second notification for the same
   * background event with nothing new to add got the model writing its "no
   * update needed" reasoning as literal English prose, which shipped
   * straight to Telegram mid-Ukrainian-conversation. Now shares the same
   * `noUpdateInstruction` wording and is routed through `resolveReplyText`
   * (via a synthesized `TaskTurn` — task_notification isn't a real
   * `TurnRequest` of its own) instead of delivering `result.replyText`
   * unconditionally.
   */
  async function reactToTaskNotification(reaction: PendingReaction): Promise<void> {
    const turnId = `bgtask:${reaction.taskId}:${Date.now()}`;
    const promptText = `[Background task ${reaction.taskId} ${reaction.status}]
${reaction.summary}

${noUpdateInstruction(
      "This is an unattended background follow-up, not a live question from the person — they won't see anything unless you tell them something new (don't repeat something you've already told them in an earlier message).",
    )}`;
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: promptText }, parent_tool_use_id: null };
    reactable.messageId = null; // synthetic push, not a real inbound message

    try {
      const result = await startJob('task_notification', turnId, message);
      const fakeTaskTurn: TaskTurn = { kind: 'task', taskId: reaction.taskId, scheduledFor: '', chatId: cfg.chatId, prompt: '' };
      const resolved = resolveReplyText(fakeTaskTurn, result);
      if (resolved.replyText.trim()) {
        const { text, bytes } = truncateText(resolved.replyText);
        log.line('reply_sent', { person: cfg.slug, turn: turnId, text, bytes });
        await sendTelegramReply(cfg.telegramBotToken, cfg.chatId, resolved.replyText);
      } else if (resolved.isNoUpdate) {
        const { text, bytes } = truncateText(resolved.suppressedReasoning);
        log.line('reply_muted', { person: cfg.slug, turn: turnId, reason: 'task_notification_no_update', text, bytes });
      }
    } catch (err) {
      log.error('task_notification_reaction_failed', err, { person: cfg.slug, taskId: reaction.taskId });
    }
  }

  /** See `SessionController.nudgePersonaRefresh`'s doc comment for why this exists at all. */
  async function nudgePersonaRefresh(): Promise<void> {
    const turnId = `persona-refresh:${Date.now()}`;
    const text =
      '[System note: your persona instructions (~/.claude/CLAUDE.md) were updated since this conversation started — a routine restart does not re-load them into your context on its own. Use the Read tool on ~/.claude/CLAUDE.md now so you have the current instructions. This is internal only, not a message from the person — do not reply to them about it.]';
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    reactable.messageId = null; // synthetic push, not a real inbound message
    try {
      const result = await startJob('persona_refresh', turnId, message);
      const { text: preview, bytes } = truncateText(result.replyText);
      log.line('persona_refresh_acked', { person: cfg.slug, turn: turnId, text: preview, bytes });
    } catch (err) {
      log.error('persona_refresh_failed', err, { person: cfg.slug });
    }
  }

  /** See `SessionController.nudgeSkillRefresh`'s doc comment for why this exists at all. */
  async function nudgeSkillRefresh(changedSkillNames: string[]): Promise<void> {
    const turnId = `skill-refresh:${Date.now()}`;
    const paths = changedSkillNames.map((name) => `.claude/skills/${name}/SKILL.md`).join(', ');
    const text = `[System note: the following shared skill file(s) were updated since this conversation started — a routine restart does not re-load them into your context on its own: ${paths}. Use the Read tool on each of them now so your understanding of their procedure is current. This is internal only, not a message from the person — do not reply to them about it.]`;
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    reactable.messageId = null; // synthetic push, not a real inbound message
    try {
      const result = await startJob('skill_refresh', turnId, message);
      const { text: preview, bytes } = truncateText(result.replyText);
      log.line('skill_refresh_acked', { person: cfg.slug, turn: turnId, skills: changedSkillNames, text: preview, bytes });
    } catch (err) {
      log.error('skill_refresh_failed', err, { person: cfg.slug, skills: changedSkillNames });
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

  function clearAutoCompactRetry(): void {
    if (autoCompactRetryTimer) {
      clearTimeout(autoCompactRetryTimer);
      autoCompactRetryTimer = null;
    }
  }

  /** Schedules the next independent retry attempt — see AUTO_COMPACT_RETRY_BACKOFFS_MS's doc comment. */
  function scheduleAutoCompactRetry(): void {
    clearAutoCompactRetry();
    const delay =
      autoCompactRetryBackoffsMs[Math.min(autoCompactRetryAttempt, autoCompactRetryBackoffsMs.length - 1)] ??
      autoCompactRetryBackoffsMs[autoCompactRetryBackoffsMs.length - 1] ??
      30 * 60_000;
    autoCompactRetryAttempt += 1;
    autoCompactRetryTimer = setTimeout(() => {
      autoCompactRetryTimer = null;
      void checkContextAndMaybeAutoCompact();
    }, delay);
  }

  async function runAutoCompact(totalTokens: number): Promise<void> {
    const turnId = `auto-compact:${Date.now()}`;
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null };
    reactable.messageId = null; // synthetic push, not a real inbound message
    const timer = setTimeout(() => timeoutControlTurn(turnId), controlTurnTimeoutMs);
    try {
      const result = await startJob('auto_compact', turnId, message);
      log.line('auto_compact_triggered', { person: cfg.slug, totalTokens, contextLimit, ok: result.ok });
      if (result.ok) {
        autoCompactRetryAttempt = 0;
        clearAutoCompactRetry();
      } else {
        scheduleAutoCompactRetry();
      }
      const notice = result.ok
        ? `✅ Auto-compacted: context passed your ${contextLimit.toLocaleString()}-token limit.`
        : `⚠️ Auto-compact timed out — context is still over your ${contextLimit.toLocaleString()}-token limit, will retry automatically.`;
      log.line('system_notice', { person: cfg.slug, turn: turnId, text: notice });
      await sendTelegramReply(cfg.telegramBotToken, cfg.chatId, notice);
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
      currentJob.costUsd = Math.max(0, message.total_cost_usd - costBaseline);
      costBaseline = message.total_cost_usd;
      if (message.subtype === 'success') currentJob.replyText = message.result;
      currentJob.usage = summarizeUsage(message.modelUsage);
      finishCurrentJob();
    }
  }

  async function runSupervised(): Promise<void> {
    while (!stopped) {
      try {
        sessionId = sessionId ?? (await readSavedSessionId(cfg));
        const esputnikServers = await readEsputnikMcpServers(cfg);
        knownEsputnikKeys = new Set(Object.keys(esputnikServers));
        dynamicEsputnikServers.clear();
        costBaseline = 0; // fresh queryFn() stream below = a fresh SDK cost counter, see costBaseline's doc comment
        const handle = queryFn({ prompt: inputQueue, options: buildQueryOptions(cfg, sessionId, reactable, permissionGate, esputnikServers) });
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
      clearAutoCompactRetry();
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
    nudgePersonaRefresh,
    nudgeSkillRefresh,
    async syncMcpServer(serverKey: string, config: McpServerConfig): Promise<'added' | 'reconnected'> {
      if (!queryHandle) throw new Error('session not started yet');
      if (knownEsputnikKeys.has(serverKey)) {
        // Already wired up (static from boot, or added dynamically earlier
        // this session) — the config itself hasn't changed, only the
        // on-disk credential has, so `setMcpServers` would likely be a
        // no-op. Force a fresh handshake so it re-reads the rewritten file.
        await queryHandle.reconnectMcpServer(serverKey);
        return 'reconnected';
      }
      dynamicEsputnikServers.set(serverKey, config);
      await queryHandle.setMcpServers(Object.fromEntries(dynamicEsputnikServers));
      knownEsputnikKeys.add(serverKey);
      return 'added';
    },
    async getEsputnikStatus(): Promise<EsputnikServerStatus[]> {
      if (!queryHandle) throw new Error('session not started yet');
      const statuses = await queryHandle.mcpServerStatus();
      return statuses.filter((s) => s.name.startsWith('esputnik-')).map((s) => ({ serverKey: s.name, status: s.status }));
    },
    resolvePermissionDecision(requestId: string, decision: PermissionDecision): { applied: boolean; toolName?: string } {
      return permissionGate.resolve(requestId, decision);
    },
  };
}
