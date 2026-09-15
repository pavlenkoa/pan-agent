/**
 * Runner entrypoint (architecture doc section 3): HTTP server on :8080,
 * `POST /turn` + `GET /healthz`. One turn at a time — a `/turn` while busy
 * returns 409 and the operator holds + retries.
 *
 * The session itself is persistent (`session-controller.ts`) — one SDK
 * `query()` spans the pod's whole lifetime instead of one per turn, so
 * backgrounded work has somewhere to land. This file's own `busy` flag is
 * still what gates concurrent `/turn`s, though: it's set synchronously
 * before any `await`, so two requests racing in before either has finished
 * body-parsing/journal-lookup can never both reach `submitTurn` at once —
 * `controller.isBusy()` alone can't provide that guarantee, since it only
 * flips once a message actually reaches the queue, which is after those
 * async steps.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { readJsonBody, sendJson } from '../shared/http.js';
import { log, truncateText } from '../shared/log.js';
import { ESPUTNIK_SERVER_URL, type ControlRequest, type ControlResponse, type TurnRequest } from '../shared/types.js';
import { loadRunnerConfig, type RunnerConfig } from './config.js';
import { createJournal } from './journal.js';
import { installPersonaFiles } from './persona-install.js';
import { createSessionController } from './session-controller.js';
import {
  esputnikToolPolicy,
  personaChangedSinceLastAck,
  readSavedContextLimit,
  readSavedSessionId,
  resolveReplyText,
  saveContextLimit,
  skillChangedSinceLastAck,
} from './sdk-session.js';
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
  // Checked before installPersonaFiles overwrites CLAUDE.md, and before the
  // session starts (so it reflects whether this boot is resuming a real
  // prior conversation) — see personaChangedSinceLastAck's doc comment for
  // why a resumed session needs an explicit nudge to see this at all.
  const wasResuming = (await readSavedSessionId(cfg)) !== null;
  const { skillNames: installedSkillNames } = await installPersonaFiles(cfg);
  const installedPersona = await readFile(path.join(cfg.claudeHome, 'CLAUDE.md'), 'utf8').catch(() => '');
  const personaChanged = installedPersona ? await personaChangedSinceLastAck(cfg, installedPersona) : false;

  // Same "resumed session won't pick this up on its own" problem as CLAUDE.md
  // above, one shared SKILL.md at a time — see skillChangedSinceLastAck's doc
  // comment (sdk-session.ts). Checked per skill so editing one shared skill
  // doesn't spuriously ack every other one's hash too.
  const changedSkillNames: string[] = [];
  for (const skillName of installedSkillNames) {
    const skillContent = await readFile(path.join(cfg.workspaceCwd, '.claude', 'skills', skillName, 'SKILL.md'), 'utf8').catch(() => '');
    if (skillContent && (await skillChangedSinceLastAck(cfg, skillName, skillContent))) {
      changedSkillNames.push(skillName);
    }
  }

  const controller = createSessionController(cfg);
  await controller.start();
  // A saved /context_limit override always wins over cfg.contextLimit (the
  // operator's per-person default, fixed at Pod creation/recreation) — see
  // readSavedContextLimit's doc comment for why an env var alone can't
  // survive an in-place container restart. Applied before the HTTP server
  // starts listening below, so no real turn can race in ahead of it.
  const savedContextLimit = await readSavedContextLimit(cfg);
  if (savedContextLimit != null) controller.setContextLimit(savedContextLimit);
  if (wasResuming && (personaChanged || changedSkillNames.length > 0)) {
    // Sequenced (not two independent `void` calls) so the two nudges can never
    // race each other onto the single-flight stream — startJob has no
    // correlation id, it trusts "the next result answers what was just
    // pushed." Still fire-and-forget from server.listen's perspective below.
    void (async () => {
      if (personaChanged) await controller.nudgePersonaRefresh();
      if (changedSkillNames.length > 0) await controller.nudgeSkillRefresh(changedSkillNames);
    })();
  }

  let busy = false;

  const incomplete = await journal.listIncomplete();
  for (const entry of incomplete) {
    log.line('journal_incomplete_on_boot', { person: cfg.slug, key: entry.key, startedAt: entry.startedAt });
  }

  async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // `busy` alone only ever covered concurrent /turn HTTP requests — it has
    // no visibility into a job session-controller started on its own
    // (auto-compact, a task-notification reaction), so a real turn could
    // slip through and silently overwrite one of those. Confirmed live
    // 2026-08-23: exactly this happened, orphaning an in-flight
    // auto-compact's promise forever and misattributing its SDK messages to
    // the turn that stomped it. `controller.isBusy()` is the actual source
    // of truth for "is session-controller doing anything right now" —
    // checking both closes the gap without losing `busy`'s own purpose
    // (rejecting a second /turn that arrives before the first has even
    // finished parsing/journaling, before isBusy() would reflect it).
    if (busy || controller.isBusy()) {
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
        const result = await controller.submitTurn(turn, key);
        const { replyText, isNoUpdate, suppressedReasoning } = resolveReplyText(turn, result);

        // Delivery is wrapped in its own try/catch (not the outer one) so a
        // failed sendTelegramReply still falls through to the turn_end log
        // below instead of skipping it entirely — see CLAUDE.md's "Error
        // path — mandatory" note: moving turn_end out of finishCurrentJob()
        // means it's no longer unconditional, and a job that resolved but
        // then failed to deliver must not end up with no turn_end at all.
        let deliveryOk = true;
        let deliveryError: string | undefined;
        try {
          if (replyText) {
            const { text, bytes } = truncateText(replyText);
            log.line('reply_sent', { person: cfg.slug, turn: key, text, bytes });
            await sendTelegramReply(cfg.telegramBotToken, turn.chatId, replyText);
          } else {
            const { text, bytes } = truncateText(isNoUpdate ? suppressedReasoning : '');
            log.line('reply_muted', {
              person: cfg.slug,
              turn: key,
              // turn.kind is guaranteed 'task' or 'chat' whenever isNoUpdate
              // is true — resolveReplyText never sets it for a control turn.
              reason: isNoUpdate ? (turn.kind === 'task' ? 'task_no_update' : 'chat_no_update') : 'empty',
              text,
              bytes,
            });
          }
        } catch (err) {
          deliveryOk = false;
          deliveryError = err instanceof Error ? err.message : String(err);
          log.error('reply_delivery_failed', err, { person: cfg.slug, turn: key });
        } finally {
          // submitTurn's job is always trigger:'http' (see session-controller.ts's
          // finishCurrentJob/timeoutControlTurn) — turnEnd is always populated here.
          const turnEnd = result.turnEnd!;
          log.line('turn_end', {
            person: cfg.slug,
            turn: key,
            trigger: turnEnd.trigger,
            ok: result.ok && deliveryOk,
            dur_ms: turnEnd.durMs,
            cost_usd: turnEnd.costUsd,
            turns: turnEnd.turns,
            ...(turnEnd.usage ?? {}),
            ...(deliveryError ? { error: deliveryError } : {}),
          });
        }

        await journal.complete(key, result.ok && deliveryOk ? 'ok' : 'error');
      } catch (err) {
        log.error('turn_processing_failed', err, { person: cfg.slug, turn: key });
        await journal.complete(key, 'error');
      }
    } finally {
      busy = false;
    }
  }

  /** Live control-plane calls against this pod's already-running session — not a turn, no journal entry, works regardless of `busy`. */
  async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: ControlRequest;
    try {
      body = await readJsonBody<ControlRequest>(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `invalid body: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    try {
      let response: ControlResponse;
      if (body.action === 'context') {
        response = { ok: true, action: 'context', context: await controller.getContextUsage() };
      } else if (body.action === 'set_effort') {
        await controller.setEffortLevel(body.level);
        response = { ok: true, action: 'set_effort' };
      } else if (body.action === 'set_context_limit') {
        controller.setContextLimit(body.tokens);
        await saveContextLimit(cfg, body.tokens);
        response = { ok: true, action: 'set_context_limit' };
      } else if (body.action === 'sync_esputnik_mcp') {
        const mode = await controller.syncMcpServer(body.serverKey, {
          type: 'http',
          url: ESPUTNIK_SERVER_URL,
          tools: esputnikToolPolicy(),
        });
        response = { ok: true, action: 'sync_esputnik_mcp', mode };
      } else if (body.action === 'permission_decision') {
        const { applied, toolName } = controller.resolvePermissionDecision(body.requestId, body.decision);
        response = { ok: true, action: 'permission_decision', applied, ...(toolName ? { toolName } : {}) };
      } else {
        response = { ok: true, action: 'esputnik_status', servers: await controller.getEsputnikStatus() };
      }
      sendJson(res, 200, response);
    } catch (err) {
      log.error('control_request_failed', err, { person: cfg.slug });
      const error: ControlResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
      sendJson(res, 500, error);
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

    if (req.method === 'POST' && url.pathname === '/control') {
      void handleControl(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  server.listen(cfg.port, () => log.line('runner_listening', { person: cfg.slug, port: cfg.port }));

  const shutdown = (): void => {
    log.line('runner_shutting_down', { person: cfg.slug });
    server.close(() => {
      void controller.stop().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('runner_fatal', err);
  process.exit(1);
});
