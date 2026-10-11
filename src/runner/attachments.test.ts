import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatAttachment } from '../shared/types.js';
import { resolveAttachments } from './attachments.js';
import type { RunnerConfig } from './config.js';

vi.mock('./transcribe.js', () => ({ transcribeAudio: vi.fn() }));
const { transcribeAudio } = await import('./transcribe.js');
const transcribeMock = vi.mocked(transcribeAudio);

const voice: ChatAttachment = { kind: 'voice', fileId: 'AgADfileid12345678', fileName: null, mimeType: 'audio/ogg', durationSec: 7 };

describe('resolveAttachments — voice messages', () => {
  let dir: string;
  let cfg: RunnerConfig;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pan-agent-att-'));
    cfg = { slug: 'test', telegramBotToken: 'tok', workspaceCwd: dir, transcribeUrl: 'http://stt.invalid', transcribeModel: 'm' } as unknown as RunnerConfig;
    transcribeMock.mockReset();
    // Telegram: getFile, then the file download.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('getFile')
          ? new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga' } }))
          : new Response(Buffer.from('OggS-fake-audio')),
      ),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const inboxFiles = async (): Promise<string[]> => readdir(path.join(dir, 'inbox')).catch(() => []);

  it('puts the JSON-quoted transcript in the prompt and keeps no audio on success', async () => {
    transcribeMock.mockResolvedValue('Привіт, "це" я.\nДругий рядок');
    const { notes } = await resolveAttachments(cfg, [voice]);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('voice message (7s)');
    expect(notes[0]).toContain('recognition errors');
    expect(notes[0]).toContain(JSON.stringify('Привіт, "це" я.\nДругий рядок'));
    expect(await inboxFiles()).toEqual([]);
  });

  it('reports silence instead of an empty transcript', async () => {
    transcribeMock.mockResolvedValue('');
    const { notes } = await resolveAttachments(cfg, [voice]);
    expect(notes[0]).toContain('no recognizable speech');
  });

  it('saves the audio and tells the model when transcription fails', async () => {
    transcribeMock.mockRejectedValue(new Error('server down'));
    const { notes } = await resolveAttachments(cfg, [voice]);

    expect(notes[0]).toContain("couldn't be transcribed right now");
    expect(await inboxFiles()).toHaveLength(1);
    expect(notes[0]).toContain(path.join(dir, 'inbox'));
  });

  it('saves the audio and says so when transcription is not configured, without calling the server', async () => {
    const { notes } = await resolveAttachments({ ...cfg, transcribeUrl: null }, [voice]);

    expect(transcribeMock).not.toHaveBeenCalled();
    expect(notes[0]).toContain("speech-to-text isn't set up");
    expect(await inboxFiles()).toHaveLength(1);
  });
});
