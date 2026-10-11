/**
 * Speech-to-text client for voice messages. Talks to any OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint (in this deployment, WhisperKit's local
 * server on the Mac host — see CLAUDE.md), so the engine behind it can change
 * without touching the runner.
 *
 * Telegram voice notes (OGG/Opus) are sent as-is: confirmed live that the
 * WhisperKit server decodes them directly, with the same transcript as a
 * pre-converted WAV, so no ffmpeg step is needed here.
 */
import type { RunnerConfig } from './config.js';

const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** The OpenAI request shape requires `model`, and confirmed live the WhisperKit server returns 500 when it's empty — but otherwise ignores the value and serves whatever model it was started with. So any non-empty string works; which model actually runs is decided where the server is launched. */
const FALLBACK_MODEL_FIELD = 'default';

type TranscribeConfig = Pick<RunnerConfig, 'transcribeUrl' | 'transcribeModel'>;

/** Accepts both `json` ({text}) and `verbose_json` (text plus segments) — only `text` is used. */
export function parseTranscription(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const text = (body as { text?: unknown }).text;
    if (typeof text === 'string') return text.trim();
  }
  throw new Error('unexpected transcription response shape');
}

export async function transcribeAudio(cfg: TranscribeConfig, audio: Buffer, mimeType = 'audio/ogg'): Promise<string> {
  if (!cfg.transcribeUrl) throw new Error('transcription is not configured');
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'voice.ogg');
  form.set('model', cfg.transcribeModel || FALLBACK_MODEL_FIELD);
  form.set('response_format', 'json');
  const res = await fetch(new URL('/v1/audio/transcriptions', cfg.transcribeUrl), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`transcription request failed (${res.status})`);
  return parseTranscription(await res.json());
}
