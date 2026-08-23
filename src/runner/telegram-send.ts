/**
 * Direct egress (architecture doc's deliberate deviation): the runner talks
 * to api.telegram.org itself, so a wedged operator can't eat an in-flight
 * reply.
 */
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

async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`sendMessage failed: ${data.description ?? res.status}`);
}

export async function sendTelegramReply(token: string, chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  for (const chunk of chunkText(trimmed)) {
    await sendMessage(token, chatId, chunk);
  }
}

// Telegram's own cap on bot-uploaded files (multipart, not a local Bot API server).
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function uploadFile(
  token: string,
  method: 'sendDocument' | 'sendPhoto',
  field: 'document' | 'photo',
  chatId: number,
  fileName: string,
  bytes: Buffer,
  caption?: string,
): Promise<void> {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (caption) form.set('caption', caption);
  form.set(field, new Blob([bytes]), fileName);

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`${method} failed: ${data.description ?? res.status}`);
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

export interface MediaGroupItem {
  fileName: string;
  bytes: Buffer;
  asPhoto?: boolean;
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

  const form = new FormData();
  form.set('chat_id', String(chatId));
  const media = items.map((item, i) => ({
    type: item.asPhoto ? 'photo' : 'document',
    media: `attach://file${i}`,
    ...(i === 0 && caption ? { caption } : {}),
  }));
  form.set('media', JSON.stringify(media));
  items.forEach((item, i) => form.set(`file${i}`, new Blob([item.bytes]), item.fileName));

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`sendMediaGroup failed: ${data.description ?? res.status}`);
}
