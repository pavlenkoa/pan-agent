/**
 * Boot reconcile (architecture doc section 2, "Restart behavior"): the
 * operator is stateless between events, so on every boot it rebuilds its
 * world from the ConfigMap index rather than trusting memory. Index is
 * intent, pod list is actual — diff them.
 */
import type { CoreV1Api } from '@kubernetes/client-node';

import { log } from '../shared/log.js';
import type { OperatorConfig } from './config.js';
import { deletePod, listPersonPods } from './k8s.js';
import { ensureTrackingDir } from './nfs.js';
import { ensurePeopleIndex } from './people-index.js';
import { ensurePersonPod } from './pod-lifecycle.js';

const PERSON_LABEL = 'pan-agent.pavlenko.io/person';

export async function bootReconcile(api: CoreV1Api, cfg: OperatorConfig): Promise<void> {
  const idx = await ensurePeopleIndex(api, cfg.namespace);
  await ensureTrackingDir();

  const pods = await listPersonPods(api, cfg.namespace);
  const podSlugs = new Map<string, string>(); // slug -> pod name
  for (const pod of pods) {
    const slug = pod.metadata?.labels?.[PERSON_LABEL];
    const name = pod.metadata?.name;
    if (slug && name) podSlugs.set(slug, name);
  }

  const activeSlugs = new Set(
    Object.entries(idx.people)
      .filter(([, p]) => p.status === 'active')
      .map(([slug]) => slug),
  );

  for (const [slug, person] of Object.entries(idx.people)) {
    if (person.status !== 'active') continue;
    if (podSlugs.has(slug)) continue;
    log.line('reconcile_creating_pod', { person: slug });
    await ensurePersonPod(api, cfg, slug, person.chatId, person.tz);
  }

  for (const [slug, podName] of podSlugs) {
    if (activeSlugs.has(slug)) continue;
    log.line('reconcile_deleting_orphan_pod', { person: slug, pod: podName });
    await deletePod(api, cfg.namespace, podName);
  }

  log.line('reconcile_done', { activePeople: activeSlugs.size, existingPods: pods.length });
}
