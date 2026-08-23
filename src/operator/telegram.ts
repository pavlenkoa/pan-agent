/**
 * The operator is the single `getUpdates` consumer for the shared bot token
 * (architecture doc's "one deliberate deviation from the brief"). Person
 * pods send replies directly via their own TELEGRAM_BOT_TOKEN — this client
 * is ingress-only plus the operator's own outbound messages (holding
 * replies, admin DMs).
 */
import { log } from '../shared/log.js';

export interface TelegramFrom {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramFrom;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramClient {
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async getUpdates(offset: number | undefined, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const res = await fetch(this.url('getUpdates'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, timeout: timeoutSeconds, allowed_updates: ['message'] }),
      signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000),
    });
    const data = (await res.json()) as TelegramApiResponse<TelegramUpdate[]>;
    if (!data.ok) throw new Error(`getUpdates failed: ${data.description ?? res.status}`);
    return data.result ?? [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const res = await fetch(this.url('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as TelegramApiResponse<unknown>;
    if (!data.ok) throw new Error(`sendMessage failed: ${data.description ?? res.status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Long-poll loop. `onUpdate` must resolve (never reject) once the update has
 * either been durably handed off (runner 202'd) or intentionally dropped
 * (denied sender) — the caller only advances the offset after it returns,
 * so an update is never acked to Telegram until it's been dealt with.
 */
export async function pollUpdates(
  client: TelegramClient,
  startOffset: number | undefined,
  onUpdate: (update: TelegramUpdate) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let offset = startOffset;
  while (!signal.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await client.getUpdates(offset, 50);
    } catch (err) {
      if (signal.aborted) return;
      log.error('telegram_poll_failed', err);
      await sleep(5000);
      continue;
    }
    for (const update of updates) {
      log.line('update_received', { updateId: update.update_id });
      await onUpdate(update);
      offset = update.update_id + 1;
    }
  }
}
