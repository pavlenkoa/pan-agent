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
import { log } from '../shared/log.js';
import type { ControlRequest, ControlResponse, TurnRequest } from '../shared/types.js';
import { loadRunnerConfig, type RunnerConfig } from './config.js';
import { createJournal } from './journal.js';
import { createSessionController } from './session-controller.js';
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
        const result = await controller.submitTurn(turn, key);
        // A successful /compact or /clear produces an empty SDK result (confirmed
        // live: the SDK handles these as a protocol-level event, not a model
        // turn), and session-controller.ts's control-turn timeout also
        // resolves with an empty, ok:false result rather than throwing —
        // synthesize a reply for both cases so the person sees *something*
        // rather than silence either way (confirmed live: silence is exactly
        // what made a genuinely hung /compact read as "does nothing").
        const replyText =
          result.replyText ||
          (turn.kind === 'control'
            ? result.ok
              ? turn.command === '/compact'
                ? '✅ Compacted your conversation history.'
                : '✅ Cleared — starting fresh from here. Memory notes and scheduled tasks are unaffected.'
              : `⚠️ ${turn.command} timed out — try again in a moment.`
            : '');
        if (replyText) {
          await sendTelegramReply(cfg.telegramBotToken, turn.chatId, replyText);
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
