import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatTurn, ControlTurn } from '../shared/types.js';
import type { RunnerConfig } from './config.js';
import { createPushableQueue } from './pushable-queue.js';
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

function resultMessageWithUsage(
  text: string,
  usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number },
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    result: text,
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        contextWindow: 1_000_000,
      },
    },
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

/** A fake query() whose events are entirely test-driven via `fakeEvents`. */
function fakeQueryFn(fakeEvents: ReturnType<typeof createPushableQueue<SDKMessage>>) {
  return vi.fn(() => {
    return (async function* gen() {
      for await (const msg of fakeEvents) yield msg;
    })() as unknown as Query;
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  function trackedFakeQueryFn(fakeEvents: ReturnType<typeof createPushableQueue<SDKMessage>>) {
    fakeEventsInUse = fakeEvents;
    return fakeQueryFn(fakeEvents);
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

    await expect(turnPromise).resolves.toEqual({ replyText: 'hello there', ok: true });
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
    await expect(turnPromise).resolves.toEqual({ replyText: 'main reply', ok: true });
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

  it('auto-compacts once usage crosses the configured context limit, and does not chain into a second one', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();
    controller.setContextLimit(100);

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessageWithUsage('hi back', { cacheReadInputTokens: 150 }));
    await expect(turnPromise).resolves.toEqual({ replyText: 'hi back', ok: true });

    // No external submitTurn call here — this job has to start on its own.
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));

    // Resolve it with a real /compact-shaped result (empty text) but
    // deliberately high usage, to prove the trigger:'auto_compact' guard
    // stops it from chaining into a second auto-compact rather than the
    // numbers just happening to fall under the limit this time.
    fakeEvents.push(resultMessageWithUsage('', { cacheReadInputTokens: 999 }));
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

  it('does not auto-compact when usage stays under the configured limit', async () => {
    const fakeEvents = createPushableQueue<SDKMessage>();
    controller = createSessionController(cfg, trackedFakeQueryFn(fakeEvents));
    await controller.start();
    await flushMicrotasks();
    controller.setContextLimit(1_000_000); // default-shaped: far above what this turn uses

    const turnPromise = controller.submitTurn(chatTurn, 'turn-1');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessageWithUsage('hi back', { cacheReadInputTokens: 150 }));
    await expect(turnPromise).resolves.toEqual({ replyText: 'hi back', ok: true });

    await flushMicrotasks();
    expect(controller.isBusy()).toBe(false);
    expect(sendTelegramReply).not.toHaveBeenCalled();
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

    await expect(turnPromise).resolves.toEqual({ replyText: '', ok: false });
    expect(controller.isBusy()).toBe(false);

    // The queue must be usable again — this is the actual bug: without the
    // timeout, everything after the hung /compact stayed stuck forever.
    const nextTurn = controller.submitTurn(chatTurn, 'turn-2');
    await vi.waitFor(() => expect(controller?.isBusy()).toBe(true));
    fakeEvents.push(resultMessage('back to normal'));
    await expect(nextTurn).resolves.toEqual({ replyText: 'back to normal', ok: true });
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
