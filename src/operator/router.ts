/**
 * Steady-state routing (architecture doc section 1): known+active -> deliver
 * as a turn; unknown -> bootstrap (pending + holding reply + admin DM);
 * denied -> dropped silently. Admin DMs starting with a recognized command
 * are intercepted first.
 */
import type { ChatAttachment } from '../shared/types.js';
import { log } from '../shared/log.js';
import { tryHandleAdminCommand } from './admin-commands.js';
import { enqueueChatMessage } from './delivery.js';
import { findSlugByTelegramUserId, readPeopleIndex, recordPending, touchLastSeen } from './people-index.js';
import { tryHandlePersonCommand } from './person-commands.js';
import { provisionPerson, slugifyForPerson, uniqueSlug } from './provisioning.js';
import type { RouterDeps } from './router-deps.js';
import type { TelegramMessage, TelegramUpdate } from './telegram.js';

/** Largest photo size is last in Telegram's array; documents pass through as-is. */
function extractAttachments(msg: TelegramMessage): ChatAttachment[] | undefined {
  const attachments: ChatAttachment[] = [];
  const photo = msg.photo?.at(-1);
  if (photo) attachments.push({ kind: 'photo', fileId: photo.file_id, fileName: null, mimeType: null });
  if (msg.document) {
    attachments.push({
      kind: 'document',
      fileId: msg.document.file_id,
      fileName: msg.document.file_name ?? null,
      mimeType: msg.document.mime_type ?? null,
    });
  }
  return attachments.length > 0 ? attachments : undefined;
}

export type { RouterDeps } from './router-deps.js';

export async function routeUpdate(deps: RouterDeps, update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.from || msg.chat.type !== 'private') return; // DM-only, non-message updates dropped (v1)

  const telegramUserId = msg.from.id;

  if (telegramUserId === deps.cfg.telegramAdminChatId) {
    const handled = await tryHandleAdminCommand(deps, msg.text ?? '', update);
    if (handled) return;
  }

  const idx = await readPeopleIndex(deps.api, deps.cfg.namespace);
  if (idx.denied[String(telegramUserId)]) return;

  const slug = findSlugByTelegramUserId(idx, telegramUserId);
  if (!slug) {
    await handleUnknownSender(deps, msg, update, telegramUserId);
    return;
  }
  const person = idx.people[slug];
  if (!person || person.status !== 'active') return;

  const handled = await tryHandlePersonCommand(deps, slug, person, msg.text ?? '');
  if (handled) return;

  await touchLastSeen(deps.api, deps.cfg.namespace, slug);
  await enqueueChatMessage(deps.api, deps.cfg, slug, person.chatId, person.tz, person.tasksToken, update.update_id, {
    messageId: msg.message_id,
    text: msg.text ?? msg.caption ?? '',
    fromHandle: msg.from.username ? `@${msg.from.username}` : null,
    date: new Date(msg.date * 1000).toISOString(),
    attachments: extractAttachments(msg),
  });
}

async function handleUnknownSender(
  deps: RouterDeps,
  msg: TelegramMessage,
  update: TelegramUpdate,
  telegramUserId: number,
): Promise<void> {
  const from = msg.from;
  if (!from) return;
  const handle = from.username ? `@${from.username}` : '(no username)';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || handle;

  if (deps.cfg.telegramAllowedIds.includes(telegramUserId)) {
    await autoApprove(deps, msg, update, telegramUserId, handle, name);
    return;
  }

  await recordPending(deps.api, deps.cfg.namespace, telegramUserId, handle, name, msg.text ?? '');
  await deps.telegram.sendMessage(
    telegramUserId,
    'Мене ще не познайомили з вами — чекаю на підтвердження адміністратора.',
  );
  await deps.telegram.sendMessage(
    deps.cfg.telegramAdminChatId,
    `Unknown sender ${handle} (${telegramUserId}): "${msg.text ?? ''}"\n/approve <slug> ${telegramUserId} | /deny ${telegramUserId}`,
  );
  log.line('unknown_sender', { telegramUserId, handle });
}

/** telegramUserId is in TELEGRAM_ALLOWED_IDS — skip pending/approve, provision immediately. */
async function autoApprove(
  deps: RouterDeps,
  msg: TelegramMessage,
  update: TelegramUpdate,
  telegramUserId: number,
  handle: string,
  name: string,
): Promise<void> {
  const idx = await readPeopleIndex(deps.api, deps.cfg.namespace);
  const slug = uniqueSlug(idx, slugifyForPerson(name, telegramUserId), telegramUserId);
  const { entry, ready } = await provisionPerson(deps, slug, telegramUserId, name);
  await deps.telegram.sendMessage(
    deps.cfg.telegramAdminChatId,
    ready
      ? `Auto-approved ${handle} (${telegramUserId}) as ${slug}.`
      : `Auto-approved ${handle} (${telegramUserId}) as ${slug}, but pod not ready yet — check kubectl.`,
  );
  await enqueueChatMessage(deps.api, deps.cfg, slug, entry.chatId, entry.tz, entry.tasksToken, update.update_id, {
    messageId: msg.message_id,
    text: msg.text ?? msg.caption ?? '',
    fromHandle: msg.from?.username ? `@${msg.from.username}` : null,
    date: new Date(msg.date * 1000).toISOString(),
    attachments: extractAttachments(msg),
  });
  log.line('person_auto_approved', { person: slug, telegramUserId });
}
