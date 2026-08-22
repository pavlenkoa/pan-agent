/**
 * Runner entrypoint (architecture doc section 3): HTTP server on :8080,
 * `POST /turn` + `GET /healthz`. One turn at a time — a `/turn` while busy
 * returns 409 and the operator holds + retries.
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';

import { readJsonBody, sendJson } from '../shared/http.js';
import { log } from '../shared/log.js';
import type { TurnRequest } from '../shared/types.js';
import { loadRunnerConfig } from './config.js';
import { createJournal } from './journal.js';
import { runTurn } from './sdk-session.js';
import { sendTelegramReply } from './telegram-send.js';

const execFileAsync = promisify(execFile);

/** Best-effort — same bot identity the old single-tenant image configured at startup. */
async function ensureGitIdentity(): Promise<void> {
  try {
    await execFileAsync('git', ['config', '--global', 'user.name', 'panclaude']);
    await execFileAsync('git', ['config', '--global', 'user.email', '269990661+panclaude@users.noreply.github.com']);
    if (process.env['GH_TOKEN']) await execFileAsync('gh', ['auth', 'setup-git']);
  } catch (err) {
    log.error('git_identity_setup_failed', err);
  }
}

async function main(): Promise<void> {
  const cfg = loadRunnerConfig();
  const journal = createJournal(cfg.journalDir);
  await ensureGitIdentity();

  let busy = false;

  const incomplete = await journal.listIncomplete();
  for (const entry of incomplete) {
    log.line('journal_incomplete_on_boot', { person: cfg.slug, key: entry.key, startedAt: entry.startedAt });
  }

  async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (busy) {
      sendJson(res, 409, { error: 'busy' });
      return;
    }
    busy = true;
    try {
      let turn: TurnRequest;
      try {
        turn = await readJsonBody<TurnRequest>(req);
      } catch (err) {
        sendJson(res, 400, { error: `invalid body: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      const { key, alreadyProcessed } = await journal.begin(turn);
      if (alreadyProcessed) {
        log.line('turn_deduped', { person: cfg.slug, turn: key });
        sendJson(res, 202, { accepted: true, deduped: true });
        return;
      }

      sendJson(res, 202, { accepted: true });

      try {
        const result = await runTurn(cfg, turn, key);
        if (result.replyText) {
          await sendTelegramReply(cfg.telegramBotToken, turn.chatId, result.replyText);
        }
        await journal.complete(key, result.ok ? 'ok' : 'error');
      } catch (err) {
        log.error('turn_processing_failed', err, { person: cfg.slug, turn: key });
        await journal.complete(key, 'error');
      }
    } finally {
      busy = false;
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ready: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/turn') {
      void handleTurn(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  server.listen(cfg.port, () => log.line('runner_listening', { person: cfg.slug, port: cfg.port }));

  const shutdown = (): void => {
    log.line('runner_shutting_down', { person: cfg.slug });
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('runner_fatal', err);
  process.exit(1);
});
