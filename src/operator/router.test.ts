import { describe, expect, it } from 'vitest';

import { extractAttachments } from './router.js';
import type { TelegramMessage } from './telegram.js';

const base = { message_id: 1, chat: { id: 1, type: 'private' }, date: 0 } as TelegramMessage;

describe('extractAttachments', () => {
  it('returns undefined for a plain text message', () => {
    expect(extractAttachments({ ...base, text: 'hi' })).toBeUndefined();
  });

  it('maps a voice message, keeping its duration and defaulting the mime type', () => {
    expect(extractAttachments({ ...base, voice: { file_id: 'v1', duration: 12 } })).toEqual([
      { kind: 'voice', fileId: 'v1', fileName: null, mimeType: 'audio/ogg', durationSec: 12 },
    ]);
  });

  it('uses the mime type Telegram reports for a voice message', () => {
    const [att] = extractAttachments({ ...base, voice: { file_id: 'v1', duration: 3, mime_type: 'audio/mpeg' } }) ?? [];
    expect(att?.mimeType).toBe('audio/mpeg');
  });

  it('still maps photos and documents alongside', () => {
    const atts = extractAttachments({
      ...base,
      photo: [{ file_id: 'small', width: 1, height: 1 }, { file_id: 'big', width: 2, height: 2 }],
      document: { file_id: 'd1', file_name: 'a.pdf', mime_type: 'application/pdf' },
    });
    expect(atts?.map((a) => [a.kind, a.fileId])).toEqual([['photo', 'big'], ['document', 'd1']]);
  });
});
