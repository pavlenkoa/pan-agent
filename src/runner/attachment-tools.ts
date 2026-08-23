/**
 * Outbound attachments: the model has no way to hand the user a file today
 * (architecture gap — only text replies exist). This exposes a `send_file`
 * MCP tool backed by the runner's own direct Telegram egress, same
 * deliberate-deviation pattern as scheduling-tools.ts.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { RunnerConfig } from './config.js';
import {
  sendTelegramDocument,
  sendTelegramMediaGroup,
  sendTelegramPhoto,
  TELEGRAM_MAX_UPLOAD_BYTES,
  type MediaGroupItem,
} from './telegram-send.js';

// Roots the model may send files from — everywhere it can plausibly have put
// or found something worth sharing, nothing outside its own sandbox.
const ALLOWED_ROOTS = ['/media', '/tracking'];

function isAllowedPath(cfg: RunnerConfig, resolved: string): boolean {
  const roots = [cfg.workspaceCwd, ...ALLOWED_ROOTS];
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

interface ResolvedFile {
  resolved: string;
  fileName: string;
  bytes: Buffer;
  sizeLabel: string;
}

/** Validates and reads every path up front — an album should never go out half-sent. */
async function resolveFiles(
  cfg: RunnerConfig,
  paths: string[],
): Promise<{ files: ResolvedFile[] } | { error: string }> {
  const files: ResolvedFile[] = [];
  for (const rawPath of paths) {
    const resolved = path.resolve(rawPath);
    if (!isAllowedPath(cfg, resolved)) {
      return { error: `Refusing to send ${resolved} — outside allowed directories.` };
    }

    let size: number;
    try {
      size = (await stat(resolved)).size;
    } catch {
      return { error: `File not found: ${resolved}` };
    }
    if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
      return {
        error: `${resolved} is ${(size / 1024 / 1024).toFixed(1)}MB — over Telegram's 50MB bot upload limit, cannot send.`,
      };
    }

    const bytes = await readFile(resolved);
    files.push({ resolved, fileName: path.basename(resolved), bytes, sizeLabel: `${(size / 1024).toFixed(0)}KB` });
  }
  return { files };
}

export function buildAttachmentMcpServer(cfg: RunnerConfig) {
  const sendFile = tool(
    'send_file',
    'Send one or more local files to the user on Telegram in a single message (e.g. downloaded .torrent files, ' +
      'screenshots, documents) — pass multiple paths to group them into one Telegram album instead of separate ' +
      `messages. Paths must be under ${cfg.workspaceCwd}, /media, or /tracking. Telegram caps uploads at 50MB per ` +
      'file and albums at 10 files — say so instead of trying when a file or count is over the limit.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Absolute path(s) to the file(s) to send — one path sends a single message, 2-10 group into one album'),
      caption: z.string().optional().describe('Optional short caption (shown on the first file for an album)'),
      asPhoto: z.boolean().optional().describe('Send as inline photo(s) instead of document(s) — only for actual images'),
    },
    async (args) => {
      const resolved = await resolveFiles(cfg, args.paths);
      if ('error' in resolved) {
        return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
      }
      const { files } = resolved;

      const [file] = files;
      if (files.length === 1 && file) {
        if (args.asPhoto) {
          await sendTelegramPhoto(cfg.telegramBotToken, cfg.chatId, file.fileName, file.bytes, args.caption);
        } else {
          await sendTelegramDocument(cfg.telegramBotToken, cfg.chatId, file.fileName, file.bytes, args.caption);
        }
        return { content: [{ type: 'text' as const, text: `Sent ${file.fileName} (${file.sizeLabel}).` }] };
      }

      const items: MediaGroupItem[] = files.map((f) => ({ fileName: f.fileName, bytes: f.bytes, asPhoto: args.asPhoto }));
      await sendTelegramMediaGroup(cfg.telegramBotToken, cfg.chatId, items, args.caption);
      return {
        content: [{ type: 'text' as const, text: `Sent ${files.length} files as one album: ${files.map((f) => f.fileName).join(', ')}.` }],
      };
    },
  );

  return createSdkMcpServer({ name: 'pan-agent-attachments', version: '1.0.0', tools: [sendFile] });
}
