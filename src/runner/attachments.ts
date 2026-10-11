/**
 * Inbound Telegram attachments (architecture doc gap closed here): photos go
 * straight into the prompt as inline vision content, documents get saved to
 * the person's workspace so Bash/Read can pick them up. The runner downloads
 * these itself with its own TELEGRAM_BOT_TOKEN — no operator-side file
 * handling needed, the operator only ever passes the small file_id through.
 * Voice messages are transcribed (transcribe.ts) and arrive in the prompt as
 * text; the audio is only kept when that can't happen.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { log } from '../shared/log.js';
import type { ChatAttachment } from '../shared/types.js';
import type { RunnerConfig } from './config.js';
import { transcribeAudio } from './transcribe.js';

const TELEGRAM_API = 'https://api.telegram.org';
// Keep the /turn payload sane — Telegram already compresses `photo` sizes well under this.
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

interface TelegramFileInfo {
  file_path?: string;
}

async function getFilePath(token: string, fileId: string): Promise<string> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { ok: boolean; result?: TelegramFileInfo; description?: string };
  if (!data.ok || !data.result?.file_path) throw new Error(data.description ?? `getFile failed (${res.status})`);
  return data.result.file_path;
}

async function downloadFile(token: string, filePath: string): Promise<Buffer> {
  const res = await fetch(`${TELEGRAM_API}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`file download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function sanitizeFileName(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/[^\w.-]/g, '_');
  return base.length > 0 ? base.slice(-120) : 'file';
}

async function saveToInbox(cfg: RunnerConfig, safeName: string, bytes: Buffer): Promise<string> {
  const dir = path.join(cfg.workspaceCwd, 'inbox');
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}-${safeName}`);
  await writeFile(dest, bytes);
  return dest;
}

/**
 * The prompt line for a voice message. The transcript is JSON-quoted so
 * quotes/newlines in the person's speech can't break out of the note, and
 * the note says it may contain recognition errors so the model reads it as
 * speech (names and technical terms are where ASR slips), not as typed text.
 * On failure the audio is saved and the model is told, never silently dropped.
 */
async function describeVoice(cfg: RunnerConfig, att: ChatAttachment, bytes: Buffer): Promise<string> {
  const dur = att.durationSec != null ? ` (${att.durationSec}s)` : '';
  if (cfg.transcribeUrl) {
    try {
      const text = await transcribeAudio(cfg, bytes);
      if (!text) return `[the user sent a voice message${dur} with no recognizable speech]`;
      return `[voice message${dur} from the user, transcribed automatically — it may contain recognition errors, especially names and technical terms; treat it as what they said: ${JSON.stringify(text)}]`;
    } catch (err) {
      log.error('voice_transcription_failed', err, { person: cfg.slug });
    }
  }
  const dest = await saveToInbox(cfg, `voice-${att.fileId.slice(-8)}.ogg`, bytes);
  return cfg.transcribeUrl
    ? `[the user sent a voice message${dur} that couldn't be transcribed right now — saved to ${dest}; tell them, and ask them to resend or type it]`
    : `[the user sent a voice message${dur}, but speech-to-text isn't set up here — saved to ${dest}]`;
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg'; data: string };
}

export interface ResolvedAttachments {
  images: ImageBlock[];
  /** Lines to append to the prompt text — saved-file paths and failures. */
  notes: string[];
}

export async function resolveAttachments(cfg: RunnerConfig, attachments: ChatAttachment[]): Promise<ResolvedAttachments> {
  const images: ImageBlock[] = [];
  const notes: string[] = [];

  for (const att of attachments) {
    try {
      const filePath = await getFilePath(cfg.telegramBotToken, att.fileId);
      const bytes = await downloadFile(cfg.telegramBotToken, filePath);

      if (att.kind === 'photo') {
        if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
          notes.push('[user sent a photo too large to inline — ask them to resend it smaller]');
          continue;
        }
        images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } });
      } else if (att.kind === 'voice') {
        notes.push(await describeVoice(cfg, att, bytes));
      } else {
        const dest = await saveToInbox(cfg, sanitizeFileName(att.fileName ?? path.basename(filePath)), bytes);
        notes.push(`[user sent a file, saved to ${dest}]`);
      }
    } catch (err) {
      log.error('attachment_download_failed', err, { person: cfg.slug, kind: att.kind });
      notes.push(`[failed to download an attached ${att.kind} — tell the user to resend it]`);
    }
  }

  return { images, notes };
}
