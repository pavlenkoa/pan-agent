import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { turnKey } from '../shared/types.js';
import type { RunnerConfig } from './config.js';
import { buildPrompt, NO_UPDATE_MARKER, personaChangedSinceLastAck, resolveReplyText } from './sdk-session.js';

describe('buildPrompt — ControlTurn', () => {
  it('returns the bare command with no prefix, regardless of chatId', () => {
    // Confirmed live 2026-08-23: the SDK only recognizes /compact and /clear
    // as bare text — a ChatTurn's `${fromHandle}: ${text}` prefix silently
    // breaks recognition and the model just answers the text as a normal
    // question instead. This guards against that regression.
    expect(buildPrompt({ kind: 'control', updateId: 1, chatId: 42, command: '/compact' })).toBe('/compact');
    expect(buildPrompt({ kind: 'control', updateId: 1, chatId: 42, command: '/clear' })).toBe('/clear');
  });
});

describe('buildPrompt — ChatTurn (regression guard)', () => {
  it('still prefixes chat messages with fromHandle when present', () => {
    const prompt = buildPrompt({
      kind: 'chat',
      updateId: 1,
      chatId: 42,
      messages: [{ messageId: 1, text: '/compact', fromHandle: '@andrii', date: '2026-08-23T00:00:00Z' }],
    });
    expect(prompt).toBe('@andrii: /compact');
  });

  it('omits the prefix when fromHandle is null', () => {
    const prompt = buildPrompt({
      kind: 'chat',
      updateId: 1,
      chatId: 42,
      messages: [{ messageId: 1, text: 'hello', fromHandle: null, date: '2026-08-23T00:00:00Z' }],
    });
    expect(prompt).toBe('hello');
  });
});

describe('buildPrompt — TaskTurn', () => {
  it('includes the task prompt and instructs the no-update marker', () => {
    const prompt = buildPrompt({
      kind: 'task',
      taskId: 'task-1',
      scheduledFor: '2026-08-24T09:00:00Z',
      chatId: 42,
      prompt: 'Check if Silo has new episodes.',
    });
    expect(prompt).toContain('[Scheduled task task-1, due 2026-08-24T09:00:00Z]');
    expect(prompt).toContain('Check if Silo has new episodes.');
    expect(prompt).toContain(NO_UPDATE_MARKER);
  });
});

describe('resolveReplyText — TaskTurn no-update suppression', () => {
  const task = { kind: 'task' as const, taskId: 'task-1', scheduledFor: '2026-08-24T09:00:00Z', chatId: 42, prompt: 'check' };

  it('suppresses delivery on a bare NO_UPDATE_MARKER reply', () => {
    expect(resolveReplyText(task, { replyText: NO_UPDATE_MARKER, ok: true })).toEqual({
      replyText: '',
      isNoUpdate: true,
      suppressedReasoning: '',
    });
  });

  it('still suppresses when the marker has surrounding whitespace', () => {
    expect(resolveReplyText(task, { replyText: `  ${NO_UPDATE_MARKER}  `, ok: true })).toEqual({
      replyText: '',
      isNoUpdate: true,
      suppressedReasoning: '',
    });
  });

  it('suppresses when the marker sits on its own trailing line after reasoning, preserving the reasoning', () => {
    // Confirmed live: the model sometimes prepends reasoning before the bare
    // marker line — an exact `trim() === MARKER` match misses this entirely
    // and delivers the literal marker text to Telegram.
    const reasoning = 'Still only TELESYNC/HDTS cam-rips, no real upgrade.';
    expect(resolveReplyText(task, { replyText: `${reasoning}\n\n${NO_UPDATE_MARKER}`, ok: true })).toEqual({
      replyText: '',
      isNoUpdate: true,
      suppressedReasoning: reasoning,
    });
  });

  it('suppresses when the marker line has trailing spaces and a trailing newline', () => {
    const reasoning = 'checking tomorrow instead';
    expect(resolveReplyText(task, { replyText: `${reasoning}\n${NO_UPDATE_MARKER} \n`, ok: true })).toEqual({
      replyText: '',
      isNoUpdate: true,
      suppressedReasoning: reasoning,
    });
  });

  it('does NOT suppress when the marker is not on its own trailing line', () => {
    const replyText = `${NO_UPDATE_MARKER} available yet, still checking tomorrow`;
    expect(resolveReplyText(task, { replyText, ok: true })).toEqual({
      replyText,
      isNoUpdate: false,
      suppressedReasoning: '',
    });
  });

  it('passes through a real task reply untouched', () => {
    expect(resolveReplyText(task, { replyText: 'нова серія вийшла!', ok: true })).toEqual({
      replyText: 'нова серія вийшла!',
      isNoUpdate: false,
      suppressedReasoning: '',
    });
  });
});

describe('resolveReplyText — ChatTurn no-update suppression', () => {
  // Deliberate behavior change from the original task-only suppression: a
  // chat turn now honors NO_UPDATE too, so a turn where react_to_message/
  // send_sticker already was the whole response doesn't also have to emit a
  // redundant text echo just to satisfy the CLI's "must produce visible
  // output" constraint (see noUpdateInstruction's doc comment).
  const chat = { kind: 'chat' as const, updateId: 1, chatId: 42, messages: [] };

  it('suppresses delivery on a bare NO_UPDATE_MARKER reply', () => {
    expect(resolveReplyText(chat, { replyText: NO_UPDATE_MARKER, ok: true })).toEqual({
      replyText: '',
      isNoUpdate: true,
      suppressedReasoning: '',
    });
  });

  it('suppresses when the marker sits on its own trailing line after reasoning', () => {
    const reasoning = 'Already reacted with 👍, nothing more to add.';
    expect(resolveReplyText(chat, { replyText: `${reasoning}\n${NO_UPDATE_MARKER}`, ok: true })).toEqual({
      replyText: '',
      isNoUpdate: true,
      suppressedReasoning: reasoning,
    });
  });

  it('passes through a real chat reply untouched', () => {
    expect(resolveReplyText(chat, { replyText: 'звісно, зараз гляну', ok: true })).toEqual({
      replyText: 'звісно, зараз гляну',
      isNoUpdate: false,
      suppressedReasoning: '',
    });
  });
});

describe('resolveReplyText — ControlTurn synthesized replies', () => {
  it('synthesizes a success message for /compact with an empty SDK result', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/compact' as const };
    expect(resolveReplyText(turn, { replyText: '', ok: true }).replyText).toBe('✅ Compacted your conversation history.');
  });

  it('synthesizes a success message for /clear with an empty SDK result', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/clear' as const };
    expect(resolveReplyText(turn, { replyText: '', ok: true }).replyText).toBe(
      '✅ Cleared — starting fresh from here. Memory notes and scheduled tasks are unaffected.',
    );
  });

  it('synthesizes a timeout warning when the control turn failed with no reply', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/compact' as const };
    expect(resolveReplyText(turn, { replyText: '', ok: false }).replyText).toBe('⚠️ /compact timed out — try again in a moment.');
  });

  it('prefers an actual SDK reply over synthesizing one', () => {
    const turn = { kind: 'control' as const, updateId: 1, chatId: 42, command: '/compact' as const };
    expect(resolveReplyText(turn, { replyText: 'real reply', ok: true }).replyText).toBe('real reply');
  });
});

describe('resolveReplyText — ChatTurn', () => {
  it('passes an empty reply straight through as empty (no synthesis for chat)', () => {
    const turn = { kind: 'chat' as const, updateId: 1, chatId: 42, messages: [] };
    expect(resolveReplyText(turn, { replyText: '', ok: true }).replyText).toBe('');
  });
});

describe('personaChangedSinceLastAck', () => {
  let dir: string;
  let cfg: RunnerConfig;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pan-agent-persona-'));
    cfg = {
      slug: 'test',
      chatId: 1,
      tz: 'UTC',
      port: 8080,
      operatorTasksUrl: 'http://operator.invalid',
      tasksToken: 'test-token',
      telegramBotToken: 'bot-token',
      journalDir: dir,
      workspaceCwd: dir,
      claudeHome: dir,
      sessionIdFile: path.join(dir, 'session-id'),
      customVarsDoc: [],
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns false on the very first check — no prior hash to compare, a fresh session needs no nudge', async () => {
    expect(await personaChangedSinceLastAck(cfg, 'content v1')).toBe(false);
  });

  it('returns false when content is unchanged since the last check', async () => {
    await personaChangedSinceLastAck(cfg, 'content v1');
    expect(await personaChangedSinceLastAck(cfg, 'content v1')).toBe(false);
  });

  it('returns true when content changed since the last check', async () => {
    await personaChangedSinceLastAck(cfg, 'content v1');
    expect(await personaChangedSinceLastAck(cfg, 'content v2')).toBe(true);
  });

  it('only reports a given change once — acknowledges it immediately, not just on a later call', async () => {
    await personaChangedSinceLastAck(cfg, 'content v1');
    await personaChangedSinceLastAck(cfg, 'content v2');
    expect(await personaChangedSinceLastAck(cfg, 'content v2')).toBe(false);
  });
});

describe('turnKey', () => {
  it('gives control turns their own dedup namespace, keyed by updateId', () => {
    expect(turnKey({ kind: 'control', updateId: 7, chatId: 42, command: '/compact' })).toBe('ctl:7');
  });
});
