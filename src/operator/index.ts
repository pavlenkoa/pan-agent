/**
 * Operator entrypoint. Owns the single Telegram connection, the people
 * index, pod lifecycle, and the task sweep. Never on the reply path — see
 * architecture doc section 2.
 */
import { log } from '../shared/log.js';
import type { PeopleIndex, TaskTurn } from '../shared/types.js';
import { commandsForChat } from './bot-commands.js';
import { loadOperatorConfig, type OperatorConfig } from './config.js';
import { deliverTaskTurn } from './delivery.js';
import { makeCoreV1Api } from './k8s.js';
import { readPeopleIndex } from './people-index.js';
import { bootReconcile } from './reconcile.js';
import { routeUpdate, type RouterDeps } from './router.js';
import { runSweep, startSweepTimer } from './sweep.js';
import { startTasksApi } from './tasks-api.js';
import { pollUpdates, TelegramClient } from './telegram.js';

/**
 * Re-asserts the `/` suggestion popup on every active person's chat (plus
 * the admin's, combined with admin commands) on every boot — cheap at this
 * scale, and covers both drift (a chat's registration was never set, e.g.
 * approved before this feature existed) and the admin's chat specifically,
 * which needs the combined list regardless of whether/when they were ever
 * routed through provisionPerson. Best-effort per chat: one failure doesn't
 * stop the operator from starting.
 */
async function registerAllBotCommands(telegram: TelegramClient, cfg: OperatorConfig, idx: PeopleIndex): Promise<void> {
  const chats = new Map<number, number>(); // telegramUserId -> chatId
  chats.set(cfg.telegramAdminChatId, cfg.telegramAdminChatId);
  for (const person of Object.values(idx.people)) {
    if (person.status === 'active') chats.set(person.telegramUserId, person.chatId);
  }
  for (const [telegramUserId, chatId] of chats) {
    try {
      await telegram.setMyCommands(commandsForChat(telegramUserId === cfg.telegramAdminChatId), {
        type: 'chat',
        chat_id: chatId,
      });
    } catch (err) {
      log.error('set_my_commands_failed', err, { telegramUserId });
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadOperatorConfig();
  const api = makeCoreV1Api();
  const telegram = new TelegramClient(cfg.telegramBotToken);
  const deps: RouterDeps = { api, cfg, telegram };

  log.line('operator_starting', { namespace: cfg.namespace, image: cfg.image });

  await bootReconcile(api, cfg);
  await registerAllBotCommands(telegram, cfg, await readPeopleIndex(api, cfg.namespace));

  const tasksServer = startTasksApi(api, cfg.namespace, cfg.tasksApiPort);

  const deliver = async (slug: string, chatId: number, turn: TaskTurn): Promise<void> => {
    const idx = await readPeopleIndex(api, cfg.namespace);
    const person = idx.people[slug];
    await deliverTaskTurn(api, cfg, slug, chatId, person?.tz ?? cfg.defaultTz, person?.tasksToken ?? '', turn);
  };

  startSweepTimer(api, cfg.namespace, cfg.sweepIntervalMs, cfg.catchUpWindowMs, deliver);
  // Catch up immediately on boot instead of waiting for the first tick.
  await runSweep(api, cfg.namespace, cfg.catchUpWindowMs, deliver);

  const abortController = new AbortController();
  const shutdown = (): void => {
    log.line('operator_shutting_down');
    abortController.abort();
    tasksServer.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  log.line('operator_ready');
  // No stored offset: Telegram itself is the durable inbound buffer — an
  // undelivered update stays queued server-side until we ack it by polling
  // past it, so resuming with no offset just re-fetches whatever we never
  // confirmed before the last restart.
  await pollUpdates(telegram, undefined, (update) => routeUpdate(deps, update), abortController.signal);
}

main().catch((err) => {
  log.error('operator_fatal', err);
  process.exit(1);
});
