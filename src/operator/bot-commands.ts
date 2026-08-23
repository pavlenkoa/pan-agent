/**
 * The `/` suggestion-popup command lists, kept in their own dependency-free
 * module rather than inline in admin-commands.ts/person-commands.ts:
 * admin-commands.ts already imports provisioning.ts (for /approve), and
 * provisioning.ts needs both lists to register commands at approval time —
 * defining them there too would be a circular import. This module has no
 * imports of its own beyond the Telegram type, so both sides can depend on
 * it safely.
 */
import { log } from '../shared/log.js';
import type { BotCommand, TelegramClient } from './telegram.js';

/** Registered only on the admin's own chat — see operator/index.ts. */
export const ADMIN_COMMANDS: BotCommand[] = [
  { command: 'approve', description: 'Approve a pending person: <slug> <telegramUserId>' },
  { command: 'deny', description: 'Deny a pending person: <telegramUserId>' },
  { command: 'people', description: 'List all known people' },
  { command: 'restart', description: "Restart a person's pod: <slug>" },
];

/**
 * Registered per-chat via Telegram's setMyCommands (chat-scoped, never a
 * default/global scope) so the `/` suggestion popup only ever exists for a
 * chat we've explicitly approved. Telegram command names may only contain
 * lowercase letters/digits/`_` — no hyphens — hence set_var not set-var.
 */
export const PERSON_COMMANDS: BotCommand[] = [
  { command: 'set_var', description: 'Set a persistent env var for your pod: KEY=VALUE [description]' },
  { command: 'list_vars', description: 'List your custom env vars' },
  { command: 'unset_var', description: 'Remove a custom env var by name' },
  { command: 'memories', description: 'List what the assistant remembers about you' },
  { command: 'forget_memory', description: 'Delete one memory file by name (see /memories)' },
  { command: 'skills', description: 'List custom skills the assistant has built for you' },
  { command: 'forget_skill', description: 'Delete one custom skill by name (see /skills)' },
  { command: 'context', description: 'Show current context/token usage for your session' },
  { command: 'effort', description: 'Show or set model effort for this session: low|medium|high|xhigh' },
  { command: 'context_limit', description: 'Show or set your auto-compact token limit (default 250,000)' },
  { command: 'compact', description: 'Manually compact your conversation history now' },
  { command: 'clear', description: 'Start a fresh conversation (memory/tasks are unaffected)' },
];

/** The admin is also a tenant (router.ts) — their chat gets both lists. */
export function commandsForChat(isAdmin: boolean): BotCommand[] {
  return isAdmin ? [...ADMIN_COMMANDS, ...PERSON_COMMANDS] : PERSON_COMMANDS;
}

/**
 * Registers the `/` popup for a newly-approved chat — chat-scoped only (see
 * telegram.ts's setMyCommands doc comment). Best-effort: a failure here
 * shouldn't fail the whole approval, the person is already usable without
 * the menu.
 */
export async function registerCommandsFor(
  telegram: TelegramClient,
  telegramUserId: number,
  chatId: number,
  isAdmin: boolean,
): Promise<void> {
  try {
    await telegram.setMyCommands(commandsForChat(isAdmin), { type: 'chat', chat_id: chatId });
  } catch (err) {
    log.error('set_my_commands_failed', err, { telegramUserId });
  }
}

/**
 * Clears a chat's `/` popup entirely (e.g. on /deny) — registration is
 * sticky on Telegram's side, nothing else ever un-sets it, so without this
 * a denied person keeps seeing every command listed (though none of them
 * can actually do anything: router.ts drops a denied sender's messages
 * before any command dispatch runs — this is a discoverability fix, not an
 * access-control one). Best-effort, same as registerCommandsFor.
 */
export async function clearCommandsFor(telegram: TelegramClient, telegramUserId: number, chatId: number): Promise<void> {
  try {
    await telegram.setMyCommands([], { type: 'chat', chat_id: chatId });
  } catch (err) {
    log.error('set_my_commands_failed', err, { telegramUserId });
  }
}
