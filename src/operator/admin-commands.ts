/**
 * Admin commands intercepted from the admin's own DM, before routing
 * (architecture doc section 1: bootstrap flow, and section 2's admin
 * commands table). Everything else from the admin routes as a normal turn
 * to the admin's own person-pod — the admin is also a tenant.
 */
import { log } from '../shared/log.js';
import { clearCommandsFor } from './bot-commands.js';
import { enqueueChatMessage } from './delivery.js';
import { denyPerson, findSlugByTelegramUserId, readPeopleIndex } from './people-index.js';
import { recreatePod, removePersonPod } from './pod-lifecycle.js';
import { provisionPerson } from './provisioning.js';
import type { RouterDeps } from './router-deps.js';
import type { TelegramUpdate } from './telegram.js';

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** Returns true if `text` was a recognized admin command (handled either way). */
export async function tryHandleAdminCommand(
  deps: RouterDeps,
  text: string,
  update: TelegramUpdate,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const [cmd, ...args] = trimmed.split(/\s+/);
  switch (cmd) {
    case '/approve':
      await handleApprove(deps, args, update);
      return true;
    case '/deny':
      await handleDeny(deps, args);
      return true;
    case '/people':
      await handlePeople(deps);
      return true;
    case '/restart':
      await handleRestart(deps, args);
      return true;
    default:
      return false;
  }
}

async function handleApprove(deps: RouterDeps, args: string[], update: TelegramUpdate): Promise<void> {
  const admin = deps.cfg.telegramAdminChatId;
  const [slug, idStr] = args;
  if (!slug || !idStr || !SLUG_RE.test(slug)) {
    await deps.telegram.sendMessage(admin, 'Usage: /approve <slug> <telegramUserId> (slug: a-z0-9-, starting with a letter)');
    return;
  }
  const telegramUserId = Number(idStr);
  if (!Number.isFinite(telegramUserId)) {
    await deps.telegram.sendMessage(admin, `Not a valid telegram user id: ${idStr}`);
    return;
  }

  const before = await readPeopleIndex(deps.api, deps.cfg.namespace);
  const pending = before.pending[idStr];

  const { entry, ready } = await provisionPerson(deps, slug, telegramUserId, pending?.name ?? slug);
  await deps.telegram.sendMessage(
    admin,
    ready ? `${slug} approved and running.` : `${slug} approved, pod created, but not ready yet — check kubectl.`,
  );

  if (pending?.firstMessage) {
    await enqueueChatMessage(deps.api, deps.cfg, slug, entry.chatId, entry.tz, entry.tasksToken, update.update_id, {
      messageId: 0,
      text: pending.firstMessage,
      fromHandle: pending.handle,
      date: pending.firstSeenAt,
    });
  }
  log.line('person_approved', { person: slug, telegramUserId });
}

async function handleDeny(deps: RouterDeps, args: string[]): Promise<void> {
  const admin = deps.cfg.telegramAdminChatId;
  const [idStr] = args;
  const telegramUserId = Number(idStr);
  if (!idStr || !Number.isFinite(telegramUserId)) {
    await deps.telegram.sendMessage(admin, 'Usage: /deny <telegramUserId>');
    return;
  }
  const idx = await denyPerson(deps.api, deps.cfg.namespace, telegramUserId);
  const slug = findSlugByTelegramUserId(idx, telegramUserId);
  if (slug) await removePersonPod(deps.api, deps.cfg.namespace, slug);
  // DM chat_id equals the Telegram user id for private chats — clears the
  // `/` popup immediately rather than waiting for the next operator boot's
  // backfill (index.ts) to catch it.
  await clearCommandsFor(deps.telegram, telegramUserId, telegramUserId);
  await deps.telegram.sendMessage(
    admin,
    slug ? `Denied ${telegramUserId} and removed pod for ${slug} (state kept for a future /approve).` : `Denied ${telegramUserId}.`,
  );
  log.line('person_denied', { telegramUserId, slug });
}

async function handlePeople(deps: RouterDeps): Promise<void> {
  const idx = await readPeopleIndex(deps.api, deps.cfg.namespace);
  const lines: string[] = [];
  for (const [slug, p] of Object.entries(idx.people)) {
    lines.push(`${slug}: ${p.status} (tg:${p.telegramUserId}, last seen ${p.lastSeenAt})`);
  }
  for (const [id, p] of Object.entries(idx.pending)) {
    lines.push(`pending ${id}: ${p.handle} — "${p.firstMessage}"`);
  }
  for (const id of Object.keys(idx.denied)) {
    lines.push(`denied ${id}`);
  }
  await deps.telegram.sendMessage(deps.cfg.telegramAdminChatId, lines.length ? lines.join('\n') : 'No people yet.');
}

async function handleRestart(deps: RouterDeps, args: string[]): Promise<void> {
  const admin = deps.cfg.telegramAdminChatId;
  const [slug] = args;
  if (!slug) {
    await deps.telegram.sendMessage(admin, 'Usage: /restart <slug>');
    return;
  }
  const idx = await readPeopleIndex(deps.api, deps.cfg.namespace);
  const person = idx.people[slug];
  if (!person) {
    await deps.telegram.sendMessage(admin, `Unknown person ${slug}.`);
    return;
  }
  await recreatePod(deps.api, deps.cfg, slug, person.chatId, person.tz, person.tasksToken);
  await deps.telegram.sendMessage(admin, `Restarted ${slug}.`);
}
