import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../shared/types.js';

vi.mock('./pod-lifecycle.js', () => ({
  ensurePersonPod: vi.fn().mockResolvedValue(undefined),
  podExists: vi.fn().mockResolvedValue(true),
  podIp: vi.fn().mockResolvedValue('10.0.0.5'),
  waitForPodReady: vi.fn().mockResolvedValue(true),
}));

vi.mock('./person-state.js', () => ({
  markUpdateDelivered: vi.fn().mockResolvedValue(undefined),
}));

import { markUpdateDelivered } from './person-state.js';
// eslint-disable-next-line import/order
import { enqueueChatMessage } from './delivery.js';

const cfg = {
  namespace: 'pan-agent',
  podReadyTimeoutMs: 1000,
} as unknown as import('./config.js').OperatorConfig;

function msg(text: string): ChatMessage {
  return { messageId: 1, text, fromHandle: null, date: new Date().toISOString() };
}

describe('enqueueChatMessage — batching while the pod is busy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('merges messages that arrive while a delivery attempt is being retried into one turn', async () => {
    // First attempt: pod is mid-turn (409). Second attempt (after backoff): accepted.
    fetchMock
      .mockResolvedValueOnce({ status: 409 } as Response)
      .mockResolvedValueOnce({ status: 202 } as Response);

    const slug = 'andrii-batch-test';
    const first = enqueueChatMessage(
      {} as unknown as import('@kubernetes/client-node').CoreV1Api,
      cfg,
      slug,
      111,
      'Europe/Warsaw',
      'test-token',
      101,
      msg('first'),
    );

    // Let the first fetch (409) resolve, then enqueue a second message while
    // the flush loop is asleep in its backoff.
    await vi.advanceTimersByTimeAsync(0);
    enqueueChatMessage(
      {} as unknown as import('@kubernetes/client-node').CoreV1Api,
      cfg,
      slug,
      111,
      'Europe/Warsaw',
      'test-token',
      102,
      msg('second'),
    );

    // Advance past the backoff so the retry (with the merged batch) fires.
    await vi.advanceTimersByTimeAsync(2000);
    await first;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondCallBody.updateId).toBe(102);
    expect(secondCallBody.messages).toHaveLength(2);
    expect(secondCallBody.messages[0].text).toBe('first');
    expect(secondCallBody.messages[1].text).toBe('second');
    expect(markUpdateDelivered).toHaveBeenCalledWith(expect.anything(), 'pan-agent', slug, 102);
  });
});
