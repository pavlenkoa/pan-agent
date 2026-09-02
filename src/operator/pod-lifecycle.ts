import type { CoreV1Api } from '@kubernetes/client-node';

import { log } from '../shared/log.js';
import type { OperatorConfig } from './config.js';
import { createPod, deletePod, getPod, isPodReady } from './k8s.js';
import { ensurePersonHomeDirs } from './nfs.js';
import { readPersonState } from './person-state.js';
import { buildPersonPodSpec, podName } from './pod-template.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create the pod if it doesn't already exist. Idempotent. */
export async function ensurePersonPod(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
): Promise<void> {
  const existing = await getPod(api, cfg.namespace, podName(slug));
  if (existing) return;
  await ensurePersonHomeDirs(slug);
  const state = await readPersonState(api, cfg.namespace, slug);
  const spec = buildPersonPodSpec(cfg, slug, chatId, tz, tasksToken, state?.customEnv ?? {}, state?.toolPermissions ?? {});
  await createPod(api, cfg.namespace, spec);
  log.line('pod_created', { person: slug });
}

export async function waitForPodReady(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const name = podName(slug);
  while (Date.now() < deadline) {
    const pod = await getPod(api, namespace, name);
    if (pod && isPodReady(pod)) return true;
    await sleep(2000);
  }
  return false;
}

export async function podIp(api: CoreV1Api, namespace: string, slug: string): Promise<string | null> {
  const pod = await getPod(api, namespace, podName(slug));
  return pod?.status?.podIP ?? null;
}

export async function podExists(api: CoreV1Api, namespace: string, slug: string): Promise<boolean> {
  return (await getPod(api, namespace, podName(slug))) !== null;
}

/** Tears down a person's running pod without touching their PersonState ConfigMap — used by /deny. */
export async function removePersonPod(api: CoreV1Api, namespace: string, slug: string): Promise<void> {
  await deletePod(api, namespace, podName(slug));
  log.line('pod_removed', { person: slug });
}

export async function recreatePod(
  api: CoreV1Api,
  cfg: OperatorConfig,
  slug: string,
  chatId: number,
  tz: string,
  tasksToken: string,
): Promise<void> {
  await deletePod(api, cfg.namespace, podName(slug));
  await waitForPodGone(api, cfg.namespace, slug);
  await ensurePersonPod(api, cfg, slug, chatId, tz, tasksToken);
  log.line('pod_recreated', { person: slug });
}

async function waitForPodGone(api: CoreV1Api, namespace: string, slug: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const name = podName(slug);
  while (Date.now() < deadline) {
    const pod = await getPod(api, namespace, name);
    if (!pod) return;
    await sleep(1000);
  }
}
