/**
 * Outbound stickers + message reactions: same deliberate-egress-deviation
 * shape as attachment-tools.ts. Reacting needs the Telegram message_id of
 * the inbound message being responded to, which only exists per-turn (a
 * chat turn's last ChatMessage) — session-controller.ts threads it in as a
 * live mutable ref (`ReactableMessageRef`) rather than baking a fixed id
 * into the tool closure the way cfg's static chatId is. Deliberately named
 * apart from the unrelated `PendingReaction`/`reactionQueue` concept in
 * session-controller.ts (task-notification bookkeeping, nothing to do with
 * Telegram message reactions) to avoid confusing the two.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { RunnerConfig } from './config.js';
import { listAvailableStickers } from './sticker-store.js';
import { sendTelegramSticker, setTelegramMessageReaction } from './telegram-send.js';

/** Mutated in place by session-controller.ts before each chat turn; `null` outside a real inbound chat message (a task/control turn, or an internal auto-compact run). */
export interface ReactableMessageRef {
  messageId: number | null;
}

/**
 * Telegram reactions are NOT arbitrary emoji — `setMessageReaction`'s
 * `ReactionTypeEmoji.emoji` only accepts this fixed, curated set (confirmed
 * 2026-08-26 against grammyjs/types' generated Bot API type, which mirrors
 * Telegram's own schema — core.telegram.org/bots/api itself documents the
 * *existence* of the constraint but doesn't enumerate it). Telegram's own
 * doc comment phrases it as "currently, it can be one of" — this set has
 * grown before and may again, so this isn't guaranteed permanent, but there
 * is no live/discoverable way to fetch the current set from the Bot API
 * itself. Enforced client-side via zod so a bad guess fails instantly
 * instead of round-tripping to Telegram for the same 400.
 */
const REACTION_EMOJI = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩',
  '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆',
  '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈',
  '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄',
  '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
] as const;

export function buildTelegramExtrasMcpServer(cfg: RunnerConfig, reactable: ReactableMessageRef) {
  const listStickers = tool(
    'list_stickers',
    "List the sticker packs this person has added (via /sticker_packs, or by sending you a sticker), with each " +
      "sticker's emoji and file id. Call this before send_sticker to get a valid file id — there is no way to see " +
      'the actual image, only the emoji it was tagged with, so match by emoji/vibe, not appearance.',
    {},
    async () => {
      const stickers = await listAvailableStickers(cfg);
      if (stickers.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No sticker packs added yet — ask the person to send you a sticker to add its pack.' },
          ],
        };
      }
      const lines = stickers.map((s) => `${s.emoji || '?'}  ${s.fileId}  (${s.pack})`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  const sendSticker = tool(
    'send_sticker',
    'Send a sticker to the user by file id — get a valid file id from list_stickers first.',
    { fileId: z.string().describe('The sticker file_id, from list_stickers') },
    async (args) => {
      const stickers = await listAvailableStickers(cfg);
      if (!stickers.some((s) => s.fileId === args.fileId)) {
        return {
          content: [{ type: 'text' as const, text: 'Unknown sticker file id — call list_stickers first and use one from there.' }],
          isError: true,
        };
      }
      await sendTelegramSticker(cfg.telegramBotToken, cfg.chatId, args.fileId);
      return { content: [{ type: 'text' as const, text: 'Sticker sent.' }] };
    },
  );

  const reactToMessage = tool(
    'react_to_message',
    'React to the message the person just sent, with a single emoji — a real Telegram reaction on their message, ' +
      'not a reply message. Only works for the message that triggered this turn. Telegram only allows a fixed set ' +
      'of reaction emoji (not arbitrary ones) — pick from the enum, not from what would otherwise fit best.',
    { emoji: z.enum(REACTION_EMOJI).describe('One of Telegram\'s fixed reaction emoji') },
    async (args) => {
      if (reactable.messageId === null) {
        return { content: [{ type: 'text' as const, text: 'No message to react to right now.' }], isError: true };
      }
      try {
        await setTelegramMessageReaction(cfg.telegramBotToken, cfg.chatId, reactable.messageId, args.emoji);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Couldn't set that reaction: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: 'Reacted.' }] };
    },
  );

  return createSdkMcpServer({ name: 'pan-agent-telegram-extras', version: '1.0.0', tools: [listStickers, sendSticker, reactToMessage] });
}
