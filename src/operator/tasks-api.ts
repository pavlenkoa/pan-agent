/**
 * The `/tasks` HTTP API — called by the runner's `schedule_task` /
 * `list_tasks` / `cancel_task` in-process MCP tools (architecture doc
 * section 3). This is the piece that fully retires the CRON.md +
 * SessionStart hack: the model schedules through a tool, the operator
 * persists and fires, nothing is ever "remembered" by the model.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { CoreV1Api } from '@kubernetes/client-node';

import { readJsonBody, sendJson } from '../shared/http.js';
import { log } from '../shared/log.js';
import type { CancelTaskRequest, ScheduleTaskRequest } from '../shared/types.js';
import { nextRunAfter } from './cron.js';
import { readPeopleIndex } from './people-index.js';
import { addTask, readPersonState, removeTask } from './person-state.js';

/**
 * Every call must prove it's that slug's own pod (its PERSON_TASKS_TOKEN),
 * not just claim a slug — otherwise any person's pod could schedule/read/
 * cancel tasks for any other person (they all share this one API).
 */
export function isAuthorized(
  idx: Awaited<ReturnType<typeof readPeopleIndex>>,
  slug: string,
  authHeader: string | undefined,
): boolean {
  const presented = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  const expected = idx.people[slug]?.tasksToken;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startTasksApi(api: CoreV1Api, namespace: string, port: number): Server {
  const server = createServer((req, res) => {
    void handle(api, namespace, req, res).catch((err) => {
      log.error('tasks_api_error', err, { path: req.url });
      sendJson(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, () => log.line('tasks_api_listening', { port }));
  return server;
}

async function handle(
  api: CoreV1Api,
  namespace: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');

  if (req.method === 'POST' && url.pathname === '/tasks') {
    const body = await readJsonBody<ScheduleTaskRequest>(req);
    if (!body.slug || !body.cron || !body.tz || !body.prompt) {
      sendJson(res, 400, { error: 'slug, cron, tz, prompt are required' });
      return;
    }
    const idx = await readPeopleIndex(api, namespace);
    if (!isAuthorized(idx, body.slug, req.headers.authorization)) {
      log.line('tasks_api_unauthorized', { slug: body.slug, method: 'POST' });
      sendJson(res, 403, { error: 'unauthorized' });
      return;
    }
    let nextRunAt: Date;
    try {
      nextRunAt = nextRunAfter(body.cron, body.tz, new Date());
    } catch (err) {
      sendJson(res, 400, { error: `invalid cron expression: ${err instanceof Error ? err.message : err}` });
      return;
    }
    const task = await addTask(api, namespace, body.slug, {
      cron: body.cron,
      tz: body.tz,
      prompt: body.prompt,
      nextRunAt: nextRunAt.toISOString(),
      ...(body.id ? { id: body.id } : {}),
    });
    log.line('task_scheduled', { person: body.slug, taskId: task.id, cron: task.cron });
    sendJson(res, 201, task);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/tasks') {
    const slug = url.searchParams.get('slug');
    if (!slug) {
      sendJson(res, 400, { error: 'slug query param is required' });
      return;
    }
    const idx = await readPeopleIndex(api, namespace);
    if (!isAuthorized(idx, slug, req.headers.authorization)) {
      log.line('tasks_api_unauthorized', { slug, method: 'GET' });
      sendJson(res, 403, { error: 'unauthorized' });
      return;
    }
    const state = await readPersonState(api, namespace, slug);
    sendJson(res, 200, { tasks: state?.tasks ?? [] });
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/tasks') {
    const body = await readJsonBody<CancelTaskRequest>(req);
    if (!body.slug || !body.taskId) {
      sendJson(res, 400, { error: 'slug and taskId are required' });
      return;
    }
    const idx = await readPeopleIndex(api, namespace);
    if (!isAuthorized(idx, body.slug, req.headers.authorization)) {
      log.line('tasks_api_unauthorized', { slug: body.slug, method: 'DELETE' });
      sendJson(res, 403, { error: 'unauthorized' });
      return;
    }
    const removed = await removeTask(api, namespace, body.slug, body.taskId);
    if (!removed) {
      sendJson(res, 404, { error: 'task not found' });
      return;
    }
    log.line('task_cancelled', { person: body.slug, taskId: body.taskId });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
