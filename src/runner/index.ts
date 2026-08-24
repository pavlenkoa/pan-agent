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
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { readJsonBody, sendJson } from '../shared/http.js';
import { log, truncateText } from '../shared/log.js';
import type { ControlRequest, ControlResponse, TurnRequest } from '../shared/types.js';
import { loadRunnerConfig, type RunnerConfig } from './config.js';
import { createJournal } from './journal.js';
import { createSessionController } from './session-controller.js';
import { resolveReplyText } from './sdk-session.js';
import { sendTelegramReply } from './telegram-send.js';

const execFileAsync = promisify(execFile);
const PERSONA_MOUNT_DIR = '/config';

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

/** Renders the person's own /set_var'd variables (names + descriptions only, never values) as a CLAUDE.md section. */
function renderCustomVarsSection(cfg: RunnerConfig): string {
  if (cfg.customVarsDoc.length === 0) return '';
  const lines = cfg.customVarsDoc.map((v) => `- \`${v.name}\` — ${v.description || '(no description given)'}`);
  return `

## Your custom environment variables

Set via /set_var by the person you're assisting — already present in your Bash environment, not something you need to load or ask for:

${lines.join('\n')}`;
}

/** Every `SKILL-<name>.md` key in the persona ConfigMap becomes a shared skill `<name>`, installed for every person. Matches `SHARED_SKILL_NAMES` in `operator/nfs.ts` — a name added here must be added there too, or `/skills` will misreport it as person-authored and `/forget_skill` will delete it (it'll just come back on next boot, but the listing will lie in the meantime). */
const SHARED_SKILL_FILE_PATTERN = /^SKILL-(.+)\.md$/;

/**
 * The pan-agent-persona ConfigMap is mounted read-only at /config — that's
 * not a path the Claude Agent SDK's CLAUDE.md/skill auto-discovery ever
 * looks at (~/.claude/CLAUDE.md for identity/user-level memory,
 * <cwd>/.claude/skills/<name>/SKILL.md for project skills — matches what
 * CLAUDE.md itself already tells the model: "read .claude/skills/media/
 * SKILL.md in the workspace"). Copy it into place on every boot so a
 * ConfigMap update takes effect on the next pod restart, appending the
 * person's own custom-var doc (the runner has no k8s API access itself —
 * see the NetworkPolicy's comment on this — so this comes in via the
 * operator-set PERSON_CUSTOM_VARS_DOC env var instead of a direct read).
 */
async function installPersonaFiles(cfg: RunnerConfig): Promise<void> {
  try {
    const sharedPersona = await readFile(path.join(PERSONA_MOUNT_DIR, 'CLAUDE.md'), 'utf8');
    await writeFile(path.join(cfg.claudeHome, 'CLAUDE.md'), sharedPersona + renderCustomVarsSection(cfg));

    const entries = await readdir(PERSONA_MOUNT_DIR);
    const skillNames: string[] = [];
    for (const entry of entries) {
      const match = entry.match(SHARED_SKILL_FILE_PATTERN);
      const skillName = match?.[1];
      if (!skillName) continue;
      const skillDir = path.join(cfg.workspaceCwd, '.claude', 'skills', skillName);
      await mkdir(skillDir, { recursive: true });
      await copyFile(path.join(PERSONA_MOUNT_DIR, entry), path.join(skillDir, 'SKILL.md'));
      skillNames.push(skillName);
    }

    log.line('persona_installed', { person: cfg.slug, customVars: cfg.customVarsDoc.length, sharedSkills: skillNames });
  } catch (err) {
    log.error('persona_install_failed', err, { person: cfg.slug });
  }
}

async function main(): Promise<void> {
  const cfg = loadRunnerConfig();
  const journal = createJournal(cfg.journalDir);
  await ensureGitIdentity();
  await installPersonaFiles(cfg);

  const controller = createSessionController(cfg);
  await controller.start();

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
        const { replyText, isTaskNoUpdate, suppressedReasoning } = resolveReplyText(turn, result);

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
            const { text, bytes } = truncateText(isTaskNoUpdate ? suppressedReasoning : '');
            log.line('reply_muted', {
              person: cfg.slug,
              turn: key,
              reason: isTaskNoUpdate ? 'task_no_update' : 'empty',
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
      } else {
        controller.setContextLimit(body.tokens);
        response = { ok: true, action: 'set_context_limit' };
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
