/**
 * Steady-state routing (architecture doc section 1): known+active -> deliver
 * as a turn; unknown -> bootstrap (pending + holding reply + admin DM);
 * denied -> dropped silently. Admin DMs starting with a recognized command
 * are intercepted first.
 */
import type { ChatAttachment, ChatReplyTo, PersonIndexEntry } from '../shared/types.js';
import { log } from '../shared/log.js';
import { tryHandleAdminCommand } from './admin-commands.js';
import { enqueueChatMessage } from './delivery.js';
import { addStickerPack } from './nfs.js';
import { findSlugByTelegramUserId, readPeopleIndex, recordPending, touchLastSeen } from './people-index.js';
import { tryHandlePersonCommand } from './person-commands.js';
import { setToolPermission } from './person-state.js';
import { postControl } from './pod-control.js';
import { provisionPerson, slugifyForPerson, uniqueSlug } from './provisioning.js';
import type { RouterDeps } from './router-deps.js';
import type { TelegramCallbackQuery, TelegramMessage, TelegramSticker, TelegramUpdate } from './telegram.js';

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

// Keeps a quoted reply short — this is context for the model, not a full
// transcript of the original message (which it can still ask about/scroll
// to in its own conversation history if it's recent).
const REPLY_SNIPPET_MAX_LEN = 300;

/**
 * Telegram's native "reply" swipe/long-press — absent for an ordinary
 * (non-reply) message. Prefers `msg.quote` (Bot API 7.0+'s `TextQuote`,
 * confirmed live 2026-08-26 it's a sibling of `reply_to_message`, not
 * nested under it) when the person selected a specific substring before
 * replying — that's exactly what they meant to point at, more precise than
 * falling back to the *whole* original message's text.
 */
function extractReplyTo(msg: TelegramMessage): ChatReplyTo | undefined {
  const r = msg.reply_to_message;
  if (!r) return undefined;
  const raw = msg.quote?.text ?? r.text ?? r.caption ?? '';
  const snippet = raw.length > REPLY_SNIPPET_MAX_LEN ? `${raw.slice(0, REPLY_SNIPPET_MAX_LEN)}…` : raw;
  return { messageId: r.message_id, snippet, fromHandle: r.from?.username ? `@${r.from.username}` : null };
}

/**
 * A sticker the person sends the bot registers its whole pack (by
 * `set_name`) for `send_sticker`/`list_stickers` to use, instead of
 * becoming a turn — mirrors how `/set_var` etc. are intercepted before
 * `enqueueChatMessage`. This is the answer to "I don't know how to find a
 * sticker pack's id": just forward any sticker from it.
 */
async function handleIncomingSticker(
  deps: RouterDeps,
  slug: string,
  person: PersonIndexEntry,
  sticker: TelegramSticker,
): Promise<void> {
  const setName = sticker.set_name;
  if (!setName) {
    await deps.telegram.sendMessage(person.chatId, "Цей стікер не належить до жодного паку — не можу його додати.");
    return;
  }
  const { added } = await addStickerPack(slug, setName);
  await deps.telegram.sendMessage(
    person.chatId,
    added ? `Додав пак стікерів "${setName}" 🎉` : `Пак "${setName}" вже доданий.`,
  );
  log.line('sticker_pack_added', { person: slug, setName, added });
}

/**
 * `callback_data` is `pm:<requestId>:o|a|d` — see runner/telegram-send.ts's
 * `sendPermissionRequest` for where it's generated and shared/types.ts's
 * `permission_decision` ControlRequest for why it never carries the tool
 * name itself (Telegram's 64-byte callback_data cap).
 */
const PERMISSION_CALLBACK_RE = /^pm:([a-zA-Z0-9]+):(o|a|d)$/;
const DECISION_BY_CODE = { o: 'once', a: 'always', d: 'deny' } as const;

/**
 * Routes a permission-gate button tap to the pod that raised it. Every
 * pod/operator shares one bot token but only this process ever calls
 * `getUpdates` (architecture doc's "single getUpdates consumer" deviation),
 * so a tap always lands here first regardless of which pod sent the
 * original prompt — resolving `telegramUserId` -> `slug` the same way the
 * message path below does is what gets it back to the right one.
 */
async function routeCallbackQuery(deps: RouterDeps, cq: TelegramCallbackQuery): Promise<void> {
  const match = PERMISSION_CALLBACK_RE.exec(cq.data ?? '');
  if (!match) {
    await deps.telegram.answerCallbackQuery(cq.id);
    return;
  }
  const requestId = match[1] ?? '';
  const decision = DECISION_BY_CODE[match[2] as 'o' | 'a' | 'd'];

  const idx = await readPeopleIndex(deps.api, deps.cfg.namespace);
  const slug = findSlugByTelegramUserId(idx, cq.from.id);
  if (!slug) {
    await deps.telegram.answerCallbackQuery(cq.id, 'Not authorized.');
    return;
  }

  const result = await postControl(deps.api, deps.cfg, slug, { action: 'permission_decision', requestId, decision });
  const resolved = result?.ok === true && result.action === 'permission_decision' ? result : null;
  const applied = resolved?.applied ?? false;
  const toolName = resolved?.toolName;

  if (!applied) {
    await deps.telegram.answerCallbackQuery(cq.id, 'Request expired or already handled.');
  } else {
    if (decision === 'always' && toolName) {
      await setToolPermission(deps.api, deps.cfg.namespace, slug, toolName);
    }
    const label = decision === 'once' ? '✅ Allowed once' : decision === 'always' ? '⭐ Always allowed' : '❌ Denied';
    await deps.telegram.answerCallbackQuery(cq.id, label);
  }

  const original = cq.message;
  if (original?.text) {
    const suffix = applied ? (decision === 'once' ? '✅ Allowed once' : decision === 'always' ? '⭐ Always allowed' : '❌ Denied') : '⚠️ Expired or already handled';
    await deps.telegram.editMessageText(original.chat.id, original.message_id, `${original.text}\n\n${suffix}`);
  }

  log.line('permission_decision_routed', { person: slug, requestId, decision, applied });
}

export type { RouterDeps } from './router-deps.js';

export async function routeUpdate(deps: RouterDeps, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await routeCallbackQuery(deps, update.callback_query);
    return;
  }

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

  if (msg.sticker) {
    await handleIncomingSticker(deps, slug, person, msg.sticker);
    return;
  }

  const handled = await tryHandlePersonCommand(deps, slug, person, msg.text ?? '', update.update_id);
  if (handled) return;

  await touchLastSeen(deps.api, deps.cfg.namespace, slug);
  await enqueueChatMessage(deps.api, deps.cfg, slug, person.chatId, person.tz, person.tasksToken, update.update_id, {
    messageId: msg.message_id,
    text: msg.text ?? msg.caption ?? '',
    fromHandle: msg.from.username ? `@${msg.from.username}` : null,
    date: new Date(msg.date * 1000).toISOString(),
    attachments: extractAttachments(msg),
    replyTo: extractReplyTo(msg),
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
    replyTo: extractReplyTo(msg),
  });
  log.line('person_auto_approved', { person: slug, telegramUserId });
}
