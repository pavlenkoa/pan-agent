import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatTurn } from '../shared/types.js';
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

  it('exhausting the bounded restart budget exits the process instead of retrying forever', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const alwaysThrows = vi.fn(() => {
        return (async function* gen(): AsyncGenerator<SDKMessage> {
          throw new Error('always dies');
          // eslint-disable-next-line no-unreachable
          yield undefined as unknown as SDKMessage;
        })() as unknown as Query;
      });
      controller = createSessionController(cfg, alwaysThrows);
      await controller.start();

      // Backoffs are 1s/2s/4s (3 bounded retries) before the exhausted exit.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(4000);
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
