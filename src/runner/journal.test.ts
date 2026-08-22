import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatTurn, TaskTurn } from '../shared/types.js';
import { createJournal, type Journal } from './journal.js';

describe('journal', () => {
  let dir: string;
  let journal: Journal;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pan-agent-journal-'));
    journal = createJournal(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const chatTurn: ChatTurn = { kind: 'chat', updateId: 987654, chatId: 111, messages: [] };
  const taskTurn: TaskTurn = {
    kind: 'task',
    taskId: 'check-tv',
    scheduledFor: '2026-07-26T07:00:00.000Z',
    chatId: 111,
    prompt: 'check subscriptions',
  };

  it('a fresh turn is not already processed', async () => {
    const { alreadyProcessed } = await journal.begin(chatTurn);
    expect(alreadyProcessed).toBe(false);
  });

  it('a redelivered update (same updateId) is deduped after completion', async () => {
    const { key } = await journal.begin(chatTurn);
    await journal.complete(key, 'ok');

    const second = await journal.begin(chatTurn);
    expect(second.alreadyProcessed).toBe(true);
  });

  it('a turn that started but never completed (crash mid-turn) is retried, not deduped', async () => {
    await journal.begin(chatTurn); // never completed — simulates a crash
    const retry = await journal.begin(chatTurn);
    expect(retry.alreadyProcessed).toBe(false);
  });

  it('an incomplete entry surfaces via listIncomplete', async () => {
    await journal.begin(chatTurn);
    const incomplete = await journal.listIncomplete();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.completedAt).toBeNull();
  });

  it('a completed entry does not surface via listIncomplete', async () => {
    const { key } = await journal.begin(chatTurn);
    await journal.complete(key, 'ok');
    expect(await journal.listIncomplete()).toHaveLength(0);
  });

  it('task turns dedup on (taskId, scheduledFor), not on taskId alone', async () => {
    const { key } = await journal.begin(taskTurn);
    await journal.complete(key, 'ok');

    // Same task, next occurrence — must NOT be deduped.
    const nextOccurrence: TaskTurn = { ...taskTurn, scheduledFor: '2026-07-27T07:00:00.000Z' };
    const result = await journal.begin(nextOccurrence);
    expect(result.alreadyProcessed).toBe(false);

    // Re-firing the exact same occurrence — must be deduped.
    const sameOccurrence = await journal.begin(taskTurn);
    expect(sameOccurrence.alreadyProcessed).toBe(true);
  });

  it('an errored turn is still marked complete and future redeliveries dedupe (at-most-once)', async () => {
    const { key } = await journal.begin(chatTurn);
    await journal.complete(key, 'error');
    const redelivered = await journal.begin(chatTurn);
    expect(redelivered.alreadyProcessed).toBe(true);
  });
});
