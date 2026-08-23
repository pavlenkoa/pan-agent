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
});
