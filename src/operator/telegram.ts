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

export interface TelegramSticker {
  file_id: string;
  emoji?: string;
  /** The pack's short name (e.g. from t.me/addstickers/<set_name>) — absent for a one-off sticker not part of any named set. */
  set_name?: string;
}

/** Deliberately shallow (no nested reply_to_message/photo/etc.) — only what's needed to give the model quoting context, not a full recursive Message shape. */
export interface TelegramReplyToMessage {
  message_id: number;
  from?: TelegramFrom;
  text?: string;
  caption?: string;
}

/** The specific substring the person selected before replying (Bot API 7.0+) — absent when they replied without selecting anything, in which case `reply_to_message`'s own text is the best we have. */
export interface TelegramTextQuote {
  text: string;
  position: number;
  is_manual?: boolean;
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
  sticker?: TelegramSticker;
  /** Present when the person used Telegram's native "reply" swipe/long-press on an earlier message (theirs, the bot's, or a third party's in principle — this bot is DM-only so in practice always one of the first two). */
  reply_to_message?: TelegramReplyToMessage;
  /** The exact substring selected before replying, if any — see TelegramTextQuote's doc comment. Sibling of reply_to_message, not nested under it. */
  quote?: TelegramTextQuote;
}

/** A tap on an inline-keyboard button (permission-gate prompts, currently the only sender of one — see runner/telegram-send.ts's sendPermissionRequest). `message` is the original message the keyboard was attached to, deliberately shallow like TelegramReplyToMessage above. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramFrom;
  message?: { message_id: number; chat: TelegramChat; text?: string };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface BotCommand {
  command: string;
  description: string;
}

/** Chat-scoped only (never 'default'/'all_private_chats') — see setMyCommands' doc comment below for why. */
export interface BotCommandScopeChat {
  type: 'chat';
  chat_id: number;
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
      body: JSON.stringify({ offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }),
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

  /** Stops the tap's loading spinner and optionally shows a short toast — must be called for every `callback_query`, even an invalid/unauthorized one, or the button just spins. Never throws: a failure here shouldn't block the actual decision from being relayed. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      const res = await fetch(this.url('answerCallbackQuery'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as TelegramApiResponse<boolean>;
      if (!data.ok) throw new Error(data.description ?? String(res.status));
    } catch (err) {
      log.error('answer_callback_query_failed', err, { callbackQueryId });
    }
  }

  /** Used to lock in a permission-gate decision on the original prompt message (drops the keyboard, appends the outcome) so a stale or already-answered button can't be tapped twice. Never throws, same rationale as answerCallbackQuery. */
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      const res = await fetch(this.url('editMessageText'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as TelegramApiResponse<unknown>;
      if (!data.ok) throw new Error(data.description ?? String(res.status));
    } catch (err) {
      log.error('edit_message_text_failed', err, { chatId, messageId });
    }
  }

  /**
   * Registers the `/` suggestion popup for one specific chat — always called
   * with a `chat` scope, never `default`/`all_private_chats`, so an
   * unapproved sender's chat has no registered commands at all (not hidden
   * client-side — Telegram's own servers have nothing to show them). This is
   * a discoverability nicety only: actual command handling in router.ts
   * already gates on person/admin status independent of what's registered
   * here, so this call being skipped or failing never grants access to
   * anything.
   */
  async setMyCommands(commands: BotCommand[], scope: BotCommandScopeChat): Promise<void> {
    const res = await fetch(this.url('setMyCommands'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands, scope }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as TelegramApiResponse<boolean>;
    if (!data.ok) throw new Error(`setMyCommands failed: ${data.description ?? res.status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This is the ONLY consumer of this bot's Telegram updates — every person's
// messages AND every button tap, for everyone, funnel through this one
// sequential loop (architecture doc's "single getUpdates consumer"
// deviation). `onUpdate` is expected to resolve quickly (router.ts's
// enqueueChatMessage now only awaits queuing a delivery, never the delivery
// itself succeeding — see its own doc comment for the incident that fixed
// that), but this bound is defense-in-depth against anything else upstream
// that might one day await something slow (an unbounded k8s API call, a
// dependency with no timeout of its own, etc.): confirmed live 2026-09-02
// that a single stuck update can freeze this whole loop for EVERY person,
// including — worst case — a person's own button tap that would resolve the
// exact permission request their busy pod is blocked on, deadlocking until
// someone manually intervenes outside Telegram entirely. A timed-out
// `onUpdate` isn't cancelled (there's no general way to abort an arbitrary
// in-flight async operation), just no longer awaited — whatever it kicked
// off keeps running in the background on its own error handling.
const UPDATE_HANDLING_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`update handling exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/**
 * Long-poll loop. `onUpdate` is *expected* to resolve (never reject) once
 * the update has either been durably handed off (runner 202'd) or
 * intentionally dropped (denied sender) — but that's not trusted blindly:
 * a routing-side failure (e.g. a transient k8s API error writing
 * bookkeeping state) is caught here too, same as a `getUpdates` failure, so
 * one bad update can't crash this loop or get stuck redelivering forever
 * (upstream's telegram plugin had a version of this bug where an untrapped
 * error permanently killed polling while the process stayed alive — ours
 * differs in shape since `main()` would exit and rely on k8s to restart the
 * pod, but a poison update would then just crash-loop forever on itself
 * since no offset is ever persisted across restarts; catching it here
 * avoids that class of failure entirely). `UPDATE_HANDLING_TIMEOUT_MS`
 * covers the same class of risk for a *hang* (never resolving) rather than
 * a *rejection* — a plain try/catch does nothing for a promise that just
 * never settles.
 */
export async function pollUpdates(
  client: TelegramClient,
  startOffset: number | undefined,
  onUpdate: (update: TelegramUpdate) => Promise<void>,
  signal: AbortSignal,
  updateTimeoutMs = UPDATE_HANDLING_TIMEOUT_MS,
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
      try {
        await withTimeout(onUpdate(update), updateTimeoutMs);
      } catch (err) {
        log.error('update_handling_failed', err, { updateId: update.update_id });
      }
      offset = update.update_id + 1;
    }
  }
}
