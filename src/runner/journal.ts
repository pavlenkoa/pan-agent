/**
 * NFS-backed idempotency ledger (architecture doc section 4): the runner
 * journals a turn's dedup key *before* processing it, so a redelivered
 * Telegram update or a re-fired task tuple is a no-op instead of a
 * duplicate reply / duplicate side effect. Pod-local dedup, not shared
 * infra — lives under `~/.claude` so it survives pod restarts.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { turnKey, type TurnRequest } from '../shared/types.js';

export interface JournalEntry {
  key: string;
  startedAt: string;
  completedAt: string | null;
  status: 'pending' | 'ok' | 'error';
}

function keyToFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json';
}

export interface Journal {
  /** Records the start of processing. `alreadyProcessed` true means: skip, reply nothing, just 202. */
  begin(turn: TurnRequest): Promise<{ key: string; alreadyProcessed: boolean }>;
  complete(key: string, status: 'ok' | 'error'): Promise<void>;
  /** Entries with no completedAt — a prior turn crashed mid-processing. Surfaced on boot per section 4. */
  listIncomplete(): Promise<JournalEntry[]>;
}

export function createJournal(baseDir: string): Journal {
  async function ensureDir(): Promise<void> {
    await mkdir(baseDir, { recursive: true });
  }

  async function readEntry(key: string): Promise<JournalEntry | null> {
    try {
      const raw = await readFile(path.join(baseDir, keyToFilename(key)), 'utf8');
      return JSON.parse(raw) as JournalEntry;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeEntry(entry: JournalEntry): Promise<void> {
    await ensureDir();
    await writeFile(path.join(baseDir, keyToFilename(entry.key)), JSON.stringify(entry, null, 2));
  }

  return {
    async begin(turn: TurnRequest) {
      const key = turnKey(turn);
      const existing = await readEntry(key);
      if (existing?.completedAt) return { key, alreadyProcessed: true };
      // No entry, or a prior attempt started but never finished (crash mid-turn) — (re)claim and retry.
      await writeEntry({ key, startedAt: new Date().toISOString(), completedAt: null, status: 'pending' });
      return { key, alreadyProcessed: false };
    },

    async complete(key: string, status: 'ok' | 'error') {
      const existing = await readEntry(key);
      await writeEntry({
        key,
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status,
      });
    },

    async listIncomplete() {
      await ensureDir();
      const files = await readdir(baseDir);
      const incomplete: JournalEntry[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const raw = await readFile(path.join(baseDir, file), 'utf8');
        const entry = JSON.parse(raw) as JournalEntry;
        if (!entry.completedAt) incomplete.push(entry);
      }
      return incomplete;
    },
  };
}
