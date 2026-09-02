/**
 * Turn delivery: POST /turn to a person's pod, with pod-recreate-on-missing
 * and retry-with-backoff on 409 (pod mid-turn) or unreachable. Chat messages
 * additionally batch while a delivery attempt is being retried (architecture
 * doc section 1, step 3) — bursts collapse into one turn instead of racing
 * each other.
 */
import type { CoreV1Api } from '@kubernetes/client-node';

import { log } from '../shared/log.js';
import type { ChatMessage, ChatTurn, TaskTurn, TurnRequest } from '../shared/types.js';
import type { OperatorConfig } from './config.js';
import { ensurePersonPod, podExists, podIp, waitForPodReady } from './pod-lifecycle.js';
import { markUpdateDelivered } from './person-state.js';
import { RUNNER_PORT } from './pod-template.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

type DeliverOutcome = 'accepted' | 'retry';

/** One delivery attempt: ensure the pod exists/is ready, POST /turn once. */
async function deliverOnce(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
  turn: TurnRequest,
): Promise<DeliverOutcome> {
  if (!(await podExists(api, cfg.namespace, slug))) {
    await ensurePersonPod(api, cfg, slug, chatId, tz, tasksToken);
  }
  const ready = await waitForPodReady(api, cfg.namespace, slug, cfg.podReadyTimeoutMs);
  if (!ready) return 'retry';
  const ip = await podIp(api, cfg.namespace, slug);
  if (!ip) return 'retry';
  try {
    const res = await fetch(`http://${ip}:${RUNNER_PORT}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(turn),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 202) {
      log.line('turn_delivered', { person: slug, kind: turn.kind });
      return 'accepted';
    }
    if (res.status === 409) return 'retry';
    log.line('turn_delivery_unexpected_status', { person: slug, status: res.status });
    return 'retry';
  } catch (err) {
    log.error('turn_delivery_failed', err, { person: slug });
    return 'retry';
  }
}

/**
 * Deliver one fixed turn, retrying on 409/unreachable up to `maxWaitMs`.
 * Returns whether it was accepted (202). A hard timeout here does NOT retry
 * forever — after `maxWaitMs` this gives up and logs loudly rather than
 * wedging the single global Telegram offset behind one broken pod
 * indefinitely.
 */
export async function sendTurnWithRetry(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
  turn: TurnRequest,
  maxWaitMs = 10 * 60_000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    if ((await deliverOnce(api, cfg, slug, chatId, tz, tasksToken, turn)) === 'accepted') return true;
    await sleep(backoffMs(attempt++));
  }
  log.line('turn_delivery_gave_up', { person: slug, kind: turn.kind });
  return false;
}

interface PersonQueue {
  busy: boolean;
  queued: { updateId: number; message: ChatMessage }[];
}

const queues = new Map<string, PersonQueue>();

/**
 * Enqueue a chat message for a person and kick off a flush. While a flush is
 * already in flight for that person, new messages just join the queue; each
 * retry inside flush() re-snapshots the whole queue, so anything that
 * arrived during a backoff wait rides along on the next attempt instead of
 * spawning its own turn.
 *
 * Always resolves once the message is queued and flush() has been started —
 * NEVER once delivery actually succeeds. `flush()` can legitimately retry
 * for up to 10 minutes (a person's pod being busy mid-turn is the normal
 * steady state, not a failure), and this is awaited by `router.ts` inside
 * `pollUpdates`'s single global per-update loop (telegram.ts) — the only
 * process consuming this bot's Telegram updates. Confirmed live 2026-09-02:
 * this used to `return flush(...)` directly on the first message for a
 * given person, which really did block that entire global loop for the
 * whole retry duration — and since a Telegram button tap is itself just
 * another update in that same queue, a person's OWN tap on the permission
 * prompt that would free up their busy pod could get stuck behind their own
 * earlier message's stuck retry, deadlocking the whole bot for everyone
 * until an operator manually resolved the pending permission decision
 * out-of-band. `flush()`'s own internal errors are caught here now that
 * nothing upstream awaits it to surface them.
 */
export function enqueueChatMessage(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
  updateId: number,
  message: ChatMessage,
): Promise<void> {
  const q = queues.get(slug) ?? { busy: false, queued: [] };
  queues.set(slug, q);
  q.queued.push({ updateId, message });
  if (!q.busy) {
    void flush(api, cfg, slug, chatId, tz, tasksToken).catch((err) => log.error('chat_flush_failed', err, { person: slug }));
  }
  return Promise.resolve();
}

async function flush(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
): Promise<void> {
  const q = queues.get(slug);
  if (!q || q.busy || q.queued.length === 0) return;
  q.busy = true;
  try {
    const deadline = Date.now() + 10 * 60_000;
    let attempt = 0;
    while (Date.now() < deadline && q.queued.length > 0) {
      const batch = q.queued;
      q.queued = [];
      const updateId = Math.max(...batch.map((b) => b.updateId));
      const turn: ChatTurn = { kind: 'chat', updateId, chatId, messages: batch.map((b) => b.message) };

      const outcome = await deliverOnce(api, cfg, slug, chatId, tz, tasksToken, turn);
      if (outcome === 'accepted') {
        await markUpdateDelivered(api, cfg.namespace, slug, updateId);
        continue; // loop re-checks q.queued in case more arrived meanwhile
      }
      // Put the failed batch back at the front so anything newly queued
      // appends after it, preserving arrival order, then back off.
      q.queued = [...batch, ...q.queued];
      await sleep(backoffMs(attempt++));
    }
    if (q.queued.length > 0) log.line('chat_delivery_gave_up', { person: slug });
  } finally {
    q.busy = false;
    if (q.queued.length > 0) void flush(api, cfg, slug, chatId, tz, tasksToken);
  }
}

export async function deliverTaskTurn(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
  turn: TaskTurn,
): Promise<void> {
  const ok = await sendTurnWithRetry(api, cfg, slug, chatId, tz, tasksToken, turn, 2 * 60_000);
  if (!ok) throw new Error(`failed to deliver task turn ${turn.taskId} to ${slug}`);
}
