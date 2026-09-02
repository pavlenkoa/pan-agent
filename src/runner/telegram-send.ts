/**
 * Direct egress (architecture doc's deliberate deviation): the runner talks
 * to api.telegram.org itself, so a wedged operator can't eat an in-flight
 * reply.
 */
import { log } from '../shared/log.js';
import { markdownToTelegramHtml } from './telegram-format.js';

const TELEGRAM_MAX_LEN = 4000;

export function chunkText(text: string, maxLen = TELEGRAM_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

type SendResult = { ok: boolean; description?: string };

/**
 * `markdownToTelegramHtml` is a best-effort regex converter, not a real
 * parser, so Telegram rejecting a request with a 400 "can't parse entities"
 * on malformed/misnested tags is a real possibility. Try the HTML-formatted
 * attempt first and fall back to the plain one on exactly that failure, so a
 * converter bug degrades to "looks like the old literal-markdown bug"
 * instead of losing the message/caption outright. Shared by every send path
 * below (text messages, document/photo captions, media-group captions).
 */
async function withHtmlFallback(
  method: string,
  chatId: number,
  attemptWithHtml: () => Promise<SendResult>,
  attemptPlain: () => Promise<SendResult>,
): Promise<void> {
  const formatted = await attemptWithHtml();
  if (formatted.ok) return;
  log.error('telegram_html_send_failed', new Error(formatted.description ?? 'unknown'), { chatId, method });
  const plain = await attemptPlain();
  if (!plain.ok) throw new Error(`${method} failed: ${plain.description ?? 'unknown'}`);
}

async function postSendMessage(token: string, chatId: number, text: string, parseMode?: 'HTML'): Promise<SendResult> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as SendResult;
}

async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  await withHtmlFallback(
    'sendMessage',
    chatId,
    () => postSendMessage(token, chatId, markdownToTelegramHtml(text), 'HTML'),
    () => postSendMessage(token, chatId, text),
  );
}

export async function sendTelegramReply(token: string, chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  for (const chunk of chunkText(trimmed)) {
    await sendMessage(token, chatId, chunk);
  }
}

/**
 * The Telegram side of the permission gate (runner/permission-gate.ts): a
 * plain-text message (no `parse_mode` — the tool `input` preview can
 * contain arbitrary characters, e.g. raw email HTML for an eSputnik call,
 * that would need careful escaping under HTML parse mode) with an inline
 * keyboard. `callback_data` deliberately carries only `requestId` + a
 * one-letter decision code, never the tool name — see shared/types.ts's
 * `permission_decision` ControlRequest doc comment for why. Not chunked
 * like `sendTelegramReply`: the caller already bounds `inputPreview`'s
 * length, and a multi-message split would only attach the buttons to one
 * of the parts.
 */
export async function sendPermissionRequest(
  token: string,
  chatId: number,
  requestId: string,
  toolLabel: string,
  inputPreview: string,
): Promise<void> {
  const text = `🔐 Permission request\n\nTool: ${toolLabel}\nInput:\n${inputPreview}`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '✅ Allow once', callback_data: `pm:${requestId}:o` },
        { text: '⭐ Always allow', callback_data: `pm:${requestId}:a` },
        { text: '❌ Deny', callback_data: `pm:${requestId}:d` },
      ],
    ],
  };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await res.json()) as SendResult;
  if (!result.ok) throw new Error(`sendMessage (permission request) failed: ${result.description ?? 'unknown'}`);
}

// Telegram's own cap on bot-uploaded files (multipart, not a local Bot API server).
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function postUpload(
  token: string,
  method: 'sendDocument' | 'sendPhoto',
  field: 'document' | 'photo',
  chatId: number,
  fileName: string,
  bytes: Buffer,
  caption?: string,
  parseMode?: 'HTML',
): Promise<SendResult> {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (caption) form.set('caption', caption);
  if (parseMode) form.set('parse_mode', parseMode);
  form.set(field, new Blob([bytes]), fileName);

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  return (await res.json()) as SendResult;
}

async function uploadFile(
  token: string,
  method: 'sendDocument' | 'sendPhoto',
  field: 'document' | 'photo',
  chatId: number,
  fileName: string,
  bytes: Buffer,
  caption?: string,
): Promise<void> {
  if (!caption) {
    const result = await postUpload(token, method, field, chatId, fileName, bytes);
    if (!result.ok) throw new Error(`${method} failed: ${result.description ?? 'unknown'}`);
    return;
  }
  await withHtmlFallback(
    method,
    chatId,
    () => postUpload(token, method, field, chatId, fileName, bytes, markdownToTelegramHtml(caption), 'HTML'),
    () => postUpload(token, method, field, chatId, fileName, bytes, caption),
  );
}

export async function sendTelegramDocument(
  token: string,
  chatId: number,
  fileName: string,
  bytes: Buffer,
  caption?: string,
): Promise<void> {
  await uploadFile(token, 'sendDocument', 'document', chatId, fileName, bytes, caption);
}

export async function sendTelegramPhoto(
  token: string,
  chatId: number,
  fileName: string,
  bytes: Buffer,
  caption?: string,
): Promise<void> {
  await uploadFile(token, 'sendPhoto', 'photo', chatId, fileName, bytes, caption);
}

export async function sendTelegramSticker(token: string, chatId: number, fileId: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendSticker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, sticker: fileId }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await res.json()) as SendResult;
  if (!result.ok) throw new Error(`sendSticker failed: ${result.description ?? 'unknown'}`);
}

/**
 * `reaction: []` clears an existing reaction — not currently exposed to the
 * model (only ever called with one emoji), but that's what an empty array
 * means to this endpoint if a future caller wants it.
 */
export async function setTelegramMessageReaction(token: string, chatId: number, messageId: number, emoji: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await res.json()) as SendResult;
  if (!result.ok) throw new Error(`setMessageReaction failed: ${result.description ?? 'unknown'}`);
}

export interface TelegramStickerInfo {
  fileId: string;
  emoji: string;
}

/** A pack's sticker list is effectively static once published — callers are expected to cache this, not call it per-message. */
export async function getTelegramStickerSet(token: string, setName: string): Promise<TelegramStickerInfo[]> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getStickerSet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: setName }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { ok: boolean; description?: string; result?: { stickers: { file_id: string; emoji?: string }[] } };
  if (!data.ok || !data.result) throw new Error(`getStickerSet failed: ${data.description ?? 'unknown'}`);
  return data.result.stickers.map((s) => ({ fileId: s.file_id, emoji: s.emoji ?? '' }));
}

export interface MediaGroupItem {
  fileName: string;
  bytes: Buffer;
  asPhoto?: boolean;
}

async function postMediaGroup(
  token: string,
  chatId: number,
  items: MediaGroupItem[],
  caption?: string,
  parseMode?: 'HTML',
): Promise<SendResult> {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  const media = items.map((item, i) => ({
    type: item.asPhoto ? 'photo' : 'document',
    media: `attach://file${i}`,
    ...(i === 0 && caption ? { caption, ...(parseMode ? { parse_mode: parseMode } : {}) } : {}),
  }));
  form.set('media', JSON.stringify(media));
  items.forEach((item, i) => form.set(`file${i}`, new Blob([item.bytes]), item.fileName));

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  return (await res.json()) as SendResult;
}

/**
 * Sends 2-10 files as one Telegram album (sendMediaGroup) — they land as a
 * single grouped message instead of N separate ones. Telegram only accepts
 * a caption on the first item of the group.
 */
export async function sendTelegramMediaGroup(
  token: string,
  chatId: number,
  items: MediaGroupItem[],
  caption?: string,
): Promise<void> {
  if (items.length < 2 || items.length > 10) {
    throw new Error(`sendMediaGroup needs 2-10 items, got ${items.length}`);
  }
  if (!caption) {
    const result = await postMediaGroup(token, chatId, items);
    if (!result.ok) throw new Error(`sendMediaGroup failed: ${result.description ?? 'unknown'}`);
    return;
  }
  await withHtmlFallback(
    'sendMediaGroup',
    chatId,
    () => postMediaGroup(token, chatId, items, markdownToTelegramHtml(caption), 'HTML'),
    () => postMediaGroup(token, chatId, items, caption),
  );
}
