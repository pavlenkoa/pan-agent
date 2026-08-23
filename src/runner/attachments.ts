/**
 * Inbound Telegram attachments (architecture doc gap closed here): photos go
 * straight into the prompt as inline vision content, documents get saved to
 * the person's workspace so Bash/Read can pick them up. The runner downloads
 * these itself with its own TELEGRAM_BOT_TOKEN — no operator-side file
 * handling needed, the operator only ever passes the small file_id through.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { log } from '../shared/log.js';
import type { ChatAttachment } from '../shared/types.js';
import type { RunnerConfig } from './config.js';

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
      } else {
        const safeName = sanitizeFileName(att.fileName ?? path.basename(filePath));
        const dir = path.join(cfg.workspaceCwd, 'inbox');
        await mkdir(dir, { recursive: true });
        const dest = path.join(dir, `${Date.now()}-${safeName}`);
        await writeFile(dest, bytes);
        notes.push(`[user sent a file, saved to ${dest}]`);
      }
    } catch (err) {
      log.error('attachment_download_failed', err, { person: cfg.slug, kind: att.kind });
      notes.push(`[failed to download an attached ${att.kind} — tell the user to resend it]`);
    }
  }

  return { images, notes };
}
