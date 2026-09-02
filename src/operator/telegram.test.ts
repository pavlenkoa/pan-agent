import { describe, expect, it, vi } from 'vitest';

import { pollUpdates, type TelegramClient, type TelegramUpdate } from './telegram.js';

function update(id: number): TelegramUpdate {
  return { update_id: id, message: undefined };
}

describe('pollUpdates', () => {
  it('keeps polling and still advances the offset when onUpdate rejects', async () => {
    const abortController = new AbortController();
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update(101), update(102)])
      .mockImplementationOnce(async () => {
        abortController.abort();
        return [];
      });
    const client = { getUpdates } as unknown as TelegramClient;

    const onUpdate = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await pollUpdates(client, undefined, onUpdate, abortController.signal);

    expect(onUpdate).toHaveBeenCalledTimes(2);
    // Offset advanced past update 102 even though its sibling update 101 threw.
    expect(getUpdates).toHaveBeenNthCalledWith(2, 103, 50);
  });

  it('moves on to the next update instead of hanging forever when onUpdate never resolves (2026-09-02 incident regression guard)', async () => {
    const abortController = new AbortController();
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([update(201), update(202)])
      .mockImplementationOnce(async () => {
        abortController.abort();
        return [];
      });
    const client = { getUpdates } as unknown as TelegramClient;

    // update 201's handler never settles — simulates the confirmed-live hang
    // (a stuck chat-message delivery blocking the whole global poll loop,
    // including a later update — here, 202 — that would otherwise unblock it).
    const onUpdate = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(undefined);

    await pollUpdates(client, undefined, onUpdate, abortController.signal, 20);

    expect(onUpdate).toHaveBeenCalledTimes(2); // 202 was still reached despite 201 hanging
    expect(getUpdates).toHaveBeenNthCalledWith(2, 203, 50); // offset advanced past both
  });
});
