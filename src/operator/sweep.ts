/**
 * 60s task sweep (architecture doc section 2/8): for each active person's
 * due tasks, deliver a task turn the same way an incoming message would.
 * Drift-free recurrence — nextRunAt always advances from the *scheduled*
 * time, never from "now" — and a catch-up window bounds how much missed
 * time gets replayed after a long outage.
 */
import type { CoreV1Api } from '@kubernetes/client-node';

import type { TaskTurn } from '../shared/types.js';
import { log } from '../shared/log.js';
import { advanceSchedule, shouldCatchUp } from './cron.js';
import { readPeopleIndex } from './people-index.js';
import { readPersonState, recordTaskFired, recordTaskSkipped } from './person-state.js';

export type DeliverTaskTurn = (slug: string, chatId: number, turn: TaskTurn) => Promise<void>;

export async function runSweep(
  api: CoreV1Api,
  namespace: string,
  catchUpWindowMs: number,
  deliver: DeliverTaskTurn,
  now: Date = new Date(),
): Promise<void> {
  const idx = await readPeopleIndex(api, namespace);
  for (const [slug, person] of Object.entries(idx.people)) {
    if (person.status !== 'active') continue;
    const state = await readPersonState(api, namespace, slug);
    if (!state) continue;
    for (const task of state.tasks) {
      if (task.paused) continue;
      const nextRunAt = new Date(task.nextRunAt);
      if (Number.isNaN(nextRunAt.getTime()) || nextRunAt.getTime() > now.getTime()) continue;

      const decision = shouldCatchUp(nextRunAt, now, catchUpWindowMs);
      if (!decision.fire) {
        const advanced = advanceSchedule(task.cron, task.tz, nextRunAt);
        await recordTaskSkipped(api, namespace, slug, task.id, advanced.toISOString());
        log.line('task_skipped', { person: slug, taskId: task.id, nextRunAt: advanced.toISOString() });
        continue;
      }

      const scheduledFor = decision.scheduledFor;
      const advanced = advanceSchedule(task.cron, task.tz, scheduledFor);
      const turn: TaskTurn = {
        kind: 'task',
        taskId: task.id,
        scheduledFor: scheduledFor.toISOString(),
        chatId: person.chatId,
        prompt: task.prompt,
      };
      try {
        await deliver(slug, person.chatId, turn);
        await recordTaskFired(api, namespace, slug, task.id, advanced.toISOString(), 'ok');
        log.line('task_fired', { person: slug, taskId: task.id, scheduledFor: turn.scheduledFor, ok: true });
      } catch (err) {
        await recordTaskFired(api, namespace, slug, task.id, advanced.toISOString(), 'error');
        log.error('task_fired', err, { person: slug, taskId: task.id, scheduledFor: turn.scheduledFor });
      }
    }
  }
}

export function startSweepTimer(
  api: CoreV1Api,
  namespace: string,
  intervalMs: number,
  catchUpWindowMs: number,
  deliver: DeliverTaskTurn,
): NodeJS.Timeout {
  return setInterval(() => {
    runSweep(api, namespace, catchUpWindowMs, deliver).catch((err) => log.error('sweep_failed', err));
  }, intervalMs);
}
