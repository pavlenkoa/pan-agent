/**
 * Turn a telegram user id + slug into an active person with a running pod —
 * shared by the admin's /approve command and the allowlist auto-approve path
 * (router.ts).
 */
import type { PeopleIndex, PersonIndexEntry } from '../shared/types.js';
import { approvePerson } from './people-index.js';
import { ensurePersonPod, waitForPodReady } from './pod-lifecycle.js';
import { ensurePersonState } from './person-state.js';
import type { RouterDeps } from './router-deps.js';

export async function provisionPerson(
  deps: RouterDeps,
  slug: string,
  telegramUserId: number,
  displayName: string,
): Promise<{ entry: PersonIndexEntry; ready: boolean }> {
  const { entry } = await approvePerson(deps.api, deps.cfg.namespace, slug, telegramUserId, deps.cfg.defaultTz);
  await ensurePersonState(deps.api, deps.cfg.namespace, slug, displayName);
  await ensurePersonPod(deps.api, deps.cfg, slug, entry.chatId, entry.tz, entry.tasksToken);
  const ready = await waitForPodReady(deps.api, deps.cfg.namespace, slug, deps.cfg.podReadyTimeoutMs);
  return { entry, ready };
}

/**
 * Best-effort slug from a Telegram display name (used only for the allowlist
 * auto-approve path; matches admin-commands.ts's SLUG_RE). Falls back to
 * `person-<id>` when nothing Latin/numeric survives — e.g. a Cyrillic-only
 * name, which NFKD diacritic-stripping doesn't transliterate.
 */
export function slugifyForPerson(name: string, telegramUserId: number): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return `person-${telegramUserId}`;
  return /^[a-z]/.test(cleaned) ? cleaned : `p-${cleaned}`;
}

/** Disambiguate against existing slugs by appending the last 4 digits of the telegram id, then the full id. */
export function uniqueSlug(idx: PeopleIndex, base: string, telegramUserId: number): string {
  if (!idx.people[base]) return base;
  const short = `${base}-${String(telegramUserId).slice(-4)}`;
  if (!idx.people[short]) return short;
  return `${base}-${telegramUserId}`;
}
