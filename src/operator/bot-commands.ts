/**
 * The `/` suggestion-popup command lists, kept in their own dependency-free
 * module rather than inline in admin-commands.ts/person-commands.ts:
 * admin-commands.ts already imports provisioning.ts (for /approve), and
 * provisioning.ts needs both lists to register commands at approval time —
 * defining them there too would be a circular import. This module has no
 * imports of its own beyond the Telegram type, so both sides can depend on
 * it safely.
 */
import type { BotCommand } from './telegram.js';

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
];

/** The admin is also a tenant (router.ts) — their chat gets both lists. */
export function commandsForChat(isAdmin: boolean): BotCommand[] {
  return isAdmin ? [...ADMIN_COMMANDS, ...PERSON_COMMANDS] : PERSON_COMMANDS;
}
