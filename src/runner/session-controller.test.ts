import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatTurn, ControlTurn } from '../shared/types.js';
import type { RunnerConfig } from './config.js';
import { createPushableQueue } from './pushable-queue.js';
import { NO_UPDATE_MARKER } from './sdk-session.js';
import type { SessionController } from './session-controller.js';

vi.mock('./telegram-send.js', () => ({ sendTelegramReply: vi.fn().mockResolvedValue(undefined) }));

// Imported after the mock so session-controller.js resolves the mocked module.
const { sendTelegramReply } = await import('./telegram-send.js');
const { createSessionController } = await import('./session-controller.js');

function resultMessage(text: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    result: text,
    modelUsage: {},
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

function taskNotification(taskId: string, summary: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    output_file: '/tmp/out',
    summary,
    uuid: `uuid-${taskId}`,
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

/**
 * A fake query() whose events are entirely test-driven via `fakeEvents`.
 * `getContextUsage` is a mutable getter, not a fixed value — tests that
 * exercise auto-compact need to change what it reports mid-test (e.g. "over
 * the limit" for one check, "back under" after compacting), and it defaults
 * to a low, never-triggers value so unrelated tests don't have to think
 * about it at all.
 */
function fakeQueryFn(
  fakeEvents: ReturnType<typeof createPushableQueue<SDKMessage>>,
  getTotalTokens: () => number = () => 0,
) {
  return vi.fn(() => {
    const gen = (async function* gen() {
      for await (const msg of fakeEvents) yield msg;
    })();
    return Object.assign(gen, {
      getContextUsage: async () => ({
        model: 'claude-sonnet-5',
        totalTokens: getTotalTokens(),
        maxTokens: 1_000_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Every result submitTurn() resolves with now carries `turnEnd` (the job is
 * always trigger:'http' by construction — see session-controller.ts's
 * finishCurrentJob/timeoutControlTurn). `durMs` is real wall-clock elapsed
 * time, so it's matched loosely; the rest reflects the fake `resultMessage`
 * defaults (num_turns: 1, total_cost_usd: 0, modelUsage: {} -> usage: null)
 * unless a test overrides them.
 */
function httpTurnEnd(overrides: Partial<{ turns: number; costUsd: number; usage: unknown }> = {}) {
  return { trigger: 'http' as const, durMs: expect.any(Number), costUsd: 0, turns: 1, usage: null, ...overrides };
}

describe('createSessionController', () => {
  let dir: string;
  let cfg: RunnerConfig;
  let controller: SessionController | undefined;
  // Tracked so afterEach can close it — the fake generator's `for await (of
  // fakeEvents)` is stuck on a pending `next()` until something does, and
  // without that `controller.stop()`'s `.return()` can never actually
  // unstick it (this is a fake-harness quirk, not a real-SDK behavior: the
  // live subprocess's `.return()` doesn't depend on us closing anything).
  let fakeEventsInUse: ReturnType<typeof createPushableQueue<SDKMessage>> | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pan-agent-session-'));
    cfg = {
      slug: 'andrii',
      chatId: 111,
      tz: 'Europe/Warsaw',
      port: 8080,
      operatorTasksUrl: 'http://operator.invalid',
      tasksToken: 'test-token',
      telegramBotToken: 'bot-token',
      journalDir: dir,
      workspaceCwd: dir,
      claudeHome: dir,
      sessionIdFile: path.join(dir, 'session-id'),
    };
    vi.clearAllMocks();
    controller = undefined;
    fakeEventsInUse = undefined;
  });

  afterEach(async () => {
    fakeEventsInUse?.close();
    await controller?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /** fakeQueryFn + tracking it for afterEach's cleanup, in one call. */
  function trackedFakeQueryFn(
    fakeEvents: ReturnType<typeof createPushableQueue<SDKMessage>>,
    getTotalTokens?: () => number,
  ) {
    fakeEventsInUse = fakeEvents;
    return fakeQueryFn(fakeEvents, getTotalTokens);
  }

  const chatTurn: ChatTurn = {
    kind: 'chat',
    updateId: 1,
    chatId: 111,
    messages: [{ messageId: 1, text: 'hi', fromHandle: null, date: new Date().toISOString() }],
  };

  it('resolves a normal turn with the next result message text', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));

    fakeEvents.push(resultMessage('hello there'));

    await expect(turnPromise).resolves.toEqual({ replyText: 'hello there', ok: true, turnEnd: httpTurnEnd() });
    expect(controller.isBusy()).toBe(false);
  });

  it('persists the session id as soon as it is seen, before any result arrives', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();

    fakeEvents.push({ type: 'system', subtype: 'init', session_id: 'sess-early' } as unknown as SDKMessage);

    const { readFile } = await import('node:fs/promises');
    // saveSessionId does real file I/O — a single microtask flush isn't a
    // reliable wait for it under load, so poll instead of guessing tick counts.
    await vi.waitFor(async () => {
      expect(await readFile(cfg.sessionIdFile, 'utf8')).toBe('sess-early');
    });
  });

  it('a task_notification while idle triggers a proactive reply', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();

    fakeEvents.push(taskNotification('bg-1', 'torrent finished'));
    // Processing this message also does a real saveSessionId write first
    // (its session_id differs from the fresh controller's null) — poll
    // rather than assume a fixed number of ticks covers that I/O.
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true)); // the reaction turn is now in flight

    fakeEvents.push(resultMessage('done downloading Iron Man'));

    await vi.waitFor(() =>
      expect(sendTelegramReply).toHaveBeenCalledWith(cfg.telegramBotToken, cfg.chatId, 'done downloading Iron Man'),
    );
  });

  it('a task_notification with nothing new to report stays silent instead of leaking reasoning to Telegram', async () => {
    // Regression guard for ~/task-notification-no-update-bug.md: this path
    // used to deliver result.replyText unconditionally, with no NO_UPDATE
    // escape hatch — a second notification for the same event with nothing
    // new to add got the model's "nothing to report" reasoning shipped
    // straight to Telegram as literal prose.
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();

    fakeEvents.push(taskNotification('bg-1', 'torrent finished'));
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));

    fakeEvents.push(resultMessage(`Already reported this.\n${NO_UPDATE_MARKER}`));

    await vi.waitFor(() => expect(controller?.isBusy()).toBe(false));
    await flushMicrotasks();
    expect(sendTelegramReply).not.toHaveBeenCalled();
  });

  it('nudgePersonaRefresh never delivers its reply to Telegram, no matter what the model says', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();

    const nudgePromise = controller.nudgePersonaRefresh();
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessage('Got it — re-read CLAUDE.md, noted the new sticker/reaction tools.'));
    await nudgePromise;

    expect(sendTelegramReply).not.toHaveBeenCalled();
    expect(controller.isBusy()).toBe(false);
  });

  it('a task_notification while busy queues and runs only after the current job resolves', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));

    fakeEvents.push(taskNotification('bg-1', 'torrent finished'));
    await flushMicrotasks();
    expect(sendTelegramReply).not.toHaveBeenCalled(); // queued, not started yet

    fakeEvents.push(resultMessage('main reply'));
    await expect(turnPromise).resolves.toEqual({ replyText: 'main reply', ok: true, turnEnd: httpTurnEnd() });
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true)); // reaction started right after

    fakeEvents.push(resultMessage('reaction reply'));
    await vi.waitFor(() =>
      expect(sendTelegramReply).toHaveBeenCalledWith(cfg.telegramBotToken, cfg.chatId, 'reaction reply'),
    );
  });

  it('isBusy reflects the single-flight slot across both turn and reaction paths', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();
    expect(controller.isBusy()).toBe(false);

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));

    fakeEvents.push(resultMessage('ok'));
    await turnPromise;
    expect(controller.isBusy()).toBe(false);
  });

  it('auto-compacts once a live getContextUsage() check crosses the configured limit, and does not chain into a second one', async () => {
    // Confirmed live 2026-08-23: a turn's own reported cacheReadTokens is NOT
    // current context size (cumulative across internal tool-call round-trips
    // within one turn, not a snapshot) — the mechanism has to ask
    // getContextUsage() for the real number, so that's what this fakes.
    let totalTokens = 150;
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents, () => totalTokens));
    await controller.start();
    await flushMicrotasks();
    controller.setContextLimit(100);

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessage('hi back'));
    await expect(turnPromise).resolves.toEqual({ replyText: 'hi back', ok: true, turnEnd: httpTurnEnd() });

    // No external submitTurn call here — this job has to start on its own.
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));

    // Resolve it with a real /compact-shaped result (empty text). Leave
    // totalTokens deliberately still over the limit, to prove the
    // trigger:'auto_compact' guard stops it from chaining into a second
    // auto-compact rather than the number just happening to drop this time.
    fakeEvents.push(resultMessage(''));
    await vi.waitFor(() =>
      expect(sendTelegramReply).toHaveBeenCalledWith(
        cfg.telegramBotToken,
        cfg.chatId,
        '✅ Auto-compacted: context passed your 100-token limit.',
      ),
    );

    await flushMicrotasks();
    expect(controller.isBusy()).toBe(false);
    expect(sendTelegramReply).toHaveBeenCalledTimes(1); // exactly one auto-compact, not two
  });

  it('does not auto-compact when the live getContextUsage() check stays under the configured limit', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents, () => 150));
    await controller.start();
    await flushMicrotasks();
    controller.setContextLimit(1_000_000); // default-shaped: far above what this turn uses

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessage('hi back'));
    await expect(turnPromise).resolves.toEqual({ replyText: 'hi back', ok: true, turnEnd: httpTurnEnd() });

    await flushMicrotasks();
    expect(controller.isBusy()).toBe(false);
    expect(sendTelegramReply).not.toHaveBeenCalled();
  });

  it('a real turn arriving while an internal job (e.g. auto-compact) is in flight gets rejected, not silently merged', async () => {
    // Confirmed live 2026-08-23: this is the actual production bug — a real
    // Telegram message arrived while an auto-compact was running, and
    // startJob() silently overwrote currentJob instead of refusing, orphaning
    // the auto-compact's promise forever. This guards the fix at the
    // session-controller level (index.ts's own isBusy() check is the other
    // half, not exercised by this unit test).
    let totalTokens = 150;
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents, () => totalTokens));
    await controller.start();
    await flushMicrotasks();
    controller.setContextLimit(100);

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessage('hi back'));
    await expect(turnPromise).resolves.toEqual({ replyText: 'hi back', ok: true, turnEnd: httpTurnEnd() });

    // Auto-compact starts on its own — while it's in flight, simulate a real
    // turn arriving (what index.ts would normally block via isBusy(), but
    // this exercises startJob()'s own defense-in-depth guard directly).
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    await expect(controller.submitTurn(chatTurn, 'turn-2')).rejects.toThrow(/still in flight/);

    // The auto-compact itself is unaffected by the rejected intruder.
    fakeEvents.push(resultMessage(''));
    await vi.waitFor(() =>
      expect(sendTelegramReply).toHaveBeenCalledWith(
        cfg.telegramBotToken,
        cfg.chatId,
        '✅ Auto-compacted: context passed your 100-token limit.',
      ),
    );
  });

  it('a control turn that never resolves times out and unblocks the queue for later turns', async () => {
    // Confirmed live 2026-08-23: a real /compact on a resumed session hung
    // for 2.5+ minutes with zero SDK output, wedging every later message.
    // Reproduced here by simply never pushing a result for the control turn.
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents), 200); // short timeout for the test
    await controller.start();
    await flushMicrotasks();

    const controlTurn: ControlTurn = { kind: 'control', updateId: 1, chatId: 111, command: '/compact' };
    const turnPromise = controller.submitTurn(controlTurn, 'ctl-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));

    await expect(turnPromise).resolves.toEqual({ replyText: '', ok: false, turnEnd: httpTurnEnd({ turns: 0 }) });
    expect(controller.isBusy()).toBe(false);

    // The queue must be usable again — this is the actual bug: without the
    // timeout, everything after the hung /compact stayed stuck forever.
    const nextTurn = controller.submitTurn(chatTurn, 'turn-2');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessage('back to normal'));
    await expect(nextTurn).resolves.toEqual({ replyText: 'back to normal', ok: true, turnEnd: httpTurnEnd() });
  });

  it('a queryFn that throws rejects the in-flight job instead of hanging', async () => {
    const boom = new Error('subprocess died');
    const throwingQueryFn = vi.fn(() => {
      return (async function* gen(): AsyncGenerator<SDKMessage> {
        yield { type: 'system', subtype: 'init', session_id: 'sess-x' } as unknown as SDKMessage;
        throw boom;
      })() as unknown as Query;
    });
    controller = createSessionController(cfg, throwingQueryFn);
    await controller.start();
    await flushMicrotasks();

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await expect(turnPromise).rejects.toBe(boom);
    expect(controller.isBusy()).toBe(false);
  });

  it(
    'exhausting the bounded restart budget exits the process instead of retrying forever',
    async () => {
      // Real timers, not fake ones: advanceTimersByTimeAsync's interaction with
      // a genuinely-throwing async generator chain proved nondeterministic
      // across environments (passed locally 5/5, failed in CI) — how many
      // chained timers it fires per advance() call isn't guaranteed. The
      // backoffs are only 1s/2s/4s (~7s total), cheap enough to just wait out
      // for real and get a properly deterministic test instead.
      //
      // The mock throws rather than returning: real process.exit() never
      // returns, so runSupervised's code never falls through past it. A mock
      // that just returns would let the loop keep retrying forever afterward
      // (mocked exit "succeeds" but doesn't actually stop anything), leaving
      // a runaway loop for afterEach's controller.stop() to wait out.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called (mocked)');
      });
      const alwaysThrows = vi.fn(() => {
        return (async function* gen(): AsyncGenerator<SDKMessage> {
          throw new Error('always dies');
          // eslint-disable-next-line no-unreachable
          yield undefined as unknown as SDKMessage;
        })() as unknown as Query;
      });
      controller = createSessionController(cfg, alwaysThrows);
      await controller.start();

      try {
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1), { timeout: 15000, interval: 100 });
      } finally {
        exitSpy.mockRestore();
      }
    },
    20000,
  );
});
