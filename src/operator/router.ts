/**
 * Steady-state routing (architecture doc section 1): known+active -> deliver
 * as a turn; unknown -> bootstrap (pending + holding reply + admin DM);
 * denied -> dropped silently. Admin DMs starting with a recognized command
 * are intercepted first.
 */
import { log } from '../shared/log.js';
import { tryHandleAdminCommand } from './admin-commands.js';
import { enqueueChatMessage } from './delivery.js';
import { findSlugByTelegramUserId, readPeopleIndex, recordPending, touchLastSeen } from './people-index.js';
import type { RouterDeps } from './router-deps.js';
import type { TelegramMessage, TelegramUpdate } from './telegram.js';

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
    await handleUnknownSender(deps, msg, telegramUserId);
    return;
  }
  const person = idx.people[slug];
  if (!person || person.status !== 'active') return;

  await touchLastSeen(deps.api, deps.cfg.namespace, slug);
  await enqueueChatMessage(deps.api, deps.cfg, slug, person.chatId, person.tz, update.update_id, {
    messageId: msg.message_id,
    text: msg.text ?? '',
    fromHandle: msg.from.username ? `@${msg.from.username}` : null,
    date: new Date(msg.date * 1000).toISOString(),
  });
}

async function handleUnknownSender(deps: RouterDeps, msg: TelegramMessage, telegramUserId: number): Promise<void> {
  const from = msg.from;
  if (!from) return;
  const handle = from.username ? `@${from.username}` : '(no username)';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || handle;
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
