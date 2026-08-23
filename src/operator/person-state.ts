/**
 * pan-agent-person-<slug> — everything per-person besides routing (profile,
 * tasks, runtime cursors). Architecture doc section 4.
 */
import { randomUUID } from 'node:crypto';

import type { CoreV1Api } from '@kubernetes/client-node';

import { emptyPersonState, type CustomEnvVar, type PersonState, type TaskRecord } from '../shared/types.js';
import { createJsonConfigMap, readJsonConfigMap, updateJsonConfigMap } from './k8s.js';

const DATA_KEY = 'state.json';

export function personConfigMapName(slug: string): string {
  return `pan-agent-person-${slug}`;
}

function personLabels(slug: string): Record<string, string> {
  return { 'app.kubernetes.io/name': 'pan-agent', 'pan-agent.pavlenko.io/person': slug };
}

/** Backfills fields added after a person's state ConfigMap was first created (e.g. customEnv). */
function normalizePersonState(state: PersonState): PersonState {
  return { ...state, customEnv: state.customEnv ?? {} };
}

export async function ensurePersonState(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  displayName: string,
): Promise<PersonState> {
  const name = personConfigMapName(slug);
  const existing = await readJsonConfigMap<PersonState>(api, namespace, name, DATA_KEY);
  if (existing) return normalizePersonState(existing.value);
  const created = await createJsonConfigMap(
    api,
    namespace,
    name,
    DATA_KEY,
    emptyPersonState(displayName),
    personLabels(slug),
  );
  return created.value;
}

export async function readPersonState(api: CoreV1Api, namespace: string, slug: string): Promise<PersonState | null> {
  const existing = await readJsonConfigMap<PersonState>(api, namespace, personConfigMapName(slug), DATA_KEY);
  return existing ? normalizePersonState(existing.value) : null;
}

export async function mutatePersonState(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  displayNameForDefault: string,
  mutate: (state: PersonState) => PersonState,
): Promise<PersonState> {
  return updateJsonConfigMap(
    api,
    namespace,
    personConfigMapName(slug),
    DATA_KEY,
    () => emptyPersonState(displayNameForDefault),
    (state) => mutate(normalizePersonState(state)),
    personLabels(slug),
  );
}

export async function markUpdateDelivered(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  updateId: number,
): Promise<void> {
  await mutatePersonState(api, namespace, slug, slug, (state) => {
    state.runtime.lastDeliveredUpdateId = updateId;
    return state;
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface NewTask {
  cron: string;
  tz: string;
  prompt: string;
  nextRunAt: string;
  id?: string;
}

export async function addTask(api: CoreV1Api, namespace: string, slug: string, task: NewTask): Promise<TaskRecord> {
  const id = task.id ?? randomUUID();
  let created!: TaskRecord;
  await mutatePersonState(api, namespace, slug, slug, (state) => {
    created = {
      id,
      cron: task.cron,
      tz: task.tz,
      prompt: task.prompt,
      nextRunAt: task.nextRunAt,
      lastRunAt: null,
      lastStatus: null,
      paused: false,
      createdAt: new Date().toISOString(),
    };
    state.tasks = [...state.tasks.filter((t) => t.id !== id), created];
    return state;
  });
  return created;
}

export async function removeTask(api: CoreV1Api, namespace: string, slug: string, taskId: string): Promise<boolean> {
  let removed = false;
  await mutatePersonState(api, namespace, slug, slug, (state) => {
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((t) => t.id !== taskId);
    removed = state.tasks.length < before;
    return state;
  });
  return removed;
}

export async function recordTaskFired(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  taskId: string,
  nextRunAt: string,
  status: 'ok' | 'error',
): Promise<void> {
  await mutatePersonState(api, namespace, slug, slug, (state) => {
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? { ...t, lastRunAt: new Date().toISOString(), lastStatus: status, nextRunAt } : t,
    );
    return state;
  });
}

/** A too-far-overdue occurrence was skipped (catch-up window exceeded) — advance nextRunAt without touching lastRunAt. */
export async function recordTaskSkipped(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  taskId: string,
  nextRunAt: string,
): Promise<void> {
  await mutatePersonState(api, namespace, slug, slug, (state) => {
    state.tasks = state.tasks.map((t) => (t.id === taskId ? { ...t, lastStatus: 'skipped', nextRunAt } : t));
    return state;
  });
}

// ---------------------------------------------------------------------------
// Custom env vars (/set_var) — a person's own vars for their own pod only.
// ---------------------------------------------------------------------------

export async function setCustomEnvVar(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  key: string,
  value: string,
  description: string,
): Promise<void> {
  const entry: CustomEnvVar = { value, description, setAt: new Date().toISOString() };
  await mutatePersonState(api, namespace, slug, slug, (state) => {
    state.customEnv = { ...state.customEnv, [key]: entry };
    return state;
  });
}

export async function removeCustomEnvVar(api: CoreV1Api, namespace: string, slug: string, key: string): Promise<boolean> {
  let removed = false;
  await mutatePersonState(api, namespace, slug, slug, (state) => {
    if (!(key in state.customEnv)) return state;
    removed = true;
    const { [key]: _omit, ...rest } = state.customEnv;
    state.customEnv = rest;
    return state;
  });
  return removed;
}
