/**
 * pan-agent-people — the routing index (architecture doc section 4). One
 * ConfigMap, small, bounded. Seeded lazily by the operator on first read;
 * never written to git (section 8: "seed it only if absent via operator").
 */
import { randomBytes } from 'node:crypto';

import type { CoreV1Api } from '@kubernetes/client-node';

import { emptyPeopleIndex, type PeopleIndex, type PersonIndexEntry } from '../shared/types.js';
import { createJsonConfigMap, readJsonConfigMap, updateJsonConfigMap } from './k8s.js';

export const PEOPLE_CM_NAME = 'pan-agent-people';
const DATA_KEY = 'people.json';

export async function ensurePeopleIndex(api: CoreV1Api, namespace: string): Promise<PeopleIndex> {
  const existing = await readJsonConfigMap<PeopleIndex>(api, namespace, PEOPLE_CM_NAME, DATA_KEY);
  if (existing) return existing.value;
  try {
    const created = await createJsonConfigMap(api, namespace, PEOPLE_CM_NAME, DATA_KEY, emptyPeopleIndex());
    return created.value;
  } catch {
    // Lost a create race (e.g. two boots at once) — the other write won, read it.
    const retried = await readJsonConfigMap<PeopleIndex>(api, namespace, PEOPLE_CM_NAME, DATA_KEY);
    if (retried) return retried.value;
    throw new Error(`Failed to create or read ${PEOPLE_CM_NAME}`);
  }
}

export async function readPeopleIndex(api: CoreV1Api, namespace: string): Promise<PeopleIndex> {
  return ensurePeopleIndex(api, namespace);
}

export async function mutatePeopleIndex(
  api: CoreV1Api,
  namespace: string,
  mutate: (idx: PeopleIndex) => PeopleIndex,
): Promise<PeopleIndex> {
  return updateJsonConfigMap(api, namespace, PEOPLE_CM_NAME, DATA_KEY, emptyPeopleIndex, mutate);
}

export function findSlugByTelegramUserId(idx: PeopleIndex, telegramUserId: number): string | null {
  for (const [slug, entry] of Object.entries(idx.people)) {
    if (entry.telegramUserId === telegramUserId) return slug;
  }
  return null;
}

export async function recordPending(
  api: CoreV1Api,
  namespace: string,
  telegramUserId: number,
  handle: string,
  name: string,
  firstMessage: string,
): Promise<PeopleIndex> {
  return mutatePeopleIndex(api, namespace, (idx) => {
    idx.pending[String(telegramUserId)] = { handle, name, firstMessage, firstSeenAt: new Date().toISOString() };
    return idx;
  });
}

/** DM chat_id equals the Telegram user id for private chats. */
export async function approvePerson(
  api: CoreV1Api,
  namespace: string,
  slug: string,
  telegramUserId: number,
  tz = 'Europe/Warsaw',
): Promise<{ idx: PeopleIndex; entry: PersonIndexEntry }> {
  let entry!: PersonIndexEntry;
  const idx = await mutatePeopleIndex(api, namespace, (idx) => {
    const now = new Date().toISOString();
    // Reuse the existing token on re-approval (e.g. /restart doesn't call this, but a
    // second /approve for the same slug shouldn't invalidate an already-running pod's token).
    const tasksToken = idx.people[slug]?.tasksToken ?? randomBytes(32).toString('hex');
    entry = {
      telegramUserId,
      chatId: telegramUserId,
      status: 'active',
      tz,
      createdAt: now,
      lastSeenAt: now,
      tasksToken,
    };
    idx.people[slug] = entry;
    delete idx.pending[String(telegramUserId)];
    delete idx.denied[String(telegramUserId)];
    return idx;
  });
  return { idx, entry };
}

export async function denyPerson(api: CoreV1Api, namespace: string, telegramUserId: number): Promise<PeopleIndex> {
  return mutatePeopleIndex(api, namespace, (idx) => {
    idx.denied[String(telegramUserId)] = { deniedAt: new Date().toISOString() };
    delete idx.pending[String(telegramUserId)];
    return idx;
  });
}

export async function touchLastSeen(api: CoreV1Api, namespace: string, slug: string): Promise<void> {
  await mutatePeopleIndex(api, namespace, (idx) => {
    const entry = idx.people[slug];
    if (entry) entry.lastSeenAt = new Date().toISOString();
    return idx;
  });
}
