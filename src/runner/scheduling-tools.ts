/**
 * In-process MCP tools exposing the operator's scheduling API to the model
 * (architecture doc section 3). This is the piece that fully retires
 * CRON.md + the SessionStart hack: the model schedules through a tool, the
 * operator persists and fires, nothing is ever "remembered" by the model.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { CancelTaskRequest, ScheduleTaskRequest, TaskRecord } from '../shared/types.js';
import type { RunnerConfig } from './config.js';

async function callTasksApi<T>(cfg: RunnerConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.operatorTasksUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.tasksToken}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as unknown;
  if (!res.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new Error(`tasks api ${method} ${path} failed: ${message}`);
  }
  return data as T;
}

export function buildSchedulingMcpServer(cfg: RunnerConfig) {
  const scheduleTask = tool(
    'schedule_task',
    'Schedule a recurring task. The operator persists it and fires it on the cron schedule by delivering the prompt as a normal turn — you never need to remember or recreate this across restarts.',
    {
      cron: z.string().describe('Standard 5-field cron expression, e.g. "0 9 * * *"'),
      prompt: z.string().describe('The prompt to run when this task fires'),
      tz: z.string().optional().describe("IANA timezone; defaults to the person's timezone"),
    },
    async (args) => {
      const request: ScheduleTaskRequest = {
        slug: cfg.slug,
        cron: args.cron,
        tz: args.tz ?? cfg.tz,
        prompt: args.prompt,
      };
      const task = await callTasksApi<TaskRecord>(cfg, 'POST', '/tasks', request);
      return { content: [{ type: 'text' as const, text: `Scheduled task ${task.id}, next run ${task.nextRunAt}` }] };
    },
  );

  const listTasks = tool('list_tasks', 'List your scheduled tasks.', {}, async () => {
    const { tasks } = await callTasksApi<{ tasks: TaskRecord[] }>(
      cfg,
      'GET',
      `/tasks?slug=${encodeURIComponent(cfg.slug)}`,
    );
    const text = tasks.length
      ? tasks.map((t) => `${t.id}: "${t.cron}" (${t.tz}) — ${t.prompt} — next ${t.nextRunAt}`).join('\n')
      : 'No scheduled tasks.';
    return { content: [{ type: 'text' as const, text }] };
  });

  const cancelTask = tool(
    'cancel_task',
    'Cancel a scheduled task by id (see list_tasks for ids).',
    { taskId: z.string() },
    async (args) => {
      const request: CancelTaskRequest = { slug: cfg.slug, taskId: args.taskId };
      await callTasksApi(cfg, 'DELETE', '/tasks', request);
      return { content: [{ type: 'text' as const, text: `Cancelled ${args.taskId}` }] };
    },
  );

  return createSdkMcpServer({
    name: 'pan-agent-scheduling',
    version: '1.0.0',
    tools: [scheduleTask, listTasks, cancelTask],
  });
}
