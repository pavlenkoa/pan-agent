/**
 * Resolves the person's sticker-pack list (a small JSON file on the NFS
 * claude-home mount, written by operator/nfs.ts via /sticker_packs or an
 * auto-added forwarded sticker) into actual sendable stickers. Read fresh
 * off disk on every call — same "no pod restart needed" shape as auto-memory
 * — but each pack's own resolved contents (via Telegram's getStickerSet) are
 * cached for the pod's lifetime, since a published pack's sticker list is
 * effectively static and re-fetching it per tool call would be wasteful.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { log } from '../shared/log.js';
import type { RunnerConfig } from './config.js';
import { getTelegramStickerSet, type TelegramStickerInfo } from './telegram-send.js';

// Must match STICKER_PACKS_FILE_NAME in operator/nfs.ts.
const STICKER_PACKS_FILE_NAME = 'sticker-packs.json';

interface StickerPackRecord {
  name: string;
}

async function readPackNames(cfg: RunnerConfig): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(cfg.claudeHome, STICKER_PACKS_FILE_NAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is StickerPackRecord => typeof v === 'object' && v !== null && typeof (v as StickerPackRecord).name === 'string')
    .map((v) => v.name);
}

const resolvedPackCache = new Map<string, TelegramStickerInfo[]>();

export interface AvailableSticker extends TelegramStickerInfo {
  pack: string;
}

export async function listAvailableStickers(cfg: RunnerConfig): Promise<AvailableSticker[]> {
  const packNames = await readPackNames(cfg);
  const all: AvailableSticker[] = [];
  for (const name of packNames) {
    let stickers = resolvedPackCache.get(name);
    if (!stickers) {
      try {
        stickers = await getTelegramStickerSet(cfg.telegramBotToken, name);
        resolvedPackCache.set(name, stickers);
      } catch (err) {
        log.error('sticker_pack_resolve_failed', err, { person: cfg.slug, pack: name });
        continue;
      }
    }
    all.push(...stickers.map((s) => ({ ...s, pack: name })));
  }
  return all;
}
