/**
 * Outbound attachments: the model has no way to hand the user a file today
 * (architecture gap — only text replies exist). This exposes a `send_file`
 * MCP tool backed by the runner's own direct Telegram egress, same
 * deliberate-deviation pattern as scheduling-tools.ts.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { RunnerConfig } from './config.js';
import { sendTelegramDocument, sendTelegramPhoto, TELEGRAM_MAX_UPLOAD_BYTES } from './telegram-send.js';

// Roots the model may send files from — everywhere it can plausibly have put
// or found something worth sharing, nothing outside its own sandbox.
const ALLOWED_ROOTS = ['/media', '/tracking'];

function isAllowedPath(cfg: RunnerConfig, resolved: string): boolean {
  const roots = [cfg.workspaceCwd, ...ALLOWED_ROOTS];
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export function buildAttachmentMcpServer(cfg: RunnerConfig) {
  const sendFile = tool(
    'send_file',
    'Send a local file to the user on Telegram (e.g. a downloaded .torrent file, a screenshot, a document). ' +
      `Path must be under ${cfg.workspaceCwd}, /media, or /tracking. Telegram caps uploads at 50MB — larger files ` +
      'will be rejected; say so instead of trying to send them.',
    {
      path: z.string().describe('Absolute path to the file to send'),
      caption: z.string().optional().describe('Optional short caption'),
      asPhoto: z.boolean().optional().describe('Send as an inline photo instead of a document (only for actual images)'),
    },
    async (args) => {
      const resolved = path.resolve(args.path);
      if (!isAllowedPath(cfg, resolved)) {
        return {
          content: [{ type: 'text' as const, text: `Refusing to send ${resolved} — outside allowed directories.` }],
          isError: true,
        };
      }

      let size: number;
      try {
        size = (await stat(resolved)).size;
      } catch {
        return { content: [{ type: 'text' as const, text: `File not found: ${resolved}` }], isError: true };
      }
      if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `${resolved} is ${(size / 1024 / 1024).toFixed(1)}MB — over Telegram's 50MB bot upload limit, cannot send.`,
            },
          ],
          isError: true,
        };
      }

      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(resolved);
      const fileName = path.basename(resolved);
      if (args.asPhoto) {
        await sendTelegramPhoto(cfg.telegramBotToken, cfg.chatId, fileName, bytes, args.caption);
      } else {
        await sendTelegramDocument(cfg.telegramBotToken, cfg.chatId, fileName, bytes, args.caption);
      }
      return { content: [{ type: 'text' as const, text: `Sent ${fileName} (${(size / 1024).toFixed(0)}KB).` }] };
    },
  );

  return createSdkMcpServer({ name: 'pan-agent-attachments', version: '1.0.0', tools: [sendFile] });
}
